# DogSC global pointer observer for Windows.
#
# The macOS build uses NSEvent global monitors to build the editable cursor
# track. The closest Windows equivalent is a WH_MOUSE_LL low-level hook, which
# is what this script installs. Events are written to stdout as one JSON
# object per line so the Electron main process can consume them as a stream.
#
# Output schema:
#   {"kind":"down","button":"left|right|middle","x":int,"y":int,"t":ms}
#   {"kind":"up",  "button":"left|right|middle","x":int,"y":int,"t":ms}
#   {"kind":"wheel","delta":int,"x":int,"y":int,"t":ms}
#   {"kind":"ready"}                      hook installed
#   {"kind":"error","message":"..."}      hook could not be installed

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
using System;
using System.Runtime.InteropServices;
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

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, LowLevelMouseProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private const int WH_MOUSE_LL = 14;
    private const int WM_LBUTTONDOWN = 0x0201;
    private const int WM_LBUTTONUP   = 0x0202;
    private const int WM_RBUTTONDOWN = 0x0204;
    private const int WM_RBUTTONUP   = 0x0205;
    private const int WM_MBUTTONDOWN = 0x0207;
    private const int WM_MBUTTONUP   = 0x0208;
    private const int WM_MOUSEWHEEL  = 0x020A;

    private IntPtr hookId = IntPtr.Zero;
    private LowLevelMouseProc proc;
    private readonly Action<string> emit;

    public DogSCPointerObserver(Action<string> emit) { this.emit = emit; }

    public bool Start()
    {
        proc = HookCallback;
        IntPtr module = GetModuleHandle(null);
        hookId = SetWindowsHookEx(WH_MOUSE_LL, proc, module, 0);
        return hookId != IntPtr.Zero;
    }

    private IntPtr HookCallback(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0)
        {
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
