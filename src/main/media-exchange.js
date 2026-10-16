/**
 * Project media exchange.
 *
 * The port of `ProjectMediaExchange.swift` from the macOS original:
 *
 *   - `exportSources` copies the untouched screen / camera / microphone
 *     recordings of a project into a user-chosen folder — no timeline edits,
 *     scaling, colour conversion or audio mixing are applied.
 *   - `importCameraReplacement` swaps the project's camera track for a file
 *     conformed elsewhere. The original gates this on AVFoundation reporting
 *     a video track and a positive duration, then copies the file verbatim:
 *     the replacement declares its own time zero and neither needs an audio
 *     track nor the same physical duration as the screen recording. A shorter
 *     camera simply becomes unavailable at its own end.
 *
 * Chromium decodes a smaller set of codecs than QuickTime does, so a
 * replacement outside that set is transcoded to H.264/AAC first. The package
 * still receives exactly one camera file, placed the way the original places
 * it (`media/camera-replacement-<uuid>/camera.<ext>`).
 */

const crypto = require("crypto");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");

const exporter = require("./exporter");

/* Codecs and containers Chromium can play from a file source. Anything
   outside these is transcoded; the check is deliberately conservative so a
   replacement the editor could not decode never enters the package. */
const PLAYABLE_VIDEO = new Set(["h264", "vp8", "vp9", "av1"]);
const PLAYABLE_AUDIO = new Set(["aac", "mp3", "opus", "vorbis"]);
const PLAYABLE_CONTAINERS = new Set([".mp4", ".m4v", ".mov", ".webm"]);

/**
 * Structured failure, mirroring `ProjectMediaExchangeError`. The renderer
 * owns the localisation, so only the code and the facts travel over IPC.
 */
class MediaExchangeError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    this.detail = detail;
  }
}

/* ------------------------------------------------------------------------- */
/* Naming                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Matches the original's `sanitizedFilename` (`/` and `:` become `-`), with
 * the addition of the remaining Windows-reserved characters.
 */
function sanitizeProjectTitle(value) {
  const parts = String(value || "")
    .split(/[\\/:*?"<>|]/)
    .join("-")
    .trim();
  return parts || "未命名录制";
}

/** Never overwrite: "Title-源文件", "Title-源文件-2", "Title-源文件-3" … */
function uniqueExportFolder(parent, baseName) {
  let candidate = path.join(parent, baseName);
  let suffix = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(parent, `${baseName}-${suffix}`);
    suffix += 1;
  }
  return candidate;
}

/** 屏幕 / 摄像头 / 麦克风 — the three source files the original exports. */
const EXPORT_ROLES = [
  { role: "screen", label: "屏幕", fallbackExtension: "mov" },
  { role: "camera", label: "摄像头", fallbackExtension: "mov" },
  { role: "microphone", label: "麦克风", fallbackExtension: "m4a" },
];

function extensionFor(sourcePath, fallbackExtension) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!extension || extension === ".") return `.${fallbackExtension}`;
  return extension;
}

/* ------------------------------------------------------------------------- */
/* Camera replacement                                                        */
/* ------------------------------------------------------------------------- */

/**
 * The original's `inspectCameraReplacement`: the file must exist, hold a
 * video track and run longer than 0.01 s. Duration mismatches against the
 * screen recording are explicitly allowed.
 *
 * @returns {Promise<object>} the ffmpeg stream inventory of the candidate.
 * @throws {MediaExchangeError} `missing-file` / `no-video-track`.
 */
async function inspectCameraReplacement(cameraPath) {
  if (!cameraPath || !fs.existsSync(cameraPath)) {
    throw new MediaExchangeError("missing-file", { path: cameraPath || "" });
  }
  const probe = await exporter.probeMedia(cameraPath);
  if (
    !probe ||
    !probe.videoCodec ||
    !(Number.isFinite(probe.duration) && probe.duration > 0.01)
  ) {
    throw new MediaExchangeError("no-video-track", {
      name: path.basename(cameraPath),
    });
  }
  return probe;
}

function needsTranscode(sourcePath, probe) {
  const extension = path.extname(sourcePath).toLowerCase();
  if (!PLAYABLE_CONTAINERS.has(extension)) return true;
  if (!PLAYABLE_VIDEO.has(probe.videoCodec)) return true;
  if (probe.audioCodec && !PLAYABLE_AUDIO.has(probe.audioCodec)) return true;
  return false;
}

async function transcodeForPlayback(sourcePath, outputPath, probe) {
  const args = [
    "-y",
    "-i",
    sourcePath,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
  ];
  if (probe.audioCodec) {
    args.push("-c:a", "aac", "-b:a", "192k");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", outputPath);
  await exporter.runFfmpeg(args);
  return outputPath;
}

/**
 * Copies (or transcodes) `source` into
 * `<package>/media/camera-replacement-<uuid>/camera.<ext>` and returns the
 * document recipe for the new camera track. The folder is removed again when
 * anything fails, so a failed import never leaves debris in the package.
 *
 * @returns {Promise<{path: string, duration: number, size: number,
 *   width: number|null, height: number|null}>}
 */
async function importCameraReplacement({ packagePath, source }) {
  const probe = await inspectCameraReplacement(source);

  const folderName = `camera-replacement-${crypto.randomUUID().toLowerCase()}`;
  const folder = path.join(packagePath, "media", folderName);
  await fsp.mkdir(folder, { recursive: true });

  try {
    let fileName;
    let finalProbe = probe;
    if (needsTranscode(source, probe)) {
      fileName = "camera.mp4";
      await transcodeForPlayback(source, path.join(folder, fileName), probe);
      finalProbe = (await exporter.probeMedia(path.join(folder, fileName))) || probe;
    } else {
      fileName = `camera${extensionFor(source, "mov")}`;
      await fsp.copyFile(source, path.join(folder, fileName));
    }

    const destination = path.join(folder, fileName);
    const stat = await fsp.stat(destination);
    return {
      /* The replacement declares its own time zero: no `offset` is carried
         over, so the new camera starts with the project. */
      path: ["media", folderName, fileName].join("/"),
      duration: Number(finalProbe?.duration) || probe.duration || 0,
      size: stat.size,
      width: finalProbe?.width ?? probe.width ?? null,
      height: finalProbe?.height ?? probe.height ?? null,
    };
  } catch (error) {
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/* ------------------------------------------------------------------------- */
/* Source export                                                             */
/* ------------------------------------------------------------------------- */

/**
 * The original's `exportSources`: the recorded screen / camera / microphone
 * files are copied byte for byte into `<title>-源文件` under the chosen
 * folder. Any failure removes the freshly created folder again.
 *
 * @param {object} options
 * @param {string} options.packagePath  the open project package.
 * @param {string} options.title        the project title, used for the folder.
 * @param {string} options.parent       the user-chosen destination folder.
 * @param {Record<string, string|null|undefined>} options.references
 *   project-relative paths per role (screen / camera / microphone).
 * @returns {Promise<string>} the created folder.
 * @throws {MediaExchangeError} `missing-source`.
 */
async function exportSources({ packagePath, title, parent, references }) {
  const folder = uniqueExportFolder(parent, `${sanitizeProjectTitle(title)}-源文件`);
  await fsp.mkdir(folder, { recursive: true });

  try {
    for (const { role, label, fallbackExtension } of EXPORT_ROLES) {
      const relative = references?.[role];
      if (!relative) continue;
      const source = path.join(packagePath, relative);
      if (!fs.existsSync(source)) {
        throw new MediaExchangeError("missing-source", { role, label });
      }
      const extension = extensionFor(source, fallbackExtension);
      await fsp.copyFile(source, path.join(folder, `${label}${extension}`));
    }
    return folder;
  } catch (error) {
    await fsp.rm(folder, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  MediaExchangeError,
  sanitizeProjectTitle,
  uniqueExportFolder,
  inspectCameraReplacement,
  importCameraReplacement,
  exportSources,
};
