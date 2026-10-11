/**
 * Locates files that must exist on the real filesystem.
 *
 * Anything spawned as a separate process — the pointer observer and the
 * desktop-icon helper — cannot live inside `app.asar`: PowerShell's `-File`
 * argument needs a genuine path, and a process cannot be started from inside
 * the archive. Electron's `fs` shim reports asar entries as existing, so the
 * packaged copy has to be checked first and the asar copy only used as a
 * development fallback.
 *
 * (HTML, CSS, fonts and modules are fine inside the asar because they are
 * served through `app://` and `net.fetch`, which are asar-aware.)
 */

const fs = require("fs");
const path = require("path");

/** Where `extraResources` lands in a packaged build. */
function packagedRoot() {
  return process.resourcesPath ? path.join(process.resourcesPath, "scripts") : null;
}

/** Where the sources live in a checkout. */
function developmentRoot() {
  return path.join(__dirname, "..", "..", "resources");
}

/**
 * Resolves a helper script, preferring the packaged copy.
 * @param {string} name file name inside `resources/`
 * @returns {string} an absolute path, or "" when neither copy exists
 */
function resolveScript(name) {
  const candidates = [];
  const packaged = packagedRoot();
  if (packaged) candidates.push(path.join(packaged, name));
  candidates.push(path.join(developmentRoot(), name));

  for (const candidate of candidates) {
    /* An asar path is only usable when nothing else is available. */
    if (candidate.includes("app.asar")) continue;
    if (fs.existsSync(candidate)) return candidate;
  }
  return "";
}

/** The directory the recorder writes temporary media into. */
function tempRoot(app) {
  return path.join(app.getPath("temp"), "dogsc");
}

module.exports = { resolveScript, packagedRoot, developmentRoot, tempRoot };
