/**
 * Recording recovery journal.
 *
 * The macOS original writes `recovery/manifest.json` +
 * `recording-performance.jsonl` while a recording runs, so an interrupted
 * take can be picked up again on the next launch. The port records into a
 * temp working directory and only builds the `.dogscproject` package when the
 * take stops, so the journal lives in that working directory — same states,
 * same guarantee: enough metadata and media survive a crash to rebuild a
 * project instead of orphaning the footage.
 *
 * Manifest (`recovery/manifest.json`):
 *   {
 *     state: "preparing" | "recording" | "paused",
 *     sessionId, startedAt, updatedAt, appVersion,
 *     config: {...},                 // recorder configuration
 *     markers: [{ id, time }],
 *     pointer: { originMs, delta },  // journal time base
 *     media: { screen: "screen.mp4", camera: "camera.webm", ... },
 *     elapsed: 12.4                  // seconds of recorded media time
 *   }
 *
 * Pointer journal (`events/pointer.jsonl`, one JSON object per line) is
 * appended every couple of seconds while recording — exactly the role the
 * original's `events/pointer.jsonl` plays — and is what the final package
 * adopts as its durable cursor track.
 *
 * Kept free of Electron imports so it can be unit-tested.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const RECOVERY_DIR_NAME = "recovery";
const MANIFEST_NAME = "manifest.json";
const PERFORMANCE_NAME = "recording-performance.jsonl";

/** States a take passes through; anything else counts as recoverable. */
const TERMINAL_STATES = new Set(["complete", "cancelled", "failed"]);

function recoveryDir(workingDir) {
  return path.join(workingDir, RECOVERY_DIR_NAME);
}

/**
 * Publishes the manifest through a temp file + rename. Every write is
 * best-effort: a journaling failure must never take the recording down.
 */
async function writeManifest(workingDir, manifest) {
  try {
    const dir = recoveryDir(workingDir);
    await fsp.mkdir(dir, { recursive: true });
    const target = path.join(dir, MANIFEST_NAME);
    const tmp = `${target}.${Date.now()}.tmp`;
    const payload = JSON.stringify(
      { ...manifest, updatedAt: new Date().toISOString() },
      null,
      2
    );
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, target);
    return true;
  } catch (error) {
    console.warn("[recovery] manifest write failed:", error?.message || error);
    return false;
  }
}

async function readManifest(workingDir) {
  try {
    const raw = await fsp.readFile(path.join(recoveryDir(workingDir), MANIFEST_NAME), "utf8");
    const manifest = JSON.parse(raw);
    return manifest && typeof manifest === "object" ? manifest : null;
  } catch {
    return null;
  }
}

/** Appends one performance sample per line; failures are ignored. */
async function appendPerformance(workingDir, sample) {
  try {
    const dir = recoveryDir(workingDir);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(
      path.join(dir, PERFORMANCE_NAME),
      `${JSON.stringify(sample)}\n`,
      "utf8"
    );
  } catch {
    /* the journal is advisory — never fail a recording over it */
  }
}

/**
 * Appends pointer entries (already normalised and rebased to the media time
 * base) to the working directory's `events/pointer.jsonl`.
 */
async function appendPointerLines(workingDir, entries) {
  if (!Array.isArray(entries) || !entries.length) return;
  try {
    await fsp.mkdir(path.join(workingDir, "events"), { recursive: true });
    const payload = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    await fsp.appendFile(path.join(workingDir, "events", "pointer.jsonl"), payload, "utf8");
  } catch (error) {
    console.warn("[recovery] pointer journal append failed:", error?.message || error);
  }
}

/**
 * Reads a pointer journal back into the arrays the project document expects.
 * Sample lines are `{ t, x, y, cursor? }`; click lines carry `click: true`.
 */
async function readPointerLines(workingDir) {
  const samples = [];
  const clicks = [];
  let raw = "";
  try {
    raw = await fsp.readFile(path.join(workingDir, "events", "pointer.jsonl"), "utf8");
  } catch {
    return { samples, clicks };
  }
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || !Number.isFinite(entry.t)) continue;
    if (entry.click) {
      clicks.push({
        t: entry.t,
        x: entry.x ?? 0.5,
        y: entry.y ?? 0.5,
        button: entry.button ?? 0,
        delta: entry.delta || 0,
      });
    } else {
      samples.push({
        t: entry.t,
        x: entry.x ?? 0.5,
        y: entry.y ?? 0.5,
        ...(entry.cursor ? { cursor: entry.cursor } : {}),
      });
    }
  }
  return { samples, clicks };
}

/** Removes the journal once a take reaches a terminal state. */
async function clear(workingDir) {
  await fsp.rm(recoveryDir(workingDir), { recursive: true, force: true }).catch(() => {});
}

/**
 * Lists interrupted takes under `baseDir` (the port's `%TEMP%/dogsc`),
 * newest first. A session counts as recoverable when its manifest exists and
 * is not in a terminal state.
 */
async function listRecoverable(baseDir) {
  const out = [];
  let entries = [];
  try {
    entries = await fsp.readdir(baseDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith("session-")) continue;
    const workingDir = path.join(baseDir, entry.name);
    const manifest = await readManifest(workingDir);
    if (!manifest) continue;
    if (TERMINAL_STATES.has(manifest.state)) continue;
    out.push({ workingDir, manifest });
  }
  out.sort((a, b) => (b.manifest.startedAt || 0) - (a.manifest.startedAt || 0));
  return out;
}

module.exports = {
  writeManifest,
  readManifest,
  appendPerformance,
  appendPointerLines,
  readPointerLines,
  clear,
  listRecoverable,
};
