/**
 * Export pipeline.
 *
 * The macOS original renders every frame through the same Core Image pipeline
 * used by the preview and hands the result to AVAssetWriter. The Windows port
 * keeps that architecture: the renderer composites frames and encodes them
 * with WebCodecs, the main process muxes the bitstream with an ffmpeg-built
 * audio mix.
 *
 * Three ffmpeg passes keep every step independently recoverable:
 *   1. audio  — trim + concat + mix the recorded tracks into a WAV
 *   2. video  — wrap (or transcode) the encoded bitstream into a silent MP4
 *   3. mux    — combine the two without re-encoding the picture
 */

const { spawn } = require("child_process");
const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { childEnv } = require("./child-env");

let cachedFfmpegPath = null;

/**
 * Resolves the bundled ffmpeg binary.
 *
 * The `extraResources` copy is checked first on purpose. In a packaged build
 * `require("ffmpeg-static")` also resolves — Electron's asar layer reports the
 * file as existing — but it points *inside* `app.asar`, and a process cannot
 * be spawned from inside the archive. That produced a bare ENOENT on export
 * that only appeared after packaging.
 */
function ffmpegPath() {
  if (cachedFfmpegPath) return cachedFfmpegPath;

  const candidates = [];
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, "ffmpeg", "ffmpeg.exe"));
    candidates.push(path.join(process.resourcesPath, "ffmpeg", "ffmpeg"));
  }
  try {
    candidates.push(require("ffmpeg-static"));
  } catch {
    /* not installed; the extraResources copy is used instead */
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "string") continue;
    /* Anything inside an asar archive is unspawnable. */
    if (candidate.includes("app.asar")) continue;
    if (fs.existsSync(candidate)) {
      cachedFfmpegPath = candidate;
      return candidate;
    }
  }

  cachedFfmpegPath = "ffmpeg";
  return cachedFfmpegPath;
}

/* ------------------------------------------------------------------------- */
/* Process helper                                                            */
/* ------------------------------------------------------------------------- */

function runFfmpeg(args, { onStderr, onProgress, duration, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { windowsHide: true, env: childEnv() });
    let stderr = "";
    let killed = false;

    const abort = () => {
      killed = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    };
    signal?.addEventListener("abort", abort, { once: true });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64000) stderr = stderr.slice(-32000);
      onStderr?.(chunk);
      if (onProgress && duration) {
        const match = /time=(\d+):(\d+):(\d+\.\d+)/.exec(chunk);
        if (match) {
          const seconds =
            Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
          onProgress(Math.min(1, seconds / duration));
        }
      }
    });

    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      if (killed) {
        reject(new Error("cancelled"));
      } else if (code === 0) {
        resolve({ stderr });
      } else {
        reject(new Error(`ffmpeg exited with ${code}\n${stderr.slice(-2000)}`));
      }
    });
  });
}

/* ------------------------------------------------------------------------- */
/* Audio                                                                     */
/* ------------------------------------------------------------------------- */

function escapeFilterPath(value) {
  return String(value).replace(/\\/g, "/").replace(/:/g, "\\:").replace(/'/g, "\\'");
}

/**
 * Builds the `-filter_complex` graph that reproduces the edited audio:
 * every kept primary clip becomes one `atrim` of the recorded track, the
 * trims are concatenated, then system audio and microphone are mixed with
 * their project volumes.
 */
function buildAudioGraph(document, tracks) {
  const clips = (document.timeline?.primaryClips || []).slice();
  clips.sort((a, b) => a.startTime - b.startTime);
  if (!clips.length) return null;

  const inputs = [];
  const chains = [];
  const labels = [];

  const sources = [
    {
      key: "system",
      file: tracks.system,
      volume: document.audio?.systemVolume ?? 0.82,
      muted: document.audio?.isSystemMuted,
      offset: document.media?.system?.offset || 0,
    },
    {
      key: "microphone",
      file: tracks.microphone,
      volume: document.audio?.microphoneVolume ?? 0.9,
      muted: document.audio?.isMicrophoneMuted,
      offset: document.media?.microphone?.offset || 0,
    },
  ].filter((source) => source.file && !source.muted);

  let inputIndex = 0;
  for (const source of sources) {
    inputs.push(source.file);
    const index = inputIndex++;
    /* 轨相对画面原点的偏移：晚启动的轨道补静音，早启动的裁掉头部，
       之后各段 atrim 才能按屏幕时间线取素材。 */
    const offset = Number(source.offset) || 0;
    const align =
      offset >= 0.001
        ? [`adelay=${Math.round(offset * 1000)}:all=1`]
        : offset <= -0.001
          ? [`atrim=start=${(-offset).toFixed(6)}`, "asetpts=PTS-STARTPTS"]
          : [];
    const parts = [];
    const segLabels = [];
    clips.forEach((clip, clipIndex) => {
      const start = (clip.sourceStart || 0) * (clip.speed || 1);
      const length = (clip.sourceDuration || 0) * (clip.speed || 1);
      const label = `a${index}_${clipIndex}`;
      // Each trimmed span restarts its own PTS so concat sees clean segments.
      parts.push(
        `[${index}:a]${align.length ? align.join(",") + "," : ""}` +
          `atrim=start=${start.toFixed(4)}:end=${(start + length).toFixed(4)},` +
          `asetpts=PTS-STARTPTS[${label}]`
      );
      segLabels.push(`[${label}]`);
    });
    if (!segLabels.length) continue;
    const joined = `aj${index}`;
    parts.push(`${segLabels.join("")}concat=n=${segLabels.length}:v=0:a=1[${joined}]`);
    const volume = Math.max(0, Math.min(1, source.volume));
    const final = `av${index}`;
    parts.push(`[${joined}]volume=${volume.toFixed(3)}[${final}]`);
    chains.push(...parts);
    labels.push(`[${final}]`);
  }

  if (!labels.length) return null;
  if (labels.length === 1) {
    chains.push(`${labels[0]}anull[aout]`);
  } else {
    chains.push(`${labels.join("")}amix=inputs=${labels.length}:duration=longest:normalize=0[aout]`);
  }

  return { inputs, graph: chains.join(";") };
}

async function renderAudio(document, tracks, outputWav, { signal } = {}) {
  const plan = buildAudioGraph(document, tracks);
  if (!plan) return null;
  const args = [];
  for (const input of plan.inputs) args.push("-i", input);
  args.push(
    "-filter_complex",
    plan.graph,
    "-map",
    "[aout]",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-c:a",
    "pcm_s16le",
    "-y",
    outputWav
  );
  await runFfmpeg(args, { signal });
  return outputWav;
}

/* ------------------------------------------------------------------------- */
/* Video                                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Chromium's H.264 encoder produces BT.709 video, but a raw Annex B stream
 * carries no colour description and `-c:v copy` keeps it that way — players
 * then guess (often BT.601) and the picture comes out shifted. Tag the
 * bitstream explicitly, the same way the original's export pipeline does.
 */
const H264_COLOR_TAGS = [
  "-bsf:v",
  "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0",
];

/* 转码目标（HEVC / ProRes）的色彩标记：输出选项形式的 BT.709，任何编码器
   都接受，不依赖 h264_metadata 这类按码流类型走的 bitstream filter。 */
const COLOR_OUTPUT_TAGS = [
  "-color_primaries", "bt709",
  "-color_trc", "bt709",
  "-colorspace", "bt709",
];

/* The original auto-switches past 4096 px to HEVC; the port offers it as a
   choice and defaults the suggestion, so the flag only shapes the UI. */
const HEVC_ENCODER_HINTS = ["libx265", "hevc_nvenc", "hevc_mf", "hevc_amf", "hevc_qsv"];

let encoderCapabilities = null;

/**
 * Probes which extra export encoders this ffmpeg build actually ships, once.
 * ffmpeg-static's Windows binary carries libx265 and prores_ks in the usual
 * builds, but the port refuses to promise a menu entry the binary cannot
 * back — the option is hidden when the encoder is missing.
 *
 * `ffmpeg -encoders` prints its list on **stdout** (runFfmpeg only surfaces
 * stderr), so this spawns ffmpeg directly and collects stdout.
 */
function detectEncoders() {
  if (encoderCapabilities) return Promise.resolve(encoderCapabilities);
  return new Promise((resolve) => {
    const caps = { hevc: false, hevcHardware: null, prores: false };
    const child = spawn(ffmpegPath(), ["-hide_banner", "-encoders"], {
      windowsHide: true,
      env: childEnv(),
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    const finish = () => {
      for (const line of stdout.split(/\r?\n/)) {
        /* Lines look like " V....D libx265  libx265 H.265 / HEVC …" — first
           token is the flag column, second is the encoder name. */
        const match = /^\s*\S+\s+(\S+)/.exec(line);
        if (!match) continue;
        const name = match[1];
        if (name === "prores_ks") caps.prores = true;
        if (HEVC_ENCODER_HINTS.includes(name)) {
          caps.hevc = true;
          if (name !== "libx265" && !caps.hevcHardware) caps.hevcHardware = name;
        }
      }
      encoderCapabilities = caps;
      resolve(caps);
    };
    child.on("close", finish);
    child.on("error", () => {
      encoderCapabilities = caps;
      resolve(caps);
    });
  });
}

/**
 * Wraps a WebCodecs bitstream into a silent video file.
 * H.264 (Annex B) is copied straight through; VP9 / AV1 are transcoded.
 * `target` asks for a final codec: "h264" (default) keeps the bitstream's
 * codec, "hevc" copies an HEVC bitstream or transcodes H.264 via libx265,
 * and "prores" always transcodes into Apple ProRes 422 (.mov) — the same
 * intermediate-codec role the original's export pipeline gives it.
 */
async function wrapVideo({ codec, bitstreamPath, outputPath, fps, duration, signal, onProgress, target = "h264" }) {
  const normalized = String(codec || "").toLowerCase();
  const isH264 = normalized.startsWith("avc") || normalized === "h264";
  const isHevc = normalized.startsWith("hev") || normalized === "h265";
  const isVp9 = normalized.startsWith("vp09") || normalized === "vp9";
  const isAv1 = normalized.startsWith("av01") || normalized === "av1";

  const args = [];
  if (isH264) {
    args.push("-f", "h264", "-r", String(fps), "-i", bitstreamPath);
  } else if (isHevc) {
    args.push("-f", "hevc", "-r", String(fps), "-i", bitstreamPath);
  } else if (isVp9) {
    args.push("-f", "ivf", "-i", bitstreamPath);
  } else if (isAv1) {
    args.push("-f", "obu", "-i", bitstreamPath);
  } else {
    throw new Error(`unsupported codec ${codec}`);
  }

  if (target === "prores") {
    /* ProRes 422 (standard profile) in a .mov — the interchange codec the
       original offers, at the cost of one extra generation from the
       high-bitrate WebCodecs intermediate. */
    args.push(
      "-c:v", "prores_ks",
      "-profile:v", "3",
      "-vendor", "apl0",
      "-pix_fmt", "yuv422p10le",
      ...COLOR_OUTPUT_TAGS
    );
  } else if (target === "hevc" && isHevc) {
    /* A hardware HEVC bitstream needs no re-encode, only a proper tag so
       QuickTime-based players pick it up. */
    args.push("-c:v", "copy", "-tag:v", "hvc1", ...COLOR_OUTPUT_TAGS);
  } else if (target === "hevc") {
    args.push(
      "-c:v", "libx265",
      "-preset", "medium",
      "-crf", "20",
      "-pix_fmt", "yuv420p",
      ...COLOR_OUTPUT_TAGS,
      "-tag:v", "hvc1"
    );
  } else if (isH264) {
    args.push("-c:v", "copy");
  } else {
    args.push(
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "18",
      "-pix_fmt",
      "yuv420p"
    );
  }
  if (target === "h264" && isH264) {
    args.push(...H264_COLOR_TAGS);
  }
  args.push("-movflags", "+faststart", "-an", "-y", outputPath);

  await runFfmpeg(args, { signal, duration, onProgress });
  return outputPath;
}

/* ------------------------------------------------------------------------- */
/* Mux                                                                       */
/* ------------------------------------------------------------------------- */

async function mux({ videoPath, audioPath, outputPath, duration, signal }) {
  const args = ["-i", videoPath];
  if (audioPath && fs.existsSync(audioPath)) {
    args.push("-i", audioPath);
  }
  args.push("-c:v", "copy");
  if (audioPath && fs.existsSync(audioPath)) {
    args.push("-c:a", "aac", "-b:a", "192k", "-shortest");
  } else {
    args.push("-an");
  }
  args.push("-movflags", "+faststart", "-y", outputPath);
  await runFfmpeg(args, { signal, duration });
  return outputPath;
}

/* ------------------------------------------------------------------------- */
/* Image-sequence fallback                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Used when WebCodecs cannot provide an encoder. Frames arrive as JPEG data
 * URLs from the renderer and are turned into a video by ffmpeg. `target`
 * picks the final codec — H.264 (default), HEVC via libx265, or ProRes 422
 * in a .mov, matching wrapVideo's targets.
 */
async function encodeImageSequence({ framesDir, pattern, fps, outputPath, signal, duration, onProgress, target = "h264" }) {
  const codecArgs =
    target === "prores"
      ? ["-c:v", "prores_ks", "-profile:v", "3", "-vendor", "apl0", "-pix_fmt", "yuv422p10le", ...COLOR_OUTPUT_TAGS]
      : target === "hevc"
        ? ["-c:v", "libx265", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", ...COLOR_OUTPUT_TAGS, "-tag:v", "hvc1"]
        : ["-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", ...H264_COLOR_TAGS];
  const args = [
    "-framerate",
    String(fps),
    "-i",
    path.join(framesDir, pattern),
    ...codecArgs,
    "-movflags",
    "+faststart",
    "-y",
    outputPath,
  ];
  await runFfmpeg(args, { signal, duration, onProgress });
  return outputPath;
}

/* ------------------------------------------------------------------------- */
/* Audio-only export                                                         */
/* ------------------------------------------------------------------------- */

async function exportAudioOnly({ document, tracks, outputPath, format, signal }) {
  const plan = buildAudioGraph(document, tracks);
  if (!plan) throw new Error("no-audio");
  const args = [];
  for (const input of plan.inputs) args.push("-i", input);
  const isM4a = String(format || "m4a").toLowerCase() === "m4a";
  args.push(
    "-filter_complex",
    plan.graph,
    "-map",
    "[aout]",
    "-ac",
    "2",
    "-ar",
    "48000"
  );
  if (isM4a) args.push("-c:a", "aac", "-b:a", "192k");
  else args.push("-c:a", "libmp3lame", "-b:a", "192k");
  args.push("-y", outputPath);
  await runFfmpeg(args, { signal });
  return outputPath;
}

/* ------------------------------------------------------------------------- */
/* Recorded media                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Rewrites a MediaRecorder WebM so it carries a real duration.
 *
 * MediaRecorder streams frames without ever seeking back to patch the segment
 * header, so the file plays everywhere but reports an unknown length. Remuxing
 * with `-c copy` costs almost nothing and makes the recorded material
 * well-formed for the editor and for any other tool the user opens it with.
 * Failure is non-fatal: the original file is kept.
 */
async function finalizeRecording(filePath) {
  if (!/\.webm$/i.test(filePath) || !fs.existsSync(filePath)) return filePath;
  const temporary = `${filePath}.remux.webm`;
  try {
    await runFfmpeg(["-i", filePath, "-c", "copy", "-y", temporary]);
    const stat = await fsp.stat(temporary);
    if (stat.size > 1024) {
      await fsp.rm(filePath, { force: true });
      await fsp.rename(temporary, filePath);
    } else {
      await fsp.rm(temporary, { force: true });
    }
  } catch (error) {
    console.warn("[exporter] could not finalise recording", error.message);
    await fsp.rm(temporary, { force: true }).catch(() => {});
  }
  return filePath;
}

/* ------------------------------------------------------------------------- */
/* Thumbnails                                                                */
/* ------------------------------------------------------------------------- */

async function grabThumbnail({ videoPath, time, outputPath }) {
  await runFfmpeg([
    "-ss",
    String(Math.max(0, time || 0)),
    "-i",
    videoPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=320:-2",
    "-y",
    outputPath,
  ]);
  return outputPath;
}

async function probeDuration(filePath) {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ["-i", filePath, "-hide_banner"], {
      windowsHide: true,
      env: childEnv(),
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", () => {
      const match = /Duration: (\d+):(\d+):(\d+\.\d+)/.exec(stderr);
      if (!match) return resolve(0);
      resolve(Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]));
    });
    child.on("error", () => resolve(0));
  });
}

/**
 * Stream inventory for an external media file, parsed from `ffmpeg -i`.
 *
 * The macOS original gates camera replacement on AVFoundation reporting at
 * least one video track and a positive duration. ffmpeg's banner carries the
 * same facts, and using the ffmpeg that the export pipeline already requires
 * keeps the check on the same decoder that will read the file afterwards.
 *
 * @returns {Promise<{duration: number|null, videoCodec: string|null,
 *   audioCodec: string|null, width: number|null, height: number|null}|null>}
 *   `null` when ffmpeg cannot be spawned at all.
 */
async function probeMedia(filePath) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath(), ["-i", filePath, "-hide_banner"], {
        windowsHide: true,
        env: childEnv(),
      });
    } catch {
      resolve(null);
      return;
    }
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (stderr.length > 64000) stderr = stderr.slice(-32000);
    });
    child.on("close", () => {
      const durationMatch = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
      const duration = durationMatch
        ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
        : null;
      const videoMatch = /Stream #\d+:\d+.*?: Video: ([a-zA-Z0-9_]+)/.exec(stderr);
      const audioMatch = /Stream #\d+:\d+.*?: Audio: ([a-zA-Z0-9_]+)/.exec(stderr);
      const sizeMatch = /Video:.*?, (\d{2,5})x(\d{2,5})/.exec(stderr);
      resolve({
        duration,
        videoCodec: videoMatch ? videoMatch[1].toLowerCase() : null,
        audioCodec: audioMatch ? audioMatch[1].toLowerCase() : null,
        width: sizeMatch ? Number(sizeMatch[1]) : null,
        height: sizeMatch ? Number(sizeMatch[2]) : null,
      });
    });
    child.on("error", () => resolve(null));
  });
}

module.exports = {
  ffmpegPath,
  finalizeRecording,
  runFfmpeg,
  renderAudio,
  wrapVideo,
  mux,
  encodeImageSequence,
  exportAudioOnly,
  grabThumbnail,
  probeDuration,
  probeMedia,
  buildAudioGraph,
  detectEncoders,
};
