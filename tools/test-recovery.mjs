/**
 * Recording recovery journal unit test.
 *
 * `src/main/recovery.js` is pure Node, so the real module runs against a temp
 * directory: manifest round-trips, terminal-state filtering, performance
 * appends and pointer-journal save/read.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const recovery = await import(
  pathToFileURL(path.join(ROOT, "src/main/recovery.js")).toString()
);

const base = await fsp.mkdtemp(path.join(os.tmpdir(), "dogsc-recovery-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
};

/* ---- manifest round-trip ---- */
const sessionA = path.join(base, "session-1001");
await recovery.writeManifest(sessionA, {
  state: "recording",
  sessionId: "session-1001",
  startedAt: 1000,
  appVersion: "0.2.0",
  config: { kind: "display", fps: 60 },
  markers: [{ id: "marker-1", time: 3.5 }],
  pointer: { originMs: 900, delta: -0.4 },
  media: { "screen.mp4": true },
  elapsed: 12.4,
});
const manifestA = await recovery.readManifest(sessionA);
check("manifest round-trips", manifestA?.state === "recording" && manifestA?.elapsed === 12.4);
check("manifest gets updatedAt", typeof manifestA?.updatedAt === "string");

/* ---- terminal states are not recoverable ---- */
await recovery.writeManifest(sessionA, { ...manifestA, state: "complete" });
let list = await recovery.listRecoverable(base);
check("complete session not recoverable", list.length === 0);

/* ---- non-terminal states are recoverable, newest first ---- */
const sessionB = path.join(base, "session-1002");
const sessionC = path.join(base, "session-1003");
await recovery.writeManifest(sessionB, { state: "paused", startedAt: 2000 });
await recovery.writeManifest(sessionC, { state: "recording", startedAt: 3000 });
await fsp.mkdir(path.join(base, "not-a-session"), { recursive: true });
list = await recovery.listRecoverable(base);
check(
  "two recoverable sessions, newest first",
  list.length === 2 && list[0].workingDir.endsWith("session-1003") && list[1].workingDir.endsWith("session-1002"),
  list.map((entry) => path.basename(entry.workingDir)).join(",")
);

/* ---- performance appends ---- */
await recovery.appendPerformance(sessionC, { t: 1, bytes: 1024, dropped: 0 });
await recovery.appendPerformance(sessionC, { t: 2, bytes: 2048, dropped: 1 });
const performanceRaw = await fsp.readFile(
  path.join(sessionC, "recovery", "recording-performance.jsonl"),
  "utf8"
);
check("performance jsonl has two samples", performanceRaw.trim().split("\n").length === 2);

/* ---- pointer journal: append, read back, clicks vs samples ---- */
await recovery.appendPointerLines(sessionC, [
  { t: 0.1, x: 0.5, y: 0.25, cursor: "system.arrow" },
  { t: 0.2, x: 0.52, y: 0.26 },
  { t: 0.3, x: 0.6, y: 0.3, button: 0, delta: 0, click: true },
]);
const track = await recovery.readPointerLines(sessionC);
check("journal samples round-trip", track.samples.length === 2 && track.samples[0].cursor === "system.arrow");
check("journal clicks round-trip", track.clicks.length === 1 && track.clicks[0].t === 0.3);

/* ---- reading a directory without a journal is empty, not an error ---- */
const empty = await recovery.readPointerLines(sessionA);
check("missing journal reads empty", empty.samples.length === 0 && empty.clicks.length === 0);

/* ---- clear removes the journal ---- */
await recovery.clear(sessionC);
check("clear removes recovery dir", !fs.existsSync(path.join(sessionC, "recovery")));
const cleared = await recovery.readManifest(sessionC);
check("cleared manifest reads null", cleared === null);

await fsp.rm(base, { recursive: true, force: true });

console.log(failures === 0 ? "=== ALL PASS ===" : `=== ${failures} FAILED ===`);
process.exit(failures === 0 ? 0 : 1);
