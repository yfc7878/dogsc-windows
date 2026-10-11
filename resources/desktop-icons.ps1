# Toggles desktop icon visibility for the DogSC recorder.
#
# Usage: desktop-icons.ps1 hide | show | status
# Prints a single JSON line: {"ok":true,"hidden":true|false}
#
# Windows exposes no supported API for this, so the script sends Explorer's
# own "toggle desktop icons" command (WM_COMMAND 0x7402) to the desktop list
# view. Visibility is checked first so the command is only sent when the
# desktop is actually in the wrong state.

param(
    [Parameter(Position = 0)]
    [ValidateSet('hide', 'show', 'status')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$source = @'
using System;
using System.Runtime.InteropServices;

public static class DogSCDesktopIcons
{
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    private static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    private const uint WM_COMMAND = 0x0111;
    private const int TOGGLE_DESKTOP_ICONS = 0x7402;

    private static IntPtr DesktopListView()
    {
        IntPtr progman = FindWindow("Progman", null);
        IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (defView == IntPtr.Zero)
        {
            // With "show desktop icons" driven by a WorkerW host, the view can
            // live under a sibling WorkerW instead of Progman.
            IntPtr worker = IntPtr.Zero;
            do
            {
                worker = FindWindowEx(IntPtr.Zero, worker, "WorkerW", null);
                if (worker == IntPtr.Zero) break;
                defView = FindWindowEx(worker, IntPtr.Zero, "SHELLDLL_DefView", null);
            } while (defView == IntPtr.Zero && worker != IntPtr.Zero);
        }
        if (defView == IntPtr.Zero) return IntPtr.Zero;
        return FindWindowEx(defView, IntPtr.Zero, "SysListView32", "FolderView");
    }

    public static bool IsHidden()
    {
        IntPtr view = DesktopListView();
        if (view == IntPtr.Zero) return false;
        return !IsWindowVisible(view);
    }

    public static bool Toggle()
    {
        IntPtr view = DesktopListView();
        if (view == IntPtr.Zero) return false;
        SendMessage(view, WM_COMMAND, (IntPtr)TOGGLE_DESKTOP_ICONS, IntPtr.Zero);
        return true;
    }
}
'@

try {
    Add-Type -TypeDefinition $source -Language CSharp | Out-Null
} catch {
    # Type already loaded in this session.
}

try {
    $hidden = [DogSCDesktopIcons]::IsHidden()
    switch ($Action) {
        'hide' {
            if (-not $hidden) { [void][DogSCDesktopIcons]::Toggle(); $hidden = $true }
        }
        'show' {
            if ($hidden) { [void][DogSCDesktopIcons]::Toggle(); $hidden = $false }
        }
    }
    Write-Output ('{"ok":true,"hidden":' + $hidden.ToString().ToLower() + '}')
} catch {
    Write-Output '{"ok":false,"reason":"failed"}'
}
