/**
 * Project package I/O.
 *
 * A `.dogscproject` is a folder package, matching the macOS original:
 *
 *   MyCapture.dogscproject/
 *     project.json          authored document (schema v27 compatible)
 *     project.previous.json last known-good revision (two-stage commit)
 *     events/pointer.jsonl  pointer track (samples + clicks, one per line)
 *     media/                screen, camera, audio, background, stickers
 *
 * Media is always addressed project-relatively in project.json so a package
 * can be moved or copied between machines without rewriting paths.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const PACKAGE_EXTENSION = ".dogscproject";
const SCHEMA_VERSION = 27;

/* ------------------------------------------------------------------------- */
/* Naming                                                                    */
/* ------------------------------------------------------------------------- */

function sanitizeName(name) {
  const cleaned = String(name || "")
    .replace(/[\\/:*?"<>|\r\n\t]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "未命名项目";
}

/** Never overwrite: "Recording", "Recording 2", "Recording 3" … */
async function uniquePackagePath(parentDir, baseName) {
  const safe = sanitizeName(baseName);
  let candidate = path.join(parentDir, `${safe}${PACKAGE_EXTENSION}`);
  let index = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parentDir, `${safe} ${index}${PACKAGE_EXTENSION}`);
    index += 1;
  }
  return candidate;
}

/* ------------------------------------------------------------------------- */
/* Writing                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Extends a path past the legacy 260-character MAX_PATH limit with the
 * Windows extended-length prefix. A `.dogscproject` under a long user
 * directory (deep profile paths, long Chinese recording names) can cross the
 * limit; Node's fs accepts the prefix natively. Electron's shell.trashItem
 * does not, so discard stays unprefixed and keeps reporting failures.
 */
function withLongPath(value) {
  if (typeof value !== "string" || !path.isAbsolute(value) || value.startsWith("\\\\?\\")) {
    return value;
  }
  if (value.length < 248) return value;
  if (value.startsWith("\\\\")) return `\\\\?\\UNC\\${value.slice(2)}`;
  return `\\\\?\\${value}`;
}

/**
 * Writes `content` to `target` through a uniquely named temp file and an
 * atomic rename. The unique suffix keeps concurrent saves (autosave racing a
 * manual save) from colliding on one staging file.
 */
async function atomicWrite(target, content) {
  const tmp = withLongPath(`${target}.${randomUUID()}.tmp`);
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, withLongPath(target));
  return target;
}

/**
 * Publishes `project.json` with the original's two-stage commit
 * (`ProjectStore.commitStagedProject`):
 *
 *  1. the outgoing document — but only if it still parses — is atomically
 *     copied aside as `project.previous.json`, so a write that lands damaged
 *     (disk full, antivirus quarantine, process killed mid-rename) can never
 *     take the last known-good revision down with it;
 *  2. a document written by an older schema is additionally kept as
 *     `project-v<N>-before-migration.json`, matching the original's
 *     pre-migration backup;
 *  3. the new document is staged under a unique name and renamed into place.
 */
async function writeProjectJson(packagePath, document) {
  await fsp.mkdir(packagePath, { recursive: true });
  const target = path.join(packagePath, "project.json");
  const payload = { ...document, schemaVersion: SCHEMA_VERSION };

  /* Stage 1 — preserve the outgoing revision while it is still readable. A
     damaged file is not worth keeping: backing it up would only let a later
     fallback restore the damage. */
  let outgoing = null;
  try {
    outgoing = await fsp.readFile(target, "utf8");
  } catch {
    /* First write for this package — nothing to preserve. */
  }
  if (outgoing !== null) {
    let parsed = null;
    try {
      parsed = JSON.parse(outgoing);
    } catch {
      parsed = null;
    }
    if (parsed) {
      await atomicWrite(path.join(packagePath, "project.previous.json"), outgoing);
      const outgoingVersion = Number(parsed.schemaVersion);
      if (Number.isFinite(outgoingVersion) && outgoingVersion < SCHEMA_VERSION) {
        await atomicWrite(
          path.join(packagePath, `project-v${outgoingVersion}-before-migration.json`),
          outgoing
        );
      }
    }
  }

  /* Stage 2 — publish. */
  await atomicWrite(target, JSON.stringify(payload, null, 2));
  return target;
}

/**
 * Copies a recorded media file into the package and returns its relative path.
 * `role` names the file inside media/ (screen, camera, system, microphone).
 */
async function adoptMedia(packagePath, sourcePath, role) {
  const mediaDir = withLongPath(path.join(packagePath, "media"));
  await fsp.mkdir(mediaDir, { recursive: true });
  const ext = path.extname(sourcePath) || ".bin";
  const relative = path.join("media", `${role}${ext}`).split(path.sep).join("/");
  const destination = withLongPath(path.join(packagePath, relative));
  await fsp.copyFile(withLongPath(sourcePath), destination);
  return relative;
}

async function adoptMediaAs(packagePath, sourcePath, relativePath) {
  const destination = withLongPath(path.join(packagePath, relativePath));
  await fsp.mkdir(withLongPath(path.dirname(destination)), { recursive: true });
  await fsp.copyFile(withLongPath(sourcePath), destination);
  return relativePath.split(path.sep).join("/");
}

/* ------------------------------------------------------------------------- */
/* Reading                                                                   */
/* ------------------------------------------------------------------------- */

async function readProjectJson(packagePath) {
  const target = path.join(packagePath, "project.json");
  const raw = await fsp.readFile(target, "utf8");
  return JSON.parse(raw);
}

/**
 * Opens a project package, with the original's revision guarantees:
 *
 *  - a `project.json` from a *future* schema is refused outright — never
 *    silently downgraded and never recovered from `previous.json`, because
 *    overwriting unknown future fields is exactly how data gets lost
 *    (`ProjectValidator.unsupportedFutureVersion`);
 *  - a `project.json` that fails to parse falls back to the last known-good
 *    `project.previous.json`, flagged so the UI can tell the user.
 */
async function readProject(packagePath) {
  let document = null;
  let recoveredFromPreviousRevision = false;
  try {
    document = await readProjectJson(packagePath);
  } catch (error) {
    let previous = null;
    try {
      previous = JSON.parse(
        await fsp.readFile(path.join(packagePath, "project.previous.json"), "utf8")
      );
    } catch {
      previous = null;
    }
    if (!previous) throw error;
    document = previous;
    recoveredFromPreviousRevision = true;
  }

  const version = Number(document?.schemaVersion);
  if (Number.isFinite(version) && version > SCHEMA_VERSION) {
    const error = new Error(
      `project schema v${version} is newer than the supported v${SCHEMA_VERSION}`
    );
    error.code = "unsupportedFutureVersion";
    error.schemaVersion = version;
    throw error;
  }
  return { packagePath, document, recoveredFromPreviousRevision };
}

/** Resolves a project-relative media path to an absolute one. */
function resolveMedia(packagePath, relative) {
  const absolute = resolveInsidePackage(packagePath, relative);
  return absolute && fs.existsSync(absolute) ? absolute : null;
}

/**
 * Resolves a package-relative path the way the original's
 * `ProjectModel.resolve(relativePath:)` does: absolute paths and `..`
 * segments are refused, and the result must stay inside the package. This is
 * the guard that keeps a hostile `project.json` from pointing media at
 * arbitrary files on disk.
 */
function resolveInsidePackage(packagePath, relative) {
  if (typeof relative !== "string" || !relative.trim()) return null;
  if (path.isAbsolute(relative) || /^[a-zA-Z]:/.test(relative)) return null;
  const normalized = path.posix.normalize(relative.split(path.sep).join("/"));
  if (!normalized || normalized === "." || normalized.startsWith("..")) return null;
  const absolute = path.join(packagePath, normalized);
  const packageRoot = path.resolve(packagePath) + path.sep;
  if (!path.resolve(absolute).startsWith(packageRoot)) return null;
  return absolute;
}

const POINTER_JOURNAL_RELATIVE = "events/pointer.jsonl";

/**
 * Writes the pointer track as `events/pointer.jsonl` — the same durable
 * journal the original keeps, and the format crash recovery reads back.
 * Samples are `{t,x,y,cursor?}` lines; clicks are lines with `click: true`.
 */
async function writePointerJournal(packagePath, samples, clicks) {
  const lines = [];
  for (const sample of Array.isArray(samples) ? samples : []) {
    lines.push(
      JSON.stringify({
        t: q(sample.t, 4),
        x: q(sample.x, 5),
        y: q(sample.y, 5),
        ...(sample.cursor ? { cursor: sample.cursor } : {}),
      })
    );
  }
  for (const click of Array.isArray(clicks) ? clicks : []) {
    lines.push(
      JSON.stringify({
        t: q(click.t, 4),
        x: q(click.x, 5),
        y: q(click.y, 5),
        button: click.button ?? 0,
        delta: click.delta || 0,
        click: true,
      })
    );
  }
  const target = path.join(packagePath, "events", "pointer.jsonl");
  await fsp.mkdir(withLongPath(path.dirname(target)), { recursive: true });
  await atomicWrite(target, lines.length ? lines.join("\n") + "\n" : "");
  return POINTER_JOURNAL_RELATIVE;
}

/** Reads a package's pointer journal back into `{ samples, clicks }`. */
async function readPointerJournal(packagePath, relative = POINTER_JOURNAL_RELATIVE) {
  const target = resolveInsidePackage(packagePath, relative) ||
    path.join(packagePath, POINTER_JOURNAL_RELATIVE);
  const raw = await fsp.readFile(withLongPath(target), "utf8");
  const samples = [];
  const clicks = [];
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

/** Quantises a number for the journal; keeps the JSONL compact and stable. */
function q(value, digits) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Number(number.toFixed(digits));
}

/** Directory listing of openable projects, newest first. */
async function listProjects(directory) {
  const results = [];
  let entries = [];
  try {
    entries = await fsp.readdir(directory, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(PACKAGE_EXTENSION)) continue;
    const packagePath = path.join(directory, entry.name);
    const jsonPath = path.join(packagePath, "project.json");
    let stat;
    try {
      stat = await fsp.stat(jsonPath);
    } catch {
      continue;
    }
    let document = null;
    try {
      document = await readProjectJson(packagePath);
    } catch {
      /* a damaged package still shows up so the user can act on it */
    }
    results.push({
      packagePath,
      name: entry.name.slice(0, -PACKAGE_EXTENSION.length),
      modified: stat.mtimeMs,
      createdAt: document?.createdAt || null,
      duration: document?.timeline?.duration || null,
      hasCamera: Boolean(document?.media?.camera),
      schemaVersion: document?.schemaVersion ?? null,
    });
  }
  results.sort((a, b) => b.modified - a.modified);
  return results;
}

/* ------------------------------------------------------------------------- */
/* Moving to the Recycle Bin                                                 */
/* ------------------------------------------------------------------------- */

/**
 * The original sends projects to the macOS Trash. `shell.trashItem` is the
 * Windows equivalent and never permanently deletes user material.
 */
/**
 * Moves a project package to the Recycle Bin.
 *
 * The path is validated first, and a failure is reported rather than thrown:
 * `shell.trashItem` rejects on anything it cannot parse, which surfaced as an
 * unhandled rejection in the renderer with no explanation for the user. A
 * project is never deleted permanently — if the Recycle Bin is unavailable the
 * package simply stays where it is.
 *
 * @returns {Promise<{ok: boolean, reason?: string, message?: string}>}
 */
async function discardProject(shell, packagePath) {
  if (typeof packagePath !== "string" || !packagePath.trim()) {
    return { ok: false, reason: "invalid-path" };
  }
  const absolute = path.resolve(packagePath);
  if (!path.isAbsolute(absolute) || path.extname(absolute) !== PACKAGE_EXTENSION) {
    return { ok: false, reason: "invalid-path" };
  }
  if (!fs.existsSync(absolute)) {
    return { ok: false, reason: "missing" };
  }

  try {
    await shell.trashItem(absolute);
    return { ok: true };
  } catch (error) {
    /* The shell sometimes reports a failure for an operation that actually
       succeeded — "Operation was aborted" is raised after the package has
       already gone. Trusting the filesystem over the error keeps the user from
       being told a project is still there when it is in the Recycle Bin. */
    if (!fs.existsSync(absolute)) {
      return { ok: true, note: "shell-reported-failure-after-success" };
    }
    return {
      ok: false,
      reason: "trash-failed",
      message: error?.message ? String(error.message).slice(0, 200) : undefined,
    };
  }
}

module.exports = {
  PACKAGE_EXTENSION,
  SCHEMA_VERSION,
  sanitizeName,
  uniquePackagePath,
  writeProjectJson,
  adoptMedia,
  adoptMediaAs,
  readProjectJson,
  readProject,
  resolveMedia,
  resolveInsidePackage,
  withLongPath,
  writePointerJournal,
  readPointerJournal,
  listProjects,
  discardProject,
};
