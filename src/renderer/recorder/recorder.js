/**
 * Recorder bar.
 *
 * Windows counterpart of the macOS `RecorderPanelController` / `RecorderViews`:
 * a floating, always-on-top strip that picks a capture source, toggles the
 * inputs, chooses where the recording lands and drives the transport.
 *
 * Panels expand the window upward from the bar (the bar keeps its screen
 * position) which is how the original's source pickers appear.
 */

import { icon, iconEl } from "../shared/icons.js";
import { t, setLocale, applyStaticTranslations } from "../shared/i18n.js";
import {
  attachTooltip,
  showMenu,
  showSheet,
  closePopover,
  toast,
  formatTimecode,
} from "../shared/widgets.js";

const api = window.dogsc;

const BAR_HEIGHT = 96; // 84px bar + 12px vertical padding
/* Idle window height: bar (96) + 34px tooltip headroom + 8px bottom padding.
   Must match SIZES.recorder in windows.js and the root padding in the CSS. */
const WINDOW_BASE_HEIGHT = 126;
const PANEL_HEIGHTS = { display: 336, window: 420, device: 300, memo: 0 };

const SOURCE_KINDS = [
  { value: "display", label: "显示器", icon: "display" },
  { value: "window", label: "窗口", icon: "window" },
  { value: "area", label: "区域", icon: "area" },
  { value: "device", label: "设备", icon: "device" },
];

const state = {
  config: {
    kind: "display",
    sourceId: null,
    sourceName: "",
    displayId: null,
    scaleFactor: 1,
    region: null,
    fps: 60,
    systemAudio: false,
    microphone: false,
    camera: false,
    cameraDeviceId: null,
    microphoneDeviceId: null,
    /** Primary capture device, used when the source kind is 设备. */
    deviceId: null,
    destination: "project",
    suggestedName: null,
  },
  status: "idle",
  elapsed: 0,
  markers: 0,
  activePanel: null,
  displays: [],
  sources: [],
  cameras: [],
  microphones: [],
  tick: null,
  prefs: {},
  devicesLoaded: false,
};

/* ------------------------------------------------------------------------- */
/* Boot                                                                      */
/* ------------------------------------------------------------------------- */

async function boot() {
  state.prefs = await api.prefs.all();
  setLocale("zh-Hans");
  document.documentElement.dataset.theme = state.prefs.appearance === "dark" ? "dark" : "light";

  state.config.systemAudio = state.prefs.systemAudioEnabled ?? true;
  state.config.microphone = state.prefs.microphoneEnabled ?? false;
  state.config.camera = state.prefs.cameraEnabled ?? false;
  state.config.microphoneDeviceId = state.prefs.microphoneDeviceId || null;
  state.config.cameraDeviceId = state.prefs.cameraDeviceId || null;

  applyStaticTranslations();
  buildBar();
  await refreshSources();
  await pickDefaultSource();
  render();

  api.on("app:theme", (payload) => {
    document.documentElement.dataset.theme = payload.dark ? "dark" : "light";
  });
  api.on("app:prefs", (payload) => {
    state.prefs = payload;
  });
  api.on("recorder:state", (payload) => {
    state.status = payload.status;
    state.elapsed = payload.elapsed || 0;
    state.markers = payload.markers || 0;
    if (payload.status === "idle") closePanel();
    render();
  });
  api.on("recorder:marker", () => {
    toast(t("添加录制标记"), { icon: "marker", duration: 1400 });
  });
  api.on("recorder:warning", (payload) => {
    const message = payload?.message;
    const table = {
      "no-frames-captured": t("录制期间没有收到任何画面。若录的是窗口，请确认该窗口没有被最小化或完全遮挡。"),
      "system-audio-unavailable": t("未收到可写入的系统声音样本，视频已保留"),
      "camera-unavailable": t("没有收到摄像头画面，已暂时关闭摄像头。请在摄像头菜单中重新选择后再试。"),
      "microphone-unavailable": t("麦克风录制失败：%@", "权限或设备不可用"),
    };
    toast(table[message] || message, { icon: "info", duration: 3600 });
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closePanel();
  });
}

/* ------------------------------------------------------------------------- */
/* Bar construction                                                          */
/* ------------------------------------------------------------------------- */

function buildBar() {
  const group = document.getElementById("source-group");
  group.innerHTML = "";
  for (const kind of SOURCE_KINDS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "source-btn";
    btn.dataset.kind = kind.value;
    btn.innerHTML = `${icon(kind.icon, 22)}<span>${t(kind.label)}</span>`;
    attachTooltip(btn, t(kind.label));
    btn.addEventListener("click", () => selectSourceKind(kind.value));
    group.appendChild(btn);
  }

  const toggles = document.getElementById("toggles");
  toggles.innerHTML = "";
  toggles.append(
    makeToggle("microphone", "mic", "麦克风"),
    makeToggle("camera", "camera", "摄像头"),
    makeToggle("systemAudio", "speaker", "系统声音")
  );

  document.getElementById("save-icon").innerHTML = icon("folder", 20);
  document.getElementById("save-chev").innerHTML = icon("chevronDown", 15);
  document.getElementById("save-to").addEventListener("click", openSaveMenu);

  const memo = document.getElementById("btn-memo");
  memo.innerHTML = icon("note", 19);
  attachTooltip(memo, t("打开备忘录"));
  memo.addEventListener("click", () => api.windows.openMemo());

  const openProject = document.getElementById("btn-open-project");
  /* A stack of layers, not a folder — 保存到 already uses a folder icon and the
     two must not be mistaken for each other. */
  openProject.innerHTML = icon("layers", 19);
  attachTooltip(openProject, t("打开项目…"));
  openProject.addEventListener("click", openProjectMenu);

  const close = document.getElementById("btn-close");
  close.innerHTML = icon("close", 17);
  attachTooltip(close, t("关闭"));
  close.addEventListener("click", () => window.close());

  const pause = document.getElementById("btn-pause");
  attachTooltip(pause, t("暂停"));
  pause.addEventListener("click", togglePause);

  const stop = document.getElementById("btn-stop");
  stop.innerHTML = icon("stop", 15);
  attachTooltip(stop, t("停止"));
  stop.addEventListener("click", () => stopRecording(false));

  const marker = document.getElementById("btn-marker");
  marker.innerHTML = icon("marker", 17);
  attachTooltip(marker, t("添加录制标记（⌃⌥M）；保存到项目，不会录入画面"));
  marker.addEventListener("click", () => api.capture.addMarker());
}

function makeToggle(key, iconName, label) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "round-btn";
  btn.dataset.toggle = key;
  btn.innerHTML = icon(iconName, 21);
  btn.addEventListener("click", () => {
    state.config[key] = !state.config[key];
    if (key === "microphone") api.prefs.set("microphoneEnabled", state.config[key]);
    if (key === "camera") api.prefs.set("cameraEnabled", state.config[key]);
    if (key === "systemAudio") api.prefs.set("systemAudioEnabled", state.config[key]);
    render();
  });
  btn.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    openInputMenu(key, btn);
  });
  btn.addEventListener("dblclick", () => openInputMenu(key, btn));
  btn.addEventListener("mousedown", (event) => {
    if (event.button === 2) return;
  });
  /* Long-press also opens the device list, matching the original's
     "click toggles, click-and-hold chooses" behaviour. */
  let holdTimer = null;
  btn.addEventListener("pointerdown", () => {
    holdTimer = setTimeout(() => openInputMenu(key, btn), 520);
  });
  const clear = () => {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = null;
  };
  btn.addEventListener("pointerup", clear);
  btn.addEventListener("pointerleave", clear);
  attachTooltip(btn, () => `${t(label)} — ${t("单击或拖拽添加")}`);
  return btn;
}

/* ------------------------------------------------------------------------- */
/* Render                                                                    */
/* ------------------------------------------------------------------------- */

function render() {
  const recording = state.status === "recording" || state.status === "paused" || state.status === "preparing";

  document.querySelectorAll(".source-btn").forEach((btn) => {
    btn.classList.toggle("is-selected", btn.dataset.kind === state.config.kind);
    btn.disabled = recording;
    btn.style.opacity = recording ? "0.4" : "";
  });

  document.querySelectorAll("[data-toggle]").forEach((btn) => {
    const key = btn.dataset.toggle;
    const on = Boolean(state.config[key]);
    btn.classList.toggle("is-on", on);
    btn.classList.toggle("is-idle", !on);
    btn.disabled = recording;
    btn.style.opacity = recording ? "0.4" : "";
  });

  const target = document.getElementById("save-target");
  target.textContent = state.config.destination === "movie" ? t("视频成片") : t("项目");

  const transport = document.getElementById("transport");
  transport.hidden = !recording;
  document.getElementById("source-group").style.display = recording ? "none" : "";
  document.querySelectorAll(".bar > .divider")[0].style.display = recording ? "none" : "";

  if (recording) {
    document.getElementById("rec-time").textContent = formatTimecode(state.elapsed);
    const pause = document.getElementById("btn-pause");
    pause.innerHTML = icon(state.status === "paused" ? "play" : "pause", 17);
    attachTooltip(pause, state.status === "paused" ? t("继续") : t("暂停"));
    const marker = document.getElementById("btn-marker");
    marker.style.color = state.markers ? "var(--amber)" : "";
  }
}

/* ------------------------------------------------------------------------- */
/* Source selection                                                          */
/* ------------------------------------------------------------------------- */

async function refreshSources({ thumbnails = false } = {}) {
  state.displays = await api.capture.displays();
  state.sources = await api.capture.sources({ thumbnails });
}

async function pickDefaultSource() {
  if (!state.displays.length) return;
  const primary = state.displays.find((display) => display.primary) || state.displays[0];
  state.config.displayId = primary.id;
  state.config.scaleFactor = primary.scaleFactor;
  const source = state.sources.find(
    (candidate) => candidate.type === "screen" && String(candidate.displayId) === String(primary.id)
  );
  if (source) {
    state.config.sourceId = source.id;
    state.config.sourceName = source.name;
  }
}

/**
 * Enumerates cameras and microphones on demand.
 *
 * The macOS original only asks for camera and microphone access when the user
 * enables them, and the same reasoning applies here: enumerating at launch
 * starts Chromium's video-capture service before the user has expressed any
 * interest in it. Doing it lazily also means the device list reflects devices
 * plugged in after the bar appeared.
 */
async function ensureDevices() {
  if (state.devicesLoaded) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    state.cameras = devices.filter((device) => device.kind === "videoinput");
    state.microphones = devices.filter((device) => device.kind === "audioinput");
    state.devicesLoaded = true;
  } catch (error) {
    console.warn("[recorder] device enumeration unavailable", error);
    state.cameras = [];
    state.microphones = [];
  }
  if (!state.config.cameraDeviceId && state.cameras[0]) {
    state.config.cameraDeviceId = state.cameras[0].deviceId;
  }
  if (!state.config.microphoneDeviceId && state.microphones[0]) {
    state.config.microphoneDeviceId = state.microphones[0].deviceId;
  }
}

function selectSourceKind(kind) {
  state.config.kind = kind;
  if (kind === "area") {
    openPanel("display", { title: t("选择录制范围"), mode: "area" });
    return;
  }
  if (kind === "display") openPanel("display", { title: t("显示器"), mode: "display" });
  else if (kind === "window") openPanel("window", { title: t("窗口"), mode: "window" });
  else openPanel("device", { title: t("设备"), mode: "device" });
  render();
}

/* ------------------------------------------------------------------------- */
/* Panels                                                                    */
/* ------------------------------------------------------------------------- */

async function openPanel(kind, options = {}) {
  const panel = document.getElementById("panel");
  const body = document.getElementById("panel-body");
  state.activePanel = kind;
  /* Thumbnails are pulled only while a picker is on screen. */
  await refreshSources({ thumbnails: true });

  body.innerHTML = "";
  const title = document.createElement("div");
  title.className = "panel-title";
  title.innerHTML = `<span>${options.title || ""}</span>`;
  const refresh = document.createElement("button");
  refresh.type = "button";
  refresh.className = "btn btn-ghost btn-icon";
  refresh.innerHTML = icon("refresh", 15);
  attachTooltip(refresh, t("刷新设备"));
  refresh.addEventListener("click", async () => {
    await refreshSources();
    state.devicesLoaded = false;
    await ensureDevices();
    openPanel(kind, options);
  });
  title.appendChild(refresh);
  body.appendChild(title);

  if (kind === "display") renderDisplayPanel(body, options);
  else if (kind === "window") renderWindowPanel(body, options);
  else if (kind === "device") {
    await ensureDevices();
    renderDevicePanel(body, options);
  }

  panel.hidden = false;
  await resizeForPanel(PANEL_HEIGHTS[kind] || 320);
}

function closePanel() {
  const panel = document.getElementById("panel");
  if (panel.hidden) return;
  panel.hidden = true;
  state.activePanel = null;
  resizeForPanel(0);
}

async function resizeForPanel(panelHeight) {
  const bounds = await api.windows.getBounds();
  if (!bounds) return;
  const height = WINDOW_BASE_HEIGHT + panelHeight;
  if (bounds.height === height) return;
  const delta = height - bounds.height;
  await api.windows.setBounds({ height, y: bounds.y - delta });
}

function renderDisplayPanel(host, options) {
  const wrap = document.createElement("div");
  wrap.className = "source-grid";

  for (const display of state.displays) {
    const source = state.sources.find(
      (candidate) => candidate.type === "screen" && String(candidate.displayId) === String(display.id)
    );
    const selected = String(state.config.displayId) === String(display.id);
    const card = document.createElement("div");
    card.className = "source-card";
    if (selected) card.classList.add("is-selected");

    const thumbWrap = document.createElement("div");
    thumbWrap.className = "thumb-wrap";
    if (source?.thumbnail) {
      const img = document.createElement("img");
      img.className = "thumb";
      img.src = source.thumbnail;
      img.alt = "";
      thumbWrap.appendChild(img);
    } else {
      const placeholder = document.createElement("div");
      placeholder.className = "thumb";
      thumbWrap.appendChild(placeholder);
    }
    if (display.primary) {
      const badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = t("主显示器");
      thumbWrap.appendChild(badge);
    }
    card.appendChild(thumbWrap);

    const meta = document.createElement("div");
    meta.className = "meta";
    meta.innerHTML = `${icon("display", 16)}<span class="name">${escapeHtml(display.label)}</span>`;
    card.appendChild(meta);

    const sub = document.createElement("div");
    sub.className = "sub";
    sub.textContent = `${display.size.width} × ${display.size.height} · ${Math.round(
      display.scaleFactor * 100
    )}%`;
    card.appendChild(sub);

    /* The original puts the primary action on the card itself:
       "选择此显示器" until it is the source, then "开始录制". */
    const action = document.createElement("button");
    action.type = "button";
    action.className = selected && options.mode !== "area" ? "btn btn-primary" : "btn";
    action.style.width = "100%";
    action.style.height = "32px";
    action.textContent =
      options.mode === "area"
        ? t("框选区域")
        : selected
          ? t("开始录制")
          : t("选择此显示器");
    action.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (options.mode === "area") {
        closePanel();
        await api.windows.openAreaSelector(display.id);
        return;
      }
      if (selected) {
        closePanel();
        await startRecording();
        return;
      }
      state.config.displayId = display.id;
      state.config.scaleFactor = display.scaleFactor;
      const match = state.sources.find(
        (candidate) => candidate.type === "screen" && String(candidate.displayId) === String(display.id)
      );
      if (match) {
        state.config.sourceId = match.id;
        state.config.sourceName = match.name;
      }
      render();
      openPanel("display", options);
    });
    card.appendChild(action);

    card.addEventListener("click", () => {
      state.config.displayId = display.id;
      state.config.scaleFactor = display.scaleFactor;
      const match = state.sources.find(
        (candidate) => candidate.type === "screen" && String(candidate.displayId) === String(display.id)
      );
      if (match) {
        state.config.sourceId = match.id;
        state.config.sourceName = match.name;
      }
      render();
      openPanel("display", options);
    });

    wrap.appendChild(card);
  }

  host.appendChild(wrap);

  if (options.mode === "area") {
    const footer = document.createElement("div");
    footer.className = "panel-footer";
    footer.textContent = t("录整个屏幕、一个窗口，或自己框选区域。连接的设备也可以作为录制来源。");
    host.appendChild(footer);
  }
}

/** Shared footer with the primary capture action for list-based panels. */
function appendStartFooter(host, { enabled, label }) {
  const footer = document.createElement("div");
  footer.className = "panel-footer";
  const hint = document.createElement("span");
  hint.textContent = t("同名录制会自动编号，不覆盖已有文件。");
  const start = document.createElement("button");
  start.type = "button";
  start.className = "btn btn-primary";
  start.style.height = "32px";
  start.style.padding = "0 16px";
  start.textContent = label || t("开始录制");
  start.disabled = !enabled;
  start.addEventListener("click", () => {
    closePanel();
    startRecording();
  });
  footer.append(hint, start);
  host.appendChild(footer);
}

function renderWindowPanel(host) {
  const list = document.createElement("div");
  const windows = state.sources.filter((source) => source.type === "window");

  if (!windows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = t("未发现设备");
    host.appendChild(empty);
    return;
  }

  for (const source of windows) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-row";
    row.style.width = "100%";
    row.style.border = "0";
    row.style.background = "transparent";
    if (state.config.sourceId === source.id) {
      row.classList.add("is-selected");
      row.style.background = "var(--selection-wash)";
    }
    row.innerHTML = `
      ${source.appIcon ? `<img src="${source.appIcon}" style="width:18px;height:18px;border-radius:4px" alt="">` : icon("window", 18)}
      <span class="grow">${escapeHtml(source.name)}</span>
      ${state.config.sourceId === source.id ? icon("check", 15) : ""}
    `;
    row.addEventListener("click", () => {
      state.config.sourceId = source.id;
      state.config.sourceName = source.name;
      state.config.displayId = source.displayId || state.config.displayId;
      render();
      openPanel("window", { title: t("窗口"), mode: "window" });
    });
    list.appendChild(row);
  }
  host.appendChild(list);
  appendStartFooter(host, { enabled: Boolean(state.config.sourceId) });
}

function renderDevicePanel(host) {
  const list = document.createElement("div");
  const devices = state.cameras;

  if (!devices.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `${t("未发现设备")}<br><span style="opacity:.7">${t(
      "设备录制保留原始格式与分辨率"
    )}</span>`;
    host.appendChild(empty);
    return;
  }

  for (const device of devices) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "list-row";
    row.style.width = "100%";
    row.style.border = "0";
    row.style.background = "transparent";
    if (state.config.deviceId === device.deviceId) {
      row.classList.add("is-selected");
      row.style.background = "var(--selection-wash)";
    }
    row.innerHTML = `
      ${icon("device", 18)}
      <span class="grow">${escapeHtml(device.label || t("未发现设备"))}</span>
      ${state.config.deviceId === device.deviceId ? icon("check", 15) : ""}
    `;
    row.addEventListener("click", () => {
      state.config.deviceId = device.deviceId;
      state.config.kind = "device";
      render();
      openPanel("device", { title: t("设备"), mode: "device" });
    });
    list.appendChild(row);
  }
  host.appendChild(list);
  appendStartFooter(host, { enabled: Boolean(state.config.deviceId) });
}

/* ------------------------------------------------------------------------- */
/* Input menus                                                               */
/* ------------------------------------------------------------------------- */

async function openInputMenu(key, anchor) {
  await ensureDevices();
  if (key === "microphone") {
    showMenu(
      anchor,
      [
        { header: t("麦克风") },
        {
          label: t("关闭"),
          checked: !state.config.microphone,
          onSelect: () => {
            state.config.microphone = false;
            render();
          },
        },
        { separator: true },
        ...state.microphones.map((device) => ({
          label: device.label || t("未发现设备"),
          checked: state.config.microphoneDeviceId === device.deviceId,
          onSelect: () => {
            state.config.microphoneDeviceId = device.deviceId;
            state.config.microphone = true;
            api.prefs.set("microphoneDeviceId", device.deviceId);
            render();
          },
        })),
        ...(state.microphones.length ? [] : [{ label: t("未发现设备"), disabled: true }]),
      ],
      { align: "center" }
    );
    return;
  }

  if (key === "camera") {
    showMenu(
      anchor,
      [
        { header: t("摄像头") },
        {
          label: t("关闭"),
          checked: !state.config.camera,
          onSelect: () => {
            state.config.camera = false;
            render();
          },
        },
        { separator: true },
        ...state.cameras.map((device) => ({
          label: device.label || t("未发现设备"),
          checked: state.config.cameraDeviceId === device.deviceId,
          onSelect: () => {
            state.config.cameraDeviceId = device.deviceId;
            state.config.camera = true;
            api.prefs.set("cameraDeviceId", device.deviceId);
            render();
          },
        })),
        ...(state.cameras.length ? [] : [{ label: t("未发现设备"), disabled: true }]),
        { separator: true },
        {
          label: t("镜像画面"),
          checked: state.prefs.mirrorCamera !== false,
          onSelect: () => api.prefs.set("mirrorCamera", state.prefs.mirrorCamera === false),
        },
      ],
      { align: "center" }
    );
    return;
  }

  showMenu(
    anchor,
    [
      { header: t("系统声音") },
      {
        label: t("录屏中的应用与系统声音"),
        checked: state.config.systemAudio,
        onSelect: () => {
          state.config.systemAudio = true;
          api.prefs.set("systemAudioEnabled", true);
          render();
        },
      },
      {
        label: t("关闭"),
        checked: !state.config.systemAudio,
        onSelect: () => {
          state.config.systemAudio = false;
          api.prefs.set("systemAudioEnabled", false);
          render();
        },
      },
    ],
    { align: "center" }
  );
}

/**
 * Opens an existing project.
 *
 * The original reaches this through its menu bar ("打开项目…"); the recorder
 * bar is the port's only always-visible surface, so the entry lives here.
 * Recent projects are listed first because that is almost always what the user
 * wants — having to hunt through a folder dialog every time would be a poor
 * substitute for the original's menu entry.
 */
async function openProjectMenu() {
  const anchor = document.getElementById("btn-open-project");
  const projects = await api.project.list().catch(() => []);
  const recent = projects.slice(0, 8);

  showMenu(
    anchor,
    [
      { header: t("打开项目…") },
      ...(recent.length
        ? recent.map((entry) => ({
            label: entry.name,
            note: formatProjectDate(entry.modified),
            onSelect: () => launchEditor(entry.packagePath),
          }))
        : [{ label: t("选择要继续编辑的项目"), disabled: true }]),
      { separator: true },
      { label: t("浏览…"), onSelect: browseForProject },
    ],
    { align: "right", width: 300 }
  );
}

/** A folder picker, because a `.dogscproject` package is a folder. */
async function browseForProject() {
  const result = await api.project.pick();
  if (result?.ok) {
    launchEditor(result.packagePath);
    return;
  }
  if (result?.reason === "not-a-project") {
    toast(t("请选择 .dogscproject 项目包"), { icon: "info", duration: 3600 });
  }
}

function launchEditor(packagePath) {
  api.windows.openEditor({ projectPath: packagePath });
  /* Editing takes over from recording, exactly as it does when a recording
     finishes and the user chooses to open the editor. */
  window.close();
}

function formatProjectDate(ms) {
  if (!ms) return "";
  const date = new Date(ms);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return sameDay ? time : `${date.getMonth() + 1}/${date.getDate()} ${time}`;
}

function openSaveMenu() {
  const anchor = document.getElementById("save-to");
  const location = state.prefs.projectLocation || "";
  showMenu(
    anchor,
    [
      { header: t("保存到") },
      {
        label: t("项目"),
        note: t("保存项目"),
        checked: state.config.destination === "project",
        onSelect: () => {
          state.config.destination = "project";
          render();
        },
      },
      {
        label: t("视频成片"),
        note: "MP4",
        checked: state.config.destination === "movie",
        onSelect: () => {
          state.config.destination = "movie";
          render();
        },
      },
      { separator: true },
      { label: t("更改位置…"), onSelect: changeLocation },
      {
        label: t("打开项目…"),
        onSelect: () => api.windows.openEditor({}),
      },
      { label: t("设置"), onSelect: () => api.windows.openSettings() },
      { separator: true },
      { label: t("退出DogSC"), onSelect: () => api.app.quit() },
    ],
    { align: "left", width: 250 }
  );
}

async function changeLocation() {
  const folder = await api.project.pickFolder({
    title: t("选择项目保存位置"),
    defaultPath: state.prefs.projectLocation,
  });
  if (!folder) return;
  state.prefs = await api.prefs.set("projectLocation", folder);
  toast(`${t("保存到")} ${folder}`, { icon: "folder" });
}

/* ------------------------------------------------------------------------- */
/* Transport                                                                 */
/* ------------------------------------------------------------------------- */

async function startRecording() {
  const needsSource =
    state.config.kind === "device"
      ? !state.config.deviceId
      : state.config.kind === "area"
        ? !state.config.region
        : !state.config.sourceId;

  if (needsSource) {
    toast(t("请先选择显示器、窗口、区域或设备。"), { icon: "info" });
    if (state.config.kind === "area") selectSourceKind("area");
    return;
  }

  const isDevice = state.config.kind === "device";
  const result = await api.capture.start({
    ...state.config,
    microphone: state.config.microphone
      ? { deviceId: state.config.microphoneDeviceId }
      : null,
    /* A device recording already uses the capture device as the main picture,
       so there is no separate picture-in-picture track to record. */
    camera:
      !isDevice && state.config.camera ? { deviceId: state.config.cameraDeviceId } : null,
    suggestedName: state.config.suggestedName,
  });

  if (!result?.ok) {
    const reasons = {
      busy: t("上一次录制尚未结束"),
      "no-source": t("请先选择显示器、窗口、区域或设备。"),
      "surface-failed": t("无法更新录制画面"),
      "capture-timeout": t("录制未能开始，请重试或改用其他来源。"),
      "system-audio-unavailable": t("未收到可写入的系统声音样本，视频已保留"),
      "no-frames-captured": t("画面写入出现丢帧"),
      "camera-unavailable": t("没有收到摄像头画面，已暂时关闭摄像头。请在摄像头菜单中重新选择后再试。"),
      "microphone-unavailable": t("麦克风录制失败：%@", "权限或设备不可用"),
    };
    /* An unrecognised failure is still worth showing: the DOMException name
       ("NotReadableError: Could not start video source") tells the user more
       than a generic message does. */
    const message = reasons[result?.reason] || result?.reason || t("操作未完成");
    toast(String(message).slice(0, 160), { icon: "info", duration: 4200 });
  }
}

async function togglePause() {
  if (state.status === "paused") await api.capture.resume();
  else await api.capture.pause();
}

async function stopRecording(cancel) {
  const result = await api.capture.stop();
  if (!result?.ok && !result?.cancelled) {
    toast(t("录制意外停止，正在安全结束并保留已经写入的素材：%@", result?.reason || t("未知错误")), {
      icon: "info",
      duration: 4000,
    });
  }
}

/**
 * The bar's primary action: idle → start, recording → stop. Bound to a click
 * on the bar background the way the original binds its record control.
 */
document.getElementById("bar").addEventListener("dblclick", (event) => {
  if (event.target.closest("button")) return;
  if (state.status === "idle") startRecording();
});

/* A dedicated record affordance: click the selected source again. */
document.addEventListener("keydown", async (event) => {
  if (event.key === " " && !event.target.closest("input, textarea")) {
    event.preventDefault();
    if (state.status === "idle") await startRecording();
    else await stopRecording(false);
  }
});

/* ------------------------------------------------------------------------- */
/* Utilities                                                                 */
/* ------------------------------------------------------------------------- */

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    const map = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
    return map[char];
  });
}

boot();
