/**
 * Timeline.
 *
 * Port of `EditorTimelineView` + `EditorTimelineLayout` + `EditorTimelineInteraction`.
 * Tracks mirror the original's lane order:
 *   轨辑 (primary) · 屏幕录制 · 缩放 · 贴图 · 屏幕 3D · 摄像头 · 系统声音 · 麦克风
 */

import { icon } from "../../shared/icons.js";
import { t } from "../../shared/i18n.js";
import {
  attachTooltip,
  formatRulerTime,
  formatTimecode,
  clamp,
} from "../../shared/widgets.js";
import { clipDuration, timelineDuration } from "./model.js";
import { store, reflowClips } from "./store.js";

const BASE_PPS = 64; // pixels per second at zoom 1
const MIN_PPS = 8;
const MAX_PPS = 640;
const RULER_HEIGHT = 26;

const TRACKS = [
  { id: "primary", label: "屏幕录制", icon: "screen", height: 62, kind: "primary" },
  { id: "zoom", label: "缩放", icon: "zoomIn", height: 40, kind: "zoom" },
  { id: "screenMotion", label: "屏幕 3D", icon: "spark", height: 34, kind: "screenMotion" },
  { id: "sticker", label: "贴图", icon: "sticker", height: 34, kind: "sticker" },
  { id: "mosaic", label: "打码", icon: "wand", height: 34, kind: "mosaic" },
  { id: "mosaic", label: "打码", icon: "wand", height: 34, kind: "mosaic" },
  { id: "cameraMotion", label: "摄像运动", icon: "camera", height: 34, kind: "cameraMotion" },
  { id: "audioSystem", label: "系统声音", icon: "speaker", height: 34, kind: "audioSystem" },
  { id: "audioMicrophone", label: "麦克风", icon: "mic", height: 34, kind: "audioMicrophone" },
];

const state = {
  filmstrip: [],
  waveform: [],
  dragging: null,
  hoverSeam: null,
  /** Timeline time under the pointer, or null when the pointer is away.
      Pasting prefers this over the playhead, matching the original. */
  hoverTime: null,
};

/** Where a pasted clip should land: under the pointer, else the playhead. */
export function pasteTime() {
  return state.hoverTime != null ? state.hoverTime : store.playhead;
}

/* ------------------------------------------------------------------------- */
/* Build                                                                     */
/* ------------------------------------------------------------------------- */

export function mountTimeline(root) {
  root.innerHTML = `
    <div class="timeline-toolbar">
      <div class="toolbar-left" id="tl-left"></div>
      <div class="toolbar-center" id="tl-center"></div>
      <div class="toolbar-right" id="tl-right"></div>
    </div>
    <div class="timeline-body">
      <div class="track-headers" id="track-headers"></div>
      <div class="track-scroll" id="track-scroll">
        <div class="track-lanes" id="track-lanes"></div>
      </div>
    </div>
  `;

  buildToolbar();
  buildHeaders();
  buildLanes();

  const scroller = root.querySelector("#track-scroll");
  scroller.addEventListener("scroll", () => {
    store.scrollLeft = scroller.scrollLeft;
    paint();
  });
  scroller.addEventListener("wheel", onWheel, { passive: false });
  scroller.addEventListener("mousemove", (event) => {
    const lanes = document.getElementById("track-lanes");
    if (!lanes) return;
    const rect = lanes.getBoundingClientRect();
    state.hoverTime = Math.max(0, (event.clientX - rect.left) / pps());
  });
  scroller.addEventListener("mouseleave", () => {
    state.hoverTime = null;
  });
  scroller.addEventListener("mousemove", (event) => {
    const lanes = document.getElementById("track-lanes");
    if (!lanes) return;
    const rect = lanes.getBoundingClientRect();
    state.hoverTime = Math.max(0, (event.clientX - rect.left) / pps());
  });
  scroller.addEventListener("mouseleave", () => {
    state.hoverTime = null;
  });

  store.subscribe(() => paint());
  paint();
}

/* ------------------------------------------------------------------------- */
/* Toolbar                                                                   */
/* ------------------------------------------------------------------------- */

function buildToolbar() {
  const left = document.getElementById("tl-left");
  const center = document.getElementById("tl-center");
  const right = document.getElementById("tl-right");

  const split = toolbarButton("scissors", t("在播放头处分割主片段"), () => store.splitAtPlayhead());
  const del = toolbarButton("trash", t("删除当前时间线选中项"), () => store.deleteSelection());
  const copyButton = toolbarButton("copy", t("复制效果片段 / 在鼠标所指位置粘贴副本"), () => {
    if (!store.copySelection()) toast(t("当前不可用"), { icon: "info" });
  });
  copyButton.id = "btn-copy-clip";
  const pasteButton = toolbarButton("sticker", t("粘贴片段"), () => pasteClipboard());
  pasteButton.id = "btn-paste-clip";
  const attributesButton = toolbarButton(
    "wand",
    t("向选中的同类组件粘贴属性，保留位置与时长"),
    () => pasteAttributes()
  );
  attributesButton.id = "btn-paste-attributes";
  const magnet = toolbarButton("magnet", t("靠近边界吸附，继续拖动脱开；Shift 临时跳过"), () => {
    store.snapping = !store.snapping;
    paint();
  });
  magnet.dataset.toggle = "snap";
  const restore = toolbarButton(
    "refresh",
    t("恢复剪辑模式：点击显示所有剪切缝，方便合并片段或还原已删除内容"),
    () => {
      store.restoreCutMode = !store.restoreCutMode;
      paint();
    }
  );
  restore.dataset.toggle = "restore";
  const markers = toolbarButton("marker", t("快速找回重点与重录位置"), () => toggleMarkerList());
  markers.id = "btn-marker-list";

  const tabs = document.createElement("div");
  tabs.className = "segmented";
  tabs.innerHTML = `
    <button type="button" class="is-selected" data-tab="picture">${icon("image", 14)}<span>${t(
      "画面"
    )}</span></button>
    <button type="button" data-tab="waveform">${icon("wave", 14)}<span>${t("波形")}</span></button>
  `;
  tabs.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => {
      tabs.querySelectorAll("button").forEach((other) => other.classList.remove("is-selected"));
      button.classList.add("is-selected");
      store.filmstripMode = button.dataset.tab;
      paint();
    });
  });

  left.append(split, del, copyButton, pasteButton, attributesButton, magnet, restore, markers);
  left.appendChild(tabs);

  /* Transport */
  const prev = toolbarButton("prevFrame", t("上一帧"), () => step(-1));
  const play = toolbarButton("play", t("播放（空格）"), () => togglePlay());
  play.id = "btn-play";
  const next = toolbarButton("nextFrame", t("下一帧"), () => step(1));
  const timecode = document.createElement("span");
  timecode.className = "timecode tabular";
  timecode.id = "timecode";
  timecode.textContent = "00:00.00 / 00:00.00";
  center.append(prev, play, next, timecode);

  /* Right controls */
  const snapChip = document.createElement("button");
  snapChip.type = "button";
  snapChip.className = "chip";
  snapChip.id = "chip-snap";
  snapChip.innerHTML = `${icon("magnet", 13)}<span>${t("吸附")}</span>`;
  snapChip.addEventListener("click", () => {
    store.snapping = !store.snapping;
    paint();
  });

  const previewChip = document.createElement("button");
  previewChip.type = "button";
  previewChip.className = "chip";
  previewChip.id = "chip-preview";
  previewChip.innerHTML = `${icon("eye", 13)}<span>${t("预览")}</span>`;
  previewChip.addEventListener("click", () => {
    store.hoverPreview = !store.hoverPreview;
    paint();
  });

  const zoomOut = toolbarButton("zoomOut", t("缩小时间线"), () => setZoom(store.zoom / 1.25));
  const zoomIn = toolbarButton("zoomIn", t("放大时间线"), () => setZoom(store.zoom * 1.25));
  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.step = "1";
  slider.id = "timeline-zoom";
  slider.style.width = "110px";
  slider.addEventListener("input", () => {
    const value = Number(slider.value) / 100;
    setZoom(Math.pow(MAX_PPS / MIN_PPS, value) * (MIN_PPS / BASE_PPS));
  });

  right.append(snapChip, previewChip, zoomOut, slider, zoomIn);
}

function toolbarButton(iconName, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-ghost btn-icon";
  button.innerHTML = icon(iconName, 16);
  attachTooltip(button, title);
  button.addEventListener("click", onClick);
  return button;
}

/* ------------------------------------------------------------------------- */
/* Track headers                                                             */
/* ------------------------------------------------------------------------- */

function buildHeaders() {
  const headers = document.getElementById("track-headers");
  headers.innerHTML = "";
  headers.style.paddingTop = `${RULER_HEIGHT}px`;

  for (const track of TRACKS) {
    const row = document.createElement("div");
    row.className = "track-header";
    row.style.height = `${track.height}px`;
    row.dataset.track = track.id;
    row.innerHTML = `
      <span class="track-icon">${icon(track.icon, 14)}</span>
      <span class="track-name">${t(track.label)}</span>
      <span class="track-actions"></span>
    `;
    const actions = row.querySelector(".track-actions");
    const visibility = document.createElement("button");
    visibility.type = "button";
    visibility.className = "track-toggle";
    visibility.innerHTML = icon("eye", 13);
    visibility.dataset.visible = "true";
    attachTooltip(visibility, t("隐藏“%@”轨道；效果仍然生效", t(track.label)));
    visibility.addEventListener("click", () => {
      const visible = visibility.dataset.visible === "true";
      visibility.dataset.visible = String(!visible);
      visibility.innerHTML = icon(visible ? "eyeOff" : "eye", 13);
      visibility.style.opacity = visible ? "0.45" : "1";
    });
    actions.appendChild(visibility);

    row.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      selectTrack(track);
    });
    headers.appendChild(row);
  }
}

function selectTrack(track) {
  if (track.kind === "zoom") store.select("zoomTrack");
  else if (track.id === "screenMotion") store.select("screenMotionTrack");
  else if (track.id === "audioSystem") store.select("audio", "system");
  else if (track.id === "audioMicrophone") store.select("audio", "microphone");
  else if (track.id === "primary") store.select("canvas");
}

/* ------------------------------------------------------------------------- */
/* Lanes                                                                     */
/* ------------------------------------------------------------------------- */

function buildLanes() {
  const lanes = document.getElementById("track-lanes");
  lanes.innerHTML = "";

  const ruler = document.createElement("div");
  ruler.className = "ruler";
  ruler.id = "ruler";
  ruler.style.height = `${RULER_HEIGHT}px`;
  ruler.addEventListener("mousedown", onRulerDown);
  ruler.addEventListener("mousemove", (event) => {
    const rect = ruler.getBoundingClientRect();
    state.hoverTime = (event.clientX - rect.left + scrollLeft()) / pps();
    paintRulerHover();
  });
  ruler.addEventListener("mouseleave", () => {
    state.hoverTime = null;
    paintRulerHover();
  });
  lanes.appendChild(ruler);

  for (const track of TRACKS) {
    const lane = document.createElement("div");
    lane.className = `lane lane-${track.kind}`;
    lane.dataset.track = track.id;
    lane.style.height = `${track.height}px`;
    if (track.kind === "zoom" || track.kind === "screenMotion" || track.kind === "cameraMotion") {
      lane.addEventListener("mousedown", onEffectLaneDown);
    }
    lane.addEventListener("dblclick", (event) => {
      if (track.id !== "cameraMotion") return;
      const time = timeFromEvent(event, lane);
      addCameraSyncPoint(time);
    });
    lanes.appendChild(lane);
  }

  const playhead = document.createElement("div");
  playhead.className = "playhead";
  playhead.id = "playhead";
  playhead.innerHTML = `<span class="playhead-grip"></span>`;
  lanes.appendChild(playhead);
}

function pps() {
  return BASE_PPS * store.zoom;
}

function scrollLeft() {
  return document.getElementById("track-scroll")?.scrollLeft || 0;
}

function timeFromEvent(event, element) {
  const rect = element.getBoundingClientRect();
  return Math.max(0, (event.clientX - rect.left) / pps());
}

function xFromTime(time) {
  return time * pps();
}

/* ------------------------------------------------------------------------- */
/* Painting                                                                  */
/* ------------------------------------------------------------------------- */

export function paint() {
  if (!store.document) return;
  const lanes = document.getElementById("track-lanes");
  if (!lanes) return;

  const duration = store.duration;
  const width = Math.max(duration * pps() + 240, lanes.parentElement.clientWidth);
  lanes.style.width = `${width}px`;

  paintRuler(duration);
  for (const track of TRACKS) {
    const lane = lanes.querySelector(`.lane[data-track="${track.id}"]`);
    if (!lane) continue;
    lane.innerHTML = "";
    if (track.kind === "primary") paintPrimary(lane);
    else if (track.kind === "zoom") paintZoom(lane);
    else if (track.kind === "screenMotion") paintMotion(lane, "screenMotion");
    else if (track.kind === "cameraMotion") paintMotion(lane, "cameraMotion");
    else if (track.kind === "sticker") paintSticker(lane);
    else if (track.kind === "mosaic") paintMosaic(lane);
    else if (track.kind === "mosaic") paintMosaic(lane);
    else paintAudio(lane, track.id);
  }

  paintMarkers();
  paintPlayhead();
  paintToolbarState();

  const scroller = document.getElementById("track-scroll");
  if (scroller && store.scrollLeft && Math.abs(scroller.scrollLeft - store.scrollLeft) > 1) {
    scroller.scrollLeft = store.scrollLeft;
  }
}

function paintRuler(duration) {
  const ruler = document.getElementById("ruler");
  if (!ruler) return;
  const step = niceStep(pps());
  ruler.innerHTML = "";

  for (let time = 0; time <= duration + step; time += step) {
    const tick = document.createElement("div");
    tick.className = "ruler-tick";
    tick.style.left = `${xFromTime(time)}px`;
    tick.innerHTML = `<span class="tabular">${formatRulerTime(time)}</span>`;
    ruler.appendChild(tick);
  }
  paintRulerHover();
}

function paintRulerHover() {
  const ruler = document.getElementById("ruler");
  if (!ruler) return;
  let hover = ruler.querySelector(".ruler-hover");
  if (state.hoverTime == null) {
    hover?.remove();
    return;
  }
  if (!hover) {
    hover = document.createElement("div");
    hover.className = "ruler-hover";
    ruler.appendChild(hover);
  }
  hover.style.left = `${xFromTime(state.hoverTime)}px`;
  hover.textContent = formatTimecode(state.hoverTime);
}

function niceStep(pixelsPerSecond) {
  const candidates = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  for (const candidate of candidates) {
    if (candidate * pixelsPerSecond >= 68) return candidate;
  }
  return 600;
}

/* ---- Primary track ------------------------------------------------------ */

function paintPrimary(lane) {
  const clips = store.document.timeline.primaryClips;
  for (const clip of clips) {
    const duration = clipDuration(clip);
    const element = document.createElement("div");
    element.className = "clip clip-primary";
    element.dataset.id = clip.id;
    element.style.left = `${xFromTime(clip.startTime)}px`;
    element.style.width = `${Math.max(12, duration * pps())}px`;
    if (store.isPrimarySelected(clip.id)) element.classList.add("is-selected");

    const canvas = document.createElement("canvas");
    canvas.className = "filmstrip";
    element.appendChild(canvas);
    drawFilmstrip(canvas, clip, duration * pps());

    const label = document.createElement("span");
    label.className = "clip-label";
    label.textContent = `${formatTimecode(clip.sourceStart)} – ${formatTimecode(
      clip.sourceStart + clip.sourceDuration
    )}`;
    element.appendChild(label);

    const leftHandle = document.createElement("div");
    leftHandle.className = "clip-handle left";
    leftHandle.dataset.handle = "left";
    const rightHandle = document.createElement("div");
    rightHandle.className = "clip-handle right";
    rightHandle.dataset.handle = "right";
    element.append(leftHandle, rightHandle);

    element.addEventListener("mousedown", (event) => onPrimaryDown(event, clip));
    element.addEventListener("dblclick", (event) => {
      event.stopPropagation();
      if (event.altKey) return;
      store.setPlayhead(clip.startTime);
    });
    lane.appendChild(element);
  }

  if (store.restoreCutMode) {
    for (let index = 1; index < clips.length; index += 1) {
      const seam = document.createElement("div");
      seam.className = "cut-seam";
      seam.style.left = `${xFromTime(clips[index].startTime)}px`;
      seam.dataset.index = String(index);
      attachTooltip(seam, t("悬停剪切缝") + " · " + t("合并或还原该处剪切"));
      seam.addEventListener("click", () => mergeAt(index));
      lane.appendChild(seam);
    }
  }
}

function drawFilmstrip(canvas, clip, width) {
  const height = 46;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(2, Math.round(width * ratio));
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);

  const frames = state.filmstrip;
  if (!frames.length) {
    ctx.fillStyle = "#8b8f96";
    ctx.fillRect(0, 0, width, height);
    return;
  }

  const source = store.document.media?.screen;
  const total = store.document.timeline.duration || 1;
  const tileWidth = (height * 16) / 9;
  const count = Math.ceil(width / tileWidth);

  for (let index = 0; index < count; index += 1) {
    const localTime = (index + 0.5) / count;
    const sourceTime = clip.sourceStart + localTime * clip.sourceDuration;
    const frameIndex = clamp(
      Math.floor((sourceTime / Math.max(source.duration || total, 0.001)) * frames.length),
      0,
      frames.length - 1
    );
    const image = frames[frameIndex];
    if (image) {
      try {
        ctx.drawImage(image, index * tileWidth, 0, tileWidth, height);
      } catch {
        /* frame not decodable yet */
      }
    }
  }
}

/* ---- Zoom track --------------------------------------------------------- */

function paintZoom(lane) {
  for (const clip of store.document.timeline.zoomClips) {
    const element = document.createElement("div");
    element.className = "clip clip-zoom";
    element.dataset.id = clip.id;
    element.style.left = `${xFromTime(clip.startTime)}px`;
    element.style.width = `${Math.max(16, clip.duration * pps())}px`;
    if (store.isSelected("zoom", clip.id)) element.classList.add("is-selected");
    element.innerHTML = `
      <div class="clip-handle left" data-handle="left"></div>
      <span class="clip-title">${t("缩放")} ${clip.scale.toFixed(1)}× · ${t(clip.mode)}</span>
      <div class="clip-handle right" data-handle="right"></div>
    `;
    element.addEventListener("mousedown", (event) => onEffectClipDown(event, "zoom", clip));
    lane.appendChild(element);
  }
}

function paintMotion(lane, kind) {
  const list =
    kind === "screenMotion"
      ? store.document.timeline.screenMotionClips
      : store.document.timeline.cameraMotionClips;
  for (const clip of list) {
    const element = document.createElement("div");
    element.className = `clip clip-${kind === "screenMotion" ? "screen3d" : "cameramotion"}`;
    element.dataset.id = clip.id;
    element.style.left = `${xFromTime(clip.startTime)}px`;
    element.style.width = `${Math.max(16, clip.duration * pps())}px`;
    if (store.isSelected(kind, clip.id)) element.classList.add("is-selected");
    const label = kind === "screenMotion" ? t("屏幕 3D") : t("摄像运动");
    element.innerHTML = `
      <div class="clip-handle left" data-handle="left"></div>
      <span class="clip-title">${label}</span>
      <div class="clip-handle right" data-handle="right"></div>
    `;
    element.addEventListener("mousedown", (event) => onEffectClipDown(event, kind, clip));
    lane.appendChild(element);
  }
}

function paintSticker(lane) {
  for (const clip of store.document.timeline.stickerClips) {
    const element = document.createElement("div");
    element.className = "clip clip-sticker";
    element.dataset.id = clip.id;
    element.style.left = `${xFromTime(clip.startTime)}px`;
    element.style.width = `${Math.max(16, clip.duration * pps())}px`;
    if (store.isSelected("sticker", clip.id)) element.classList.add("is-selected");
    element.innerHTML = `
      <div class="clip-handle left" data-handle="left"></div>
      <span class="clip-title">${t("贴图 · 层 %lld", clip.layer + 1)}</span>
      <div class="clip-handle right" data-handle="right"></div>
    `;
    element.addEventListener("mousedown", (event) => onEffectClipDown(event, "sticker", clip));
    lane.appendChild(element);
  }
}

function paintMosaic(lane) {
  for (const clip of store.document.timeline.mosaicClips) {
    const element = document.createElement("div");
    element.className = "clip clip-mosaic";
    element.dataset.id = clip.id;
    element.style.left = `${xFromTime(clip.startTime)}px`;
    element.style.width = `${Math.max(16, clip.duration * pps())}px`;
    if (store.isSelected("mosaic", clip.id)) element.classList.add("is-selected");
    element.innerHTML = `
      <div class="clip-handle left" data-handle="left"></div>
      <span class="clip-title">${t(clip.style)}</span>
      <div class="clip-handle right" data-handle="right"></div>
    `;
    element.addEventListener("mousedown", (event) => onEffectClipDown(event, "mosaic", clip));
    lane.appendChild(element);
  }
}

function paintAudio(lane, trackId) {
  const role = trackId === "audioSystem" ? "system" : "microphone";
  const entry = store.document.media?.[role];
  if (!entry) {
    const empty = document.createElement("div");
    empty.className = "lane-empty";
    empty.textContent = t("没有音频轨");
    lane.appendChild(empty);
    return;
  }
  const clips = store.document.timeline.primaryClips;
  for (const clip of clips) {
    const element = document.createElement("div");
    element.className = "clip clip-audio";
    element.style.left = `${xFromTime(clip.startTime)}px`;
    element.style.width = `${Math.max(12, clipDuration(clip) * pps())}px`;
    element.dataset.role = role;
    const canvas = document.createElement("canvas");
    canvas.className = "waveform";
    element.appendChild(canvas);
    drawWaveform(canvas, clip, clipDuration(clip) * pps());
    lane.appendChild(element);
  }
}

function drawWaveform(canvas, clip, width) {
  const height = 26;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.max(2, Math.round(width * ratio));
  canvas.height = Math.round(height * ratio);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  ctx.scale(ratio, ratio);

  const peaks = state.waveform;
  ctx.strokeStyle = "rgba(255,255,255,0.72)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  if (!peaks.length) {
    ctx.moveTo(0, height / 2);
    ctx.lineTo(width, height / 2);
  } else {
    const total = store.document.timeline.duration || 1;
    for (let x = 0; x < width; x += 1) {
      const sourceTime = clip.sourceStart + (x / Math.max(width, 1)) * clip.sourceDuration;
      const index = clamp(
        Math.floor((sourceTime / Math.max(total, 0.001)) * peaks.length),
        0,
        peaks.length - 1
      );
      const amplitude = (peaks[index] || 0) * (height / 2 - 1);
      ctx.moveTo(x, height / 2 - amplitude);
      ctx.lineTo(x, height / 2 + amplitude);
    }
  }
  ctx.stroke();
}

/* ---- Markers & playhead ------------------------------------------------- */

function paintMarkers() {
  const ruler = document.getElementById("ruler");
  if (!ruler) return;
  ruler.querySelectorAll(".marker").forEach((node) => node.remove());
  for (const marker of store.document.markers || []) {
    const node = document.createElement("div");
    node.className = "marker";
    node.style.left = `${xFromTime(marker.time)}px`;
    node.innerHTML = icon("marker", 12);
    attachTooltip(node, t("录制标记：点击跳转；标尺上右键可删除"));
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      store.setPlayhead(marker.time);
    });
    node.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      store.select("marker", marker.id);
      store.deleteSelection();
    });
    ruler.appendChild(node);
  }
}

function paintPlayhead() {
  const playhead = document.getElementById("playhead");
  if (!playhead) return;
  playhead.style.left = `${xFromTime(store.playhead)}px`;
}

function paintToolbarState() {
  const timecode = document.getElementById("timecode");
  if (timecode) {
    timecode.textContent = `${formatTimecode(store.playhead)} / ${formatTimecode(store.duration)}`;
  }
  const play = document.getElementById("btn-play");
  if (play) play.innerHTML = icon(store.playing ? "pause" : "play", 16);

  const snapChip = document.getElementById("chip-snap");
  if (snapChip) snapChip.classList.toggle("is-on", store.snapping);
  const previewChip = document.getElementById("chip-preview");
  if (previewChip) previewChip.classList.toggle("is-on", store.hoverPreview);

  const magnet = document.querySelector('[data-toggle="snap"]');
  if (magnet) magnet.style.color = store.snapping ? "" : "var(--secondary-text)";
  const restore = document.querySelector('[data-toggle="restore"]');
  if (restore) restore.classList.toggle("is-active", store.restoreCutMode);

  const slider = document.getElementById("timeline-zoom");
  if (slider && document.activeElement !== slider) {
    const normalized =
      Math.log((pps() / BASE_PPS) * (BASE_PPS / MIN_PPS)) / Math.log(MAX_PPS / MIN_PPS);
    slider.value = String(Math.round(normalized * 100));
  }
}

/* ------------------------------------------------------------------------- */
/* Interactions                                                              */
/* ------------------------------------------------------------------------- */

function onRulerDown(event) {
  const ruler = event.currentTarget;
  const seek = (clientX) => {
    const rect = ruler.getBoundingClientRect();
    store.setPlayhead(Math.max(0, (clientX - rect.left) / pps()));
  };
  seek(event.clientX);
  const move = (moveEvent) => seek(moveEvent.clientX);
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function onPrimaryDown(event, clip) {
  event.stopPropagation();
  const handle = event.target.closest(".clip-handle");
  const index = store.clipIndex(clip.id);

  if (event.altKey && !handle) {
    const time = timeFromEvent(event, event.currentTarget.parentElement);
    store.setPlayhead(time);
    store.splitAtPlayhead();
    return;
  }

  /* Shift extends the range, Ctrl adds or removes one clip — the same
     modifiers the original documents for 主片段. */
  store.selectPrimary(clip.id, {
    additive: event.ctrlKey || event.metaKey,
    range: event.shiftKey,
  });
  if (!handle) return;

  const startX = event.clientX;
  const original = { ...clip };
  const siblings = store.document.timeline.primaryClips;
  const previous = siblings[index - 1];
  const next = siblings[index + 1];
  store.beginGesture();

  const move = (moveEvent) => {
    const deltaSeconds = (moveEvent.clientX - startX) / pps();
    store.apply((doc) => {
      const target = doc.timeline.primaryClips[index];
      if (!target) return;
      if (handle.classList.contains("left")) {
        const maxTrim = original.sourceDuration - 0.15;
        const availableBefore = previous
          ? (original.sourceStart - (previous.sourceStart + previous.sourceDuration)) /
            (original.speed || 1)
          : original.sourceStart / (original.speed || 1);
        const trim = clamp(deltaSeconds, -availableBefore, maxTrim);
        target.sourceStart = original.sourceStart + trim * (original.speed || 1);
        target.sourceDuration = original.sourceDuration - trim * (original.speed || 1);
      } else {
        const maxExtend = store.document.media?.screen?.duration
          ? (store.document.media.screen.duration -
              (original.sourceStart + original.sourceDuration)) /
            (original.speed || 1)
          : 0;
        const availableAfter = next
          ? (next.sourceStart - (original.sourceStart + original.sourceDuration)) /
            (original.speed || 1)
          : maxExtend;
        const trim = clamp(deltaSeconds, -original.sourceDuration + 0.15, Math.max(0, availableAfter));
        target.sourceDuration = original.sourceDuration + trim * (original.speed || 1);
      }
      doc.timeline.primaryClips = reflowClips(doc.timeline.primaryClips);
    });
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    store.commitGesture(handle.classList.contains("left") ? "裁切主片段左端" : "裁切主片段右端");
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function onEffectLaneDown(event) {
  if (event.target.closest(".clip")) return;
  const lane = event.currentTarget;
  const kind = lane.classList.contains("lane-zoom")
    ? "zoom"
    : lane.classList.contains("lane-screenMotion")
      ? "screenMotion"
      : "cameraMotion";
  const startTime = timeFromEvent(event, lane);
  const startX = event.clientX;
  let created = false;

  const move = (moveEvent) => {
    const delta = Math.abs(moveEvent.clientX - startX);
    if (!created && delta > 5) {
      created = true;
      createEffectClip(kind, startTime);
    }
    if (created) {
      const current = timeFromEvent(moveEvent, lane);
      const from = Math.min(startTime, current);
      const duration = Math.max(0.4, Math.abs(current - startTime));
      const clip = latestEffectClip(kind);
      if (!clip) return;
      store.apply(() => {
        clip.startTime = from;
        clip.duration = duration;
      });
    }
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    if (created) store.commitGesture(t("添加缩放"));
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

function latestEffectClip(kind) {
  const doc = store.document;
  if (kind === "zoom") return doc.timeline.zoomClips[doc.timeline.zoomClips.length - 1];
  if (kind === "screenMotion") return doc.timeline.screenMotionClips[doc.timeline.screenMotionClips.length - 1];
  return doc.timeline.cameraMotionClips[doc.timeline.cameraMotionClips.length - 1];
}

export function createEffectClip(kind, startTime, duration = 1.6) {
  const store_ = store;
  store_.commit(kind === "zoom" ? t("添加缩放") : kind === "screenMotion" ? t("添加屏幕 3D") : t("添加摄像运动"), (doc) => {
    const base = {
      id: crypto.randomUUID(),
      startTime: Math.max(0, startTime),
      duration,
      transitionIn: doc.motion.defaultZoomTransitionDuration,
      transitionOut: doc.motion.defaultZoomTransitionDuration,
      easing: doc.motion.defaultZoomEasing,
    };
    if (kind === "zoom") {
      const point = pointerNear(doc, startTime);
      doc.timeline.zoomClips.push({
        ...base,
        mode: "自动",
        focus: point,
        scale: doc.motion.defaultZoomScale || 1.4,
      });
      doc.timeline.zoomClips.sort((a, b) => a.startTime - b.startTime);
      store_.select("zoom", base.id);
    } else if (kind === "screenMotion") {
      doc.timeline.screenMotionClips.push({
        ...base,
        target: {
          position: { ...doc.canvas.contentPosition },
          scale: 1.08,
          rotation: 0,
          tiltX: 0,
          tiltY: 0,
          perspective: 0.5,
          opacity: 1,
          cornerRadius: doc.canvas.cornerRadius,
        },
      });
      doc.timeline.screenMotionClips.sort((a, b) => a.startTime - b.startTime);
      store_.select("screenMotion", base.id);
    } else {
      doc.timeline.cameraMotionClips.push({
        ...base,
        target: {
          position: { ...doc.camera.position },
          scale: 1,
          rotation: 0,
          tiltX: 0,
          tiltY: 0,
          perspective: 0.5,
          opacity: 1,
          cornerRadius: 0,
        },
      });
      doc.timeline.cameraMotionClips.sort((a, b) => a.startTime - b.startTime);
      store_.select("cameraMotion", base.id);
    }
  });
}

/** Nearest recorded pointer position, used to seed an automatic zoom focus. */
function pointerNear(doc, time) {
  const samples = doc.pointerTrack?.samples || [];
  if (!samples.length) return { x: 0.5, y: 0.5 };
  let best = samples[0];
  let bestDistance = Infinity;
  for (const sample of samples) {
    const distance = Math.abs(sample.t - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = sample;
    }
  }
  return { x: clamp(best.x, 0, 1), y: clamp(best.y, 0, 1) };
}

function onEffectClipDown(event, kind, clip) {
  event.stopPropagation();
  store.select(kind, clip.id);
  const handle = event.target.closest(".clip-handle");
  const startX = event.clientX;
  const original = { ...clip };
  store.beginGesture();

  const move = (moveEvent) => {
    const delta = (moveEvent.clientX - startX) / pps();
    store.apply(() => {
      const target = store.clipFor(kind, clip.id);
      if (!target) return;
      if (!handle) {
        target.startTime = Math.max(0, original.startTime + delta);
      } else if (handle.classList.contains("left")) {
        const trim = clamp(delta, -original.startTime, original.duration - 0.2);
        target.startTime = original.startTime + trim;
        target.duration = original.duration - trim;
      } else {
        target.duration = Math.max(0.2, original.duration + delta);
      }
    });
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    store.commitGesture(handle ? t("调整缩放时间") : t("移动缩放"));
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/**
 * Pastes the copied clip. The original places it under the pointer when the
 * pointer is over the timeline and reports why it could not fit otherwise.
 */
export function pasteClipboard() {
  const result = store.pasteClipboard(pasteTime());
  if (result.ok) return true;
  const messages = {
    empty: t("当前不可用"),
    "no-room": t("此位置到片尾的时长不足，无法粘贴完整片段。请选择更靠前的位置。"),
    occupied: t("此处已有同轨道动画，无法粘贴完整片段。请在足够长的空白处粘贴。"),
    "no-camera": t("当前项目没有摄像头素材，无法粘贴摄像运动片段。"),
    unsupported: t("当前不可用"),
  };
  toast(messages[result.reason] || t("当前不可用"), { icon: "info", duration: 3600 });
  return false;
}

export function pasteAttributes() {
  const result = store.pasteAttributes();
  if (result.ok) return true;
  toast(t("向选中的同类组件粘贴属性，保留位置与时长"), { icon: "info" });
  return false;
}

/**
 * Merges two adjacent primary clips, restoring a cut seam.
 */
function mergeAt(index) {
  store.commit(t("还原该处剪切"), (doc) => {
    const clips = doc.timeline.primaryClips;
    const previous = clips[index - 1];
    const current = clips[index];
    if (!previous || !current) return;
    const merged = {
      ...previous,
      sourceDuration: previous.sourceDuration + current.sourceDuration,
    };
    doc.timeline.primaryClips = reflowClips([
      ...clips.slice(0, index - 1),
      merged,
      ...clips.slice(index + 1),
    ]);
  });
}

function addCameraSyncPoint(time) {
  store.commit(t("添加摄像头同步点"), (doc) => {
    doc.timeline.cameraMotionClips.push({
      id: crypto.randomUUID(),
      startTime: Math.max(0, time),
      duration: 0.4,
      transitionIn: 0.1,
      transitionOut: 0.1,
      easing: "linear",
      target: {
        position: { ...doc.camera.position },
        scale: 1,
        rotation: 0,
        tiltX: 0,
        tiltY: 0,
        perspective: 0.5,
        opacity: 1,
        cornerRadius: 0,
      },
    });
    doc.timeline.cameraMotionClips.sort((a, b) => a.startTime - b.startTime);
  });
}

function onWheel(event) {
  if (event.ctrlKey || event.metaKey) {
    event.preventDefault();
    const scroller = event.currentTarget;
    const rect = scroller.getBoundingClientRect();
    const anchorX = event.clientX - rect.left + scroller.scrollLeft;
    const anchorTime = anchorX / pps();
    setZoom(store.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12));
    scroller.scrollLeft = anchorTime * pps() - (event.clientX - rect.left);
    store.scrollLeft = scroller.scrollLeft;
  }
}

export function setZoom(value) {
  store.zoom = clamp(value, MIN_PPS / BASE_PPS, MAX_PPS / BASE_PPS);
  paint();
}

export function step(frames) {
  const fps = 30;
  store.setPlayhead(store.playhead + frames / fps);
}

/* ------------------------------------------------------------------------- */
/* Playback                                                                  */
/* ------------------------------------------------------------------------- */

let rafId = null;
let lastTick = 0;

export function togglePlay() {
  if (store.playing) stopPlayback();
  else startPlayback();
}

export function startPlayback() {
  if (!store.document) return;
  if (store.playhead >= store.duration - 0.01) store.setPlayhead(0);
  store.playing = true;
  lastTick = performance.now();
  syncMedia(true);
  rafId = requestAnimationFrame(tick);
  store.notify("play");
}

export function stopPlayback() {
  store.playing = false;
  if (rafId) cancelAnimationFrame(rafId);
  rafId = null;
  syncMedia(false);
  store.notify("play");
}

function tick(now) {
  if (!store.playing) return;
  const delta = (now - lastTick) / 1000;
  lastTick = now;
  const next = store.playhead + delta;
  if (next >= store.duration) {
    store.setPlayhead(store.duration);
    stopPlayback();
    return;
  }
  store.playhead = next;
  syncMedia(true);
  store.notify("tick");
  rafId = requestAnimationFrame(tick);
}

/** Keeps the recorded media elements aligned with the playhead. */
export function syncMedia(playing) {
  const doc = store.document;
  if (!doc) return;
  const time = store.playhead;
  const sourceTime = store.sourceTime(time);

  const screen = store.media.screen;
  if (screen && Math.abs((screen.currentTime || 0) - sourceTime) > 0.12) {
    try {
      screen.currentTime = sourceTime;
    } catch {
      /* seeking before metadata is ready */
    }
  }
  const camera = store.media.camera;
  if (camera && Math.abs((camera.currentTime || 0) - sourceTime) > 0.12) {
    try {
      camera.currentTime = sourceTime;
    } catch {
      /* same */
    }
  }

  for (const role of ["system", "microphone"]) {
    const audio = store.media[role];
    if (!audio) continue;
    const muted = role === "system" ? doc.audio.isSystemMuted : doc.audio.isMicrophoneMuted;
    const volume = role === "system" ? doc.audio.systemVolume : doc.audio.microphoneVolume;
    audio.volume = muted ? 0 : volume;
    if (playing) {
      if (Math.abs((audio.currentTime || 0) - sourceTime) > 0.25) {
        try {
          audio.currentTime = sourceTime;
        } catch {
          /* same */
        }
      }
      if (audio.paused) audio.play().catch(() => {});
    } else if (!audio.paused) {
      audio.pause();
    }
  }

  if (playing) {
    if (screen?.paused) screen.play().catch(() => {});
    if (camera?.paused) camera.play().catch(() => {});
  } else {
    if (screen && !screen.paused) screen.pause();
    if (camera && !camera.paused) camera.pause();
  }
}

/* ------------------------------------------------------------------------- */
/* Filmstrip + waveform analysis                                             */
/* ------------------------------------------------------------------------- */

export async function buildFilmstrip() {
  const video = store.media.screen;
  if (!video) return;
  const count = 24;
  const duration = video.duration && Number.isFinite(video.duration)
    ? video.duration
    : store.document.media?.screen?.duration || 1;
  const frames = [];
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext("2d");

  for (let index = 0; index < count; index += 1) {
    const time = (index / count) * duration;
    try {
      await seekVideo(video, time);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const image = new Image();
      image.src = canvas.toDataURL("image/jpeg", 0.7);
      await image.decode().catch(() => {});
      frames.push(image);
    } catch {
      /* skip frames that cannot be decoded */
    }
  }
  state.filmstrip = frames;
  paint();
}

function seekVideo(video, time) {
  return new Promise((resolve) => {
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
    setTimeout(done, 900);
  });
}

/**
 * Builds the audio waveform.
 *
 * Decoding happens on an `OfflineAudioContext`, not a live one: analysing a
 * file needs no audio device, and a live context fails outright on a machine
 * with none ("The AudioContext encountered an error from the audio device"),
 * which would leave the track without a waveform for no good reason. An
 * offline context is also silent by construction, so this can never make a
 * sound while the user is editing.
 */
export async function buildWaveform() {
  const audio = store.media.system || store.media.microphone;
  if (!audio) return;
  const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!OfflineContext) return;

  try {
    const response = await fetch(audio.src);
    const buffer = await response.arrayBuffer();
    /* One channel and one frame is plenty — only `decodeAudioData` is used. */
    const context = new OfflineContext(1, 1, 44100);
    const decoded = await context.decodeAudioData(buffer);
    const channel = decoded.getChannelData(0);
    const buckets = 900;
    const blockSize = Math.floor(channel.length / buckets) || 1;
    const peaks = new Array(buckets).fill(0);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      let peak = 0;
      const start = bucket * blockSize;
      for (let i = 0; i < blockSize; i += 1) {
        const value = Math.abs(channel[start + i] || 0);
        if (value > peak) peak = value;
      }
      peaks[bucket] = peak;
    }
    state.waveform = peaks;
    paint();
  } catch (error) {
    console.warn("[timeline] waveform analysis failed", error?.message || error);
  }
}

/* ------------------------------------------------------------------------- */
/* Marker list                                                               */
/* ------------------------------------------------------------------------- */

function toggleMarkerList() {
  const existing = document.getElementById("marker-list");
  if (existing) {
    existing.remove();
    return;
  }
  const list = document.createElement("div");
  list.id = "marker-list";
  list.className = "popover";
  const header = document.createElement("div");
  header.className = "menu-header";
  header.textContent = `${t("录制标记")} · ${(store.document.markers || []).length}`;
  list.appendChild(header);

  for (const marker of store.document.markers || []) {
    const row = document.createElement("div");
    row.className = "menu-item";
    row.innerHTML = `<span class="menu-check">${icon("marker", 13)}</span><span>${t(
      "标记 %d",
      (store.document.markers.indexOf(marker) + 1)
    )}</span><span class="menu-note tabular">${formatTimecode(marker.time)}</span>`;
    row.addEventListener("click", () => {
      store.setPlayhead(marker.time);
      list.remove();
    });
    list.appendChild(row);
  }

  if (!(store.document.markers || []).length) {
    const empty = document.createElement("div");
    empty.className = "menu-item";
    empty.style.color = "var(--secondary-text)";
    empty.textContent = t("未删除素材");
    list.appendChild(empty);
  }

  document.body.appendChild(list);
  const anchor = document.getElementById("btn-marker-list");
  const rect = anchor.getBoundingClientRect();
  list.style.left = `${rect.left}px`;
  list.style.top = `${rect.top - list.offsetHeight - 6}px`;
  setTimeout(() => {
    const close = (event) => {
      if (!list.contains(event.target)) {
        list.remove();
        document.removeEventListener("mousedown", close, true);
      }
    };
    document.addEventListener("mousedown", close, true);
  }, 0);
}

export { state as timelineState, TRACKS };
