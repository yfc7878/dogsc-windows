/**
 * Capture surface.
 *
 * The hidden window that owns the recording graph. It is the Windows
 * counterpart of ScreenRecorder + CameraRecorder + MicrophoneRecorder +
 * NativeScreenRecording in the macOS original.
 *
 * Design notes
 * ------------
 * · Encoder output is streamed to the main process as it is produced
 *   (`MediaRecorder` timeslices), so a long recording never sits in memory and
 *   whatever was written survives an unexpected stop.
 * · Region capture runs the display through a canvas crop, which is how the
 *   original's "区域" source produces a video that only contains the selection.
 * · Camera and microphone are recorded as their own tracks rather than being
 *   baked into the screen picture, because the editor composites them — this
 *   is what makes the camera layout and cursor effects editable afterwards.
 */

const api = window.dogsc;

const state = {
  config: null,
  desktopStream: null,
  deviceStream: null,
  cameraStream: null,
  micStream: null,
  cropVideo: null,
  cropCanvas: null,
  cropLoop: null,
  cropActive: false,
  canvasStream: null,
  audioContext: null,
  recorders: new Map(),
  writing: [],
  sizes: {},
  durations: {},
  trackStartedAt: {},
  screenMode: "legacy",
  startedAt: 0,
  paused: false,
  stopping: false,
  frameCount: 0,
  lastFrameAt: 0,
  droppedFrames: 0,
  pendingWrites: [],
};

const MIME_CANDIDATES = {
  video: [
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ],
  audio: ["audio/webm;codecs=opus", "audio/webm"],
};

function pickMime(kind) {
  for (const candidate of MIME_CANDIDATES[kind]) {
    if (window.MediaRecorder?.isTypeSupported(candidate)) return candidate;
  }
  return "";
}

/* ------------------------------------------------------------------------- */
/* Stream acquisition                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Acquires the desktop (or a single window) as the primary picture.
 *
 * Sources differ in what they accept: some window sources reject a frame-rate
 * constraint outright with `NotReadableError`, and system audio is not always
 * available. Rather than failing the whole recording, the constraints are
 * relaxed step by step — the picture matters more than the requested rate, and
 * the actual frame rate is whatever the source delivers either way.
 */
async function acquireDesktop(config) {
  const frameRate = config.fps || 60;
  const base = {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: config.sourceId,
  };
  const audio = { mandatory: { ...base } };
  const attempts = [];
  if (config.systemAudio) {
    attempts.push({
      label: "video+audio with frame rate",
      video: { mandatory: { ...base, maxFrameRate: frameRate, minFrameRate: Math.min(30, frameRate) } },
      audio,
    });
    attempts.push({
      label: "video+audio",
      video: { mandatory: { ...base, maxFrameRate: frameRate } },
      audio,
    });
  }
  attempts.push({
    label: "video with frame rate",
    video: { mandatory: { ...base, maxFrameRate: frameRate, minFrameRate: Math.min(30, frameRate) } },
  });
  attempts.push({ label: "video", video: { mandatory: { ...base } } });

  let lastError = null;
  for (const attempt of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: attempt.video,
        audio: attempt.audio ?? false,
      });
    } catch (error) {
      lastError = error;
      console.warn(`[capture] desktop acquisition failed (${attempt.label})`, error?.name);
      if (attempt.audio) {
        /* System audio is a bonus; losing it must not lose the picture. */
        await api.capture.warning({ message: "system-audio-unavailable" });
      }
    }
  }
  throw lastError || new Error("desktop capture failed");
}

/**
 * 系统声音（WASAPI 回环）。ffmpeg 采集模式下屏幕不再经过 Chromium，但回环
 * 音频仍要从桌面源取得。
 *
 * 不用"纯音频请求"：实测在部分版本上它既不返回也不报错（挂起），会拖死
 * 采集面的启动；统一用"最小视频轨 + 音频"的请求（与旧采集路径同一套已被
 * 验证的约束），视频轨只负责把音频带出来，帧率尺寸都压到最低，不会被录制。
 */
async function acquireSystemAudio(config) {
  const base = { chromeMediaSource: "desktop", chromeMediaSourceId: config.sourceId };
  return Promise.race([
    navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { ...base } },
      video: { mandatory: { ...base, maxFrameRate: 5, maxWidth: 320, maxHeight: 180 } },
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error("system-audio-timeout")), 8000)),
  ]);
}

/**
 * Acquires a capture device as the primary picture.
 *
 * The macOS original's "设备" source records a connected device's screen
 * through ScreenCaptureKit. Windows has no equivalent, so the closest honest
 * mapping is to record the selected capture device itself as the main track —
 * the editor then treats it exactly like any other primary recording.
 */
async function acquireDevice(config) {
  return navigator.mediaDevices.getUserMedia({
    video: {
      deviceId: config.deviceId ? { exact: config.deviceId } : undefined,
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: config.fps || 30 },
    },
    audio: false,
  });
}

async function acquireCamera(config) {
  if (!config.camera || !config.camera.deviceId) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: { exact: config.camera.deviceId },
        width: { ideal: config.camera.width || 1280 },
        height: { ideal: config.camera.height || 720 },
        frameRate: { ideal: 30 },
      },
      audio: false,
    });
  } catch (error) {
    console.warn("[capture] camera unavailable", error);
    await api.capture.warning({ message: "camera-unavailable" });
    return null;
  }
}

async function acquireMicrophone(config) {
  if (!config.microphone) return null;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: config.microphone.deviceId
          ? { exact: config.microphone.deviceId }
          : undefined,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
  } catch (error) {
    console.warn("[capture] microphone unavailable", error);
    await api.capture.warning({ message: "microphone-unavailable" });
    return null;
  }
}

/**
 * Builds a display-cropped stream for area recordings. The crop rectangle is
 * authored in device-independent pixels by the selector overlay and scaled to
 * the display's physical pixels here.
 */
function buildRegionStream(videoTrack, config) {
  const settings = videoTrack.getSettings();
  const sourceWidth = settings.width || 1920;
  const sourceHeight = settings.height || 1080;
  const scale = config.scaleFactor || 1;
  const region = config.region;

  const video = document.createElement("video");
  video.srcObject = new MediaStream([videoTrack]);
  video.muted = true;
  video.playsInline = true;

  const canvas = document.createElement("canvas");
  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  canvas.width = even(region.width * scale);
  canvas.height = even(region.height * scale);
  const ctx = canvas.getContext("2d", { alpha: false });

  const draw = () => {
    /* Guarded by an explicit flag, not by `state.cropLoop`: the first call
       happens from `loadedmetadata`, before the handle exists, so checking the
       handle would abort the loop before it ever started. */
    if (!state.cropActive) return;
    const sx = region.x * scale;
    const sy = region.y * scale;
    const sw = region.width * scale;
    const sh = region.height * scale;
    try {
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    } catch {
      /* the frame may not be ready on the very first tick */
    }
    state.cropLoop = video.requestVideoFrameCallback
      ? video.requestVideoFrameCallback(draw)
      : requestAnimationFrame(draw);
  };

  state.cropActive = true;
  video.addEventListener("loadedmetadata", () => {
    video.play().catch(() => {});
    draw();
  });

  state.cropVideo = video;
  state.cropCanvas = canvas;
  return canvas.captureStream(config.fps || 60);
}

/* ------------------------------------------------------------------------- */
/* Recording                                                                 */
/* ------------------------------------------------------------------------- */

function startRecorder(role, stream, kind, { extension = ".webm", videoBitsPerSecond } = {}) {
  if (!stream || !stream.getTracks().length) return null;
  const mime = pickMime(kind);
  let recorder;
  try {
    recorder = new MediaRecorder(stream, {
      mimeType: mime || undefined,
      videoBitsPerSecond,
      audioBitsPerSecond: kind === "audio" ? 160000 : undefined,
    });
  } catch (error) {
    console.error(`[capture] recorder for ${role} failed`, error);
    return null;
  }

  recorder.ondataavailable = async (event) => {
    if (!event.data || !event.data.size) return;
    const buffer = await event.data.arrayBuffer();
    /* The promise is kept so `stop()` can await every write still in flight,
       but settled entries are dropped as they resolve — otherwise an
       hour-long recording would hold thousands of settled promises. */
    const pending = api.capture
      .write({ role, extension, data: buffer })
      .catch((error) => console.error("[capture] write failed", error));
    state.pendingWrites.push(pending);
    pending.finally(() => {
      const index = state.pendingWrites.indexOf(pending);
      if (index >= 0) state.pendingWrites.splice(index, 1);
    });
  };

  recorder.onerror = (event) => {
    console.error(`[capture] ${role} recorder error`, event.error);
    api.capture.warning({ message: `${role}-recorder-error` });
  };

  recorder.start(1000);
  /* 墙钟锚点：主进程用它把每条附加轨对齐到屏幕画面（ffmpeg 首帧时钟）。 */
  state.trackStartedAt[role] = Date.now();
  state.recorders.set(role, recorder);
  state.writing.push(role);
  return recorder;
}

function measureStream(stream, role) {
  const track = stream?.getVideoTracks?.()[0];
  if (!track) return;
  const settings = track.getSettings();
  state.sizes[role] = { width: settings.width, height: settings.height };
  track.addEventListener("ended", () => api.capture.warning({ message: `${role}-ended` }));
}

async function start(config) {
  state.config = config;
  state.startedAt = performance.now();
  state.stopping = false;
  state.writing = [];
  state.pendingWrites = [];
  state.trackStartedAt = {};
  state.screenMode = config.screenMode === "ffmpeg" ? "ffmpeg" : "legacy";
  const ffmpegScreen = state.screenMode === "ffmpeg";

  const isDevice = config.kind === "device";

  let screenStream;
  if (isDevice) {
    screenStream = await acquireDevice(config);
    state.deviceStream = screenStream;
  } else if (ffmpegScreen) {
    /* 屏幕由主进程的 ffmpeg（ddagrab）采集；这里只为系统声音取回环音频，
       桌面流本身不会被录制。音频拿不到时只降级该轨，不动整场录制。 */
    console.warn("[capture] ffmpeg-mode start: acquiring system audio", Boolean(config.systemAudio));
    if (config.systemAudio) {
      try {
        state.desktopStream = await acquireSystemAudio(config);
      } catch (error) {
        console.warn("[capture] system audio unavailable", error?.name);
        await api.capture.warning({ message: "system-audio-unavailable" });
      }
    }
    console.warn("[capture] ffmpeg-mode start: desktopStream =", Boolean(state.desktopStream));
  } else {
    const desktop = await acquireDesktop(config);
    state.desktopStream = desktop;
    screenStream = desktop;
    if (config.kind === "area" && config.region) {
      const track = desktop.getVideoTracks()[0];
      screenStream = buildRegionStream(track, config);
      state.canvasStream = screenStream;
    }
  }

  if (!ffmpegScreen) {
    measureStream(screenStream, "screen");
    startRecorder("screen", screenStream, "video", { videoBitsPerSecond: 12000000 });
  }

  /* A device recording already uses the capture device as the main picture, so
     there is nothing separate to record for the picture-in-picture track. */
  if (!isDevice) {
    const camera = await acquireCamera(config);
    if (camera) {
      state.cameraStream = camera;
      measureStream(camera, "camera");
      startRecorder("camera", camera, "video", { videoBitsPerSecond: 6000000 });
    }
  }

  const mic = await acquireMicrophone(config);
  if (mic) {
    state.micStream = mic;
    startRecorder("microphone", mic, "audio");
  }

  /* System audio is a separate track on the desktop stream, so it records as
     its own file and stays independently editable. */
  const systemTrack = state.desktopStream?.getAudioTracks()[0];
  if (systemTrack) {
    const systemStream = new MediaStream([systemTrack]);
    startRecorder("system", systemStream, "audio");
  }

  await api.capture.started({ writing: state.writing, sizes: state.sizes });
}

function pause() {
  state.paused = true;
  for (const recorder of state.recorders.values()) {
    if (recorder.state === "recording") recorder.pause();
  }
}

function resume() {
  state.paused = false;
  for (const recorder of state.recorders.values()) {
    if (recorder.state === "paused") recorder.resume();
  }
}

async function grabPoster() {
  /* ffmpeg 采集模式下屏幕画面不在本进程里，封面由主进程从成片抽首帧。 */
  if (state.screenMode === "ffmpeg") return null;
  const video = state.cropVideo || findPreviewVideo();
  if (!video) return null;
  const canvas = document.createElement("canvas");
  const width = 640;
  const ratio = (video.videoHeight || 9) / (video.videoWidth || 16);
  canvas.width = width;
  canvas.height = Math.max(2, Math.round(width * ratio));
  const ctx = canvas.getContext("2d");
  try {
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  } catch {
    return null;
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) return null;
  const buffer = await blob.arrayBuffer();
  const result = await api.capture.writeFile({ name: "poster.png", data: buffer });
  return result?.path || null;
}

function findPreviewVideo() {
  /* When no crop canvas exists the primary stream has no <video> element, so
     one is created lazily for the poster grab. */
  if (state._posterVideo) return state._posterVideo;
  const primary = state.desktopStream || state.deviceStream;
  if (!primary) return null;
  const video = document.createElement("video");
  video.srcObject = primary;
  video.muted = true;
  video.playsInline = true;
  video.play().catch(() => {});
  state._posterVideo = video;
  return video;
}

async function stop() {
  if (state.stopping) return;
  state.stopping = true;

  const stopped = [...state.recorders.values()].map(
    (recorder) =>
      new Promise((resolve) => {
        if (recorder.state === "inactive") return resolve();
        recorder.addEventListener("stop", () => resolve(), { once: true });
        try {
          recorder.stop();
        } catch {
          resolve();
        }
      })
  );
  await Promise.all(stopped);
  await Promise.all(state.pendingWrites).catch(() => {});

  const posterPath = await grabPoster().catch(() => null);

  const durations = {};
  for (const role of state.writing) durations[role] = (performance.now() - state.startedAt) / 1000;

  const files = {};
  for (const role of state.writing) {
    files[role] = `${state.config.workingDir}\\${role}.webm`;
  }

  teardown();

  await api.capture.finished({
    files,
    durations,
    sizes: state.sizes,
    posterPath,
    duration: (performance.now() - state.startedAt) / 1000,
    markers: [],
    config: state.config,
    suggestedName: state.config.suggestedName || null,
    screenMode: state.screenMode,
    trackStartedAt: { ...state.trackStartedAt },
  });
}

function teardown() {
  state.cropActive = false;
  if (state.cropLoop && state.cropVideo?.cancelVideoFrameCallback) {
    try {
      state.cropVideo.cancelVideoFrameCallback(state.cropLoop);
    } catch {
      /* already cancelled */
    }
  }
  state.cropLoop = null;

  for (const stream of [
    state.desktopStream,
    state.deviceStream,
    state.cameraStream,
    state.micStream,
    state.canvasStream,
  ]) {
    for (const track of stream?.getTracks?.() || []) {
      try {
        track.stop();
      } catch {
        /* already stopped */
      }
    }
  }
  state.desktopStream = null;
  state.deviceStream = null;
  state.cameraStream = null;
  state.micStream = null;
  state.canvasStream = null;
  state.recorders.clear();
  state._posterVideo = null;
}

/* ------------------------------------------------------------------------- */
/* Command channel                                                           */
/* ------------------------------------------------------------------------- */

api.on("capture:command", async (command) => {
  if (!command || !command.type) return;
  try {
    switch (command.type) {
      case "start":
        await start(command.config);
        break;
      case "pause":
        pause();
        break;
      case "resume":
        resume();
        break;
      case "stop":
        await stop();
        break;
      default:
        break;
    }
  } catch (error) {
    /* DOMException serialises to "[object DOMException]" through the console,
       so the name and message are spelled out — a failed capture has to say
       *why* it failed. */
    const detail = error && error.name ? `${error.name}: ${error.message}` : String(error);
    console.error("[capture] command failed", command.type, detail);
    teardown();
    await api.capture.failed({ message: detail });
  }
});

window.addEventListener("beforeunload", () => {
  teardown();
});
