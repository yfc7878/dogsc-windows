/**
 * Desktop icon visibility.
 *
 * The macOS build hides desktop files and the Dock from the recording via
 * Finder/NSWorkspace. Windows has no supported API for this, so the port uses
 * the long-standing Explorer technique: send the "toggle desktop icons"
 * command (0x7402) to the desktop's SysListView32 window.
 *
 * The current visibility is read first with IsWindowVisible so the command is
 * only ever sent when the desktop is actually in the wrong state — this makes
 * the operation idempotent instead of a blind toggle.
 */

const { spawn } = require("child_process");
const fs = require("fs");
const { childEnv } = require("./child-env");
const { resolveScript } = require("./paths");

const SCRIPT = resolveScript("desktop-icons.ps1");

function run(argument) {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCRIPT)) return resolve({ ok: false, reason: "missing-script" });
    let child;
    try {
      child = spawn(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, argument],
        { windowsHide: true, env: childEnv() }
      );
    } catch {
      return resolve({ ok: false, reason: "spawn-failed" });
    }
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      out += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.on("close", () => {
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
      try {
        resolve(JSON.parse(line));
      } catch {
        resolve({ ok: false, reason: "unparsable", raw: line });
      }
    });
    child.on("error", () => resolve({ ok: false, reason: "spawn-failed" }));
    setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    }, 6000);
  });
}

async function setDesktopIconsHidden(hidden) {
  return run(hidden ? "hide" : "show");
}

async function isDesktopIconsHidden() {
  return run("status");
}

module.exports = { setDesktopIconsHidden, isDesktopIconsHidden };
