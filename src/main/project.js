/**
 * Project package I/O.
 *
 * A `.dogscproject` is a folder package, matching the macOS original:
 *
 *   MyCapture.dogscproject/
 *     project.json          authored document (schema v27 compatible)
 *     media/                screen, camera, audio, background, stickers
 *
 * Media is always addressed project-relatively in project.json so a package
 * can be moved or copied between machines without rewriting paths.
 */

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

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

async function writeProjectJson(packagePath, document) {
  await fsp.mkdir(packagePath, { recursive: true });
  const target = path.join(packagePath, "project.json");
  const tmp = `${target}.tmp`;
  const payload = { ...document, schemaVersion: SCHEMA_VERSION };
  await fsp.writeFile(tmp, JSON.stringify(payload, null, 2), "utf8");
  await fsp.rename(tmp, target);
  return target;
}

/**
 * Copies a recorded media file into the package and returns its relative path.
 * `role` names the file inside media/ (screen, camera, system, microphone).
 */
async function adoptMedia(packagePath, sourcePath, role) {
  const mediaDir = path.join(packagePath, "media");
  await fsp.mkdir(mediaDir, { recursive: true });
  const ext = path.extname(sourcePath) || ".bin";
  const relative = path.join("media", `${role}${ext}`).split(path.sep).join("/");
  const destination = path.join(packagePath, relative);
  await fsp.copyFile(sourcePath, destination);
  return relative;
}

async function adoptMediaAs(packagePath, sourcePath, relativePath) {
  const destination = path.join(packagePath, relativePath);
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(sourcePath, destination);
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

async function readProject(packagePath) {
  const document = await readProjectJson(packagePath);
  return { packagePath, document };
}

/** Resolves a project-relative media path to an absolute one. */
function resolveMedia(packagePath, relative) {
  if (!relative) return null;
  const absolute = path.join(packagePath, relative);
  return fs.existsSync(absolute) ? absolute : null;
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
  listProjects,
  discardProject,
};
