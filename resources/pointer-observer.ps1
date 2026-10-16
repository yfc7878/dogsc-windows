# DogSC global pointer observer for Windows.
#
# The macOS build uses NSEvent global monitors to build the editable cursor
# track and reads NSCursor.current to record which cursor *shape* was on
# screen. The closest Windows equivalent is a WH_MOUSE_LL low-level hook plus
# GetCursorInfo, which is what this script installs. Events are written to
# stdout as one JSON object per line so the Electron main process can consume
# them as a stream.
#
# Output schema:
#   {"kind":"down","button":"left|right|middle","x":int,"y":int,"t":ms}
#   {"kind":"up",  "button":"left|right|middle","x":int,"y":int,"t":ms}
#   {"kind":"wheel","delta":int,"x":int,"y":int,"t":ms}
#   {"kind":"shape","shape":"system.arrow|system.ibeam|system.crosshair|system.not-allowed|system.pointing-hand"}
#   {"kind":"ready"}                      hook installed
#   {"kind":"error","message":"..."}      hook could not be installed
#
# Shape events fire only when the shape changes. Unrecognised cursors (an
# application's own artwork, resize arrows) fall back to the arrow, matching
# the original's `recordedSystemAssetID` fallback in `cursorScene`.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

public sealed class DogSCPointerObserver : IDisposable
{
    public delegate IntPtr LowLevelMouseProc(int nCode, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int x; public int y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MSLLHOOKSTRUCT
    {
        public POINT pt;
        public uint mouseData;
        public uint flags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct CURSORINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hCursor;
        public POINT ptScreenPos;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr LoadCursor(IntPtr hInstance, IntPtr lpCursorName);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetCursorInfo(ref CURSORINFO pci);

    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP   = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP   = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP   = 0x0208;
    private const int WM_MOUSEWHEEL  = 0x020A;

    /* IDC_* resource identifiers for the shapes the editor renders. */
    private const int IDC_ARROW = 32512;
    private const int IDC_IBEAM = 32513;
    private const int IDC_CROSS = 32515;
    private const int IDC_NO = 32648;
    private const int IDC_HAND = 32649;

    private IntPtr hookId = IntPtr.Zero;
    private LowLevelMouseProc proc;
    private readonly Action<string> emit;

    private IntPtr shapeArrow, shapeIBeam, shapeCross, shapeNotAllowed, shapeHand;
    private readonly Dictionary<IntPtr, string> shapeCache = new Dictionary<IntPtr, string>();
    private IntPtr lastCursorHandle = IntPtr.Zero;
    private string lastShape = null;

    public DogSCPointerObserver(Action<string> emit) { this.emit = emit; }

    public bool Start()
    {
        proc = HookCallback;
        IntPtr module = GetModuleHandle(null);
        hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, module, 0);
        if (hookId == IntPtr.Zero) return false;
        shapeArrow = LoadCursor(IntPtr.Zero, new IntPtr(IDC_ARROW));
        shapeIBeam = LoadCursor(IntPtr.Zero, new IntPtr(IDC_IBEAM));
        shapeCross = LoadCursor(IntPtr.Zero, new IntPtr(IDC_CROSS));
        shapeNotAllowed = LoadCursor(IntPtr.Zero, new IntPtr(IDC_NO));
        shapeHand = LoadCursor(IntPtr.Zero, new IntPtr(IDC_HAND));
        /* Announce the shape that is already on screen so the first recorded
           samples carry it without waiting for a mouse move. */
        try { ReportShape(false); } catch { }
        ListenForRequests();
        return true;
    }

    /// <summary>
    /// The main process writes "shape" whenever a capture starts, because the
    /// observer only reports changes: a second recording that begins with the
    /// same cursor would otherwise stay silent until the shape changes.
    /// </summary>
    private void ListenForRequests()
    {
        Thread worker = new Thread(() =>
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Trim() == "shape")
                    {
                        try { ReportShape(true); } catch { }
                    }
                }
            }
            catch { }
        });
        worker.IsBackground = true;
        worker.Start();
    }

    private string IdentifyShape(IntPtr handle)
    {
        if (handle == shapeArrow) return "system.arrow";
        if (handle == shapeIBeam) return "system.ibeam";
        if (handle == shapeCross) return "system.crosshair";
        if (handle == shapeNotAllowed) return "system.not-allowed";
        if (handle == shapeHand) return "system.pointing-hand";
        /* Unrecognised artwork (custom cursors, resize arrows): fall back to
           the arrow the way the original falls back to `.systemArrow`. */
        return "system.arrow";
    }

    private void ReportShape(bool force)
    {
        CURSORINFO info = new CURSORINFO();
        info.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
        if (!GetCursorInfo(ref info) || info.hCursor == IntPtr.Zero) return;
        IntPtr handle = info.hCursor;
        if (handle == lastCursorHandle && !force) return;
        lastCursorHandle = handle;

        string shape;
        if (!shapeCache.TryGetValue(handle, out shape))
        {
            if (shapeCache.Count > 512) shapeCache.Clear();
            shape = IdentifyShape(handle);
            shapeCache[handle] = shape;
        }
        if (shape != null && (force || shape != lastShape))
        {
            lastShape = shape;
            EmitShape(shape);
        }
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
            /* Cheap handle comparison on every event; the shape itself is
               resolved once per distinct cursor object. */
            try { ReportShape(false); } catch { }

            int message = wParam.ToInt32();
            MSLLHOOKSTRUCT data = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
            long tick = data.time;
            int x = data.pt.x;
            int y = data.pt.y;

            if (message == WM_LBUTTONDOWN) Emit("down", "left", x, y, tick, 0);
            else if (message == WM_LBUTTONUP) Emit("up", "left", x, y, tick, 0);
            else if (message == WM_RBUTTONDOWN) Emit("down", "right", x, y, tick, 0);
            else if (message == WM_RBUTTONUP) Emit("up", "right", x, y, tick, 0);
            else if (message == WM_MBUTTONDOWN) Emit("down", "middle", x, y, tick, 0);
            else if (message == WM_MBUTTONUP) Emit("up", "middle", x, y, tick, 0);
            else if (message == WM_MOUSEWHEEL)
            {
                int delta = (short)((data.mouseData >> 16) & 0xFFFF);
                Emit("wheel", "", x, y, tick, delta);
            }
        }
        return CallNextHookEx(hookId, nCode, wParam, lParam);
    }

    private void Emit(string kind, string button, int x, int y, long tick, int delta)
    {
        try
        {
            emit(string.Format(
                "{{\"kind\":\"{0}\",\"button\":\"{1}\",\"x\":{2},\"y\":{3},\"t\":{4},\"delta\":{5}}}",
                kind, button, x, y, tick, delta));
        }
        catch { }
    }

    private void EmitShape(string shape)
    {
        try
        {
            emit("{\"kind\":\"shape\",\"shape\":\"" + shape + "\"}");
        }
        catch { }
    }

    public void Dispose()
    {
        if (hookId != IntPtr.Zero)
        {
            UnhookWindowsHookEx(hookId);
            hookId = IntPtr.Zero;
        }
    }
}
'@

$writer = New-Object System.IO.StreamWriter([Console]::OpenStandardOutput())
$writer.AutoFlush = $true

function Write-EventLine {
    param([string]$Line)
    $writer.WriteLine($Line)
}

function Format-Reason {
    param($ErrorRecord)
    return ($ErrorRecord.Exception.Message -replace '\\', '/' -replace '"', "'" -replace "`r?`n", ' ')
}

# Compiling the hook type takes a moment on a cold start and the very first
# run on a machine can race with PowerShell's own initialisation, so it is
# retried once. A genuine failure is reported rather than swallowed, which
# lets the app log why pointer clicks will be missing from the recording.
$loaded = $false
for ($attempt = 1; $attempt -le 2 -and -not $loaded; $attempt++) {
    try {
        Add-Type -TypeDefinition $source `
            -ReferencedAssemblies System.Windows.Forms, System.Drawing `
            -Language CSharp -ErrorAction Stop | Out-Null
        $loaded = $true
    } catch {
        if ($attempt -eq 2) {
            Write-EventLine ('{"kind":"error","message":"Add-Type failed: ' + (Format-Reason $_) + '"}')
            exit 1
        }
        Start-Sleep -Milliseconds 500
    }
}

try {
    $observer = New-Object DogSCPointerObserver([Action[string]]{ param($line) $writer.WriteLine($line) })
} catch {
    Write-EventLine ('{"kind":"error","message":"observer construction failed: ' + (Format-Reason $_) + '"}')
    exit 1
}

if (-not $observer.Start()) {
    Write-EventLine '{"kind":"error","message":"SetWindowsHookEx failed"}'
    exit 1
}

Write-EventLine '{"kind":"ready"}'

# A message pump is required for WH_MOUSE_LL callbacks to be delivered.
# Run() without a form keeps the observer completely windowless, so it never
# appears in a recording the way a hidden form could.
[System.Windows.Forms.Application]::Run()
$observer.Dispose()
