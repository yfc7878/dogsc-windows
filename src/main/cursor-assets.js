/**
 * System cursor asset extraction.
 *
 * The renderer draws every built-in cursor style from the real Windows
 * artwork, the same way the macOS original draws from `NSCursor`. The actual
 * extraction lives in `resources/cursor-assets.ps1` (LoadCursor + mask
 * parsing); this module spawns it once per session and caches the result.
 *
 * Assets carry either `mode: "sprite"` (an ordinary ARGB PNG drawn with its
 * hotspot at the pointer position) or `mode: "invert"` (a white mask the
 * renderer blends with a difference operation — how Windows itself shows the
 * I-beam and crosshair over arbitrary content).
 */

const { spawn } = require("child_process");
const { resolveScript } = require("./paths");
const { childEnv } = require("./child-env");

let cached = null;
let pending = null;

function runExtractor() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          resolveScript("cursor-assets.ps1"),
        ],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: childEnv() }
      );
    } catch (error) {
      console.error("[cursor-assets] spawn failed", error);
      resolve({ assets: [] });
      return;
    }

    let buffer = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.length > 4 * 1024 * 1024) buffer = buffer.slice(-2 * 1024 * 1024);
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      const text = String(chunk).trim();
      if (text) console.error("[cursor-assets]", text.slice(0, 300));
    });
    child.on("error", (error) => {
      console.error("[cursor-assets] failed", error);
      resolve({ assets: [] });
    });
    child.on("close", () => {
      /* The script prints one JSON line; tolerate leading noise. */
      const line = buffer
        .split(/\r?\n/)
        .map((entry) => entry.trim())
        .filter((entry) => entry.startsWith("{"))
        .pop();
      if (!line) {
        resolve({ assets: [] });
        return;
      }
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        console.error("[cursor-assets] bad JSON", error.message);
        resolve({ assets: [] });
      }
    });

    /* Add-Type compilation can take a few seconds on a cold start. */
    setTimeout(() => {
      if (child && !child.killed) {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    }, 20000);
  });
}

/** Resolves the system cursor artwork, extracted once per session. */
function loadCursorAssets() {
  if (cached) return Promise.resolve(cached);
  if (!pending) {
    pending = runExtractor().then((payload) => {
      cached = payload;
      return payload;
    });
  }
  return pending;
}

module.exports = { loadCursorAssets };
