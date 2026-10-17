/**
 * Inspector.
 *
 * Port of `EditorInspectorView` and its per-tool companions. Six tools, each
 * with the sections the original groups them into:
 *   画面 (背景 / 布局 / 样机) · 开场 · 运镜 · 光标 · 摄像头 · 声音
 */

import { icon } from "../../shared/icons.js";
import { t } from "../../shared/i18n.js";
import {
  attachTooltip,
  choiceGroup,
  clamp,
  isControlDragging,
  segmented,
  showMenu,
  sliderRow,
  switchRow,
  textField,
  toast,
} from "../../shared/widgets.js";
import {
  BACKGROUND_PATTERNS,
  CAMERA_SHAPES,
  CLICK_EFFECTS,
  CURSOR_ASSETS,
  CURSOR_PRESET_COLORS,
  DYNAMIC_BACKGROUNDS,
  MOTION_CURVES,
  OPENING_ELEMENTS,
  OPENING_PRESETS,
  SCREEN_FRAMES,
  SPEED_PRESETS,
  STICKER_ANIMATIONS_IN,
  STICKER_ANIMATIONS_OUT,
  easeProgress,
  evaluateClip,
  rid,
} from "./model.js";
import {
  pointerAt,
  drawClickEffect,
  drawCursorShape,
  cursorThemeColor,
} from "./frame-renderer.js";
import { createEffectClip, startPlayback, togglePlay } from "./timeline.js";
import { store } from "./store.js";

const TOOLS = [
  { id: "frame", label: "画面", icon: "screen" },
  { id: "opening", label: "开场", icon: "opening" },
  { id: "zoom", label: "运镜", icon: "viewfinder" },
  { id: "cursor", label: "光标", icon: "cursor" },
  { id: "camera", label: "摄像头", icon: "camera" },
  { id: "audio", label: "声音", icon: "speaker" },
];

const FRAME_TABS = [
  { id: "background", label: "背景", icon: "layers" },
  { id: "layout", label: "布局", icon: "inset" },
  { id: "mockup", label: "样机", icon: "mockup" },
];

const state = { tool: "frame", frameTab: "background", backgroundTab: "pattern" };

/* Custom canvas/bar gestures in this panel ask the store subscription to hold
   off rebuilding while they run — exactly like the native-slider guard in
   widgets.js: the element under the pointer must survive the gesture. */
let inspectorDragging = false;

/* Live painter for the zoom envelope, so its playhead dot follows playback
   while tick/playhead notifications skip the full rebuild. Reassigned by
   paintInspector and cleared whenever the panel is rebuilt. */
let envelopeSync = null;

/* ------------------------------------------------------------------------- */
/* Rail                                                                      */
/* ------------------------------------------------------------------------- */

function applyRailAvailability(button, tool) {
  const available = isToolAvailable(tool.id);
  button.disabled = !available;
  button.style.opacity = available ? "" : "0.38";
  return available;
}

export function mountRail(root) {
  root.innerHTML = "";
  for (const tool of TOOLS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rail-button";
    button.dataset.tool = tool.id;
    button.innerHTML = `${icon(tool.icon, 19)}<span>${t(tool.label)}</span>`;
    applyRailAvailability(button, tool);
    /* Resolved when the tooltip is shown, not now: the rail is mounted before
       the project finishes loading, so the reason has to be able to change. */
    attachTooltip(button, () =>
      isToolAvailable(tool.id) ? t(tool.label) : unavailableReason(tool.id)
    );
    button.addEventListener("click", () => {
      state.tool = tool.id;
      paintRail();
      paintInspector();
    });
    root.appendChild(button);
  }
  paintRail();
}

/**
 * Re-evaluates which tools the loaded project makes available.
 *
 * The rail is built before `store.load()` resolves, so camera, audio and
 * cursor stayed greyed out — tooltip and all — however complete the project
 * actually was. Called once the document arrives.
 */
export function refreshRailAvailability() {
  for (const button of document.querySelectorAll(".rail-button")) {
    const tool = TOOLS.find((entry) => entry.id === button.dataset.tool);
    if (tool) applyRailAvailability(button, tool);
  }
}

function paintRail() {
  document.querySelectorAll(".rail-button").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.tool === state.tool);
  });
}

function isToolAvailable(tool) {
  if (tool === "camera") return Boolean(store.document?.media?.camera);
  if (tool === "audio") {
    return Boolean(store.document?.media?.system || store.document?.media?.microphone);
  }
  if (tool === "cursor") return Boolean(store.document?.pointerTrack?.samples?.length);
  return true;
}

function unavailableReason(tool) {
  if (tool === "camera") return t("当前项目没有摄像头素材");
  if (tool === "audio") return t("当前项目没有系统声音或麦克风素材");
  return t("当前项目没有记录鼠标事件");
}

/* ------------------------------------------------------------------------- */
/* Inspector body                                                            */
/* ------------------------------------------------------------------------- */

export function mountInspector(root) {
  root.innerHTML = `
    <div class="inspector-head">
      <span class="inspector-title" id="inspector-title">${t("画面")}</span>
      <span class="inspector-scope" id="inspector-scope">${t("全片")}</span>
    </div>
    <div class="inspector-body" id="inspector-body"></div>
  `;
  /* Rebuilding the surface mid-drag would remove the control under the pointer
     and cancel the gesture, which is why a held slider used to snap back to
     click-only stepping. The value is applied continuously either way; the
     repaint happens once the gesture ends.
     High-frequency notifications are also skipped: during playback `tick`
     fires every frame and scrubbing fires `playhead` every frame — rebuilding
     this panel for those used to flicker the whole inspector and burn CPU for
     nothing. The timeline and the preview repaint themselves for those. */
  store.subscribe((_store, reason) => {
    if (isControlDragging() || inspectorDragging) return;
    if (
      reason === "tick" ||
      reason === "playhead" ||
      reason === "play" ||
      reason === "saved" ||
      reason === "save-state" ||
      reason === "clipboard"
    ) {
      /* The envelope's playhead dot follows playback without a rebuild. */
      if ((reason === "tick" || reason === "playhead") && envelopeSync) envelopeSync();
      return;
    }
    paintInspector();
  });
  paintInspector();
}

export function paintInspector() {
  const body = document.getElementById("inspector-body");
  const title = document.getElementById("inspector-title");
  const scope = document.getElementById("inspector-scope");
  if (!body || !store.document) return;
  envelopeSync = null;

  const tool = TOOLS.find((entry) => entry.id === state.tool) || TOOLS[0];
  title.textContent = t(tool.label);
  scope.textContent = scopeLabel();
  body.innerHTML = "";

  /* Selecting a sticker or a redaction clip takes over the inspector: those
     clips carry their own authoring surface in the original, independent of
     which tool tab was last open. */
  if (store.selection.kind === "sticker" && store.selectedSticker()) {
    title.textContent = t("贴图");
    renderStickerTool(body, store.selectedSticker());
    return;
  }
  if (store.selection.kind === "mosaic" && store.selectedMosaic()) {
    title.textContent = t("打码");
    renderMosaicTool(body, store.selectedMosaic());
    return;
  }

  switch (state.tool) {
    case "frame":
      renderFrameTool(body);
      break;
    case "opening":
      renderOpeningTool(body);
      break;
    case "zoom":
      renderMotionTool(body);
      break;
    case "cursor":
      renderCursorTool(body);
      break;
    case "camera":
      renderCameraTool(body);
      break;
    case "audio":
      renderAudioTool(body);
      break;
    default:
      break;
  }
}

function scopeLabel() {
  const { kind, id } = store.selection;
  if (kind === "zoom") return t("缩放动画 %d", store.document.timeline.zoomClips.indexOf(store.findZoom(id)) + 1);
  if (kind === "screenMotion") return t("屏幕 3D %d", store.document.timeline.screenMotionClips.indexOf(store.findScreenMotion(id)) + 1);
  if (kind === "cameraMotion") return t("摄像运动 %d", store.document.timeline.cameraMotionClips.indexOf(store.findCameraMotion(id)) + 1);
  if (kind === "primary") return t("片段 %d", store.clipIndex(id) + 1);
  if (kind === "sticker") return t("贴图 · 层 %lld", (store.findSticker(id)?.layer ?? 0) + 1);
  if (kind === "camera") return t("摄像头");
  if (kind === "audio") return t("全片声音");
  if (state.tool === "cursor") return t("全片");
  if (state.tool === "opening") return t("全片");
  return t("全片");
}

function section(title, hint) {
  const wrapper = document.createElement("section");
  wrapper.className = "inspector-section";
  const heading = document.createElement("h3");
  heading.className = "section-title";
  heading.textContent = title;
  wrapper.appendChild(heading);
  if (hint) {
    const note = document.createElement("p");
    note.className = "section-hint";
    note.textContent = hint;
    wrapper.appendChild(note);
  }
  return wrapper;
}

function group(parent, children) {
  const box = document.createElement("div");
  box.className = "group";
  for (const child of children) if (child) box.appendChild(child);
  parent.appendChild(box);
  return box;
}

/* ------------------------------------------------------------------------- */
/* 画面                                                                      */
/* ------------------------------------------------------------------------- */

function renderFrameTool(body) {
  const tabs = segmented(
    FRAME_TABS.map((entry) => ({ value: entry.id, label: t(entry.label), icon: entry.icon })),
    state.frameTab,
    (value) => {
      state.frameTab = value;
      paintInspector();
    }
  );
  tabs.style.width = "100%";
  body.appendChild(tabs);

  if (state.frameTab === "background") renderBackground(body);
  else if (state.frameTab === "layout") renderLayout(body);
  else renderMockup(body);
}

function renderBackground(body) {
  const canvas = store.document.canvas;
  const source = canvas.backgroundSource || {};

  const tabs = document.createElement("div");
  tabs.className = "choice-row";
  const options = [
    { id: "wallpaper", label: t("壁纸"), icon: "photo" },
    { id: "pattern", label: t("网格"), icon: "grid" },
    { id: "dynamic", label: t("动效"), icon: "wave" },
    { id: "image", label: t("自定"), icon: "photoPlus" },
  ];
  if (["projectImage", "systemImage", "projectVideo", "systemVideo"].includes(source.kind)) {
    state.backgroundTab = "image";
  } else if (source.kind === "dynamicFlow") {
    state.backgroundTab = "dynamic";
  } else if (source.kind === "pattern") {
    state.backgroundTab = "pattern";
  }
  for (const option of options) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "choice";
    if (state.backgroundTab === option.id) button.classList.add("is-selected");
    button.innerHTML = `${icon(option.icon, 15)}<span>${option.label}</span>`;
    button.addEventListener("click", () => {
      state.backgroundTab = option.id;
      if (option.id === "pattern") {
        store.commit(t("选择纹理网格"), (doc) => {
          doc.canvas.backgroundSource = {
            kind: "pattern",
            patternPreset: doc.canvas.backgroundSource.patternPreset || BACKGROUND_PATTERNS[0],
          };
        });
      } else if (option.id === "dynamic") {
        store.commit(t("选择动态背景"), (doc) => {
          doc.canvas.backgroundSource = {
            kind: "dynamicFlow",
            dynamicPreset: DYNAMIC_BACKGROUNDS[0],
          };
        });
      } else if (option.id === "wallpaper") {
        chooseWallpaper();
      } else {
        chooseCustomImage();
      }
      paintInspector();
    });
    tabs.appendChild(button);
  }
  body.appendChild(tabs);

  if (state.backgroundTab === "pattern") {
    const grid = document.createElement("div");
    grid.className = "preset-grid";
    for (const preset of BACKGROUND_PATTERNS) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "preset-card";
      if (source.patternPreset === preset) card.classList.add("is-selected");
      card.innerHTML = `<span class="swatch" data-pattern="${preset}"></span><span>${preset}</span>`;
      card.addEventListener("click", () => {
        store.commit(t("选择纹理网格"), (doc) => {
          doc.canvas.backgroundSource = { kind: "pattern", patternPreset: preset };
        });
      });
      grid.appendChild(card);
    }
    body.appendChild(grid);

    const s = section(t("背景效果"));
    group(s, [
      sliderRow({
        label: t("图案大小"),
        value: canvas.patternScale,
        min: 0.4,
        max: 6,
        step: 0.05,
        format: (v) => v.toFixed(2),
        suffix: "×",
        onChange: (v) => store.apply((doc) => (doc.canvas.patternScale = v)),
        onCommit: (v) => store.commit(t("调整图案大小"), (doc) => (doc.canvas.patternScale = v)),
      }),
      sliderRow({
        label: t("图案不透明度"),
        value: canvas.patternOpacity,
        min: 0,
        max: 1,
        step: 0.01,
        format: (v) => String(Math.round(v * 100)),
        suffix: "%",
        onChange: (v) => store.apply((doc) => (doc.canvas.patternOpacity = v)),
        onCommit: (v) => store.commit(t("调整图案不透明度"), (doc) => (doc.canvas.patternOpacity = v)),
      }),
    ]);
    body.appendChild(s);
  } else if (state.backgroundTab === "dynamic") {
    const grid = document.createElement("div");
    grid.className = "preset-grid";
    for (const preset of DYNAMIC_BACKGROUNDS) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "preset-card";
      if (source.dynamicPreset === preset) card.classList.add("is-selected");
      card.innerHTML = `<span class="swatch" data-pattern="极光流体星云"></span><span>${preset}</span>`;
      card.addEventListener("click", () => {
        store.commit(t("选择动态背景"), (doc) => {
          doc.canvas.backgroundSource = { kind: "dynamicFlow", dynamicPreset: preset };
        });
      });
      grid.appendChild(card);
    }
    body.appendChild(grid);
  } else {
    const s = section(t("背景素材"));
    const row = document.createElement("div");
    row.className = "row";
    const pick = document.createElement("button");
    pick.type = "button";
    pick.className = "btn";
    pick.style.flex = "1";
    pick.innerHTML = `${icon("image", 15)}<span>${t("选择画布背景")}</span>`;
    pick.addEventListener("click", () => chooseCustomImage());
    row.appendChild(pick);
    s.appendChild(row);
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = t("壁纸") + " · PNG / JPG / MP4";
    s.appendChild(hint);
    body.appendChild(s);
  }

  const blur = section(t("背景效果"));
  group(blur, [
    sliderRow({
      label: t("背景模糊"),
      value: canvas.backgroundBlur,
      min: 0,
      max: 60,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "px",
      onChange: (v) => store.apply((doc) => (doc.canvas.backgroundBlur = v)),
      onCommit: (v) => store.commit(t("调整背景模糊"), (doc) => (doc.canvas.backgroundBlur = v)),
    }),
  ]);
  body.appendChild(blur);
}

/**
 * The port of `SystemWallpaperLibrary`'s picker.
 *
 * Lists the wallpapers Windows ships with, plus whatever the desktop is
 * currently using. These are kept as local references rather than copied into
 * the project — system artwork should not silently become a redistributable
 * project asset. "选择画布背景" remains the way to bring in a file of your own,
 * and that one *is* copied so the package stays self-contained.
 */
async function chooseWallpaper() {
  const data = await api().system.wallpapers().catch(() => null);
  const groups = data?.groups || [];
  const current = data?.current || null;

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal modal-wide";
  const heading = document.createElement("h2");
  heading.textContent = t("显示更多壁纸");
  modal.appendChild(heading);

  const apply = async (asset) => {
    store.commit(t("选择自定义壁纸"), (doc) => {
      doc.canvas.backgroundSource = { kind: "systemImage", absolutePath: asset.path };
    });
    await store.loadBackground();
    backdrop.remove();
  };

  const scroll = document.createElement("div");
  scroll.className = "wallpaper-scroll";

  if (current) {
    const row = document.createElement("div");
    row.className = "wallpaper-current";
    const thumb = document.createElement("img");
    thumb.src = `dogsc-media://local/${encodeURIComponent(current.path)}`;
    thumb.alt = "";
    const label = document.createElement("div");
    label.className = "grow";
    label.innerHTML = `<strong>${t("使用当前桌面壁纸")}</strong><small>${current.name}</small>`;
    const use = document.createElement("button");
    use.type = "button";
    use.className = "btn";
    use.textContent = t("应用");
    use.addEventListener("click", () => apply(current));
    row.append(thumb, label, use);
    scroll.appendChild(row);
  }

  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "section-hint";
    empty.textContent = t("未发现系统壁纸，可用「选择画布背景」导入自己的图片。");
    scroll.appendChild(empty);
  }

  for (const group of groups) {
    const title = document.createElement("div");
    title.className = "wallpaper-group-title";
    title.textContent = group.name;
    scroll.appendChild(title);

    const grid = document.createElement("div");
    grid.className = "wallpaper-grid";
    for (const asset of group.assets) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "wallpaper-card";
      card.title = asset.name;
      const img = document.createElement("img");
      img.src = `dogsc-media://local/${encodeURIComponent(asset.path)}`;
      img.alt = asset.name;
      img.loading = "lazy";
      card.appendChild(img);
      card.addEventListener("click", () => apply(asset));
      grid.appendChild(card);
    }
    scroll.appendChild(grid);
  }
  modal.appendChild(scroll);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const browse = document.createElement("button");
  browse.type = "button";
  browse.className = "btn";
  browse.textContent = t("选择画布背景");
  browse.addEventListener("click", () => {
    backdrop.remove();
    chooseCustomImage();
  });
  const close = document.createElement("button");
  close.type = "button";
  close.className = "btn btn-primary";
  close.style.height = "var(--height-selection)";
  close.style.padding = "0 18px";
  close.textContent = t("取消");
  close.addEventListener("click", () => backdrop.remove());
  actions.append(browse, close);
  modal.appendChild(actions);

  backdrop.appendChild(modal);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

async function chooseCustomImage() {
  const file = await api().project.pickFile({
    title: t("选择画布背景"),
    filters: [
      { name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] },
      { name: "视频", extensions: ["mp4", "mov", "webm"] },
    ],
  });
  if (!file) return;
  const relative = await store.importBackground(file);
  if (!relative) return;
  const isVideo = /\.(mp4|mov|webm)$/i.test(file);
  store.commit(t("选择自定义壁纸"), (doc) => {
    doc.canvas.backgroundSource = isVideo
      ? { kind: "projectVideo", relativePath: relative }
      : { kind: "projectImage", relativePath: relative };
  });
  await store.loadBackground();
}

function renderLayout(body) {
  const canvas = store.document.canvas;

  const padding = section(t("画面留白"), t("可直接在画面中拖动"));
  group(padding, [
    sliderRow({
      label: t("边距"),
      value: canvas.padding,
      min: 0,
      max: 320,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "px",
      onChange: (v) => store.apply((doc) => (doc.canvas.padding = v)),
      onCommit: (v) => store.commit(t("调整画布边距"), (doc) => (doc.canvas.padding = v)),
    }),
  ]);
  body.appendChild(padding);

  const position = section(t("位置与大小"));
  const positionRow = document.createElement("div");
  positionRow.className = "row";
  const positionLabel = document.createElement("span");
  positionLabel.className = "field-label";
  positionLabel.style.flex = "1";
  positionLabel.textContent = t("素材位置");
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn btn-ghost";
  reset.style.fontSize = "11.5px";
  reset.innerHTML = `${icon("refresh", 12)}<span>${t("恢复位置与大小")}</span>`;
  reset.addEventListener("click", () => {
    store.commit(t("居中屏幕素材"), (doc) => {
      doc.canvas.contentPosition = { x: 0.5, y: 0.5 };
      doc.canvas.contentScale = 1;
    });
  });
  positionRow.append(positionLabel, reset);
  position.appendChild(positionRow);

  const pad = document.createElement("div");
  pad.className = "position-pad";
  pad.id = "position-pad";
  position.appendChild(pad);
  renderPositionPad(pad, canvas.contentPosition, (x, y) => {
    store.apply((doc) => (doc.canvas.contentPosition = { x, y }));
  }, () => store.commitGesture(t("移动屏幕素材")));

  group(position, [
    sliderRow({
      label: "X",
      value: canvas.contentPosition.x,
      min: 0,
      max: 1,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => store.apply((doc) => (doc.canvas.contentPosition.x = v)),
      onCommit: (v) => store.commit(t("移动屏幕素材"), (doc) => (doc.canvas.contentPosition.x = v)),
      tooltip: t("素材位置") + " X",
    }),
    sliderRow({
      label: "Y",
      value: canvas.contentPosition.y,
      min: 0,
      max: 1,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => store.apply((doc) => (doc.canvas.contentPosition.y = v)),
      onCommit: (v) => store.commit(t("移动屏幕素材"), (doc) => (doc.canvas.contentPosition.y = v)),
      tooltip: t("素材位置") + " Y",
    }),
    sliderRow({
      label: t("素材缩放"),
      value: canvas.contentScale,
      min: 0.2,
      max: 3,
      step: 0.01,
      format: (v) => v.toFixed(2),
      suffix: "×",
      onChange: (v) => store.apply((doc) => (doc.canvas.contentScale = v)),
      onCommit: (v) => store.commit(t("缩放屏幕素材"), (doc) => (doc.canvas.contentScale = v)),
    }),
  ]);
  body.appendChild(position);

  const corners = section(t("圆角、描边与阴影"));
  group(corners, [
    sliderRow({
      label: t("内容圆角"),
      value: canvas.cornerRadius,
      min: 0,
      max: 160,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "px",
      onChange: (v) => store.apply((doc) => (doc.canvas.cornerRadius = v)),
      onCommit: (v) => store.commit(t("调整画面圆角"), (doc) => (doc.canvas.cornerRadius = v)),
    }),
    sliderRow({
      label: t("外描边"),
      value: canvas.borderWidth,
      min: 0,
      max: 40,
      step: 0.5,
      format: (v) => v.toFixed(1),
      suffix: "px",
      onChange: (v) => store.apply((doc) => (doc.canvas.borderWidth = v)),
      onCommit: (v) => store.commit(t("调整屏幕描边"), (doc) => (doc.canvas.borderWidth = v)),
    }),
    colorRow(t("描边颜色"), canvas.borderColor, (hex) =>
      store.commit(t("调整描边颜色"), (doc) => (doc.canvas.borderColor = hex))
    ),
    sliderRow({
      label: t("阴影强度"),
      value: canvas.shadowStrength,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => store.apply((doc) => (doc.canvas.shadowStrength = v)),
      onCommit: (v) => store.commit(t("调整屏幕阴影"), (doc) => (doc.canvas.shadowStrength = v)),
    }),
  ]);
  body.appendChild(corners);

  const crop = section(t("屏幕裁切"), t("编辑屏幕裁切"));
  const cropRow = document.createElement("div");
  cropRow.className = "row";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "btn";
  edit.style.flex = "1";
  edit.innerHTML = `${icon("crop", 15)}<span>${t("编辑屏幕裁切")}</span>`;
  edit.addEventListener("click", () => {
    document.dispatchEvent(new CustomEvent("dogsc:enter-crop"));
  });
  const clear = document.createElement("button");
  clear.type = "button";
  clear.className = "btn";
  clear.innerHTML = `${icon("refresh", 15)}`;
  attachTooltip(clear, t("清除裁切"));
  clear.addEventListener("click", () => {
    store.commit(t("清除裁切"), (doc) => {
      doc.canvas.crop = { x: 0, y: 0, width: 1, height: 1 };
    });
  });
  cropRow.append(edit, clear);
  crop.appendChild(cropRow);
  body.appendChild(crop);
}

function renderPositionPad(host, position, onChange, onCommit) {
  host.innerHTML = "";
  const dot = document.createElement("span");
  dot.className = "position-dot";
  const paintDot = (value) => {
    dot.style.left = `${value.x * 100}%`;
    dot.style.top = `${value.y * 100}%`;
  };
  paintDot(position);
  host.appendChild(dot);

  const grid = document.createElement("span");
  grid.className = "position-cross";
  host.appendChild(grid);

  host.addEventListener("mousedown", (event) => {
    store.beginGesture();
    const rect = host.getBoundingClientRect();
    const move = (moveEvent) => {
      const x = Math.max(0, Math.min(1, (moveEvent.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (moveEvent.clientY - rect.top) / rect.height));
      paintDot({ x, y });
      onChange(x, y);
    };
    move(event);
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      onCommit();
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

function renderMockup(body) {
  const canvas = store.document.canvas;
  const grid = document.createElement("div");
  grid.className = "preset-grid wide";
  for (const frame of SCREEN_FRAMES) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    if (canvas.screenFrame === frame.value) card.classList.add("is-selected");
    card.innerHTML = `${icon(frame.icon, 18)}<span>${t(frame.label)}</span>`;
    card.addEventListener("click", () => {
      store.commit(t("更换屏幕边框"), (doc) => (doc.canvas.screenFrame = frame.value));
    });
    grid.appendChild(card);
  }
  body.appendChild(grid);

  const hint = document.createElement("p");
  hint.className = "section-hint";
  hint.textContent = t("选择样机；内容圆角、描边与阴影在“布局”中调整。");
  body.appendChild(hint);

  if (canvas.screenFrame === "none") return;

  /* Device frames are bezels, not toolbars — 顶栏高度 means nothing there. */
  const isDeviceFrame = [
    "devicePhone",
    "adaptiveDevice",
    "phonePortrait",
    "phoneLandscape",
    "tabletPortrait",
    "tabletLandscape",
  ].includes(canvas.screenFrame);

  const s = section(t("样机"));
  group(s, [
    sliderRow({
      label: t("框体比例"),
      value: canvas.screenFrameScale,
      min: 0.6,
      max: 1.6,
      step: 0.01,
      format: (v) => v.toFixed(2),
      suffix: "×",
      onChange: (v) => store.apply((doc) => (doc.canvas.screenFrameScale = v)),
      onCommit: (v) => store.commit(t("调整屏幕样机大小"), (doc) => (doc.canvas.screenFrameScale = v)),
    }),
    ...(isDeviceFrame
      ? []
      : [
          sliderRow({
            label: t("顶栏高度"),
            value: canvas.screenFrameToolbarScale,
            min: 0.65,
            max: 1.6,
            step: 0.01,
            format: (v) => v.toFixed(2),
            suffix: "×",
            onChange: (v) => store.apply((doc) => (doc.canvas.screenFrameToolbarScale = v)),
            onCommit: (v) => store.commit(t("调整样机顶栏高度"), (doc) => (doc.canvas.screenFrameToolbarScale = v)),
          }),
        ]),
    sliderRow({
      label: t("框体外圆角"),
      value: canvas.screenFrameOuterCornerRadius ?? canvas.cornerRadius + 10,
      min: 0,
      max: 160,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "px",
      onChange: (v) => store.apply((doc) => (doc.canvas.screenFrameOuterCornerRadius = v)),
      onCommit: (v) => store.commit(t("调整样机外圆角"), (doc) => (doc.canvas.screenFrameOuterCornerRadius = v)),
    }),
  ]);

  const isBrowser = canvas.screenFrame === "browserLight" || canvas.screenFrame === "browserDark";
  const titleField = textField({
    value: isBrowser ? canvas.screenFrameBrowserAddress : canvas.screenFrameTitle,
    placeholder: isBrowser ? t("网址或文字") : t("可留空"),
    onCommit: (value) => {
      store.commit(isBrowser ? t("修改浏览器地址") : t("修改窗口标题"), (doc) => {
        if (isBrowser) doc.canvas.screenFrameBrowserAddress = value.slice(0, 240);
        else doc.canvas.screenFrameTitle = value.slice(0, 120);
      });
    },
  });
  const fieldRow = document.createElement("div");
  fieldRow.className = "col";
  const label = document.createElement("span");
  label.className = "field-label";
  label.textContent = isBrowser ? t("修改浏览器地址") : t("修改窗口标题");
  fieldRow.append(label, titleField);
  s.appendChild(fieldRow);
  body.appendChild(s);
}

/* ------------------------------------------------------------------------- */
/* 开场                                                                      */
/* ------------------------------------------------------------------------- */

function renderOpeningTool(body) {
  const opening = store.document.opening;
  const s = section(t("让所有元素有序进入画面"));

  group(s, [
    switchRow(t("开场"), opening.isEnabled, (value) => {
      store.commit(t("更换开场方式"), (doc) => {
        doc.opening.isEnabled = value;
      });
    }),
    choiceGroup(
      OPENING_PRESETS.map((preset) => ({ value: preset, label: preset })),
      opening.preset,
      (value) =>
        store.commit(t("更换开场方式"), (doc) => {
          doc.opening.preset = value;
        })
    ),
  ]);
  body.appendChild(s);

  if (!opening.isEnabled) {
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = t("让所有元素有序进入画面");
    body.appendChild(hint);
    return;
  }

  const timing = section(t("过渡与时间"));
  timing.appendChild(openingTimingEditor(opening));
  group(timing, [
    sliderRow({
      label: t("总时长"),
      value: opening.duration,
      min: 0.4,
      max: 8,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) => store.apply((doc) => (doc.opening.duration = v)),
      onCommit: (v) => store.commit(t("调整开场总时长"), (doc) => (doc.opening.duration = v)),
    }),
    sliderRow({
      label: t("元素间隔"),
      value: opening.stagger,
      min: 0,
      max: 1.2,
      step: 0.01,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) => store.apply((doc) => (doc.opening.stagger = v)),
      onCommit: (v) => store.commit(t("调整开场元素间隔"), (doc) => (doc.opening.stagger = v)),
    }),
  ]);
  body.appendChild(timing);

  const curve = section(t("顺滑"));
  group(curve, [
    choiceGroup(
      MOTION_CURVES.map((entry) => ({ value: entry.value, label: t(entry.label) })),
      opening.motionCurve,
      (value) =>
        store.commit(t("调整开场节奏"), (doc) => {
          doc.opening.motionCurve = value;
        })
    ),
  ]);
  const hint = document.createElement("p");
  hint.className = "section-hint";
  hint.textContent =
    opening.motionCurve === "crisp"
      ? t("快速进入并干净收尾，节奏更明确。")
      : opening.motionCurve === "gentle"
        ? t("起落更慢，适合较大的画面和样机。")
        : t("均衡加减速，适合大多数元素。");
  curve.appendChild(hint);
  body.appendChild(curve);

  const elements = section(t("参与元素与顺序"), t("只有一个元素参与时无需设置间隔。"));
  const list = document.createElement("div");
  list.className = "group";
  for (const element of opening.elementOrder) {
    const included = opening.includedElements.includes(element);
    const row = document.createElement("div");
    row.className = "order-row";
    const sw = document.createElement("button");
    sw.type = "button";
    sw.className = "switch";
    if (included) sw.classList.add("is-on");
    sw.addEventListener("click", () => {
      store.commit(t("调整开场顺序"), (doc) => {
        const set = new Set(doc.opening.includedElements);
        if (set.has(element)) set.delete(element);
        else set.add(element);
        doc.opening.includedElements = OPENING_ELEMENTS.filter((value) => set.has(value));
      });
    });
    const label = document.createElement("span");
    label.className = "field-label";
    label.style.flex = "1";
    label.textContent = t(element);
    const up = document.createElement("button");
    up.type = "button";
    up.className = "btn btn-ghost btn-icon";
    up.innerHTML = icon("chevronRight", 13);
    up.style.transform = "rotate(-90deg)";
    up.addEventListener("click", () => moveOrder(element, -1));
    const down = document.createElement("button");
    down.type = "button";
    down.className = "btn btn-ghost btn-icon";
    down.innerHTML = icon("chevronRight", 13);
    down.style.transform = "rotate(90deg)";
    down.addEventListener("click", () => moveOrder(element, 1));
    row.append(sw, label, up, down);
    list.appendChild(row);
  }
  elements.appendChild(list);
  body.appendChild(elements);
}

function moveOrder(element, delta) {
  store.commit(t("调整开场顺序"), (doc) => {
    const order = [...doc.opening.elementOrder];
    const index = order.indexOf(element);
    const next = index + delta;
    if (next < 0 || next >= order.length) return;
    [order[index], order[next]] = [order[next], order[index]];
    doc.opening.elementOrder = order;
  });
}

/* ------------------------------------------------------------------------- */
/* 开场时序条                                                                  */
/* ------------------------------------------------------------------------- */

const OPENING_ELEMENT_ICONS = { 屏幕: "screen", 摄像头: "camera", 贴图: "sticker" };

/**
 * One bar per element on a shared schedule (port of EditorOpeningTimeline):
 * the first row sets the total duration, later rows set the common stagger,
 * and any right grip sets the duration. Element `i` starts at `stagger × i`
 * and animates for `duration` — exactly what openingProgress() renders.
 *
 * The domain is frozen for the length of a drag: changing the duration
 * rescales the schedule, and letting that rescale feed back under the
 * pointer would make the drag fight itself (EditorOpeningTiming.swift).
 */
function openingTimingEditor(opening) {
  const wrap = document.createElement("div");
  wrap.className = "opening-timing";
  const head = document.createElement("div");
  head.className = "opening-timing-head";
  wrap.appendChild(head);
  const list = document.createElement("div");
  list.className = "opening-timing-rows";
  wrap.appendChild(list);

  const clampRange = (value, min, max) => Math.min(Math.max(value, min), max);
  const view = { duration: opening.duration, stagger: opening.stagger };
  let frozenDomain = null;

  const domainNow = () => {
    let lastIndex = 0;
    opening.elementOrder.forEach((element, index) => {
      if (opening.includedElements.includes(element)) lastIndex = index;
    });
    return Math.max(view.duration + view.stagger * lastIndex, 1);
  };
  const domain = () => frozenDomain ?? domainNow();

  const updateHead = () => {
    head.textContent = `${t("总时长")} ${view.duration.toFixed(2)}s · ${t("元素间隔")} ${view.stagger.toFixed(2)}s`;
  };

  const rows = [];
  const layout = () => {
    const scale = domain();
    for (const row of rows) {
      if (!row.included) continue;
      const start = row.index * view.stagger;
      const left = Math.min(start / scale, 1) * 100;
      const width = Math.max(Math.min((view.duration / scale) * 100, 100 - left), 0.5);
      row.bar.style.left = `${left}%`;
      row.bar.style.width = `${width}%`;
      const pixels = ((row.track.clientWidth || 200) * width) / 100;
      row.range.textContent = pixels >= 84 ? `${start.toFixed(2)}–${(start + view.duration).toFixed(2)}s` : "";
      row.bar.classList.toggle("has-grip", pixels >= 18);
    }
  };

  for (const element of opening.elementOrder) {
    const index = opening.elementOrder.indexOf(element);
    const included = opening.includedElements.includes(element);
    const row = document.createElement("div");
    row.className = "opening-timing-row";
    if (!included) row.classList.add("is-muted");
    const label = document.createElement("span");
    label.className = "opening-timing-label";
    label.innerHTML = `${icon(OPENING_ELEMENT_ICONS[element] || "spark", 13)}<span>${t(element)}</span>`;
    const track = document.createElement("div");
    track.className = "opening-timing-track";
    const bar = document.createElement("div");
    bar.className = "opening-timing-bar";
    const range = document.createElement("span");
    range.className = "opening-timing-range";
    const grip = document.createElement("span");
    grip.className = "opening-timing-grip";
    bar.append(range, grip);
    if (included) {
      track.appendChild(bar);
      attachTooltip(track, index === 0 ? t("拖动调时长") : t("拖动调间隔 · 右端调时长"));
    }
    row.append(label, track);
    list.appendChild(row);
    rows.push({ element, index, included, track, bar, range });
  }

  for (const row of rows) {
    if (!row.included) continue;
    row.track.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const trackRect = row.track.getBoundingClientRect();
      const barRect = row.bar.getBoundingClientRect();
      const onGrip = barRect.width >= 18 && event.clientX >= barRect.right - 16;
      const mode = onGrip || row.index === 0 ? "duration" : "stagger";
      inspectorDragging = true;
      frozenDomain = domainNow();
      store.beginGesture();
      try {
        row.track.setPointerCapture(event.pointerId);
      } catch {
        /* pointer capture is best-effort */
      }
      const secondsPerPoint = frozenDomain / Math.max(trackRect.width, 1);
      let previousX = event.clientX;

      const onMove = (moveEvent) => {
        const delta = (moveEvent.clientX - previousX) * secondsPerPoint;
        previousX = moveEvent.clientX;
        if (mode === "duration") {
          view.duration = clampRange(view.duration + delta, 0.4, 8);
        } else {
          /* Element `index` starts at stagger × index, so it follows the
             pointer when the stagger moves by pointerDelta ÷ index. */
          view.stagger = clampRange(view.stagger + delta / Math.max(row.index, 1), 0, 1.2);
        }
        store.apply((doc) => {
          doc.opening.duration = view.duration;
          doc.opening.stagger = view.stagger;
        });
        updateHead();
        layout();
      };
      const onEnd = () => {
        row.track.removeEventListener("pointermove", onMove);
        row.track.removeEventListener("pointerup", onEnd);
        row.track.removeEventListener("pointercancel", onEnd);
        inspectorDragging = false;
        frozenDomain = null;
        store.commitGesture(mode === "duration" ? t("调整开场总时长") : t("调整开场元素间隔"));
      };
      row.track.addEventListener("pointermove", onMove);
      row.track.addEventListener("pointerup", onEnd);
      row.track.addEventListener("pointercancel", onEnd);
    });
  }

  updateHead();
  layout();
  requestAnimationFrame(layout);
  return wrap;
}

/* ------------------------------------------------------------------------- */
/* 运镜                                                                      */
/* ------------------------------------------------------------------------- */

function renderMotionTool(body) {
  const doc = store.document;
  const zoomClip = store.selectedZoomClip();
  const screenMotion = store.selection.kind === "screenMotion" ? store.findScreenMotion(store.selection.id) : null;

  const typeRow = segmented(
    [
      { value: "zoom", label: t("缩放") },
      { value: "screen3d", label: t("屏幕 3D") },
    ],
    screenMotion ? "screen3d" : "zoom",
    (value) => {
      if (value === "zoom") {
        const clip = store.document.timeline.zoomClips[0];
        if (clip) store.select("zoom", clip.id);
        else createEffectClip("zoom", store.playhead);
      } else {
        const clip = store.document.timeline.screenMotionClips[0];
        if (clip) store.select("screenMotion", clip.id);
        else createEffectClip("screenMotion", store.playhead);
      }
      paintInspector();
    }
  );
  typeRow.style.width = "100%";
  body.appendChild(typeRow);

  if (screenMotion) {
    renderScreen3D(body, screenMotion);
  } else if (zoomClip) {
    renderZoom(body, zoomClip);
  } else {
    const s = section(t("缩放"));
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = t("在播放头添加屏幕 3D");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.style.width = "100%";
    button.innerHTML = `${icon("plus", 15)}<span>${t("在播放头添加屏幕 3D")}</span>`;
    button.addEventListener("click", () => createEffectClip("zoom", store.playhead));
    s.append(hint, button);
    body.appendChild(s);
  }

  /* Global motion defaults, matching the original's "新动画过渡" section. */
  const defaults = section(t("新动画过渡"));
  group(defaults, [
    sliderRow({
      label: t("过渡时长"),
      value: doc.motion.defaultZoomTransitionDuration,
      min: 0,
      max: 3,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) => store.apply((d) => (d.motion.defaultZoomTransitionDuration = v)),
      onCommit: (v) => store.commit(t("调整默认过渡时长"), (d) => (d.motion.defaultZoomTransitionDuration = v)),
    }),
    sliderRow({
      label: t("放大比例"),
      value: doc.motion.defaultZoomScale,
      min: 1,
      max: 6,
      step: 0.1,
      format: (v) => v.toFixed(1),
      suffix: "×",
      onChange: (v) => store.apply((d) => (d.motion.defaultZoomScale = v)),
      onCommit: (v) => store.commit(t("调整缩放"), (d) => (d.motion.defaultZoomScale = v)),
    }),
    choiceGroup(
      [
        { value: "spring", label: t("弹簧") },
        { value: "cubic", label: t("三次方缓动") },
        { value: "quad", label: t("二次方缓动") },
        { value: "quint", label: t("五次平滑") },
        { value: "linear", label: t("线性") },
      ],
      doc.motion.defaultZoomEasing,
      (value) =>
        store.commit(t("调整默认过渡时长"), (d) => {
          d.motion.defaultZoomEasing = value;
        })
    ),
  ]);
  body.appendChild(defaults);

  const smoothing = section(t("高级平滑参数"));
  group(smoothing, [
    sliderRow({
      label: t("光标质量"),
      value: doc.motion.cursorSpringMass,
      min: 0.5,
      max: 8,
      step: 0.1,
      format: (v) => v.toFixed(1),
      onChange: (v) => store.apply((d) => (d.motion.cursorSpringMass = v)),
      onCommit: (v) => store.commit(t("调整光标弹簧质量"), (d) => (d.motion.cursorSpringMass = v)),
    }),
    sliderRow({
      label: t("光标刚度"),
      value: doc.motion.cursorSpringStiffness,
      min: 40,
      max: 1200,
      step: 5,
      format: (v) => String(Math.round(v)),
      onChange: (v) => store.apply((d) => (d.motion.cursorSpringStiffness = v)),
      onCommit: (v) => store.commit(t("调整光标弹簧刚度"), (d) => (d.motion.cursorSpringStiffness = v)),
    }),
    sliderRow({
      label: t("光标阻尼"),
      value: doc.motion.cursorSpringDamping,
      min: 4,
      max: 160,
      step: 1,
      format: (v) => String(Math.round(v)),
      onChange: (v) => store.apply((d) => (d.motion.cursorSpringDamping = v)),
      onCommit: (v) => store.commit(t("调整光标弹簧阻尼"), (d) => (d.motion.cursorSpringDamping = v)),
    }),
  ]);
  body.appendChild(smoothing);
}

/* ------------------------------------------------------------------------- */
/* 缩放包络曲线                                                                */
/* ------------------------------------------------------------------------- */

const ENVELOPE_MAX_SCALE = 6;
const ENVELOPE_MIN_PEAK = 1.05;
const ENVELOPE_PLOT = { top: 14, right: 34, bottom: 24, left: 10 };

/**
 * The shape of one zoom, drawn the way a synthesiser draws an envelope
 * (port of EditorZoomEnvelope.swift): time runs right, magnification rises
 * on a log scale, and three draggable nodes set the push-in length and peak,
 * the peak alone, and the pull-out length. The curve samples the very same
 * evaluation the frame renderer uses, so the drawing cannot drift from what
 * the export actually renders.
 */
function zoomEnvelope(clip) {
  const wrap = document.createElement("div");
  wrap.className = "zoom-envelope";
  const canvas = document.createElement("canvas");
  wrap.appendChild(canvas);
  const hud = document.createElement("span");
  hud.className = "zoom-envelope-hud";
  wrap.appendChild(hud);

  /* Values being edited — updated live while a node is held. */
  const view = {
    startTime: clip.startTime,
    duration: Math.max(clip.duration, 0.001),
    transitionIn: clip.transitionIn,
    transitionOut: clip.transitionOut,
    scale: clip.scale,
    easing: clip.easing,
  };

  let dragging = null; // "enter" | "peak" | "exit"
  let hovered = null;

  /* The renderer's own evaluation decides the curve — including the easing
     overshoot clamp — so the panel can never disagree with the canvas. */
  const progressAt = (local) => {
    const evaluated = evaluateClip(
      {
        startTime: 0,
        duration: view.duration,
        transitionIn: view.transitionIn,
        transitionOut: view.transitionOut,
        easing: view.easing,
      },
      Math.min(Math.max(local, 0), view.duration)
    );
    return evaluated ? evaluated.progress : 0;
  };
  const scaleAt = (time) => 1 + (view.scale - 1) * progressAt(time);

  const plotRect = () => {
    const width = canvas.clientWidth || 258;
    const height = canvas.clientHeight || 156;
    return {
      x: ENVELOPE_PLOT.left,
      y: ENVELOPE_PLOT.top,
      width: Math.max(width - ENVELOPE_PLOT.left - ENVELOPE_PLOT.right, 1),
      height: Math.max(height - ENVELOPE_PLOT.top - ENVELOPE_PLOT.bottom, 1),
    };
  };
  const timeToX = (time, plot) => plot.x + Math.min(Math.max(time / view.duration, 0), 1) * plot.width;
  const xToTime = (x, plot) => ((x - plot.x) / plot.width) * view.duration;
  const scaleToY = (scale, plot) => {
    const clamped = Math.min(Math.max(scale, 0.9), ENVELOPE_MAX_SCALE + 0.4);
    return plot.y + plot.height - (Math.log(clamped) / Math.log(ENVELOPE_MAX_SCALE)) * plot.height;
  };
  const yToScale = (y, plot) =>
    Math.exp(((plot.y + plot.height - y) / plot.height) * Math.log(ENVELOPE_MAX_SCALE));

  /* The exit node only exists once there is a pull-out to drag; the enter
     node is always present (drags right to create a push-in). */
  const nodePoints = (plot) => {
    const points = {
      enter: { x: timeToX(view.transitionIn, plot), y: scaleToY(view.scale, plot) },
      peak: { x: timeToX(Math.max(view.duration - view.transitionOut, 0), plot), y: scaleToY(view.scale, plot) },
    };
    if (view.transitionOut > 0.001) {
      points.exit = { x: timeToX(view.duration, plot), y: scaleToY(1, plot) };
    }
    return points;
  };
  const nearestNode = (x, y, plot, radius = 16) => {
    let best = null;
    let bestDistance = Infinity;
    for (const [id, point] of Object.entries(nodePoints(plot))) {
      const distance = Math.hypot(point.x - x, point.y - y);
      if (distance <= radius && distance < bestDistance) {
        best = id;
        bestDistance = distance;
      }
    }
    return best;
  };

  const cssValue = (name, fallback) => {
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };
  const uiFont = "10px 'Alibaba PuHuiTi 3', 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif";

  const draw = () => {
    const width = canvas.clientWidth || 258;
    const height = canvas.clientHeight || 156;
    const dpr = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const plot = plotRect();
    const accent = cssValue("--zoom-curve-accent", "#a9803e");
    const faint = cssValue("--secondary-text", "#616161");
    const grid = cssValue("--chrome-055", "rgba(0, 0, 0, 0.06)");
    const gridStrong = cssValue("--chrome-16", "rgba(0, 0, 0, 0.16)");
    const paper = cssValue("--card-elevated", "#ffffff");

    /* Magnification gridlines on the log scale, 1× solid. */
    ctx.lineWidth = 0.75;
    ctx.font = uiFont;
    ctx.textBaseline = "middle";
    ctx.textAlign = "left";
    for (const level of [1, 2, 3, 4, 6]) {
      const y = scaleToY(level, plot);
      ctx.strokeStyle = level === 1 ? gridStrong : grid;
      ctx.setLineDash(level === 1 ? [] : [2, 4]);
      ctx.beginPath();
      ctx.moveTo(plot.x, y);
      ctx.lineTo(plot.x + plot.width, y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = faint;
      ctx.fillText(`${level}×`, plot.x + plot.width + 6, y);
    }

    /* Phase captions under the axis (进入 / 保持 / 退出). */
    ctx.textAlign = "center";
    const phases = [
      [t("进入"), 0, view.transitionIn],
      [t("保持"), view.transitionIn, view.duration - view.transitionOut],
      [t("退出"), view.duration - view.transitionOut, view.duration],
    ];
    for (const [label, from, to] of phases) {
      const left = timeToX(from, plot);
      const right = timeToX(to, plot);
      if (right - left > 30) ctx.fillText(label, (left + right) / 2, plot.y + plot.height + 15);
    }

    /* The evaluated curve with a flat wash underneath. */
    const steps = Math.max(Math.floor(plot.width / 3), 24);
    const points = [];
    for (let step = 0; step <= steps; step += 1) {
      const time = (step / steps) * view.duration;
      points.push([timeToX(time, plot), scaleToY(scaleAt(time), plot)]);
    }
    if (points.length > 1) {
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
      ctx.save();
      ctx.lineTo(points[points.length - 1][0], plot.y + plot.height);
      ctx.lineTo(points[0][0], plot.y + plot.height);
      ctx.closePath();
      ctx.globalAlpha = 0.12;
      ctx.fillStyle = accent;
      ctx.fill();
      ctx.restore();
      ctx.beginPath();
      ctx.moveTo(points[0][0], points[0][1]);
      for (const [x, y] of points.slice(1)) ctx.lineTo(x, y);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.6;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      ctx.stroke();
    }

    /* Playhead: a dashed line and a dot riding the curve. */
    const relative = store.playhead - view.startTime;
    if (relative >= 0 && relative <= view.duration) {
      const px = timeToX(relative, plot);
      const py = scaleToY(scaleAt(relative), plot);
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.55;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(px, plot.y - 6);
      ctx.lineTo(px, plot.y + plot.height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fillStyle = paper;
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    /* Nodes. */
    for (const [id, point] of Object.entries(nodePoints(plot))) {
      const lit = dragging === id || (!dragging && hovered === id);
      if (lit) {
        ctx.beginPath();
        ctx.arc(point.x, point.y, 15, 0, Math.PI * 2);
        ctx.globalAlpha = 0.22;
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
      const radius = lit ? 8 : 6.5;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = paper;
      ctx.fill();
      ctx.strokeStyle = accent;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
  };

  const updateHud = (node) => {
    if (node === "enter") {
      hud.textContent = `${t("进入")} ${view.transitionIn.toFixed(2)}s · ${t("峰值")} ${view.scale.toFixed(2)}×`;
    } else if (node === "peak") {
      hud.textContent = `${t("峰值")} ${view.scale.toFixed(2)}×`;
    } else {
      hud.textContent = `${t("退出")} ${view.transitionOut.toFixed(2)}s`;
    }
  };

  const localPoint = (event) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  canvas.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || dragging) return;
    const plot = plotRect();
    const point = localPoint(event);
    const node = nearestNode(point.x, point.y, plot);
    if (!node) return;
    event.preventDefault();
    dragging = node;
    hovered = node;
    inspectorDragging = true;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      /* pointer capture is best-effort */
    }
    store.beginGesture();
    updateHud(node);
    draw();
  });

  canvas.addEventListener("pointermove", (event) => {
    const plot = plotRect();
    const point = localPoint(event);
    if (!dragging) {
      const node = nearestNode(point.x, point.y, plot);
      if (node !== hovered) {
        hovered = node;
        canvas.style.cursor = node ? "grab" : "default";
        draw();
      }
      return;
    }
    canvas.style.cursor = "grabbing";
    const time = Math.min(Math.max(xToTime(point.x, plot), 0), view.duration);
    const peak = Math.min(Math.max(yToScale(point.y, plot), ENVELOPE_MIN_PEAK), ENVELOPE_MAX_SCALE);
    if (dragging === "enter") {
      view.transitionIn = Math.min(Math.max(time, 0), Math.min(3, view.duration));
      view.scale = peak;
    } else if (dragging === "peak") {
      view.scale = peak;
    } else {
      view.transitionOut = Math.min(Math.max(view.duration - time, 0), Math.min(3, view.duration));
    }
    store.apply((doc) => {
      const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
      if (!target) return;
      target.transitionIn = view.transitionIn;
      target.transitionOut = view.transitionOut;
      target.scale = view.scale;
    });
    updateHud(dragging);
    draw();
  });

  const endDrag = (event) => {
    if (!dragging) return;
    dragging = null;
    inspectorDragging = false;
    try {
      canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* already released */
    }
    canvas.style.cursor = "default";
    hovered = null;
    hud.textContent = "";
    store.commitGesture(t("调整缩放曲线"));
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);
  canvas.addEventListener("pointerleave", () => {
    if (dragging || !hovered) return;
    hovered = null;
    canvas.style.cursor = "";
    draw();
  });

  /* Keep the playhead dot riding the curve without rebuilding the panel. */
  envelopeSync = () => {
    if (canvas.isConnected) draw();
  };

  requestAnimationFrame(draw);
  return wrap;
}

function renderZoom(body, clip) {
  const s = section(t("缩放"));
  const modeRow = choiceGroup(
    [
      { value: "自动", label: t("自动") },
      { value: "手动", label: t("手动") },
    ],
    clip.mode,
    (value) =>
      store.commit(t("调整缩放"), (doc) => {
        const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
        if (target) target.mode = value;
      })
  );
  s.appendChild(modeRow);

  const focusRow = document.createElement("div");
  focusRow.className = "row";
  const focusLabel = document.createElement("span");
  focusLabel.className = "field-label";
  focusLabel.style.flex = "1";
  focusLabel.textContent = t("缩放锚点");
  const usePointer = document.createElement("button");
  usePointer.type = "button";
  usePointer.className = "btn btn-ghost";
  usePointer.style.fontSize = "11.5px";
  usePointer.innerHTML = `${icon("cursor", 12)}<span>${t("录制鼠标位置")}</span>`;
  attachTooltip(usePointer, t("录制鼠标位置 · 调整焦点切换为手动定位"));
  usePointer.addEventListener("click", () => {
    const point = pointerAt(store.document, clip.startTime) || { x: 0.5, y: 0.5 };
    store.commit(t("调整缩放焦点"), (doc) => {
      const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
      if (!target) return;
      target.focus = { x: point.x, y: point.y };
      target.mode = "手动";
    });
    paintInspector();
  });
  focusRow.append(focusLabel, usePointer);
  s.appendChild(focusRow);

  const pad = document.createElement("div");
  pad.className = "position-pad";
  s.appendChild(pad);
  renderPositionPad(
    pad,
    clip.focus,
    (x, y) =>
      store.apply((doc) => {
        const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
        if (target) {
          target.focus = { x, y };
          target.mode = "手动";
        }
      }),
    () => store.commitGesture(t("调整缩放焦点"))
  );

  /* The envelope edits the same three values the sliders below drive,
     sampling the renderer's own evaluation for its curve. */
  s.appendChild(zoomEnvelope(clip));
  const curveHint = document.createElement("p");
  curveHint.className = "section-hint";
  curveHint.textContent = t("拖动节点调整进入、峰值与退出");
  s.appendChild(curveHint);

  /* Per-clip easing — the original's ZoomEasingPreset picker. The global
     default in 新动画过渡 seeds new clips; this overrides it per clip. */
  s.appendChild(
    choiceGroup(
      [
        { value: "spring", label: t("弹簧") },
        { value: "cubic", label: t("三次方缓动") },
        { value: "quad", label: t("二次方缓动") },
        { value: "quint", label: t("五次平滑") },
        { value: "linear", label: t("线性") },
      ],
      clip.easing || "spring",
      (value) =>
        store.commit(t("调整缩放缓动"), (doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.easing = value;
        })
    )
  );

  group(s, [
    sliderRow({
      label: t("放大比例"),
      value: clip.scale,
      min: 1,
      max: 6,
      step: 0.1,
      format: (v) => v.toFixed(1),
      suffix: "×",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.scale = v;
        }),
      onCommit: (v) => {
        if (v < 1 || v > 6) toast(t("新动画倍率必须在 1 到 6 倍之间。"), { icon: "info" });
        store.commit(t("调整缩放"), (doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.scale = v;
        });
      },
    }),
    sliderRow({
      label: t("进入时长"),
      value: clip.transitionIn,
      min: 0,
      max: 3,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionIn = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整缩放时间"), (doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionIn = v;
        }),
    }),
    sliderRow({
      label: t("退出时长"),
      value: clip.transitionOut,
      min: 0,
      max: 3,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionOut = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整缩放时间"), (doc) => {
          const target = doc.timeline.zoomClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionOut = v;
        }),
    }),
  ]);

  const actions = document.createElement("div");
  actions.className = "row";
  const applyAll = document.createElement("button");
  applyAll.type = "button";
  applyAll.className = "btn";
  applyAll.style.flex = "1";
  applyAll.textContent = t("将倍率应用到全部缩放");
  applyAll.addEventListener("click", () => {
    store.commit(t("统一全部缩放级别"), (doc) => {
      for (const entry of doc.timeline.zoomClips) entry.scale = clip.scale;
    });
  });
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn";
  remove.innerHTML = icon("trash", 15);
  attachTooltip(remove, t("删除缩放"));
  remove.addEventListener("click", () => {
    store.select("zoom", clip.id);
    store.deleteSelection();
  });
  actions.append(applyAll, remove);
  s.appendChild(actions);
  body.appendChild(s);
}

function renderScreen3D(body, clip) {
  const s = section(t("空间姿态"));
  const pad = document.createElement("div");
  pad.className = "position-pad";
  s.appendChild(pad);
  renderPositionPad(
    pad,
    clip.target.position,
    (x, y) =>
      store.apply((doc) => {
        const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
        if (target) target.target.position = { x, y };
      }),
    () => store.commitGesture(t("调整屏幕 3D 位置"))
  );

  group(s, [
    sliderRow({
      label: t("目标大小"),
      value: clip.target.scale,
      min: 0.2,
      max: 3,
      step: 0.01,
      format: (v) => v.toFixed(2),
      suffix: "×",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.scale = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕 3D 大小"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.scale = v;
        }),
    }),
    sliderRow({
      label: t("3D 倾斜 X 角度"),
      value: clip.target.tiltX,
      /* Limits match the original's tilt pad (X ±28°, Y ±32°), which is what
         bounds the reachable foreshortening in the macOS build. */
      min: -28,
      max: 28,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "°",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.tiltX = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕 3D 倾斜"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.tiltX = v;
        }),
    }),
    sliderRow({
      label: t("3D 倾斜 Y 角度"),
      value: clip.target.tiltY,
      min: -32,
      max: 32,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "°",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.tiltY = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕 3D 倾斜"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.tiltY = v;
        }),
    }),
    sliderRow({
      label: t("平面旋转"),
      value: clip.target.rotation,
      min: -30,
      max: 30,
      step: 0.5,
      format: (v) => v.toFixed(1),
      suffix: "°",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.rotation = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕平面旋转"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.rotation = v;
        }),
    }),
    sliderRow({
      label: t("透视强度"),
      value: clip.target.perspective,
      min: 0,
      max: 2,
      step: 0.01,
      format: (v) => v.toFixed(2),
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.perspective = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕透视"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.target.perspective = v;
        }),
    }),
  ]);
  body.appendChild(s);

  const transition = section(t("过渡与时间"));
  group(transition, [
    sliderRow({
      label: t("进入时长"),
      value: clip.transitionIn,
      min: 0,
      max: 3,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionIn = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕 3D 过渡"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionIn = v;
        }),
    }),
    sliderRow({
      label: t("退出时长"),
      value: clip.transitionOut,
      min: 0,
      max: 3,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) =>
        store.apply((doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionOut = v;
        }),
      onCommit: (v) =>
        store.commit(t("调整屏幕 3D 过渡"), (doc) => {
          const target = doc.timeline.screenMotionClips.find((entry) => entry.id === clip.id);
          if (target) target.transitionOut = v;
        }),
    }),
  ]);
  body.appendChild(transition);
}

/* ------------------------------------------------------------------------- */
/* 光标                                                                      */
/* ------------------------------------------------------------------------- */

function renderCursorTool(body) {
  const doc = store.document;
  const style = doc.cursorStyle;

  const appearance = section(t("光标样式"));
  const grid = document.createElement("div");
  grid.className = "preset-grid wide";
  grid.id = "cursor-asset-grid";
  for (const asset of CURSOR_ASSETS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    if (style.assetID === asset.value) card.classList.add("is-selected");
    card.innerHTML = `${icon(asset.icon, 18)}<span>${t(asset.label)}</span>`;
    if (asset.note) attachTooltip(card, t(asset.note));
    card.addEventListener("click", () => {
      store.commit(t("调整光标样式"), (d) => {
        d.cursorStyle.assetID = asset.value;
      });
      if (asset.value === "system.hidden") {
        toast(t("预览和导出均不显示光标及点击反馈。选择“系统”或“触控圆点”可恢复。"), {
          icon: "eyeOff",
          duration: 3600,
        });
      }
      paintInspector();
    });
    grid.appendChild(card);
  }
  appearance.appendChild(grid);
  /* 效果预览：点击重播一轮（EditorCursorStylePreview 的移植）。 */
  appearance.appendChild(cursorPreviewCard(style));
  body.appendChild(appearance);

  const geometry = section(t("大小"));
  group(geometry, [
    sliderRow({
      label: t("大小"),
      value: style.size,
      min: 0.25,
      max: 6,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "×",
      onChange: (v) => store.apply((d) => (d.cursorStyle.size = v)),
      onCommit: (v) => store.commit(t("调整光标大小"), (d) => (d.cursorStyle.size = v)),
    }),
    switchRow(t("静止后隐藏"), style.hideWhenIdle, (value) => {
      store.commit(t("切换静止隐藏"), (d) => {
        d.cursorStyle.hideWhenIdle = value;
      });
      paintInspector();
    }),
  ]);
  if (style.hideWhenIdle) {
    geometry.querySelector(".group").appendChild(
      sliderRow({
        label: t("静止隐藏延迟"),
        value: style.idleDelay,
        min: 0.2,
        max: 8,
        step: 0.1,
        format: (v) => v.toFixed(1),
        suffix: "s",
        onChange: (v) => store.apply((d) => (d.cursorStyle.idleDelay = v)),
        onCommit: (v) => store.commit(t("调整静止隐藏延迟"), (d) => (d.cursorStyle.idleDelay = v)),
      })
    );
  }
  body.appendChild(geometry);

  const clicks = section(t("点击反馈"));
  const effects = document.createElement("div");
  effects.className = "preset-grid wide";
  for (const effect of CLICK_EFFECTS) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    if (style.clickEffectStyle === effect.value) card.classList.add("is-selected");
    card.innerHTML = `<span>${t(effect.label)}</span>`;
    card.addEventListener("click", () => {
      store.commit(t("调整点击动画样式"), (d) => {
        d.cursorStyle.clickEffectStyle = effect.value;
      });
      paintInspector();
    });
    effects.appendChild(card);
  }
  clicks.appendChild(effects);

  if (style.clickEffectStyle !== "none") {
    const colourRow = document.createElement("div");
    colourRow.className = "swatch-row";
    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "swatch";
    reset.style.background = "var(--media-accent)";
    attachTooltip(reset, t("恢复光标默认颜色"));
    reset.addEventListener("click", () => {
      store.commit(t("调整点击动画颜色"), (d) => {
        d.cursorStyle.clickColor = null;
      });
    });
    colourRow.appendChild(reset);
    for (const preset of CURSOR_PRESET_COLORS) {
      const swatch = document.createElement("button");
      swatch.type = "button";
      swatch.className = "swatch";
      swatch.style.background = preset.hex;
      if (style.clickColor === preset.hex) swatch.classList.add("is-selected");
      attachTooltip(swatch, t("预设颜色：%@", t(preset.label)));
      swatch.addEventListener("click", () => {
        store.commit(t("调整点击动画颜色"), (d) => {
          d.cursorStyle.clickColor = preset.hex;
        });
        paintInspector();
      });
      colourRow.appendChild(swatch);
    }
    clicks.appendChild(colourRow);

    group(clicks, [
      sliderRow({
        label: t("不透明度"),
        value: style.clickOpacity,
        min: 0.05,
        max: 1,
        step: 0.01,
        format: (v) => String(Math.round(v * 100)),
        suffix: "%",
        onChange: (v) => store.apply((d) => (d.cursorStyle.clickOpacity = v)),
        onCommit: (v) => store.commit(t("调整点击不透明度"), (d) => (d.cursorStyle.clickOpacity = v)),
      }),
      sliderRow({
        label: t("范围"),
        value: style.clickScale,
        min: 0.4,
        max: 3,
        step: 0.01,
        format: (v) => v.toFixed(2),
        suffix: "×",
        onChange: (v) => store.apply((d) => (d.cursorStyle.clickScale = v)),
        onCommit: (v) => store.commit(t("调整点击动画大小"), (d) => (d.cursorStyle.clickScale = v)),
      }),
    ]);
  }
  body.appendChild(clicks);

  const sync = section(t("音画同步"), t("同步正常"));
  const offset = style.syncOffset || 0;
  const syncRow = document.createElement("div");
  syncRow.className = "row";
  const status = document.createElement("span");
  status.className = "field-value";
  status.style.flex = "1";
  status.textContent =
    Math.abs(offset) < 0.001
      ? t("同步正常")
      : offset > 0
        ? t("画面延后 %@", `${Math.round(offset * 1000)}ms`)
        : t("画面提前 %@", `${Math.round(-offset * 1000)}ms`);
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn";
  reset.style.height = "28px";
  reset.textContent = t("归零光标音画同步");
  reset.addEventListener("click", () => {
    store.commit(t("归零光标音画同步"), (d) => {
      d.cursorStyle.syncOffset = 0;
    });
    paintInspector();
  });
  syncRow.append(status, reset);
  sync.appendChild(syncRow);

  group(sync, [
    sliderRow({
      label: t("偏移 %@", "0ms"),
      value: offset,
      min: -1,
      max: 1,
      step: 1 / 30,
      format: (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 1000)}`,
      suffix: "ms",
      parse: (text) => Number(text),
      scale: 0.001,
      tooltip: t("微调光标轨相对画面的时间偏移"),
      onChange: (v) => store.apply((d) => (d.cursorStyle.syncOffset = v)),
      onCommit: (v) => store.commit(t("校准光标音画同步"), (d) => (d.cursorStyle.syncOffset = v)),
    }),
  ]);
  const syncHint = document.createElement("p");
  syncHint.className = "section-hint";
  syncHint.textContent = t("光标效果、开场与新动画默认值");
  sync.appendChild(syncHint);
  body.appendChild(sync);
}

/**
 * The cursor effect preview — the port of `EditorCursorStylePreview`.
 *
 * A card that plays one round of the click feedback with the current cursor,
 * exactly as the compositor would draw it (same `drawClickEffect` /
 * `drawCursorShape`), replaying whenever the card is clicked. Idle frames
 * hold the 0.34 phase the original rests at.
 */
function cursorPreviewCard(style) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "cursor-preview";
  card.id = "cursor-preview";

  if (style.assetID === "system.hidden") {
    card.disabled = true;
    card.innerHTML =
      `<span class="cursor-preview-empty">${icon("eyeOff", 15)}<span>${t("光标已始终隐藏")}</span></span>`;
    return card;
  }

  card.innerHTML =
    `<span class="cursor-preview-label">${t("效果预览")}</span>` +
    `<span class="cursor-preview-replay">${icon("refresh", 15)}</span>`;
  const canvas = document.createElement("canvas");
  canvas.className = "cursor-preview-canvas";
  card.prepend(canvas);

  const PHASE_PERIOD = 1.15; // seconds per loop, matching the original
  const PLAY_DURATION = 1600; // ms before the preview settles
  const REST_PHASE = 0.34;
  let playing = false;
  let frameId = 0;

  const paint = (phase) => {
    const width = card.clientWidth || 240;
    const height = card.clientHeight || 124;
    const dpr = window.devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(width * dpr) ||
      canvas.height !== Math.round(height * dpr)
    ) {
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    }
    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const cx = width * 0.46;
    const cy = height * 0.5;
    const size = Math.max(10, Math.min(15, height * 0.12));
    const assetID = style.assetID === "system.automatic" ? "system.arrow" : style.assetID;
    const color = style.clickColor || cursorThemeColor(assetID);

    if (style.clickEffectStyle !== "none") {
      drawClickEffect(ctx, style.clickEffectStyle, phase, cx, cy, size, {
        color,
        opacity: style.clickOpacity,
        scale: style.clickScale,
      });
    }

    ctx.save();
    ctx.translate(cx + size * 0.75, cy + size * 1.0);
    drawCursorShape(ctx, assetID, Math.max(12, Math.min(22, height * 0.2)), store.cursorAssets);
    ctx.restore();
  };

  const loop = (startedAt) => {
    const elapsed = performance.now() - startedAt;
    if (playing && elapsed < PLAY_DURATION) {
      const phase = ((elapsed / 1000) % PHASE_PERIOD) / PHASE_PERIOD;
      paint(phase);
      frameId = requestAnimationFrame(() => loop(startedAt));
    } else {
      playing = false;
      paint(REST_PHASE);
    }
  };

  const play = () => {
    cancelAnimationFrame(frameId);
    playing = true;
    loop(performance.now());
  };
  card.addEventListener("click", play);
  /* One round on entry, like the original's active-editor playback. */
  requestAnimationFrame(() => {
    if (card.isConnected) play();
  });
  return card;
}

/* ------------------------------------------------------------------------- */
/* 摄像头                                                                    */
/* ------------------------------------------------------------------------- */

function renderCameraTool(body) {
  const doc = store.document;
  const camera = doc.camera;

  const layout = section(t("摄像头位置"));
  const presets = document.createElement("div");
  presets.className = "preset-grid wide";
  /* Insets are generous on the vertical axis: a square PiP is as tall as
     `size * aspect` of the canvas, so a corner at y = 0.16 would be clipped. */
  const positions = [
    { label: "左上", x: 0.18, y: 0.26 },
    { label: "右上", x: 0.82, y: 0.26 },
    { label: "左下", x: 0.18, y: 0.74 },
    { label: "右下", x: 0.82, y: 0.74 },
    { label: "居中上", x: 0.5, y: 0.26 },
    { label: "居中下", x: 0.5, y: 0.74 },
  ];
  for (const preset of positions) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "preset-card";
    card.innerHTML = `<span>${t(preset.label)}</span>`;
    card.addEventListener("click", () => {
      store.commit(t("切换摄像头布局"), (d) => {
        d.camera.position = { x: preset.x, y: preset.y };
      });
    });
    presets.appendChild(card);
  }
  layout.appendChild(presets);

  const pad = document.createElement("div");
  pad.className = "position-pad";
  layout.appendChild(pad);
  renderPositionPad(
    pad,
    camera.position,
    (x, y) =>
      store.apply((d) => {
        d.camera.position = { x, y };
      }),
    () => store.commitGesture(t("移动摄像头"))
  );

  group(layout, [
    switchRow(t("显示摄像头"), !camera.isHidden, (value) => {
      store.commit(t("切换摄像头显示"), (d) => {
        d.camera.isHidden = !value;
      });
    }),
    choiceGroup(
      CAMERA_SHAPES.map((shape) => ({ value: shape, label: t(shape) })),
      camera.shape,
      (value) =>
        store.commit(t("调整摄像头形状"), (d) => {
          d.camera.shape = value;
        })
    ),
  ]);
  body.appendChild(layout);

  const size = section(t("摄像头大小"));
  group(size, [
    sliderRow({
      label: t("摄像头大小"),
      value: camera.size,
      min: 0.06,
      max: 0.9,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => store.apply((d) => (d.camera.size = v)),
      onCommit: (v) => store.commit(t("调整摄像头大小"), (d) => (d.camera.size = v)),
    }),
    sliderRow({
      label: t("圆角程度"),
      value: camera.roundness,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => store.apply((d) => (d.camera.roundness = v)),
      onCommit: (v) => store.commit(t("调整摄像头圆角"), (d) => (d.camera.roundness = v)),
    }),
    switchRow(t("镜像摄像头"), camera.isMirrored, (value) => {
      store.commit(t("切换摄像头镜像"), (d) => {
        d.camera.isMirrored = value;
      });
    }),
  ]);
  body.appendChild(size);

  const appearance = section(t("圆角、描边与阴影"));
  group(appearance, [
    sliderRow({
      label: t("摄像头描边"),
      value: camera.borderWidth,
      min: 0,
      max: 30,
      step: 0.5,
      format: (v) => v.toFixed(1),
      suffix: "px",
      onChange: (v) => store.apply((d) => (d.camera.borderWidth = v)),
      onCommit: (v) => store.commit(t("调整摄像头描边"), (d) => (d.camera.borderWidth = v)),
    }),
    sliderRow({
      label: t("摄像头阴影"),
      value: camera.shadowStrength,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => store.apply((d) => (d.camera.shadowStrength = v)),
      onCommit: (v) => store.commit(t("调整摄像头阴影"), (d) => (d.camera.shadowStrength = v)),
    }),
    sliderRow({
      label: t("缩放联动"),
      value: camera.scaleDuringZoom,
      min: 0,
      max: 2,
      step: 0.01,
      format: (v) => v.toFixed(2),
      suffix: "×",
      tooltip: t("跟随屏幕缩放调整摄像头大小；1 倍保持原大小。"),
      onChange: (v) => store.apply((d) => (d.camera.scaleDuringZoom = v)),
      onCommit: (v) => store.commit(t("调整摄像头缩放跟随"), (d) => (d.camera.scaleDuringZoom = v)),
    }),
  ]);
  body.appendChild(appearance);

  const framing = section(t("蒙版内取景"));
  const framePad = document.createElement("div");
  framePad.className = "position-pad";
  framing.appendChild(framePad);
  renderPositionPad(
    framePad,
    camera.contentPosition,
    (x, y) =>
      store.apply((d) => {
        d.camera.contentPosition = { x, y };
      }),
    () => store.commitGesture(t("调整蒙版内取景"))
  );
  group(framing, [
    sliderRow({
      label: t("蒙版内素材缩放"),
      value: camera.contentScale,
      min: 1,
      max: 4,
      step: 0.01,
      format: (v) => v.toFixed(2),
      suffix: "×",
      onChange: (v) => store.apply((d) => (d.camera.contentScale = v)),
      onCommit: (v) => store.commit(t("调整蒙版内素材缩放"), (d) => (d.camera.contentScale = v)),
    }),
  ]);
  const resetFraming = document.createElement("button");
  resetFraming.type = "button";
  resetFraming.className = "btn";
  resetFraming.style.width = "100%";
  resetFraming.textContent = t("重置蒙版内取景");
  resetFraming.addEventListener("click", () => {
    store.commit(t("重置蒙版内取景"), (d) => {
      d.camera.contentPosition = { x: 0.5, y: 0.5 };
      d.camera.contentScale = 1;
    });
  });
  framing.appendChild(resetFraming);
  body.appendChild(framing);

  /* ---- 音画同步：全片偏移（原版摄像头同步）---- */
  const sync = section(t("音画同步"), t("同步正常"));
  const syncOffset = camera.syncOffset || 0;
  const syncRow = document.createElement("div");
  syncRow.className = "row";
  const syncStatus = document.createElement("span");
  syncStatus.className = "field-value";
  syncStatus.style.flex = "1";
  syncStatus.textContent =
    Math.abs(syncOffset) < 0.001
      ? t("同步正常")
      : syncOffset > 0
        ? t("画面延后 %@", `${Math.round(syncOffset * 1000)}ms`)
        : t("画面提前 %@", `${Math.round(-syncOffset * 1000)}ms`);
  const syncReset = document.createElement("button");
  syncReset.type = "button";
  syncReset.className = "btn";
  syncReset.style.height = "28px";
  syncReset.textContent = t("归零摄像头音画同步");
  syncReset.addEventListener("click", () => {
    store.commit(t("归零摄像头音画同步"), (d) => {
      d.camera.syncOffset = 0;
    });
    paintInspector();
  });
  syncRow.append(syncStatus, syncReset);
  sync.appendChild(syncRow);
  group(sync, [
    sliderRow({
      label: t("偏移 %@", "0ms"),
      value: syncOffset,
      min: -1,
      max: 1,
      step: 1 / 30,
      format: (v) => `${v >= 0 ? "+" : ""}${Math.round(v * 1000)}`,
      suffix: "ms",
      parse: (text) => Number(text),
      scale: 0.001,
      tooltip: t("微调摄像头画面相对屏幕的时间偏移"),
      onChange: (v) => store.apply((d) => (d.camera.syncOffset = v)),
      onCommit: (v) => store.commit(t("校准摄像头音画同步"), (d) => (d.camera.syncOffset = v)),
    }),
  ]);
  const audition = document.createElement("button");
  audition.type = "button";
  audition.className = "btn";
  audition.style.width = "100%";
  audition.innerHTML = `${icon("play", 15)}<span>${t("试听")}</span>`;
  audition.addEventListener("click", () => {
    /* Play a short window around the playhead — the original's 自动试听. */
    if (store.playing) {
      togglePlay();
      return;
    }
    store.setPlayhead(Math.max(0, store.playhead - 1));
    startPlayback(store.playhead + 2);
  });
  sync.appendChild(audition);
  body.appendChild(sync);

  /* ---- 摄像头动画：原版的播放头布局预设与出现动画 ---- */
  const animation = section(t("摄像头动画"), t("在播放头添加；时长与缓动可随后在时间线上调整"));
  const addEntrance = document.createElement("button");
  addEntrance.type = "button";
  addEntrance.className = "btn";
  addEntrance.style.width = "100%";
  addEntrance.innerHTML = `${icon("plus", 15)}<span>${t("在播放头添加出现动画")}</span>`;
  addEntrance.addEventListener("click", () =>
    addCameraMotionClip({
      position: { ...camera.position },
      scale: 1,
      opacity: 1,
    }, { entrance: true })
  );
  animation.appendChild(addEntrance);

  const presetRow = document.createElement("div");
  presetRow.className = "row";
  presetRow.style.marginTop = "8px";
  const layoutPresets = [
    {
      label: t("全屏"),
      target: {
        position: { x: 0.5, y: 0.5 },
        scale: clamp(0.95 / Math.max(camera.size, 0.05), 0.2, 4),
        opacity: 1,
      },
    },
    {
      label: t("画中画"),
      target: {
        position: { x: 0.84, y: 0.24 },
        scale: clamp(0.24 / Math.max(camera.size, 0.05), 0.1, 4),
        opacity: 1,
      },
    },
    {
      label: t("当前布局"),
      target: { position: { ...camera.position }, scale: 1, opacity: 1 },
    },
  ];
  for (const preset of layoutPresets) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.style.flex = "1";
    button.textContent = preset.label;
    button.addEventListener("click", () => addCameraMotionClip(preset.target));
    presetRow.appendChild(button);
  }
  animation.appendChild(presetRow);
  body.appendChild(animation);

  renderCameraPresets(body, camera);
}

/**
 * Adds a camera motion clip at the playhead — the port of the original's
 * playhead layout presets and 出现动画. The target blends from the camera's
 * current layout; `entrance` clips keep the camera out of frame until they
 * start and fade in with their own ramp.
 */
function addCameraMotionClip(target, { entrance = false } = {}) {
  const id = rid();
  store.commit(entrance ? t("添加摄像头出现动画") : t("添加摄像头动画"), (doc) => {
    const clip = {
      id,
      startTime: Math.max(0, store.playhead),
      duration: 1.6,
      transitionIn: doc.motion.defaultZoomTransitionDuration,
      transitionOut: doc.motion.defaultZoomTransitionDuration,
      easing: doc.motion.defaultZoomEasing,
      entrance,
      target: {
        position: { ...target.position },
        scale: target.scale,
        rotation: 0,
        tiltX: 0,
        tiltY: 0,
        perspective: 0.65,
        opacity: target.opacity ?? 1,
        cornerRadius: doc.canvas.cornerRadius,
      },
    };
    doc.timeline.cameraMotionClips.push(clip);
    doc.timeline.cameraMotionClips.sort((a, b) => a.startTime - b.startTime);
  });
  store.select("cameraMotion", id);
  paintInspector();
}

/* ------------------------------------------------------------------------- */
/* 摄像头布局预设                                                            */
/* ------------------------------------------------------------------------- */

const CAMERA_PRESET_KEYS = [
  "shape",
  "position",
  "size",
  "borderWidth",
  "shadowStrength",
  "roundness",
  "isMirrored",
  "scaleDuringZoom",
  "contentPosition",
  "contentScale",
];

/**
 * Reusable camera layouts.
 *
 * Stored in the preference store rather than the project, because the whole
 * point is to carry one machine's camera framing — the physical position of a
 * webcam does not change between recordings.
 */
function renderCameraPresets(body, camera) {
  const presets = store.cameraLayoutPresets || [];
  const section_ = section(t("布局预设"), t("保存摄像头布局预设"));

  const actions = document.createElement("div");
  actions.className = "row";

  const save = document.createElement("button");
  save.type = "button";
  save.className = "btn";
  save.style.flex = "1";
  save.innerHTML = `${icon("plus", 15)}<span>${t("保存摄像头布局预设")}</span>`;
  save.addEventListener("click", async () => {
    const { value } = await promptName(t("预设名称"), t("新录制默认"));
    if (!value) return;
    const preset = { name: value };
    for (const key of CAMERA_PRESET_KEYS) preset[key] = structuredClone(camera[key]);
    store.cameraLayoutPresets = [
      ...presets.filter((entry) => entry.name !== value),
      preset,
    ];
    await api().prefs.set("cameraLayoutPresets", store.cameraLayoutPresets);
    toast(t("保存摄像头布局预设"), { icon: "camera" });
    paintInspector();
  });
  actions.appendChild(save);
  section_.appendChild(actions);

  if (presets.length) {
    const list = document.createElement("div");
    list.className = "group";
    for (const preset of presets) {
      const row = document.createElement("div");
      row.className = "order-row";
      const label = document.createElement("span");
      label.className = "field-label";
      label.style.flex = "1";
      label.textContent = preset.name;

      const apply = document.createElement("button");
      apply.type = "button";
      apply.className = "btn";
      apply.style.height = "26px";
      apply.textContent = t("应用");
      apply.addEventListener("click", () => {
        store.commit(t("应用场景预设"), (doc) => {
          for (const key of CAMERA_PRESET_KEYS) {
            if (preset[key] !== undefined) doc.camera[key] = structuredClone(preset[key]);
          }
        });
      });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn btn-icon";
      remove.style.height = "26px";
      remove.style.width = "26px";
      remove.innerHTML = icon("trash", 13);
      remove.addEventListener("click", async () => {
        store.cameraLayoutPresets = presets.filter((entry) => entry.name !== preset.name);
        await api().prefs.set("cameraLayoutPresets", store.cameraLayoutPresets);
        paintInspector();
      });

      row.append(label, apply, remove);
      list.appendChild(row);
    }
    section_.appendChild(list);
  }

  body.appendChild(section_);
}

/** Small inline name prompt, matching the project-rename dialog. */
function promptName(title, initial) {
  return new Promise((resolve) => {
    const backdrop = document.createElement("div");
    backdrop.className = "modal-backdrop";
    const modal = document.createElement("div");
    modal.className = "modal";
    modal.innerHTML = `<h2>${title}</h2>`;
    const input = document.createElement("input");
    input.className = "text-field";
    input.value = initial;
    modal.appendChild(input);
    const actions = document.createElement("div");
    actions.className = "modal-actions";
    const cancel = document.createElement("button");
    cancel.className = "btn";
    cancel.textContent = t("取消");
    const ok = document.createElement("button");
    ok.className = "btn btn-primary";
    ok.style.height = "var(--height-selection)";
    ok.style.padding = "0 18px";
    ok.textContent = t("确定");
    actions.append(cancel, ok);
    modal.appendChild(actions);
    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    input.focus();
    input.select();
    cancel.addEventListener("click", () => {
      backdrop.remove();
      resolve({});
    });
    ok.addEventListener("click", () => {
      backdrop.remove();
      resolve({ value: input.value.trim() });
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") ok.click();
      if (event.key === "Escape") cancel.click();
      event.stopPropagation();
    });
  });
}

/* ------------------------------------------------------------------------- */
/* 声音                                                                      */
/* ------------------------------------------------------------------------- */

function renderAudioTool(body) {
  const doc = store.document;
  const audio = doc.audio;
  const clip = store.selection.kind === "primary" ? store.findPrimary(store.selection.id) : null;
  const override = clip?.audioOverride || null;

  const scope = section(t("片段声音"));
  scope.appendChild(
    choiceGroup(
      [
        { value: "inherit", label: t("继承全片设置") },
        { value: "custom", label: t("仅此片段，自定义设置") },
      ],
      override ? "custom" : "inherit",
      (value) => {
        if (!clip) {
          toast(t("请先选择一个主片段，再调整它的声音。"), {
            icon: "info",
          });
          return;
        }
        store.commit(value === "custom" ? t("调整当前片段系统声音") : t("恢复片段声音继承"), (d) => {
          const target = d.timeline.primaryClips.find((entry) => entry.id === clip.id);
          if (!target) return;
          target.audioOverride =
            value === "custom"
              ? { systemVolume: d.audio.systemVolume, microphoneVolume: d.audio.microphoneVolume }
              : null;
        });
        paintInspector();
      }
    )
  );
  if (clip && override) {
    const hint = document.createElement("p");
    hint.className = "section-hint";
    hint.textContent = t("已覆盖此段的声音设置");
    scope.appendChild(hint);
  }
  body.appendChild(scope);

  /* Clip-level playback speed. Changing it re-times the clip and reflows the
     timeline, so the whole project's duration follows. */
  if (clip) {
    const speed = section(t("片段长度"), t("开始 %@ · 范围 %@", "0.00s", `${clip.sourceDuration.toFixed(2)}s`));
    group(speed, [
      sliderRow({
        label: t("调整片段速度"),
        value: clip.speed,
        min: 0.25,
        max: 4,
        step: 0.05,
        format: (v) => `${v.toFixed(2)}×`,
        suffix: "",
        onChange: (v) =>
          store.apply((d) => {
            const target = d.timeline.primaryClips.find((entry) => entry.id === clip.id);
            if (target) target.speed = v;
          }),
        onCommit: (v) => store.setSpeed(clip.id, v),
      }),
    ]);
    const presets = document.createElement("div");
    presets.className = "choice-row";
    for (const value of SPEED_PRESETS) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "choice";
      if (Math.abs(clip.speed - value) < 0.001) button.classList.add("is-selected");
      button.textContent = `${value}×`;
      button.addEventListener("click", () => store.setSpeed(clip.id, value));
      presets.appendChild(button);
    }
    speed.appendChild(presets);
    body.appendChild(speed);
  }

  const system = section(t("系统声音"), t("录屏中的应用与系统声音"));
  group(system, [
    switchRow(t("全片静音"), audio.isSystemMuted, (value) => {
      store.commit(t("切换系统声音"), (d) => {
        d.audio.isSystemMuted = value;
      });
    }),
    sliderRow({
      label: t("系统声音音量"),
      value: audio.systemVolume,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => {
        store.apply((d) => (d.audio.systemVolume = v));
        const element = store.media.system;
        if (element) element.volume = audio.isSystemMuted ? 0 : v;
      },
      onCommit: (v) => store.commit(t("调整系统声音音量"), (d) => (d.audio.systemVolume = v)),
    }),
  ]);
  if (!doc.media?.system) {
    const empty = document.createElement("p");
    empty.className = "section-hint";
    empty.textContent = t("当前项目没有系统声音或麦克风素材");
    system.appendChild(empty);
  }
  body.appendChild(system);

  const microphone = section(t("麦克风"), t("独立录制的人声轨道"));
  group(microphone, [
    switchRow(t("全片静音"), audio.isMicrophoneMuted, (value) => {
      store.commit(t("切换麦克风"), (d) => {
        d.audio.isMicrophoneMuted = value;
      });
    }),
    sliderRow({
      label: t("麦克风音量"),
      value: audio.microphoneVolume,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => {
        store.apply((d) => (d.audio.microphoneVolume = v));
        const element = store.media.microphone;
        if (element) element.volume = audio.isMicrophoneMuted ? 0 : v;
      },
      onCommit: (v) => store.commit(t("调整麦克风音量"), (d) => (d.audio.microphoneVolume = v)),
    }),
  ]);
  if (!doc.media?.microphone) {
    const empty = document.createElement("p");
    empty.className = "section-hint";
    empty.textContent = t("当前项目没有系统声音或麦克风素材");
    microphone.appendChild(empty);
  }
  body.appendChild(microphone);
}

/* ------------------------------------------------------------------------- */
/* 贴图                                                                      */
/* ------------------------------------------------------------------------- */

function renderStickerTool(body, clip) {
  const list = store.document.timeline.stickerClips;
  const index = list.indexOf(clip);
  const apply = (mutate) => store.apply(mutate);
  const commit = (name, mutate) => store.commit(name, mutate);
  const withClip = (mutate) => (doc) => {
    const target = doc.timeline.stickerClips.find((entry) => entry.id === clip.id);
    if (target) mutate(target);
  };

  const position = section(t("位置与大小"), t("拖动中部移动；拖动两端调整时长"));
  const pad = document.createElement("div");
  pad.className = "position-pad";
  position.appendChild(pad);
  renderPositionPad(
    pad,
    clip.position,
    (x, y) => apply(withClip((target) => (target.position = { x, y }))),
    () => store.commitGesture(t("移动贴图"))
  );
  group(position, [
    sliderRow({
      label: t("大小"),
      value: clip.scale,
      min: 0.02,
      max: 1.5,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.scale = v))),
      onCommit: (v) => commit(t("调整贴图大小"), withClip((target) => (target.scale = v))),
    }),
    sliderRow({
      label: t("旋转"),
      value: clip.rotation,
      min: -180,
      max: 180,
      step: 1,
      format: (v) => String(Math.round(v)),
      suffix: "°",
      onChange: (v) => apply(withClip((target) => (target.rotation = v))),
      onCommit: (v) => commit(t("旋转贴图"), withClip((target) => (target.rotation = v))),
    }),
    sliderRow({
      label: t("透明度"),
      value: clip.opacity,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.opacity = v))),
      onCommit: (v) => commit(t("调整贴图"), withClip((target) => (target.opacity = v))),
    }),
  ]);
  body.appendChild(position);

  const appearance = section(t("圆角、描边与阴影"));
  group(appearance, [
    sliderRow({
      label: t("描边"),
      value: clip.borderWidth,
      min: 0,
      max: 40,
      step: 0.5,
      format: (v) => v.toFixed(1),
      suffix: "px",
      onChange: (v) => apply(withClip((target) => (target.borderWidth = v))),
      onCommit: (v) => commit(t("调整贴图描边"), withClip((target) => (target.borderWidth = v))),
    }),
    colorRow(t("描边颜色"), clip.borderColor, (hex) =>
      commit(t("调整贴图描边"), withClip((target) => (target.borderColor = hex)))
    ),
    sliderRow({
      label: t("阴影"),
      value: clip.shadowStrength,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.shadowStrength = v))),
      onCommit: (v) => commit(t("调整贴图"), withClip((target) => (target.shadowStrength = v))),
    }),
  ]);
  body.appendChild(appearance);

  const timing = section(t("过渡与时间"));
  group(timing, [
    sliderRow({
      label: t("片段时间"),
      value: clip.duration,
      min: 0.2,
      max: Math.max(1, store.duration),
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) => apply(withClip((target) => (target.duration = v))),
      onCommit: (v) => commit(t("修剪贴图"), withClip((target) => (target.duration = v))),
    }),
  ]);
  body.appendChild(timing);

  const animation = section(t("入场时长"));
  group(animation, [
    choiceGroup(
      STICKER_ANIMATIONS_IN.map((value) => ({ value, label: t(value) })),
      clip.animationIn,
      (value) =>
        commit(t("选择贴图动画"), withClip((target) => (target.animationIn = value)))
    ),
    sliderRow({
      label: t("入场时长"),
      value: clip.animationInDuration,
      min: 0.05,
      max: 2,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) => apply(withClip((target) => (target.animationInDuration = v))),
      onCommit: (v) => commit(t("调整贴图"), withClip((target) => (target.animationInDuration = v))),
    }),
  ]);
  body.appendChild(animation);

  const exit = section(t("出场时长"));
  group(exit, [
    choiceGroup(
      STICKER_ANIMATIONS_OUT.map((value) => ({ value, label: t(value) })),
      clip.animationOut,
      (value) =>
        commit(t("选择贴图动画"), withClip((target) => (target.animationOut = value)))
    ),
    sliderRow({
      label: t("出场时长"),
      value: clip.animationOutDuration,
      min: 0.05,
      max: 2,
      step: 0.05,
      format: (v) => v.toFixed(2),
      suffix: "s",
      onChange: (v) => apply(withClip((target) => (target.animationOutDuration = v))),
      onCommit: (v) => commit(t("调整贴图"), withClip((target) => (target.animationOutDuration = v))),
    }),
  ]);
  body.appendChild(exit);

  const rhythm = section(t("动效节奏"));
  group(rhythm, [
    choiceGroup(
      MOTION_CURVES.map((curve) => ({ value: curve.value, label: t(curve.label) })),
      clip.animationCurve || "swift",
      (value) => commit(t("调整贴图动效节奏"), withClip((target) => (target.animationCurve = value)))
    ),
  ]);
  body.appendChild(rhythm);

  const layers = section(t("当前第 %lld 层，共 %lld 层", index + 1, list.length));
  const layerRow = document.createElement("div");
  layerRow.className = "row";
  for (const [label, delta] of [
    ["置底贴图", -999],
    ["下移贴图", -1],
    ["上移贴图", 1],
    ["置顶贴图", 999],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.style.flex = "1";
    button.textContent = t(label);
    button.addEventListener("click", () => moveStickerLayer(clip.id, delta));
    layerRow.appendChild(button);
  }
  layers.appendChild(layerRow);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn";
  remove.style.width = "100%";
  remove.innerHTML = `${icon("trash", 15)}<span>${t("删除贴图")}</span>`;
  remove.addEventListener("click", () => {
    store.select("sticker", clip.id);
    store.deleteSelection();
  });
  layers.appendChild(remove);
  body.appendChild(layers);
}

/** Reorders a sticker within the layer stack. */
function moveStickerLayer(id, delta) {
  store.commit(t("调整贴图层级"), (doc) => {
    const list = doc.timeline.stickerClips;
    const index = list.findIndex((entry) => entry.id === id);
    if (index < 0) return;
    const next = delta >= 999 ? list.length - 1 : delta <= -999 ? 0 : index + delta;
    const clamped = Math.max(0, Math.min(list.length - 1, next));
    if (clamped === index) return;
    const [moved] = list.splice(index, 1);
    list.splice(clamped, 0, moved);
    list.forEach((entry, order) => {
      entry.layer = order;
    });
  });
}

/* ------------------------------------------------------------------------- */
/* 打码                                                                      */
/* ------------------------------------------------------------------------- */

function renderMosaicTool(body, clip) {
  const apply = (mutate) => store.apply(mutate);
  const commit = (name, mutate) => store.commit(name, mutate);
  const withClip = (mutate) => (doc) => {
    const target = doc.timeline.mosaicClips.find((entry) => entry.id === clip.id);
    if (target) mutate(target);
  };

  const style = section(t("柔化或突出"));
  style.appendChild(
    choiceGroup(
      [
        { value: "柔化", label: t("柔化") },
        { value: "突出", label: t("突出") },
      ],
      clip.style,
      (value) => commit(t("调整打码"), withClip((target) => (target.style = value)))
    )
  );
  const hint = document.createElement("p");
  hint.className = "section-hint";
  hint.textContent =
    clip.style === "突出"
      ? t("突出暗度")
      : t("清晰带 · 两侧渐变虚化");
  style.appendChild(hint);
  body.appendChild(style);

  const strength = section(t(clip.style === "突出" ? "突出暗度" : "柔化强度"));
  group(strength, [
    sliderRow({
      label: t("强度"),
      value: clip.strength,
      min: 0,
      max: 1,
      step: 0.01,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.strength = v))),
      onCommit: (v) => commit(t("调整打码"), withClip((target) => (target.strength = v))),
    }),
  ]);
  body.appendChild(strength);

  const area = section(t("选中区域"), t("在画面上拖动边缘或四角，拖动框内可整体移动。"));
  const rect = clip.rect;
  group(area, [
    sliderRow({
      label: "X",
      value: rect.x,
      min: 0,
      max: 1,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.rect.x = v))),
      onCommit: (v) => commit(t("移动打码区域"), withClip((target) => (target.rect.x = v))),
    }),
    sliderRow({
      label: "Y",
      value: rect.y,
      min: 0,
      max: 1,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.rect.y = v))),
      onCommit: (v) => commit(t("移动打码区域"), withClip((target) => (target.rect.y = v))),
    }),
    sliderRow({
      label: t("宽度"),
      value: rect.width,
      min: 0.03,
      max: 1,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.rect.width = v))),
      onCommit: (v) => commit(t("调整打码区域"), withClip((target) => (target.rect.width = v))),
    }),
    sliderRow({
      label: t("高度"),
      value: rect.height,
      min: 0.03,
      max: 1,
      step: 0.005,
      format: (v) => String(Math.round(v * 100)),
      suffix: "%",
      onChange: (v) => apply(withClip((target) => (target.rect.height = v))),
      onCommit: (v) => commit(t("调整打码区域"), withClip((target) => (target.rect.height = v))),
    }),
  ]);
  body.appendChild(area);

  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "btn";
  remove.style.width = "100%";
  remove.innerHTML = `${icon("trash", 15)}<span>${t("删除柔化")}</span>`;
  remove.addEventListener("click", () => {
    store.select("mosaic", clip.id);
    store.deleteSelection();
  });
  body.appendChild(remove);
}

/* ------------------------------------------------------------------------- */
/* Shared colour row                                                         */
/* ------------------------------------------------------------------------- */

/**
 * Colour row: a swatch that opens the preset palette, plus an editable hex
 * field — the port of EditorHexColorInput. Invalid input is rejected rather
 * than silently written, which is what the original's validation does.
 */
function colorRow(label, value, onChange) {
  const row = document.createElement("div");
  row.className = "field-row";
  const name = document.createElement("span");
  name.className = "field-label";
  name.textContent = label;

  const swatch = document.createElement("button");
  swatch.type = "button";
  swatch.className = "color-chip";
  swatch.style.background = value;
  attachTooltip(swatch, t("打开%@取色器", label));
  swatch.addEventListener("click", () => {
    showMenu(
      swatch,
      CURSOR_PRESET_COLORS.map((preset) => ({
        label: t(preset.label),
        note: preset.hex,
        checked: value?.toUpperCase() === preset.hex,
        onSelect: () => {
          onChange(preset.hex);
          paintInspector();
        },
      })),
      { align: "right" }
    );
  });

  const hex = document.createElement("input");
  hex.className = "text-field hex-field";
  hex.value = value || "#FFFFFF";
  hex.spellcheck = false;
  hex.maxLength = 7;
  attachTooltip(hex, t("请输入六位色值，例如 #EDA647"));
  hex.addEventListener("keydown", (event) => {
    if (event.key === "Enter") hex.blur();
    event.stopPropagation();
  });
  hex.addEventListener("blur", () => {
    const candidate = hex.value.trim().toUpperCase();
    if (/^#[0-9A-F]{6}$/.test(candidate)) {
      onChange(candidate);
    } else {
      hex.value = value || "#FFFFFF";
      toast(t("%@格式无效", t("描边颜色")), { icon: "info" });
    }
  });

  row.append(name, hex, swatch);
  return row;
}

function api() {
  return window.dogsc;
}

export { state as inspectorState, easeProgress };
