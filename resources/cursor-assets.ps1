# DogSC system cursor extraction for Windows.
#
# The macOS original draws its cursor styles from the real system artwork
# (`NSCursor.arrow.image` and the HI services vector assets). The Windows
# equivalent is the cursor bitmap behind `LoadCursor(NULL, IDC_*)`, which this
# script resolves into a renderable sprite.
#
# A Windows cursor is a mask pair — a monochrome AND/XOR mask, optionally a
# 32-bit colour bitmap — and the styles split into three shapes:
#
#   * colour cursors (arrow, hand, forbidden): the colour bitmap carries
#     32-bit ARGB pixels already;
#   * legacy monochrome cursors: AND=0 pixels are opaque and take their colour
#     from the XOR mask (white) or stay black;
#   * inverted cursors (I-beam, crosshair): the AND mask is entirely white and
#     the XOR mask marks the pixels the system *inverts* against whatever is
#     underneath. A bitmap cannot express that statically, so the artwork is
#     emitted as a white mask plus `"mode":"invert"` and the renderer draws it
#     with a difference blend — exactly how Windows itself shows it.
#
# Output (one line on stdout):
#   {"assets":[
#     {"id":"system.arrow","mode":"sprite","png":"<base64>",
#      "hotspotX":3,"hotspotY":2,"width":32,"height":32},
#     {"id":"system.ibeam","mode":"invert", ...}
#   ]}
#
# The Electron main process caches the result for the session.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
using System;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

public sealed class DogSCCursorExtractor
{
    [StructLayout(LayoutKind.Sequential)]
    private struct ICONINFO
    {
        public bool fIcon;
        public int xHotspot;
        public int yHotspot;
        public IntPtr hbmMask;
        public IntPtr hbmColor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFOHEADER
    {
        public int biSize;
        public int biWidth;
        public int biHeight;
        public ushort biPlanes;
        public ushort biBitCount;
        public int biCompression;
        public int biSizeImage;
        public int biXPelsPerMeter;
        public int biYPelsPerMeter;
        public int biClrUsed;
        public int biClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BITMAPINFO
    {
        public BITMAPINFOHEADER bmiHeader;
        public int bmiColors;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetIconInfo(IntPtr hIcon, out ICONINFO piconinfo);

    [DllImport("user32.dll")]
    private static extern IntPtr GetDC(IntPtr hWnd);

    [DllImport("user32.dll")]
    private static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteObject(IntPtr hObject);

    [DllImport("gdi32.dll")]
    private static extern int GetDIBits(IntPtr hdc, IntPtr hbm, uint start, uint lines, byte[] bits, ref BITMAPINFO bi, uint usage);

    private static bool IsWhite(Color c) { return c.R > 128; }

    /// <summary>Reads a bitmap as top-down 32-bit BGRA through GetDIBits.</summary>
    private static byte[] ReadBits32(IntPtr hdc, IntPtr hbm, int width, int height)
    {
        BITMAPINFO bi = new BITMAPINFO();
        bi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
        bi.bmiHeader.biWidth = width;
        bi.bmiHeader.biHeight = -height; /* top-down rows */
        bi.bmiHeader.biPlanes = 1;
        bi.bmiHeader.biBitCount = 32;
        bi.bmiHeader.biCompression = 0; /* BI_RGB */
        byte[] target = new byte[width * height * 4];
        int result = GetDIBits(hdc, hbm, 0, (uint)height, target, ref bi, 0);
        return result == 0 ? null : target;
    }

    /// <summary>Extracts one system cursor as a base64 PNG JSON fragment.</summary>
    public static string Extract(string id, int cursorName)
    {
        IntPtr hCursor = LoadCursor(IntPtr.Zero, new IntPtr(cursorName));
        if (hCursor == IntPtr.Zero) return null;

        ICONINFO info;
        if (!GetIconInfo(hCursor, out info)) return null;
        try
        {
            if (info.hbmMask == IntPtr.Zero) return null;
            using (Bitmap mask = Bitmap.FromHbitmap(info.hbmMask))
            {
                int width = mask.Width;
                bool hasColor = info.hbmColor != IntPtr.Zero;
                int height = hasColor ? mask.Height : mask.Height / 2;
                if (width <= 0 || height <= 0 || width > 256 || height > 256) return null;

                string mode = "sprite";
                byte[] pixels = new byte[width * height * 4];

                bool colorUsed = false;
                if (hasColor)
                {
                    /* Prefer the colour bitmap's own pixels (they carry the
                       anti-aliased edges on modern themes), but only when its
                       alpha channel is actually meaningful — plenty of themes
                       ship opaque bitmaps and use the mask for transparency. */
                    IntPtr hdc = GetDC(IntPtr.Zero);
                    byte[] colorBits;
                    try
                    {
                        colorBits = ReadBits32(hdc, info.hbmColor, width, height);
                    }
                    finally
                    {
                        ReleaseDC(IntPtr.Zero, hdc);
                    }
                    if (colorBits != null)
                    {
                        int transparent = 0;
                        int solid = 0;
                        for (int i = 3; i < colorBits.Length; i += 4)
                        {
                            if (colorBits[i] < 8) transparent++;
                            else if (colorBits[i] > 247) solid++;
                        }
                        colorUsed = transparent > 0 && solid > 0;
                        if (colorUsed)
                        {
                            Array.Copy(colorBits, pixels, pixels.Length);
                        }
                    }
                }

                bool areColor = colorUsed;
                if (!areColor && hasColor)
                {
                    /* Opaque colour bitmap: the single-height mask decides
                       transparency, the bitmap supplies the colour. */
                    IntPtr hdc = GetDC(IntPtr.Zero);
                    byte[] colorBits;
                    try
                    {
                        colorBits = ReadBits32(hdc, info.hbmColor, width, height);
                    }
                    finally
                    {
                        ReleaseDC(IntPtr.Zero, hdc);
                    }
                    if (colorBits != null)
                    {
                        areColor = true;
                        for (int y = 0; y < height; y++)
                        {
                            for (int x = 0; x < width; x++)
                            {
                                int i = (y * width + x) * 4;
                                if (IsWhite(mask.GetPixel(x, y)))
                                {
                                    pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0;
                                }
                                else
                                {
                                    pixels[i] = colorBits[i];
                                    pixels[i + 1] = colorBits[i + 1];
                                    pixels[i + 2] = colorBits[i + 2];
                                    pixels[i + 3] = 255;
                                }
                            }
                        }
                    }
                }

                if (!areColor)
                {
                    /* Mask-driven paths. AND=white marks pixels the XOR mask
                       decides; AND=black forces the background bit to 0. */
                    bool andAllWhite = true;
                    for (int y = 0; y < height && andAllWhite; y++)
                    {
                        for (int x = 0; x < width; x++)
                        {
                            if (!IsWhite(mask.GetPixel(x, y))) { andAllWhite = false; break; }
                        }
                    }

                    if (andAllWhite)
                    {
                        /* Inverted cursor: XOR white marks the pixels the
                           system inverts against the backdrop. Only stacked
                           mask bitmaps (2x height) can carry an XOR half. */
                        mode = "invert";
                        for (int y = 0; y < height; y++)
                        {
                            for (int x = 0; x < width; x++)
                            {
                                bool inverted = mask.Height > height
                                    && IsWhite(mask.GetPixel(x, y + height));
                                int i = (y * width + x) * 4;
                                if (inverted)
                                {
                                    pixels[i] = 255; pixels[i + 1] = 255; pixels[i + 2] = 255; pixels[i + 3] = 255;
                                }
                                else
                                {
                                    pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0;
                                }
                            }
                        }
                    }
                    else
                    {
                        /* Classic monochrome cursor: AND=0 is opaque, its value
                           comes from XOR (white) or stays black. */
                        int maskOffset = mask.Height > height ? height : 0;
                        for (int y = 0; y < height; y++)
                        {
                            for (int x = 0; x < width; x++)
                            {
                                int i = (y * width + x) * 4;
                                bool andWhite = IsWhite(mask.GetPixel(x, y));
                                bool xorWhite = mask.Height > height
                                    ? IsWhite(mask.GetPixel(x, y + maskOffset))
                                    : false;
                                byte value = xorWhite ? (byte)255 : (byte)0;
                                if (andWhite)
                                {
                                    pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 0;
                                }
                                else
                                {
                                    pixels[i] = value; pixels[i + 1] = value; pixels[i + 2] = value; pixels[i + 3] = 255;
                                }
                            }
                        }
                    }
                }

                string base64;
                using (Bitmap bmp = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                {
                    BitmapData data = bmp.LockBits(
                        new Rectangle(0, 0, width, height),
                        ImageLockMode.WriteOnly,
                        PixelFormat.Format32bppArgb
                    );
                    try
                    {
                        Marshal.Copy(pixels, 0, data.Scan0, pixels.Length);
                    }
                    finally
                    {
                        bmp.UnlockBits(data);
                    }
                    using (MemoryStream stream = new MemoryStream())
                    {
                        bmp.Save(stream, ImageFormat.Png);
                        base64 = Convert.ToBase64String(stream.ToArray());
                    }
                }

                return string.Format(
                    "{{\"id\":\"{0}\",\"mode\":\"{1}\",\"png\":\"{2}\",\"hotspotX\":{3},\"hotspotY\":{4},\"width\":{5},\"height\":{6}}}",
                    id, mode, base64, info.xHotspot, info.yHotspot, width, height
                );
            }
        }
        finally
        {
            if (info.hbmColor != IntPtr.Zero) DeleteObject(info.hbmColor);
            if (info.hbmMask != IntPtr.Zero) DeleteObject(info.hbmMask);
        }
    }
}
'@

$loaded = $false
for ($attempt = 1; $attempt -le 2 -and -not $loaded; $attempt++) {
    try {
        Add-Type -TypeDefinition $source `
            -ReferencedAssemblies System.Drawing `
            -Language CSharp -ErrorAction Stop | Out-Null
        $loaded = $true
    } catch {
        if ($attempt -eq 2) {
            Write-Output ('{"assets":[],"error":"' + (($_.Exception.Message -replace '\\', '/' -replace '"', "'" -replace "`r?`n", ' ')) + '"}')
            exit 1
        }
        Start-Sleep -Milliseconds 400
    }
}

# IDC_* constants for the styles the editor exposes as fixed choices.
$targets = @(
    @{ id = 'system.arrow';          name = 32512 },
    @{ id = 'system.ibeam';          name = 32513 },
    @{ id = 'system.crosshair';      name = 32515 },
    @{ id = 'system.not-allowed';    name = 32648 },
    @{ id = 'system.pointing-hand';  name = 32649 }
)

$items = @()
foreach ($target in $targets) {
    try {
        $fragment = [DogSCCursorExtractor]::Extract($target.id, $target.name)
        if ($fragment) { $items += $fragment }
    } catch { }
}

Write-Output ('{"assets":[' + ($items -join ',') + ']}')
