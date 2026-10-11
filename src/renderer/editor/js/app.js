/**
 * Editor application.
 *
 * Boots the workspace, wires the top bar, the preview surface, the transport,
 * the crop tool and the keyboard map. Port of `EditorView` + `DogSCApp`'s
 * command routing.
 */

import { icon } from "../../shared/icons.js";
import { setLocale, t } from "../../shared/i18n.js";
import {
  attachTooltip,
  clamp,
  formatTimecode,
  showMenu,
  showSheet,
  toast,
} from "../../shared/widgets.js";
import { CANVAS_RATIOS, normalizeDocument } from "./model.js";
import { planAutoZoom } from "./auto-zoom.js";
import { renderFrame, setInteractiveSelection, resolveCanvasSize } from "./frame-renderer.js";
import { store } from "./store.js";
import {
  buildFilmstrip,
  buildWaveform,
  mountTimeline,
  paint as paintTimeline,
  pasteAttributes,
  pasteClipboard,
  setZoom,
  startPlayback,
  stopPlayback,
  syncMedia,
  togglePlay,
} from "./timeline.js";
import { mountInspector, mountRail, paintInspector, refreshRailAvailability } from "./inspector.js";

const api = window.dogsc;

const ui = {
  canvas: null,
  ctx: null,
  cropOverlay: null,
  cropRect: null,
  renderQueued: false,
  timelineHeight: 250,
  cropMode: false,
};

/* ------------------------------------------------------------------------- */
/* Boot                                                                      */
/* ------------------------------------------------------------------------- */

async function boot() {
  setLocale("zh-Hans");
  const prefs = await api.prefs.all();
  const theme = await api.app.theme();
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
  store.previewQuality = prefs.previewQuality || "smooth";
  store.scenePresets = Array.isArray(prefs.scenePresets) ? prefs.scenePresets : [];
  store.defaultSceneName = prefs.defaultScenePreset?.name || null;
  /* Remembered from the last session, like the original's `waveform-clips`. */
  store.filmstripMode = prefs.waveformClips ? "waveform" : "picture";
  store.cameraLayoutPresets = Array.isArray(prefs.cameraLayoutPresets)
    ? prefs.cameraLayoutPresets
    : [];
  store.snapping = true;

  ui.canvas = document.getElementById("preview-canvas");
  ui.needsRender = false;
  ui.lastSeekTime = null;
  ui.ctx = ui.canvas.getContext("2d", { alpha: false });

  buildTopBar();
  buildCanvasToolbar();
  mountRail(document.getElementById("tool-rail"));
  mountInspector(document.getElementById("inspector"));
  mountTimeline(document.getElementById("timeline"));
  buildCropOverlay();
  buildSplitter();

  store.subscribe(() => queueRender());
  window.addEventListener("resize", () => {
    resizePreview();
    queueRender();
  });

  api.on("app:theme", (payload) => {
    document.documentElement.dataset.theme = payload.dark ? "dark" : "light";
    queueRender();
  });
  api.on("editor:open-project", (packagePath) => openProject(packagePath));
  api.on("editor:menu-command", (command) => runCommand(command));
  document.addEventListener("dogsc:enter-crop", () => enterCropMode());

  const params = new URLSearchParams(location.search);
  const projectPath = params.get("project");
  if (projectPath) await openProject(projectPath);
  else await openLastOrCreate();

  installShortcuts();
  resizePreview();
  startPreviewLoop();
}

async function openLastOrCreate() {
  const prefs = await api.prefs.all();
  const last = prefs.lastProjectPath;
  if (last) {
    const result = await api.project.open(last).catch(() => null);
    if (result) {
      await openProject(last);
      return;
    }
  }
  showEmptyState();
}

function showEmptyState() {
  const overlay = document.getElementById("empty-state");
  overlay.hidden = false;
  document.getElementById("btn-open-project").addEventListener("click", pickProject);
}

async function pickProject() {
  const folder = await api.project.pickFolder({
    title: t("选择要继续编辑的项目"),
    defaultPath: (await api.prefs.all()).projectLocation,
  });
  if (!folder) return;
  await openProject(folder);
}

async function openProject(packagePath) {
  try {
    await store.load(packagePath);
  } catch (error) {
    toast(t("无法读取当前项目素材"), { icon: "info" });
    showEmptyState();
    return;
  }
  document.getElementById("empty-state").hidden = true;
  document.getElementById("project-name").textContent = store.document.name;
  document.title = `${store.document.name} — DogSC`;
  /* The rail is built before the document exists, so which tools the project
     makes available is only known now. */
  refreshRailAvailability();
  paintInspector();
  paintTimeline();
  resizePreview();
  queueRender();
  /* Analysed in the background. The filmstrip seeks the recording around, so
     the preview is told to re-park on the playhead once it finishes. */
  buildFilmstrip()
    .then(() => {
      ui.lastSeekTime = null;
    })
    .catch(() => {});
  buildWaveform().catch(() => {});
  document.getElementById("canvas-ratio-label").textContent = store.document.canvas.aspectRatio;
}

/* ------------------------------------------------------------------------- */
/* Top bar                                                                   */
/* ------------------------------------------------------------------------- */

function buildTopBar() {
  const bar = document.getElementById("top-bar");

  const sidebar = topButton("sidebar", t("显示 / 隐藏检查器"), () => {
    const inspector = document.getElementById("inspector");
    inspector.hidden = !inspector.hidden;
    resizePreview();
  });
  sidebar.id = "btn-sidebar";

  const titleGroup = document.createElement("button");
  titleGroup.type = "button";
  titleGroup.className = "project-title";
  titleGroup.id = "project-title";
  titleGroup.innerHTML = `<span id="project-name">${t("未命名项目")}</span>${icon("chevronDown", 14)}`;
  attachTooltip(titleGroup, t("重命名项目"));
  titleGroup.addEventListener("click", (event) => showProjectMenu(event.currentTarget));

  const copy = topButton("copy", t("复制片段"), async () => {
    await navigator.clipboard.writeText(store.packagePath || "");
    toast(t("已复制"), { icon: "copy", duration: 1200 });
  });

  const left = document.getElementById("top-left");
  left.append(sidebar, titleGroup, copy);

  const right = document.getElementById("top-right");
  const undo = topButton("undo", t("撤销（⌘Z）"), () => store.undo());
  undo.id = "btn-undo";
  const redo = topButton("redo", t("重做（⌘⇧Z）"), () => store.redo());
  redo.id = "btn-redo";

  const scene = document.createElement("button");
  scene.type = "button";
  scene.className = "btn";
  scene.innerHTML = `${icon("sparkles", 15)}<span>${t("场景预设")}</span>`;
  scene.addEventListener("click", (event) => showSceneMenu(event.currentTarget));

  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "btn";
  exportButton.id = "btn-export";
  exportButton.innerHTML = `${icon("export", 15)}<span>${t("导出")}</span>`;
  attachTooltip(exportButton, t("导出成片（⌘E）"));
  /* `openExport(range)` takes an optional export range — handing the listener
     the click event itself made the panel read `event.end - event.start` as
     the duration (NaN) and treat the event as a range, which rebased every
     clip timestamp onto NaN and produced a black, un-exportable sheet. */
  exportButton.addEventListener("click", () => openExport());

  const help = topButton("help", t("快捷键"), () => showShortcuts());
  const theme = topButton("sun", t("切换深色 / 浅色外观"), async () => {
    const current = document.documentElement.dataset.theme;
    await api.app.setTheme(current === "dark" ? "light" : "dark");
  });
  theme.id = "btn-theme";

  const settings = topButton("settings", t("设置"), () => api.windows.openSettings());

  const windowControls = document.createElement("div");
  windowControls.className = "window-controls";
  windowControls.innerHTML = `
    <button type="button" data-action="minimize" aria-label="minimize">${icon("minus", 14)}</button>
    <button type="button" data-action="maximize" aria-label="maximize">${icon("inset", 12)}</button>
    <button type="button" data-action="close" aria-label="close">${icon("close", 14)}</button>
  `;
  windowControls.querySelector('[data-action="minimize"]').addEventListener("click", () => api.windows.minimize());
  windowControls.querySelector('[data-action="maximize"]').addEventListener("click", () => api.windows.toggleMaximize());
  windowControls.querySelector('[data-action="close"]').addEventListener("click", () => api.windows.close());

  right.append(undo, redo, scene, exportButton, help, theme, settings, windowControls);
  void bar;
}

function topButton(iconName, title, onClick) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-ghost btn-icon";
  button.innerHTML = icon(iconName, 16);
  attachTooltip(button, title);
  button.addEventListener("click", onClick);
  return button;
}

function showProjectMenu(anchor) {
  showMenu(
    anchor,
    [
      { label: t("重命名项目"), onSelect: renameProject },
      { label: t("保存项目"), note: "Ctrl+S", onSelect: () => store.save().then(() => toast(t("已保存"), { icon: "save" })) },
      { separator: true },
      { label: t("打开项目…"), note: "Ctrl+O", onSelect: pickProject },
      { label: t("在文件夹中显示"), onSelect: () => api.project.reveal(store.packagePath) },
      { separator: true },
      { label: t("导出成片…"), note: "Ctrl+E", onSelect: openExport },
    ],
    { align: "left", width: 230 }
  );
}

async function renameProject() {
  const { value } = await promptInline(t("项目名称"), store.document.name);
  if (!value) return;
  store.commit(t("重命名项目"), (doc) => {
    doc.name = value;
  });
  document.getElementById("project-name").textContent = value;
}

function promptInline(title, initial) {
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

/**
 * Scene presets live in the preference store, not in the project, because the
 * original treats them as reusable across recordings — including the one that
 * new recordings start from.
 */
function showSceneMenu(anchor) {
  const presets = store.scenePresets;
  const defaultName = store.defaultSceneName;
  showMenu(
    anchor,
    [
      { header: t("场景预设") },
      { label: t("保存场景预设"), onSelect: () => saveScenePreset(false) },
      ...(presets.length
        ? [
            { separator: true },
            ...presets.map((preset) => ({
              label: preset.name,
              note: preset.name === defaultName ? t("新录制默认") : undefined,
              onSelect: () => applyScenePreset(preset),
            })),
            { separator: true },
            ...presets.map((preset) => ({
              label: t("设为新录制默认：%@", preset.name),
              checked: preset.name === defaultName,
              onSelect: () => setDefaultScenePreset(preset.name),
            })),
            { separator: true },
            ...presets.map((preset) => ({
              label: t("删除预设：%@", preset.name),
              onSelect: () => deleteScenePreset(preset.name),
            })),
          ]
        : [{ label: t("保存或复用完整场景配置"), disabled: true }]),
    ],
    { align: "right", width: 300 }
  );
}

/**
 * Marks a preset as the one new recordings start from.
 *
 * The whole preset is stored, not just its name, because the main process
 * seeds a freshly recorded project from it before the editor ever sees the
 * document.
 */
async function setDefaultScenePreset(name) {
  const preset = store.scenePresets.find((entry) => entry.name === name) || null;
  store.defaultSceneName = preset ? name : null;
  await api.prefs.set("defaultScenePreset", preset);
  toast(preset ? t("新录制默认：%@", name) : t("已取消新录制默认"), { icon: "sparkles" });
}

async function saveScenePreset(makeDefault) {
  const { value } = await promptInline(t("预设名称"), t("新录制默认"));
  if (!value) return;
  const doc = store.document;
  const preset = {
    name: value,
    canvas: structuredClone(doc.canvas),
    camera: structuredClone(doc.camera),
    cursorStyle: structuredClone(doc.cursorStyle),
    opening: structuredClone(doc.opening),
    motion: structuredClone(doc.motion),
  };
  store.scenePresets = [...store.scenePresets.filter((entry) => entry.name !== value), preset];
  await api.prefs.set("scenePresets", store.scenePresets);
  if (makeDefault) await setDefaultScenePreset(value);
  toast(t("保存场景预设"), { icon: "sparkles" });
}

async function deleteScenePreset(name) {
  store.scenePresets = store.scenePresets.filter((entry) => entry.name !== name);
  await api.prefs.set("scenePresets", store.scenePresets);
  if (store.defaultSceneName === name) {
    store.defaultSceneName = null;
    await api.prefs.set("defaultScenePreset", null);
  }
  paintInspector();
}

function applyScenePreset(preset) {
  store.commit(t("应用场景预设"), (doc) => {
    doc.canvas = { ...doc.canvas, ...structuredClone(preset.canvas) };
    doc.camera = { ...doc.camera, ...structuredClone(preset.camera) };
    doc.cursorStyle = { ...doc.cursorStyle, ...structuredClone(preset.cursorStyle) };
    doc.opening = { ...doc.opening, ...structuredClone(preset.opening) };
    doc.motion = { ...doc.motion, ...structuredClone(preset.motion) };
  });
}

/* ------------------------------------------------------------------------- */
/* Canvas toolbar                                                            */
/* ------------------------------------------------------------------------- */

function buildCanvasToolbar() {
  const bar = document.getElementById("canvas-toolbar");

  const ratio = document.createElement("button");
  ratio.type = "button";
  ratio.className = "chip";
  ratio.id = "canvas-ratio";
  ratio.innerHTML = `${icon("ratio", 14)}<span id="canvas-ratio-label">${t("适应")}</span>${icon(
    "chevronDown",
    12
  )}`;
  ratio.addEventListener("click", (event) => {
    showMenu(
      event.currentTarget,
      CANVAS_RATIOS.map((value) => ({
        label: value,
        checked: store.document.canvas.aspectRatio === value,
        onSelect: () => {
          if (value === "自定义") {
            promptCustomRatio();
            return;
          }
          store.commit(t("调整画布比例"), (doc) => {
            doc.canvas.aspectRatio = value;
          });
          document.getElementById("canvas-ratio-label").textContent = value;
          resizePreview();
        },
      })),
      { align: "center" }
    );
  });

  const crop = document.createElement("button");
  crop.type = "button";
  crop.className = "chip";
  crop.id = "canvas-crop";
  crop.innerHTML = `${icon("crop", 14)}<span>${t("裁切")}</span>`;
  crop.addEventListener("click", () => enterCropMode());

  const add = document.createElement("button");
  add.type = "button";
  add.className = "chip chip-icon";
  add.innerHTML = icon("plus", 15);
  attachTooltip(add, t("添加到画面"));
  add.addEventListener("click", (event) => {
    showMenu(
      event.currentTarget,
      [
        { label: t("导入贴图…"), icon: "sticker", onSelect: importSticker },
        { label: t("柔化或突出"), icon: "wand", onSelect: addMosaic },
        { separator: true },
        { label: t("在播放头添加屏幕 3D"), icon: "spark", onSelect: () => addScreenMotion() },
        { label: t("在播放头添加摄像运动"), icon: "camera", onSelect: () => addCameraMotion() },
        { separator: true },
        { label: t("自动运镜（按点击生成）"), icon: "zoomIn", onSelect: runAutoZoom },
      ],
      { align: "center", width: 250 }
    );
  });

  const list = document.createElement("button");
  list.type = "button";
  list.className = "chip chip-icon";
  list.innerHTML = icon("list", 15);
  attachTooltip(list, t("录制标记"));
  list.addEventListener("click", () => {
    document.getElementById("btn-marker-list")?.click();
  });

  bar.append(ratio, crop, add, list);
}

/**
 * Custom canvas ratio. The original accepts any ratio between 1:10 and 10:1
 * and rejects anything outside it.
 */
async function promptCustomRatio() {
  const current = store.document.canvas.customAspectRatio || { width: 16, height: 9 };
  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal";
  modal.innerHTML = `<h2>${t("输入宽高比例，例如 3:2（支持 1:10 至 10:1）")}</h2>`;

  const row = document.createElement("div");
  row.className = "row";
  const widthField = document.createElement("input");
  widthField.className = "text-field";
  widthField.value = String(current.width);
  const colon = document.createElement("span");
  colon.className = "field-value";
  colon.textContent = ":";
  const heightField = document.createElement("input");
  heightField.className = "text-field";
  heightField.value = String(current.height);
  row.append(widthField, colon, heightField);
  modal.appendChild(row);

  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const cancel = document.createElement("button");
  cancel.className = "btn";
  cancel.textContent = t("取消");
  const apply = document.createElement("button");
  apply.className = "btn btn-primary";
  apply.style.height = "var(--height-selection)";
  apply.style.padding = "0 18px";
  apply.textContent = t("应用");
  actions.append(cancel, apply);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  document.body.appendChild(backdrop);
  widthField.focus();
  widthField.select();

  const close = () => backdrop.remove();
  cancel.addEventListener("click", close);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) close();
  });
  for (const field of [widthField, heightField]) {
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") apply.click();
      if (event.key === "Escape") close();
      event.stopPropagation();
    });
  }
  apply.addEventListener("click", () => {
    const width = Number(widthField.value);
    const height = Number(heightField.value);
    const ratio = width / Math.max(height, 0.0001);
    if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 10) {
      toast(t("输入宽高比例，例如 3:2（支持 1:10 至 10:1）"), { icon: "info" });
      return;
    }
    store.commit(t("调整画布比例"), (doc) => {
      doc.canvas.aspectRatio = "自定义";
      doc.canvas.customAspectRatio = { width, height };
    });
    document.getElementById("canvas-ratio-label").textContent = "自定义";
    close();
    resizePreview();
  });
}

/**
 * Custom canvas ratio. The original accepts any ratio between 1:10 and 10:1
 * and rejects anything outside it.
 */
async function importSticker() {
  const file = await api.project.pickFile({
    title: t("选择贴图"),
    filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
  });
  if (!file) return;
  const relative = await store.importSticker(file);
  if (!relative) return;
  const layer = store.document.timeline.stickerClips.length;
  store.commit(t("导入贴图…"), (doc) => {
    doc.timeline.stickerClips.push({
      id: crypto.randomUUID(),
      startTime: store.playhead,
      duration: 2.5,
      source: relative,
      position: { x: 0.5, y: 0.5 },
      scale: 0.22,
      rotation: 0,
      opacity: 1,
      borderWidth: 0,
      borderColor: "#FFFFFF",
      shadowStrength: 0.2,
      layer,
      animationIn: "淡入",
      animationOut: "淡出",
      animationInDuration: 0.4,
      animationOutDuration: 0.4,
    });
  });
}

function addMosaic() {
  store.commit(t("添加柔化"), (doc) => {
    doc.timeline.mosaicClips.push({
      id: crypto.randomUUID(),
      startTime: store.playhead,
      duration: 2,
      rect: { x: 0.3, y: 0.3, width: 0.4, height: 0.3 },
      style: "柔化",
      strength: 0.5,
    });
  });
}

function addScreenMotion() {
  store.commit(t("添加屏幕 3D"), (doc) => {
    doc.timeline.screenMotionClips.push({
      id: crypto.randomUUID(),
      startTime: store.playhead,
      duration: 1.8,
      transitionIn: doc.motion.defaultZoomTransitionDuration,
      transitionOut: doc.motion.defaultZoomTransitionDuration,
      easing: doc.motion.defaultZoomEasing,
      target: {
        position: { ...doc.canvas.contentPosition },
        scale: 1.06,
        rotation: -6,
        tiltX: 8,
        tiltY: -12,
        perspective: 0.5,
        opacity: 1,
        cornerRadius: doc.canvas.cornerRadius,
      },
    });
    doc.timeline.screenMotionClips.sort((a, b) => a.startTime - b.startTime);
  });
}

/**
 * 自动运镜：按录制的点击轨迹生成缩放片段（对应原版 AutoZoomPlanner）。
 * 重新生成时只替换先前的自动片段，手动添加的缩放保持不动。
 */
function runAutoZoom() {
  if (!store.document) return;
  const planned = planAutoZoom(store.document);
  if (!planned.length) {
    toast(t("没有可用于自动运镜的点击记录"), { icon: "info" });
    return;
  }
  store.commit(t("自动运镜"), (doc) => {
    doc.timeline.zoomClips = [
      ...doc.timeline.zoomClips.filter((clip) => clip.mode !== "自动"),
      ...planned,
    ].sort((a, b) => a.startTime - b.startTime);
  });
  toast(t("已生成 %d 段自动运镜", planned.length), { icon: "spark" });
}

function addCameraMotion() {
  store.commit(t("添加摄像运动"), (doc) => {
    doc.timeline.cameraMotionClips.push({
      id: crypto.randomUUID(),
      startTime: store.playhead,
      duration: 1.8,
      transitionIn: doc.motion.defaultZoomTransitionDuration,
      transitionOut: doc.motion.defaultZoomTransitionDuration,
      easing: doc.motion.defaultZoomEasing,
      target: {
        position: { x: 0.5, y: 0.5 },
        scale: 1.3,
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

/* ------------------------------------------------------------------------- */
/* Preview                                                                   */
/* ------------------------------------------------------------------------- */

function resizePreview() {
  const host = document.getElementById("preview-host");
  const canvas = ui.canvas;
  if (!host || !canvas) return;

  const rect = host.getBoundingClientRect();
  const document_ = store.document;
  const ratio = document_ ? canvasRatio() : 16 / 9;

  let width = rect.width - 48;
  let height = width / ratio;
  if (height > rect.height - 48) {
    height = rect.height - 48;
    width = height * ratio;
  }
  width = Math.max(120, Math.floor(width));
  height = Math.max(80, Math.floor(height));

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ui.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ui.displaySize = { width, height };
  /* Kept so `render()` can hand the compositor the same scale the canvas was
     sized with — the frame must fill the whole backing store. */
  ui.displayScale = dpr;

  layoutCropOverlay();
}

function canvasRatio() {
  const canvas = store.document.canvas;
  const source = store.document.__sourceSize || { width: 1920, height: 1080 };
  const crop = canvas.crop;
  const fixed = {
    "16:9": 16 / 9,
    "4:3": 4 / 3,
    "9:16": 9 / 16,
    "1:1": 1,
    "3:4": 3 / 4,
    "2.39:1": 2.39,
    "1:2.39": 1 / 2.39,
  }[canvas.aspectRatio];
  if (fixed) return fixed;
  if (canvas.aspectRatio === "自定义") {
    return canvas.customAspectRatio.width / Math.max(canvas.customAspectRatio.height, 0.001);
  }
  return (source.width * crop.width) / Math.max(source.height * crop.height, 1);
}

function queueRender() {
  ui.needsRender = true;
}

/**
 * The preview runs continuously.
 *
 * Animated backgrounds, the opening sequence, cursor click ripples and video
 * frames all change without any store notification, and a decoded frame only
 * becomes drawable a moment after the playhead moves — so the surface is
 * repainted on every animation frame, exactly like the original's
 * `SharedRenderedPreviewSurface`.
 */
function startPreviewLoop() {
  if (ui.previewLoop) return;
  const step = () => {
    ui.previewLoop = requestAnimationFrame(step);
    render();
  };
  ui.previewLoop = requestAnimationFrame(step);
}

function render() {
  if (!store.document || !ui.displaySize) return;
  syncPreviewMedia();
  setInteractiveSelection(
    store.selection.kind === "screen"
      ? "screen"
      : store.selection.kind === "camera"
        ? "camera"
        : null
  );
  const result = renderFrame(ui.ctx, store.document, store.playhead, {
    width: ui.displaySize.width,
    height: ui.displaySize.height,
    scale: ui.displayScale || 1,
    sources: store.sources,
    interactive: true,
  });
  ui.lastLayout = result;
  if (ui.cropMode) updateCropOverlay();
}

/**
 * Keeps the recorded media parked on the playhead while paused, so scrubbing
 * updates the picture. During playback the timeline transport owns the clock
 * and this is a no-op.
 */
function syncPreviewMedia() {
  if (store.playing) {
    ui.lastSeekTime = store.playhead;
    return;
  }
  if (ui.lastSeekTime != null && Math.abs(ui.lastSeekTime - store.playhead) < 0.0005) return;
  ui.lastSeekTime = store.playhead;
  syncMedia(false);
}

/* ------------------------------------------------------------------------- */
/* Crop                                                                      */
/* ------------------------------------------------------------------------- */

function buildCropOverlay() {
  const host = document.getElementById("preview-host");
  const overlay = document.createElement("div");
  overlay.className = "crop-overlay";
  overlay.id = "crop-overlay";
  overlay.hidden = true;
  overlay.innerHTML = `
    <div class="crop-rect" id="crop-rect">
      <div class="crop-handle" data-handle="nw"></div>
      <div class="crop-handle" data-handle="ne"></div>
      <div class="crop-handle" data-handle="sw"></div>
      <div class="crop-handle" data-handle="se"></div>
      <div class="crop-handle" data-handle="n"></div>
      <div class="crop-handle" data-handle="s"></div>
      <div class="crop-handle" data-handle="w"></div>
      <div class="crop-handle" data-handle="e"></div>
      <div class="crop-size tabular" id="crop-size"></div>
    </div>
    <div class="crop-actions">
      <span class="crop-hint">${t("在画面上拖动边缘或四角，拖动框内可整体移动。")}</span>
      <button class="btn" id="crop-clear">${t("清除裁切")}</button>
      <button class="btn btn-primary" id="crop-done">${t("完成")}</button>
    </div>
  `;
  host.appendChild(overlay);

  overlay.addEventListener("mousedown", onCropDown);
  document.getElementById("crop-done").addEventListener("click", () => exitCropMode());
  document.getElementById("crop-clear").addEventListener("click", () => {
    store.commit(t("清除裁切"), (doc) => {
      doc.canvas.crop = { x: 0, y: 0, width: 1, height: 1 };
    });
    updateCropOverlay();
  });
}

function enterCropMode() {
  if (!store.document) return;
  ui.cropMode = true;
  document.getElementById("crop-overlay").hidden = false;
  document.getElementById("canvas-crop").classList.add("is-active");
  updateCropOverlay();
}

function exitCropMode() {
  ui.cropMode = false;
  document.getElementById("crop-overlay").hidden = true;
  document.getElementById("canvas-crop").classList.remove("is-active");
  resizePreview();
  queueRender();
}

function layoutCropOverlay() {
  const overlay = document.getElementById("crop-overlay");
  const canvas = ui.canvas;
  if (!overlay || !canvas) return;
  const hostRect = document.getElementById("preview-host").getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  overlay.style.left = `${canvasRect.left - hostRect.left}px`;
  overlay.style.top = `${canvasRect.top - hostRect.top}px`;
  overlay.style.width = `${canvasRect.width}px`;
  overlay.style.height = `${canvasRect.height}px`;
}

function updateCropOverlay() {
  if (!ui.cropMode) return;
  layoutCropOverlay();
  const rect = document.getElementById("crop-rect");
  const size = document.getElementById("crop-size");
  if (!rect || !store.document) return;
  const crop = store.document.canvas.crop;
  const overlay = document.getElementById("crop-overlay");
  rect.style.left = `${crop.x * 100}%`;
  rect.style.top = `${crop.y * 100}%`;
  rect.style.width = `${crop.width * 100}%`;
  rect.style.height = `${crop.height * 100}%`;

  const source = store.document.__sourceSize || { width: 1920, height: 1080 };
  size.textContent = `${Math.round(source.width * crop.width)} × ${Math.round(
    source.height * crop.height
  )}`;
  void overlay;
}

function onCropDown(event) {
  const handle = event.target.closest(".crop-handle");
  const overlay = document.getElementById("crop-overlay");
  const rect = overlay.getBoundingClientRect();
  const start = store.document.canvas.crop;
  const startX = event.clientX;
  const startY = event.clientY;
  const moving = !handle && event.target.closest(".crop-rect");
  if (!handle && !moving) return;

  store.beginGesture();
  const move = (moveEvent) => {
    const dx = (moveEvent.clientX - startX) / rect.width;
    const dy = (moveEvent.clientY - startY) / rect.height;
    store.apply((doc) => {
      const next = { ...start };
      const kind = handle?.dataset.handle;
      if (moving) {
        next.x = clamp(start.x + dx, 0, 1 - start.width);
        next.y = clamp(start.y + dy, 0, 1 - start.height);
      } else {
        if (kind.includes("w")) {
          const right = start.x + start.width;
          next.x = clamp(start.x + dx, 0, right - 0.05);
          next.width = right - next.x;
        }
        if (kind.includes("e")) next.width = clamp(start.width + dx, 0.05, 1 - start.x);
        if (kind.includes("n")) {
          const bottom = start.y + start.height;
          next.y = clamp(start.y + dy, 0, bottom - 0.05);
          next.height = bottom - next.y;
        }
        if (kind.includes("s")) next.height = clamp(start.height + dy, 0.05, 1 - start.y);
      }
      doc.canvas.crop = next;
    });
    updateCropOverlay();
    queueRender();
  };
  const up = () => {
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    store.commitGesture(t("裁切屏幕"));
    resizePreview();
    queueRender();
  };
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);
}

/* ------------------------------------------------------------------------- */
/* Splitter                                                                  */
/* ------------------------------------------------------------------------- */

function buildSplitter() {
  const splitter = document.getElementById("splitter");
  splitter.addEventListener("mousedown", () => {
    const startY = event.clientY;
    const startHeight = ui.timelineHeight;
    const move = (moveEvent) => {
      ui.timelineHeight = clamp(startHeight - (moveEvent.clientY - startY), 150, window.innerHeight - 320);
      document.getElementById("timeline").style.height = `${ui.timelineHeight}px`;
      resizePreview();
      queueRender();
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
  splitter.addEventListener("dblclick", () => {
    ui.timelineHeight = 250;
    document.getElementById("timeline").style.height = `${ui.timelineHeight}px`;
    resizePreview();
    queueRender();
  });
}

/* ------------------------------------------------------------------------- */
/* Commands + shortcuts                                                      */
/* ------------------------------------------------------------------------- */

function installShortcuts() {
  window.addEventListener("keydown", (event) => {
    const inField = event.target.closest("input, textarea, [contenteditable=true]");
    const mod = event.ctrlKey || event.metaKey;

    if (event.key === "Escape") {
      if (ui.cropMode) exitCropMode();
      return;
    }
    if (inField) return;

    if (event.code === "Space") {
      event.preventDefault();
      togglePlay();
      return;
    }
    if (mod && event.key.toLowerCase() === "c") {
      event.preventDefault();
      if (!store.copySelection()) toast(t("当前不可用"), { icon: "info" });
      return;
    }
    if (mod && event.key.toLowerCase() === "v") {
      event.preventDefault();
      if (event.shiftKey) pasteAttributes();
      else pasteClipboard();
      return;
    }
    if (mod && event.altKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      exportSelection();
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) store.redo();
      else store.undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      store.save().then(() => toast(t("已保存"), { icon: "save" }));
      return;
    }
    if (mod && event.key.toLowerCase() === "e") {
      event.preventDefault();
      openExport();
      return;
    }
    if (mod && event.key.toLowerCase() === "o") {
      event.preventDefault();
      pickProject();
      return;
    }
    if (mod && event.key.toLowerCase() === "j") {
      event.preventDefault();
      showShortcuts();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      event.preventDefault();
      store.deleteSelection();
      return;
    }
    if (event.key.toLowerCase() === "s" && !mod) {
      store.splitAtPlayhead();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      store.setPlayhead(store.playhead - (event.shiftKey ? 5 : 1) / 30);
      syncMedia(false);
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      store.setPlayhead(store.playhead + (event.shiftKey ? 5 : 1) / 30);
      syncMedia(false);
      return;
    }
    if (event.altKey && event.key.toLowerCase() === "x") {
      event.preventDefault();
      exportSelection();
      return;
    }
    if (event.key === "+" || event.key === "=") {
      setZoom(store.zoom * 1.2);
      return;
    }
    if (event.key === "-") {
      setZoom(store.zoom / 1.2);
    }
  });
}

async function runCommand(command) {
  switch (command) {
    case "undo":
      store.undo();
      break;
    case "redo":
      store.redo();
      break;
    case "split":
      store.splitAtPlayhead();
      break;
    case "delete":
      store.deleteSelection();
      break;
    case "play":
      togglePlay();
      break;
    case "export":
      openExport();
      break;
    case "save":
      await store.save();
      break;
    default:
      break;
  }
}

function openExport(range) {
  if (!store.document) return;
  /* Defence in depth for the listener mix-up above: any truthy argument that
     is not a real {start, end} range is dropped here, so a stray event object
     can never poison the payload again. */
  if (range && (!Number.isFinite(range.start) || !Number.isFinite(range.end))) range = null;
  const document_ = JSON.parse(JSON.stringify(stripDocument(store.document)));
  api.windows.openExport({
    packagePath: store.packagePath,
    document: document_,
    duration: range ? range.end - range.start : store.duration,
    range: range || null,
    media: mediaPaths(),
    sourceSize: store.document.__sourceSize || { width: 1920, height: 1080 },
  });
}

/**
 * ⌥X — exports the selected primary clips as a range. The original requires
 * at least one selected clip and reports the selection in the sheet.
 */
function exportSelection() {
  const range = store.selectedRange();
  if (!range || !range.clips.length) {
    toast(t("请先选择一个或多个主片段，再按 ⌥X 导出选区。"), { icon: "info", duration: 3600 });
    return;
  }
  openExport(range);
}

function stripDocument(document_) {
  const copy = { ...document_ };
  delete copy.__sourceSize;
  delete copy.__cameraSize;
  delete copy.__scenePresets;
  return copy;
}

function mediaPaths() {
  const media = {};
  for (const role of ["screen", "camera", "system", "microphone"]) {
    const entry = store.document.media?.[role];
    if (!entry?.path) continue;
    media[role] = { relative: entry.path, absolute: joinPath(store.packagePath, entry.path) };
  }
  return media;
}

function joinPath(base, relative) {
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]$/, "")}${separator}${relative.replace(/\//g, separator)}`;
}

/* ------------------------------------------------------------------------- */
/* Shortcut sheet                                                            */
/* ------------------------------------------------------------------------- */

function showShortcuts() {
  const groups = [
    {
      title: t("播放与浏览"),
      items: [
        [t("空格"), t("播放 / 暂停")],
        ["← / →", t("向前 / 向后移动 1 帧")],
        ["⇧ + ← / →", t("向前 / 向后移动 5 帧")],
        [t("悬停时间线"), t("预览所指帧，不移动播放头")],
        ["滚轮 / 捏合", t("以指针为锚缩放时间线")],
      ],
    },
    {
      title: t("剪辑"),
      items: [
        ["S", t("在播放头分割选中动画；未选动画时分割主片段")],
        ["⌥ + 点击主片段", t("在点击处直接切分")],
        ["⇧ / ⌘ 点击主片段", t("连续选择 / 增减选择主片段")],
        ["Ctrl + C", t("复制片段")],
        ["Ctrl + V", t("粘贴片段")],
        ["Ctrl + ⇧ + V", t("粘贴属性")],
        ["⌥ + X", t("导出选中的主片段范围")],
        ["Delete", t("删除当前选中项")],
        ["Ctrl + Z / ⇧ + Ctrl + Z", `${t("撤销")} / ${t("重做")}`],
      ],
    },
    {
      title: t("运镜与轨道"),
      items: [
        [t("拖动缩放轨空白"), t("创建缩放片段")],
        [t("拖动运动轨空白"), t("创建屏幕 3D / 摄像运动")],
        [t("双击分栏柄"), t("恢复时间线默认高度")],
      ],
    },
    {
      title: t("界面"),
      items: [
        ["Ctrl + S", t("保存项目")],
        ["Ctrl + O", t("打开项目")],
        ["Ctrl + E", t("导出成片")],
        ["Ctrl + J", t("快捷键")],
      ],
    },
  ];

  const backdrop = document.createElement("div");
  backdrop.className = "modal-backdrop";
  const modal = document.createElement("div");
  modal.className = "modal shortcut-sheet";
  modal.innerHTML = `<h2>${t("快捷键")}</h2>`;
  const grid = document.createElement("div");
  grid.className = "shortcut-grid";
  for (const group of groups) {
    const column = document.createElement("div");
    column.className = "shortcut-column";
    column.innerHTML = `<h4>${group.title}</h4>`;
    for (const [key, description] of group.items) {
      const row = document.createElement("div");
      row.className = "shortcut-row";
      row.innerHTML = `<kbd>${key}</kbd><span>${description}</span>`;
      column.appendChild(row);
    }
    grid.appendChild(column);
  }
  modal.appendChild(grid);
  const actions = document.createElement("div");
  actions.className = "modal-actions";
  const close = document.createElement("button");
  close.className = "btn";
  close.textContent = t("知道了");
  close.addEventListener("click", () => backdrop.remove());
  actions.appendChild(close);
  modal.appendChild(actions);
  backdrop.appendChild(modal);
  backdrop.addEventListener("mousedown", (event) => {
    if (event.target === backdrop) backdrop.remove();
  });
  document.body.appendChild(backdrop);
}

/* ------------------------------------------------------------------------- */
/* Autosave                                                                  */
/* ------------------------------------------------------------------------- */

setInterval(() => {
  if (store.dirty && store.packagePath) {
    store.save().catch((error) => console.error("[editor] autosave failed", error));
  }
}, 20000);

window.addEventListener("beforeunload", () => {
  stopPlayback();
  if (store.dirty && store.packagePath) {
    /* The synchronous path is unavailable in the renderer; the interval above
       keeps the on-disk copy fresh, which is what the original relies on. */
    store.save().catch(() => {});
  }
});

export { showSheet, normalizeDocument, resolveCanvasSize, startPlayback, formatTimecode };

boot();

/* Exposed for the diagnostics mode in the main process (DOGSC_SMOKE). */
window.__dogscStore = store;

/**
 * Renders the document at a series of timestamps into an offscreen canvas and
 * reports a fingerprint per frame.
 *
 * This is the regression test for the compositor: comparing fingerprints
 * proves the picture actually changes over time (zoom, motion, cursor, opening)
 * and that it is never blank. Screenshots alone cannot tell a frozen preview
 * from a correct one.
 */
window.__dogscRenderProbe = (times) => {
  const probe = document.createElement("canvas");
  const width = 480;
  const ratio = canvasRatio();
  probe.width = width;
  probe.height = Math.max(2, Math.round(width / ratio));
  const ctx = probe.getContext("2d", { alpha: false, willReadFrequently: true });

  const frames = [];
  for (const time of times) {
    parkMediaAt(time);
    renderFrame(ctx, store.document, time, {
      width: probe.width,
      height: probe.height,
      sources: store.sources,
    });
    const data = ctx.getImageData(0, 0, probe.width, probe.height).data;
    let sum = 0;
    let nonBlack = 0;
    let samples = 0;
    /* A cheap fingerprint: mean luminance plus the share of pixels that are
       not essentially black, which tells "blank frame" apart from "dark
       background". */
    for (let i = 0; i < data.length; i += 4 * 7) {
      const luma = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
      sum += luma;
      if (luma > 12) nonBlack += 1;
      samples += 1;
    }
    frames.push({
      time: Number(time.toFixed(2)),
      luma: Number((sum / samples).toFixed(2)),
      coverage: Number((nonBlack / samples).toFixed(3)),
    });
  }
  return frames;
};

/** Parks the recorded media on `time` so a probe frame is deterministic. */
function parkMediaAt(time) {
  const sourceTime = store.sourceTime(time);
  for (const role of ["screen", "camera"]) {
    const video = store.media[role];
    if (!video) continue;
    try {
      video.currentTime = sourceTime;
    } catch {
      /* seeking before metadata is ready */
    }
  }
}
