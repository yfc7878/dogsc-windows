/**
 * Export sheet.
 *
 * Renders every frame through the same compositor the editor preview uses,
 * encodes the result with WebCodecs, and hands the bitstream to the main
 * process which muxes it with an ffmpeg-built audio mix.
 *
 * This mirrors `DirectExportPipeline.swift`: one renderer, one frame schedule,
 * preview and export can never diverge.
 */

import { icon } from "../shared/icons.js";
import { setLocale, t } from "../shared/i18n.js";
import {
  attachTooltip,
  formatBytes,
  formatDuration,
  formatTimecode,
  toast,
} from "../shared/widgets.js";
import { renderFrame, resolveCanvasSize } from "../editor/js/frame-renderer.js";
import {
  clipDuration,
  normalizeDocument,
  reflow,
  sourceTimeAt,
  timelineDuration,
} from "../editor/js/model.js";

const api = window.dogsc;

const RESOLUTIONS = [
  { value: "原始素材", label: "原始素材", note: "跟随素材" },
  { value: "1080p", label: "1080p", note: "轻量高清" },
  { value: "1440p", label: "1440p", note: "细节优先" },
  { value: "4K", label: "4K", note: "超清输出" },
];

const FPS = [
  { value: 30, label: "30 FPS", note: "更小体积" },
  { value: 60, label: "60 FPS", note: "更流畅" },
];

/**
 * Only H.264 is requested for the bitstream path.
 *
 * ffmpeg can ingest a raw Annex B H.264 stream directly, which lets the mux
 * pass copy the picture without re-encoding. VP9/AV1 encoders emit bare
 * frames that need a container ffmpeg has no demuxer for, so when H.264 is
 * unavailable the renderer falls back to a JPEG image sequence instead of
 * producing a file that cannot be muxed.
 */
const CODEC_CANDIDATES = [
  "avc1.640034",
  "avc1.640028",
  "avc1.4D0034",
  "avc1.4D0028",
  "avc1.42E01E",
];

const state = {
  payload: null,
  document: null,
  media: { screen: null, camera: null },
  /* The composite needs the same background and sticker media the editor uses,
     otherwise the exported picture silently falls back to the pattern. */
  backgroundImage: null,
  backgroundVideo: null,
  stickers: new Map(),
  content: "video",
  resolution: "1080p",
  fps: 60,
  outputPath: null,
  folder: null,
  baseName: "DogSC 导出",
  exporting: false,
  cancelled: false,
  startedAt: 0,
  encoder: null,
  mode: "bitstream",
  codec: null,
};

/* ------------------------------------------------------------------------- */
/* Boot                                                                      */
/* ------------------------------------------------------------------------- */

async function boot() {
  setLocale("zh-Hans");
  const theme = await api.app.theme();
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";

  document.getElementById("head-icon").innerHTML = icon("export", 22);
  document.getElementById("btn-close").innerHTML = icon("close", 15);
  document.getElementById("btn-rename").innerHTML = icon("crop", 15);
  document.getElementById("folder-icon").innerHTML = icon("folder", 16);
  document.getElementById("folder-chev").innerHTML = icon("chevronRight", 14);

  document.getElementById("btn-close").addEventListener("click", () => window.close());
  document.getElementById("btn-cancel").addEventListener("click", cancel);
  document.getElementById("btn-start").addEventListener("click", start);
  document.getElementById("btn-folder").addEventListener("click", chooseFolder);

  const prefs = await api.prefs.all();
  state.folder = prefs.exportLocation;

  api.on("export:init", (payload) => init(payload));
  api.on("export:progress", (payload) => updateProgress(payload));

  /* `ready-to-show` can fire before this listener exists, so the payload is
     pulled once the window is genuinely ready. */
  const payload = await api.windows.exportPayload();
  if (payload) await init(payload);
}

/**
 * Builds the document an export range describes.
 *
 * ⌥X exports only the selected primary clips, so every track has to be
 * re-based onto a timeline that starts at zero: clips fully outside the range
 * are dropped, clips straddling its edges are trimmed, and everything that
 * survives is shifted back.
 */
function documentForRange(document_, range) {
  if (!range) return document_;
  const trimmed = structuredClone(document_);
  const start = range.start;
  const end = range.end;

  const clips = [];
  for (const clip of document_.timeline.primaryClips) {
    const clipStart = clip.startTime;
    const clipEnd = clip.startTime + clipDuration(clip);
    const from = Math.max(clipStart, start);
    const to = Math.min(clipEnd, end);
    if (to - from < 0.02) continue;
    const speed = clip.speed || 1;
    clips.push({
      ...clip,
      sourceStart: clip.sourceStart + (from - clipStart) * speed,
      sourceDuration: (to - from) * speed,
      startTime: from - start,
    });
  }
  trimmed.timeline.primaryClips = reflow(clips);

  const rebase = (list) =>
    list
      .map((clip) => {
        const from = Math.max(clip.startTime, start);
        const to = Math.min(clip.startTime + clip.duration, end);
        if (to - from < 0.05) return null;
        return { ...clip, startTime: from - start, duration: to - from };
      })
      .filter(Boolean);

  trimmed.timeline.zoomClips = rebase(document_.timeline.zoomClips);
  trimmed.timeline.screenMotionClips = rebase(document_.timeline.screenMotionClips);
  trimmed.timeline.cameraMotionClips = rebase(document_.timeline.cameraMotionClips);
  trimmed.timeline.stickerClips = rebase(document_.timeline.stickerClips);
  trimmed.timeline.mosaicClips = rebase(document_.timeline.mosaicClips);
  trimmed.timeline.duration = end - start;
  trimmed.markers = (document_.markers || [])
    .filter((marker) => marker.time >= start && marker.time <= end)
    .map((marker) => ({ ...marker, time: marker.time - start }));
  return trimmed;
}

/**
 * Builds the document an export range describes.
 *
 * ⌥X exports only the selected primary clips, so every track has to be
 * re-based onto a timeline that starts at zero: clips fully outside the range
 * are dropped, clips straddling its edges are trimmed, and everything that
 * survives is shifted back.
 */
async function init(payload) {
  state.payload = payload;
  state.document = normalizeDocument(payload.document);
  state.range = payload.range || null;
  if (state.range) {
    state.document = documentForRange(state.document, state.range);
  }
  state.document.__sourceSize = payload.sourceSize || { width: 1920, height: 1080 };
  state.baseName = `${state.document.name}-${payload.duration ? "60fps" : "成片"}`;
  document.getElementById("sheet-sub").textContent = state.document.name;
  document.getElementById("file-name").value = state.baseName;
  document.getElementById("folder-path").textContent = state.folder || t("尚未选择");

  await loadMedia();
  await loadBackground();
  await loadStickers();
  buildChoices();
  updateSpecs();
  await renderPreview();
  estimate();
}

async function loadMedia() {
  const packagePath = state.payload.packagePath;
  for (const role of ["screen", "camera"]) {
    const entry = state.payload.media?.[role];
    if (!entry?.relative) continue;
    const url = await api.project.mediaUrl({ packagePath, relative: entry.relative });
    if (!url) continue;
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    await new Promise((resolve) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener("error", resolve, { once: true });
      setTimeout(resolve, 8000);
    });
    state.media[role] = video;
    if (role === "camera") {
      state.document.__cameraSize = {
        width: video.videoWidth || 1280,
        height: video.videoHeight || 720,
      };
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Composite media                                                           */
/* ------------------------------------------------------------------------- */

/**
 * The background picture/video and the stickers, loaded exactly as the editor
 * loads them.
 *
 * Without this the export window only had the recorded screen and camera, so a
 * project with a wallpaper background or stickers exported with the fallback
 * pattern instead — the picture did not match the preview.
 */
function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

async function loadBackground() {
  state.backgroundImage = null;
  state.backgroundVideo = null;
  const source = state.document?.canvas?.backgroundSource;
  if (!source) return;
  const packagePath = state.payload.packagePath;

  if (source.kind === "projectImage" && source.relativePath) {
    const url = await api.project.mediaUrl({ packagePath, relative: source.relativePath });
    if (url) state.backgroundImage = await loadImage(url);
  } else if (source.kind === "systemImage" && source.absolutePath) {
    state.backgroundImage = await loadImage(
      `dogsc-media://local/${encodeURIComponent(source.absolutePath)}`
    );
  } else if (source.kind === "projectVideo" && source.relativePath) {
    const url = await api.project.mediaUrl({ packagePath, relative: source.relativePath });
    if (!url) return;
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.crossOrigin = "anonymous";
    await new Promise((resolve) => {
      video.addEventListener("loadeddata", resolve, { once: true });
      video.addEventListener("error", resolve, { once: true });
      setTimeout(resolve, 8000);
    });
    state.backgroundVideo = video;
  }
}

async function loadStickers() {
  state.stickers = new Map();
  for (const clip of state.document?.timeline?.stickerClips || []) {
    if (!clip.source || state.stickers.has(clip.source)) continue;
    const url = await api.project.mediaUrl({
      packagePath: state.payload.packagePath,
      relative: clip.source,
    });
    if (!url) continue;
    const image = await loadImage(url);
    if (image) state.stickers.set(clip.source, image);
  }
}

/** The drawable set handed to the compositor, matching the editor's `sources`. */
function compositeSources() {
  return {
    screen: state.media.screen,
    camera: state.media.camera,
    backgroundImage: state.backgroundImage,
    backgroundVideo: state.backgroundVideo,
    stickers: state.stickers,
  };
}

/* ------------------------------------------------------------------------- */
/* Options                                                                   */
/* ------------------------------------------------------------------------- */

function buildChoices() {
  const contentHost = document.getElementById("content-choices");
  contentHost.innerHTML = "";
  const hasAudio = Boolean(state.payload.media?.system || state.payload.media?.microphone);
  for (const option of [
    { value: "video", label: t("视频成片"), note: t("画面与剪辑后的混音") },
    { value: "audio", label: t("仅音频"), note: "M4A · " + t("剪辑后的混音") },
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    if (state.content === option.value) button.classList.add("is-selected");
    button.innerHTML = `<span>${option.label}</span>${
      state.content === option.value ? icon("check", 13) : ""
    }`;
    button.disabled = option.value === "audio" && !hasAudio;
    attachTooltip(button, option.note);
    button.addEventListener("click", () => {
      state.content = option.value;
      buildChoices();
      updateSpecs();
      estimate();
    });
    contentHost.appendChild(button);
  }

  const resolutionHost = document.getElementById("resolution-choices");
  resolutionHost.innerHTML = "";
  for (const option of RESOLUTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    if (state.resolution === option.value) button.classList.add("is-selected");
    button.innerHTML = `<span>${option.label}</span>${
      state.resolution === option.value ? icon("check", 13) : ""
    }`;
    attachTooltip(button, option.note);
    button.addEventListener("click", () => {
      state.resolution = option.value;
      buildChoices();
      updateSpecs();
      renderPreview();
      estimate();
    });
    resolutionHost.appendChild(button);
  }

  const fpsHost = document.getElementById("fps-choices");
  fpsHost.innerHTML = "";
  for (const option of FPS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    if (state.fps === option.value) button.classList.add("is-selected");
    button.innerHTML = `<span>${option.label}</span>${
      state.fps === option.value ? icon("check", 13) : ""
    }`;
    attachTooltip(button, option.note);
    button.addEventListener("click", () => {
      state.fps = option.value;
      buildChoices();
      updateSpecs();
      estimate();
    });
    fpsHost.appendChild(button);
  }

  const isAudio = state.content === "audio";
  document.getElementById("block-resolution").hidden = isAudio;
  document.getElementById("block-fps").hidden = isAudio;
  document.getElementById("file-ext").textContent = isAudio ? ".m4a" : ".mp4";
  document.getElementById("spec-format").textContent = isAudio ? "M4A" : "MP4";
  document.getElementById("btn-start").textContent = isAudio
    ? t("开始导出音频")
    : t("开始导出视频");
}

function targetSize() {
  return resolveCanvasSize(state.document, state.resolution, state.document.__sourceSize);
}

function updateSpecs() {
  const size = targetSize();
  document.getElementById("spec-size").textContent = `${size.width} × ${size.height}`;
  document.getElementById("spec-fps").textContent = `${state.fps} fps`;
  document.getElementById("spec-duration").textContent = formatDuration(
    timelineDuration(state.document)
  );
  if (state.range) {
    document.getElementById("sheet-sub").textContent = t(
      "%d 个片段，从 %@ 到 %@",
      state.range.clips.length,
      formatTimecode(state.range.start),
      formatTimecode(state.range.end)
    );
    document.getElementById("btn-start").textContent = t("开始导出选区视频");
  }
}

function estimate() {
  const duration = timelineDuration(state.document);
  if (state.content === "audio") {
    document.getElementById("estimate").textContent = t(
      "预计大小 · 约 %@",
      formatBytes(duration * 24000)
    );
    return;
  }
  const size = targetSize();
  const pixels = size.width * size.height;
  /* Rough H.264 budget: ~0.10 bits per pixel per frame at the default quality. */
  const bytesPerSecond = (pixels * state.fps * 0.1) / 8;
  document.getElementById("estimate").textContent = t(
    "预计大小 · 约 %@",
    formatBytes(bytesPerSecond * duration)
  );
}

async function chooseFolder() {
  const folder = await api.project.pickFolder({
    title: t("选择导出文件夹"),
    defaultPath: state.folder,
  });
  if (!folder) return;
  state.folder = folder;
  await api.prefs.set("exportLocation", folder);
  document.getElementById("folder-path").textContent = folder;
}

/* ------------------------------------------------------------------------- */
/* Preview                                                                   */
/* ------------------------------------------------------------------------- */

async function renderPreview() {
  const canvas = document.getElementById("export-preview");
  const size = targetSize();
  const ratio = size.width / Math.max(size.height, 1);
  const width = 300;
  const height = Math.round(width / ratio);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const duration = timelineDuration(state.document);
  const time = Math.min(duration * 0.25, 3);
  await seekAll(time);
  renderFrame(ctx, state.document, time, {
    width,
    height,
    /* Same reason as the editor preview: the canvas is backed at device
       resolution, so the frame has to be scaled to match or it lands in the
       top-left corner at 1/dpr size. */
    scale: dpr,
    sources: compositeSources(),
  });
}

async function seekAll(time) {
  const sourceTime = sourceTimeAt(state.document, time);
  const videos = Object.values(state.media).filter(Boolean);
  /* A background video is part of the picture and has to follow the playhead
     just like the recorded media. */
  if (state.backgroundVideo && state.backgroundVideo.readyState >= 1) {
    videos.push(state.backgroundVideo);
  }
  await Promise.all(videos.map((video) => seek(video, sourceTime)));
}

function seek(video, time) {
  return new Promise((resolve) => {
    if (Math.abs((video.currentTime || 0) - time) < 0.02 && video.readyState >= 2) return resolve();
    const done = () => {
      video.removeEventListener("seeked", done);
      resolve();
    };
    video.addEventListener("seeked", done);
    try {
      video.currentTime = time;
    } catch {
      done();
    }
    setTimeout(done, 1500);
  });
}

/* ------------------------------------------------------------------------- */
/* Export                                                                    */
/* ------------------------------------------------------------------------- */

async function start() {
  if (state.exporting) return;
  const name = document.getElementById("file-name").value.trim();
  if (!name) {
    toast(t("请输入文件名。"), { icon: "info" });
    return;
  }
  if (name === "." || name === "..") {
    toast(t("文件名不能是 . 或 ..。"), { icon: "info" });
    return;
  }
  if (/[\\/:*?"<>|\n]/.test(name)) {
    toast(t("文件名不能包含 /、: 或换行。"), { icon: "info" });
    return;
  }
  if (!state.folder) {
    toast(t("请先选择保存位置"), { icon: "info" });
    return;
  }

  const extension = state.content === "audio" ? "m4a" : "mp4";
  state.outputPath = `${state.folder}\\${name}.${extension}`;

  state.exporting = true;
  state.cancelled = false;
  state.startedAt = Date.now();
  setBusy(true);
  document.getElementById("progress").hidden = false;
  setProgress("audio", 0);

  try {
    if (state.content === "audio") {
      const result = await api.exporter.audioOnly({
        document: state.document,
        media: state.payload.media,
        outputPath: state.outputPath,
        format: "m4a",
      });
      if (!result?.ok) throw new Error(result?.reason || "failed");
      finishSuccess(result);
      return;
    }

    const size = targetSize();
    const duration = timelineDuration(state.document);
    const codec = await pickCodec(size, state.fps);
    state.codec = codec;

    const begin = await api.exporter.begin({
      outputPath: state.outputPath,
      codec: codec ? codec.codec : null,
      fps: state.fps,
      duration,
      mode: codec ? "bitstream" : "frames",
    });
    if (!begin?.ok) throw new Error(begin?.reason || "begin-failed");

    state.mode = codec ? "bitstream" : "frames";
    await runFrameLoop({ size, duration, codec });
    if (state.cancelled) return;

    setProgress("muxing", 0);
    const result = await api.exporter.finish({
      document: state.document,
      media: state.payload.media,
      exportAudio: true,
    });
    if (!result?.ok) {
      /* Known reasons get a sentence the user can act on; anything else keeps
         the technical message so a real bug is still debuggable. */
      const known = {
        "no-frames": t("编码器没有输出任何画面，请重试或更换分辨率／帧率"),
        busy: t("已有导出任务在进行中"),
        "no-job": t("导出任务已失效，请重新开始"),
      }[result?.reason];
      throw new Error(known || result?.message || result?.reason || "failed");
    }
    finishSuccess(result);
  } catch (error) {
    if (state.cancelled) return;
    console.error("[export] failed", error);
    /* Release the job in the main process: without this an export that died
       before `finish` left it registered and every later attempt reported
       "busy". */
    api.exporter.cancel().catch(() => {});
    setProgress("failed", 0);
    toast(t("导出失败") + `：${error.message}`, { icon: "info", duration: 5000 });
    state.exporting = false;
    setBusy(false);
  }
}

async function pickCodec(size, fps) {
  if (typeof VideoEncoder === "undefined") return null;
  const bitrate = Math.round(size.width * size.height * fps * 0.1);
  for (const codec of CODEC_CANDIDATES) {
    try {
      const support = await VideoEncoder.isConfigSupported({
        codec,
        width: size.width,
        height: size.height,
        bitrate,
        framerate: fps,
      });
      if (support?.supported) return { codec, bitrate, hardwareAcceleration: "no-preference" };
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

/**
 * Runs one encode pass and reports what it produced.
 *
 * The byte count matters: an encoder that is configured successfully can still
 * emit nothing (a flaky hardware encoder, or a GPU under contention). That used
 * to be invisible here and only surfaced much later as an ffmpeg failure on an
 * empty bitstream, so the pass measures itself instead.
 */
async function encodeBitstreamPass({ size, duration, codec, hardwareAcceleration, sources }) {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d", { alpha: false });

  const totalFrames = Math.max(1, Math.round(duration * state.fps));
  const pending = [];
  let bytes = 0;
  let frames = 0;
  let encoderError = null;

  const encoder = new VideoEncoder({
    output: (chunk) => {
      bytes += chunk.byteLength;
      const buffer = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buffer);
      pending.push(
        api.exporter.chunk({
          data: buffer,
          timestamp: chunk.timestamp,
          keyframe: chunk.type === "key",
        })
      );
    },
    error: (error) => {
      encoderError = String(error?.message || error);
      console.error("[export] encoder error", error);
    },
  });
  encoder.configure({
    codec: codec.codec,
    width: size.width,
    height: size.height,
    bitrate: codec.bitrate,
    framerate: state.fps,
    latencyMode: "quality",
    hardwareAcceleration,
    /* ffmpeg's `h264` demuxer expects Annex B start codes, not the AVCC
       length-prefixed framing Chromium produces by default. */
    avc: { format: "annexb" },
  });
  state.encoder = encoder;

  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (state.cancelled) break;
    const time = frameIndex / state.fps;

    await seekAll(time);
    renderFrame(ctx, state.document, time, { width: size.width, height: size.height, sources });

    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((frameIndex / state.fps) * 1e6),
      duration: Math.round(1e6 / state.fps),
    });
    encoder.encode(frame, { keyFrame: frameIndex % (state.fps * 2) === 0 });
    frame.close();
    frames += 1;

    /* Keep the encoder queue shallow so memory stays bounded. */
    while (encoder.encodeQueueSize > 12 && !state.cancelled) {
      await new Promise((resolve) => setTimeout(resolve, 4));
      await Promise.all(pending.splice(0));
    }

    if (frameIndex % 5 === 0 || frameIndex === totalFrames - 1) {
      setProgress("encoding", (frameIndex + 1) / totalFrames);
    }
  }

  await Promise.all(pending.splice(0));
  if (!state.cancelled) {
    try {
      await encoder.flush();
    } catch (error) {
      encoderError = encoderError || String(error?.message || error);
    }
    await Promise.all(pending.splice(0));
  }
  try {
    encoder.close();
  } catch {
    /* already closed */
  }
  state.encoder = null;
  return { frames, bytes, error: encoderError };
}

/** JPEG image sequence: the fallback when no H.264 encoder exists at all. */
async function encodeJpegFrames({ size, duration, sources }) {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d", { alpha: false });

  const totalFrames = Math.max(1, Math.round(duration * state.fps));
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    if (state.cancelled) break;
    const time = frameIndex / state.fps;
    await seekAll(time);
    renderFrame(ctx, state.document, time, { width: size.width, height: size.height, sources });

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.94));
    const buffer = await blob.arrayBuffer();
    await api.exporter.chunk({
      data: buffer,
      name: `frame-${String(frameIndex + 1).padStart(6, "0")}.jpg`,
    });

    if (frameIndex % 5 === 0 || frameIndex === totalFrames - 1) {
      setProgress("encoding", (frameIndex + 1) / totalFrames);
    }
  }
}

async function runFrameLoop({ size, duration, codec }) {
  const sources = compositeSources();

  if (!codec) {
    await encodeJpegFrames({ size, duration, sources });
    return;
  }

  let pass = await encodeBitstreamPass({
    size,
    duration,
    codec,
    hardwareAcceleration: "no-preference",
    sources,
  });

  if (!state.cancelled && pass.frames > 0 && pass.bytes === 0) {
    /* A hardware encoder can accept frames and emit nothing. Retrying on the
       software encoder turns that into a finished export instead of an empty
       bitstream and an incomprehensible ffmpeg failure. */
    console.warn("[export] the encoder produced no data; retrying with the software encoder");
    setProgress("encoding", 0);
    pass = await encodeBitstreamPass({
      size,
      duration,
      codec,
      hardwareAcceleration: "prefer-software",
      sources,
    });
  }

  if (!state.cancelled && pass.bytes === 0) {
    throw new Error(
      pass.error ? `${t("编码器没有输出画面")}（${pass.error}）` : t("编码器没有输出画面")
    );
  }
}

async function cancel() {
  if (!state.exporting) {
    window.close();
    return;
  }
  state.cancelled = true;
  await api.exporter.cancel();
  setProgress("cancelling", 0);
  state.exporting = false;
  setBusy(false);
  document.getElementById("progress").hidden = true;
  toast(t("导出已取消"), { icon: "info" });
}

function finishSuccess(result) {
  state.exporting = false;
  setBusy(false);
  setProgress("done", 1);
  document.getElementById("btn-start").textContent = t("在文件夹中显示");
  document.getElementById("btn-start").onclick = () => api.exporter.reveal(result.outputPath);
  document.getElementById("btn-cancel").textContent = t("关闭");
  document.getElementById("btn-cancel").onclick = () => window.close();
  document.getElementById("estimate").textContent = `${t("导出完成")} · ${formatBytes(result.size || 0)}`;
  toast(`${t("导出完成")} · ${result.outputPath}`, { icon: "check", duration: 4200 });
}

function setBusy(busy) {
  document.getElementById("btn-start").disabled = busy;
  document.getElementById("file-name").disabled = busy;
  document.getElementById("btn-folder").disabled = busy;
}

/* ------------------------------------------------------------------------- */
/* Progress                                                                  */
/* ------------------------------------------------------------------------- */

const STAGE_LABELS = {
  preparing: "正在准备素材",
  audio: "正在处理音频",
  encoding: "正在合成与编码",
  muxing: "正在完成文件",
  cancelling: "正在取消导出",
  done: "正在完成文件",
  failed: "需要注意",
};

function setProgress(stage, progress) {
  const bar = document.getElementById("progress");
  bar.hidden = false;
  document.getElementById("progress-fill").style.width = `${Math.round(progress * 100)}%`;
  document.getElementById("progress-stage").textContent = t(STAGE_LABELS[stage] || "正在合成与编码");
  const elapsed = (Date.now() - state.startedAt) / 1000;
  document.getElementById("progress-elapsed").textContent = t(
    "已用时 %@",
    formatDuration(elapsed)
  );
}

function updateProgress(payload) {
  if (!state.exporting) return;
  setProgress(payload.stage, payload.progress || 0);
}

/* Closing the sheet abandons the export, so the job must not stay registered
   in the main process. */
window.addEventListener("pagehide", () => {
  if (state.exporting) api.exporter.cancel().catch(() => {});
});

boot();

/* ------------------------------------------------------------------------- */
/* Diagnostics entry point                                                   */
/* ------------------------------------------------------------------------- */

/**
 * Used by the main process's DOGSC_EXPORT_TEST mode: configures the sheet for
 * a known-good export and runs it, so the render → encode → mux pipeline can
 * be verified without driving the UI by hand.
 */
window.__dogscExportTest = async (target, seconds = 4, options = {}) => {
  const folder = target.replace(/[\\/][^\\/]*$/, "");
  const name = target.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  state.folder = folder;
  /* The panel defaults are the ones a user actually exports with (60 fps), so
     the check has to be able to mirror them instead of only its own preset. */
  state.resolution = options.resolution || "1080p";
  state.fps = options.fps || 30;
  state.content = options.content || "video";
  document.getElementById("folder-path").textContent = folder;
  document.getElementById("file-name").value = name;
  /* Keep the check short: only the first few seconds are exported. */
  const clips = state.document.timeline.primaryClips;
  clips.forEach((clip, index) => {
    const budget = index === 0 ? seconds : 0;
    clip.sourceDuration = Math.min(clip.sourceDuration, budget);
  });
  state.document.timeline.primaryClips = clips.filter((clip) => clip.sourceDuration > 0.05);
  buildChoices();
  updateSpecs();
  await start();
};
