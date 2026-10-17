/**
 * Project model.
 *
 * A direct port of the storage contract in `RecorderCore/ProjectModel.swift`
 * and `ProjectTimeline.swift`. Field names, enum raw values, default values
 * and clamping ranges all follow the Swift definitions so a document authored
 * on either platform describes the same edit.
 */

export const SCHEMA_VERSION = 27;

/* ------------------------------------------------------------------------- */
/* Enumerations (raw values match the Swift cases)                           */
/* ------------------------------------------------------------------------- */

export const CANVAS_RATIOS = ["适应", "16:9", "4:3", "9:16", "1:1", "3:4", "2.39:1", "1:2.39", "自定义"];
export const CANVAS_RESOLUTIONS = ["原始素材", "1080p", "1440p", "4K"];

export const SCREEN_FRAMES = [
  { value: "none", label: "无边框", icon: "display" },
  { value: "windowLight", label: "macOS 窗口·浅色", icon: "mockup" },
  { value: "windowDark", label: "macOS 窗口·深色", icon: "mockup" },
  { value: "browserLight", label: "浏览器·浅色", icon: "window" },
  { value: "browserDark", label: "浏览器·深色", icon: "window" },
  { value: "devicePhone", label: "通用平板样机", icon: "device" },
  { value: "adaptiveDevice", label: "自适应设备框", icon: "device" },
  { value: "phonePortrait", label: "手机·竖屏", icon: "device" },
  { value: "phoneLandscape", label: "手机·横屏", icon: "device" },
  { value: "tabletPortrait", label: "平板·竖屏", icon: "device" },
  { value: "tabletLandscape", label: "平板·横屏", icon: "device" },
];

export const BACKGROUND_PATTERNS = [
  "黑曜石网格",
  "工程白网格",
  "暗夜星阵",
  "建筑极简点",
  "立体等角网",
];

export const DYNAMIC_BACKGROUNDS = ["赛博微流网格", "星辉漫步点阵", "极光流体星云"];

export const CAMERA_SHAPES = ["方形", "横向", "纵向", "原始比例", "圆形"];

export const CURSOR_ASSETS = [
  /* The full asset set the original's CursorAssetLibrary resolves. "系统"
     (automatic) follows the recorded cursor as it changed shape; every other
     entry pins one style. */
  { value: "system.automatic", label: "系统", note: "跟随录制切换", icon: "cursor" },
  { value: "system.arrow", label: "系统箭头", icon: "cursor" },
  { value: "system.pointing-hand", label: "指向手势", icon: "cursorHand" },
  { value: "system.ibeam", label: "I 型光标", icon: "cursorIbeam" },
  { value: "system.crosshair", label: "十字准星", icon: "cursorCross" },
  { value: "system.open-hand", label: "张开手", icon: "cursorOpenHand" },
  { value: "system.closed-hand", label: "握拳手", icon: "cursorClosedHand" },
  { value: "system.not-allowed", label: "禁止", icon: "cursorNo" },
  { value: "system.touch-dot", label: "触控圆点", icon: "cursorDot" },
  { value: "system.hidden", label: "始终隐藏", icon: "eyeOff" },
];

export const CLICK_EFFECTS = [
  { value: "ripple", label: "涟漪扩散", duration: 0.36 },
  { value: "glow", label: "柔和光晕", duration: 0.32 },
  { value: "pulse", label: "弹性双环", duration: 0.38 },
  { value: "burst", label: "聚焦微闪", duration: 0.22 },
  { value: "none", label: "无效果", duration: 0 },
];

export const CURSOR_PRESET_COLORS = [
  { label: "极光紫", hex: "#8B5CF6" },
  { label: "天际蓝", hex: "#38BDF8" },
  { label: "薄荷绿", hex: "#34D399" },
  { label: "日落橙", hex: "#FB923C" },
  { label: "炫目粉", hex: "#F472B6" },
  { label: "冰川白", hex: "#F8FAFC" },
];

export const OPENING_PRESETS = ["聚拢", "侧滑", "轻 3D"];
export const OPENING_ELEMENTS = ["屏幕", "摄像头", "贴图"];
export const MOTION_CURVES = [
  { value: "swift", label: "顺滑" },
  { value: "crisp", label: "利落" },
  { value: "gentle", label: "柔和" },
];

export const EASING_PRESETS = ["spring", "easeInOut", "easeOut", "linear"];

/* ------------------------------------------------------------------------- */
/* Defaults                                                                  */
/* ------------------------------------------------------------------------- */

export function defaultCanvas() {
  return {
    aspectRatio: "适应",
    customAspectRatio: { width: 16, height: 9 },
    backgroundSource: { kind: "pattern", patternPreset: "黑曜石网格" },
    padding: 70,
    contentScale: 1,
    contentPosition: { x: 0.5, y: 0.5 },
    crop: { x: 0, y: 0, width: 1, height: 1 },
    cornerRadius: 0,
    borderWidth: 0,
    borderColor: "#FFFFFF",
    shadowStrength: 0.28,
    backgroundBlur: 0,
    insetOpacity: 0.125,
    screenFrame: "none",
    screenFrameScale: 1,
    screenFrameToolbarScale: 1,
    screenFrameOuterCornerRadius: null,
    screenFrameContentCornerRadius: null,
    screenFrameTitle: "",
    screenFrameBrowserAddress: "",
    patternScale: 1,
    patternOpacity: 1,
  };
}

export function defaultAudio() {
  return {
    systemVolume: 0.82,
    microphoneVolume: 0.9,
    isSystemMuted: false,
    isMicrophoneMuted: false,
  };
}

export function defaultCamera() {
  return {
    shape: "方形",
    /* Top-right. `size` is a fraction of the canvas *width*, so a square PiP
       occupies `size * aspect` of the height — the vertical inset has to allow
       for that or the default framing is clipped on a 16:9 canvas. */
    position: { x: 0.86, y: 0.25 },
    size: 0.24,
    borderWidth: 3,
    shadowStrength: 0.25,
    roundness: 0.5,
    isMirrored: true,
    isHidden: false,
    scaleDuringZoom: 0.7,
    contentPosition: { x: 0.5, y: 0.5 },
    contentScale: 1,
    /* Whole-track A/V sync, seconds. Positive delays the picture against the
       camera (the camera frame is sampled earlier) — same convention as
       cursorStyle.syncOffset. */
    syncOffset: 0,
  };
}

export function defaultMotion() {
  return {
    screen: "聚焦",
    cursor: "平滑",
    screenSpringMass: 2.4,
    screenSpringStiffness: 210,
    screenSpringDamping: 42,
    cursorSpringMass: 2.8,
    cursorSpringStiffness: 450,
    cursorSpringDamping: 66,
    defaultZoomEasing: "spring",
    defaultZoomTransitionDuration: 0.7,
    defaultZoomScale: 1.4,
  };
}

export function defaultCursorStyle() {
  return {
    assetID: "system.automatic",
    size: 1.25,
    hideWhenIdle: false,
    idleDelay: 1.2,
    clickEffectStyle: "ripple",
    clickColor: null,
    clickOpacity: 0.8,
    clickScale: 1,
    motionTiltStrength: 2,
    /* A/V alignment: how far the recorded pointer track is shifted relative to
       the picture. Positive delays the cursor, negative advances it. */
    syncOffset: 0,
  };
}

/** Preset click-effect durations, shared by the renderer and the inspector. */
export const CLICK_EFFECT_DURATION = {
  ripple: 0.36,
  glow: 0.32,
  pulse: 0.38,
  burst: 0.22,
  none: 0,
};

export const STICKER_ANIMATIONS_IN = [
  "无动画",
  "淡入",
  "弹出",
  "从左",
  "从右",
  "从上",
  "从下",
  "左上",
  "右上",
  "左下",
  "右下",
];
export const STICKER_ANIMATIONS_OUT = [
  "无动画",
  "淡出",
  "收缩",
  "反向",
  "向左",
  "向右",
  "向上",
  "向下",
  "左上",
  "右上",
  "左下",
  "右下",
];

export const SPEED_PRESETS = [0.5, 1, 1.5, 2];

export function defaultOpening() {
  return {
    isEnabled: false,
    preset: "轻 3D",
    motionCurve: "swift",
    duration: 2.2,
    stagger: 0.16,
    includedElements: [...OPENING_ELEMENTS],
    elementOrder: [...OPENING_ELEMENTS],
  };
}

/* ------------------------------------------------------------------------- */
/* Normalisation                                                             */
/* ------------------------------------------------------------------------- */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const num = (value, fallback) => (Number.isFinite(value) ? value : fallback);

/**
 * Fills a decoded document with every default the current schema expects.
 * This is the port of the Swift `init(from:)` implementations, which upgrade
 * older documents field by field instead of failing to open them.
 */
export function normalizeDocument(raw) {
  const doc = raw && typeof raw === "object" ? { ...raw } : {};
  const canvas = { ...defaultCanvas(), ...(doc.canvas || {}) };
  canvas.customAspectRatio = { ...defaultCanvas().customAspectRatio, ...(canvas.customAspectRatio || {}) };
  canvas.contentPosition = { ...defaultCanvas().contentPosition, ...(canvas.contentPosition || {}) };
  canvas.crop = clampCrop({ ...defaultCanvas().crop, ...(canvas.crop || {}) });
  canvas.padding = clamp(num(canvas.padding, 70), 0, 400);
  canvas.contentScale = clamp(num(canvas.contentScale, 1), 0.1, 4);
  canvas.cornerRadius = clamp(num(canvas.cornerRadius, 0), 0, 160);
  canvas.borderWidth = clamp(num(canvas.borderWidth, 0), 0, 40);
  canvas.shadowStrength = clamp(num(canvas.shadowStrength, 0.28), 0, 1);
  canvas.backgroundBlur = clamp(num(canvas.backgroundBlur, 0), 0, 60);
  canvas.screenFrameScale = clamp(num(canvas.screenFrameScale, 1), 0.6, 1.6);
  canvas.screenFrameToolbarScale = clamp(num(canvas.screenFrameToolbarScale, 1), 0.65, 1.6);
  canvas.patternScale = clamp(num(canvas.patternScale, 1), 0.4, 6);
  canvas.patternOpacity = clamp(num(canvas.patternOpacity, 1), 0, 1);

  const audio = { ...defaultAudio(), ...(doc.audio || {}) };
  audio.systemVolume = clamp(num(audio.systemVolume, 0.82), 0, 1);
  audio.microphoneVolume = clamp(num(audio.microphoneVolume, 0.9), 0, 1);

  const camera = { ...defaultCamera(), ...(doc.camera || {}) };
  camera.position = { ...defaultCamera().position, ...(camera.position || {}) };
  camera.contentPosition = { ...defaultCamera().contentPosition, ...(camera.contentPosition || {}) };
  camera.size = clamp(num(camera.size, 0.29), 0.06, 0.9);
  camera.borderWidth = clamp(num(camera.borderWidth, 3), 0, 30);
  camera.roundness = clamp(num(camera.roundness, 0.5), 0, 1);
  camera.scaleDuringZoom = clamp(num(camera.scaleDuringZoom, 0.7), 0, 2);

  const motion = { ...defaultMotion(), ...(doc.motion || {}) };
  const cursorStyle = { ...defaultCursorStyle(), ...(doc.cursorStyle || {}) };
  cursorStyle.size = clamp(num(cursorStyle.size, 1.25), 0.25, 6);
  cursorStyle.idleDelay = clamp(num(cursorStyle.idleDelay, 1.2), 0.2, 8);
  cursorStyle.clickOpacity = clamp(num(cursorStyle.clickOpacity, 0.8), 0.05, 1);
  cursorStyle.clickScale = clamp(num(cursorStyle.clickScale, 1), 0.4, 3);
  cursorStyle.motionTiltStrength = clamp(num(cursorStyle.motionTiltStrength, 2), 2, 4);
  cursorStyle.syncOffset = clamp(num(cursorStyle.syncOffset, 0), -2, 2);

  const opening = { ...defaultOpening(), ...(doc.opening || {}) };
  opening.duration = clamp(num(opening.duration, 2.2), 0.4, 8);
  opening.stagger = clamp(num(opening.stagger, 0.16), 0, 1.2);

  const timeline = normalizeTimeline(doc.timeline, doc.media);

  return {
    schemaVersion: doc.schemaVersion || SCHEMA_VERSION,
    id: doc.id || `dogsc-${Date.now().toString(36)}`,
    name: doc.name || "未命名项目",
    createdAt: doc.createdAt || new Date().toISOString(),
    capture: doc.capture || { kind: "display", fps: 60 },
    media: doc.media || {},
    canvas,
    audio,
    camera,
    motion,
    cursorStyle,
    opening,
    pointerTrack: {
      /* `path` references `events/pointer.jsonl` in the package; samples and
         clicks are hydrated from it on load and stripped again on save. */
      path: typeof doc.pointerTrack?.path === "string" ? doc.pointerTrack.path : null,
      count: Number.isFinite(doc.pointerTrack?.count) ? doc.pointerTrack.count : null,
      samples: Array.isArray(doc.pointerTrack?.samples) ? doc.pointerTrack.samples : [],
      clicks: Array.isArray(doc.pointerTrack?.clicks) ? doc.pointerTrack.clicks : [],
    },
    markers: Array.isArray(doc.markers) ? doc.markers.map((m) => ({ id: m.id || rid(), time: num(m.time, 0) })) : [],
    timeline,
  };
}

function normalizeTimeline(raw, media) {
  const duration = num(raw?.duration, num(media?.screen?.duration, 1));
  const clips = Array.isArray(raw?.primaryClips) && raw.primaryClips.length
    ? raw.primaryClips
    : [{ id: "clip-1", sourceStart: 0, sourceDuration: duration, startTime: 0, speed: 1, audioOverride: null }];

  const primaryClips = clips
    .map((clip) => ({
      id: clip.id || rid(),
      sourceStart: Math.max(0, num(clip.sourceStart, 0)),
      sourceDuration: Math.max(0.05, num(clip.sourceDuration, duration)),
      startTime: Math.max(0, num(clip.startTime, 0)),
      speed: clamp(num(clip.speed, 1), 0.25, 4),
      audioOverride: clip.audioOverride || null,
    }))
    .sort((a, b) => a.startTime - b.startTime);

  /* Start times are recomputed so the clip list is always gapless, which is
     what the original's `ProjectTimelineEditing` guarantees. */
  let cursor = 0;
  for (const clip of primaryClips) {
    clip.startTime = cursor;
    cursor += clip.duration;
  }

  const zoomClips = (raw?.zoomClips || []).map((clip) => ({
    id: clip.id || rid(),
    startTime: num(clip.startTime, 0),
    duration: Math.max(0.2, num(clip.duration, 1)),
    mode: clip.mode === "手动" ? "手动" : "自动",
    focus: { x: num(clip.focus?.x, 0.5), y: num(clip.focus?.y, 0.5) },
    scale: clamp(num(clip.scale, 1.4), 1, 6),
    transitionIn: clamp(num(clip.transitionIn, 0.7), 0, 3),
    transitionOut: clamp(num(clip.transitionOut, 0.7), 0, 3),
    easing: clip.easing || "spring",
  })).sort((a, b) => a.startTime - b.startTime);

  const screenMotionClips = normalizeMotionClips(raw?.screenMotionClips);
  const cameraMotionClips = normalizeMotionClips(raw?.cameraMotionClips);

  const stickerClips = (raw?.stickerClips || []).map((clip) => ({
    id: clip.id || rid(),
    startTime: num(clip.startTime, 0),
    duration: Math.max(0.2, num(clip.duration, 2)),
    source: clip.source || "",
    position: { x: num(clip.position?.x, 0.5), y: num(clip.position?.y, 0.5) },
    scale: clamp(num(clip.scale, 0.25), 0.02, 3),
    rotation: num(clip.rotation, 0),
    opacity: clamp(num(clip.opacity, 1), 0, 1),
    borderWidth: clamp(num(clip.borderWidth, 0), 0, 40),
    borderColor: clip.borderColor || "#FFFFFF",
    shadowStrength: clamp(num(clip.shadowStrength, 0.2), 0, 1),
    layer: num(clip.layer, 0),
    animationIn: clip.animationIn || "无动画",
    animationOut: clip.animationOut || "无动画",
    animationInDuration: num(clip.animationInDuration, 0.4),
    animationOutDuration: num(clip.animationOutDuration, 0.4),
    /* Pace of the enter/exit ramp — the original's 动效节奏. */
    animationCurve: clip.animationCurve || "swift",
  }));

  const mosaicClips = (raw?.mosaicClips || []).map((clip) => ({
    id: clip.id || rid(),
    startTime: num(clip.startTime, 0),
    duration: Math.max(0.2, num(clip.duration, 2)),
    rect: {
      x: num(clip.rect?.x, 0.3),
      y: num(clip.rect?.y, 0.3),
      width: num(clip.rect?.width, 0.4),
      height: num(clip.rect?.height, 0.3),
    },
    style: clip.style === "突出" ? "突出" : "柔化",
    strength: clamp(num(clip.strength, 0.5), 0, 1),
  }));

  return {
    duration: cursor,
    primaryClips,
    zoomClips,
    screenMotionClips,
    cameraMotionClips,
    stickerClips,
    mosaicClips,
  };
}

function normalizeMotionClips(list) {
  return (list || []).map((clip) => ({
    id: clip.id || rid(),
    startTime: num(clip.startTime, 0),
    duration: Math.max(0.2, num(clip.duration, 1.6)),
    transitionIn: clamp(num(clip.transitionIn, 0.7), 0, 3),
    transitionOut: clamp(num(clip.transitionOut, 0.7), 0, 3),
    easing: clip.easing || "spring",
    /* Camera entrance clips (the original's 出现动画): the camera stays out of
       frame until the clip starts and fades in with its own ramp. Optional so
       existing projects keep their verified behaviour. */
    entrance: Boolean(clip.entrance),
    target: {
      position: { x: num(clip.target?.position?.x, 0.5), y: num(clip.target?.position?.y, 0.5) },
      scale: clamp(num(clip.target?.scale, 1), 0.1, 4),
      rotation: num(clip.target?.rotation, 0),
      tiltX: num(clip.target?.tiltX, 0),
      tiltY: num(clip.target?.tiltY, 0),
      perspective: clamp(num(clip.target?.perspective, 0.65), 0, 2),
      opacity: clamp(num(clip.target?.opacity, 1), 0, 1),
      cornerRadius: clamp(num(clip.target?.cornerRadius, 0), 0, 160),
    },
  })).sort((a, b) => a.startTime - b.startTime);
}

export function clampCrop(crop, minimumSize = 0.02) {
  const minimum = clamp(minimumSize, 0.001, 1);
  const safeX = clamp(num(crop.x, 0), 0, 1 - minimum);
  const safeY = clamp(num(crop.y, 0), 0, 1 - minimum);
  return {
    x: safeX,
    y: safeY,
    width: clamp(num(crop.width, 1), minimum, 1 - safeX),
    height: clamp(num(crop.height, 1), minimum, 1 - safeY),
  };
}

/* ------------------------------------------------------------------------- */
/* Timeline math (ProjectTimeline.swift)                                     */
/* ------------------------------------------------------------------------- */

export function clipDuration(clip) {
  return clip.sourceDuration / (clip.speed || 1);
}

export function timelineDuration(document) {
  const clips = document.timeline.primaryClips;
  if (!clips.length) return 0;
  const last = clips[clips.length - 1];
  return last.startTime + clipDuration(last);
}

/** Maps a timeline time to the recorded source time inside the primary clip. */
export function sourceTimeAt(document, time) {
  const clips = document.timeline.primaryClips;
  for (const clip of clips) {
    const duration = clipDuration(clip);
    if (time >= clip.startTime && time < clip.startTime + duration) {
      return clip.sourceStart + (time - clip.startTime) * (clip.speed || 1);
    }
  }
  const last = clips[clips.length - 1];
  if (!last) return 0;
  return last.sourceStart + clipDuration(last) * (last.speed || 1);
}

export function clipAt(document, time) {
  const clips = document.timeline.primaryClips;
  for (const clip of clips) {
    const duration = clipDuration(clip);
    if (time >= clip.startTime && time < clip.startTime + duration) return clip;
  }
  return clips[clips.length - 1] || null;
}

/** Splits the primary clip under `time`, returning the new clip list. */
export function splitPrimaryAt(document, time) {
  const clips = document.timeline.primaryClips;
  const index = clips.findIndex(
    (clip) => time > clip.startTime + 0.02 && time < clip.startTime + clipDuration(clip) - 0.02
  );
  if (index < 0) return null;
  const clip = clips[index];
  const offset = time - clip.startTime;
  const left = { ...clip, sourceDuration: offset * (clip.speed || 1) };
  const right = {
    ...clip,
    id: rid(),
    sourceStart: clip.sourceStart + offset * (clip.speed || 1),
    sourceDuration: clip.sourceDuration - offset * (clip.speed || 1),
    startTime: clip.startTime + offset,
  };
  const next = [...clips.slice(0, index), left, right, ...clips.slice(index + 1)];
  return reflow(next);
}

/** Recomputes gapless start times after any structural edit. */
export function reflow(clips) {
  let cursor = 0;
  const result = clips.map((clip) => {
    const copy = { ...clip, startTime: cursor };
    cursor += clipDuration(copy);
    return copy;
  });
  return result;
}

export function rid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const value = (Math.random() * 16) | 0;
    return (char === "x" ? value : (value & 0x3) | 0x8).toString(16);
  });
}

/* ------------------------------------------------------------------------- */
/* Easing                                                                    */
/* ------------------------------------------------------------------------- */

export function easeProgress(kind, t) {
  const x = clamp(t, 0, 1);
  switch (kind) {
    case "linear":
      return x;
    case "quad":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "cubic":
    case "easeInOut":
      /* `easeInOut` is the legacy value earlier builds wrote for 均衡; it now
         maps to the cubic curve it was always meant to be (it used to fall
         through to the spring default). */
      return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
    case "quint":
      return x < 0.5 ? 16 * x * x * x * x * x : 1 - Math.pow(-2 * x + 2, 5) / 2;
    case "crisp":
      return 1 - Math.pow(1 - x, 4);
    case "gentle":
      return x < 0.5 ? 2 * x * x : 1 - Math.pow(-2 * x + 2, 2) / 2;
    case "spring":
    default:
      /* Critically-damped spring response used by the original's transitions. */
      return 1 - Math.exp(-6 * x) * Math.cos(6.5 * x);
  }
}

/**
 * Evaluates an animated clip's authored target at `time`, blending the
 * transition-in and transition-out ramps the way `ElementMotion.swift` does.
 */
export function evaluateClip(clip, time) {
  const local = time - clip.startTime;
  const duration = clip.duration;
  if (local < 0 || local > duration) return null;
  const inDuration = Math.min(clip.transitionIn, duration);
  const outDuration = Math.min(clip.transitionOut, duration);
  let progress = 1;
  if (local < inDuration) progress = easeProgress(clip.easing, local / Math.max(inDuration, 0.001));
  else if (local > duration - outDuration) {
    progress = easeProgress(clip.easing, (duration - local) / Math.max(outDuration, 0.001));
  }
  return { progress: clamp(progress, 0, 1), local };
}

export function clipAtTime(list, time) {
  for (const clip of list) {
    if (time >= clip.startTime && time <= clip.startTime + clip.duration) return clip;
  }
  return null;
}
