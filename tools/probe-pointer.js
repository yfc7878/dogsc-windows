// Standalone probe for the Windows low-level pointer observer.
// Run with: node tools/probe-pointer.js
const { spawn } = require("child_process");
const path = require("path");

const script = path.join(__dirname, "..", "resources", "pointer-observer.ps1");

const child = spawn(
  "powershell.exe",
  ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script],
  { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }
);

let buffer = "";
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  const lines = buffer.split(/\r?\n/);
  buffer = lines.pop();
  for (const line of lines) {
    if (line.trim()) console.log("[event]", line.trim());
  }
});

child.stderr.on("data", (chunk) => console.error("[stderr]", chunk.toString("utf8").trim()));

child.on("exit", (code) => console.log("[exit]", code));

setTimeout(() => {
  console.log("--- probe finished ---");
  child.kill();
  process.exit(0);
}, 8000);
