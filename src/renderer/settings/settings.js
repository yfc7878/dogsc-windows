/**
 * Settings window.
 *
 * Port of `AppSettingsView`: 通用 / 录制 / 存储位置 / 权限 / 关于.
 */

import { icon } from "../shared/icons.js";
import { setLocale, t } from "../shared/i18n.js";
import { attachTooltip, choiceGroup, enableManualDrag, switchRow, toast } from "../shared/widgets.js";
import { playChime } from "../shared/sound.js";

const api = window.dogsc;

/* The settings window is frameless; its title areas move the window
   programmatically because CSS app-region drag strobes on Windows here. */
enableManualDrag();

const SECTIONS = [
  { id: "general", label: "通用", icon: "settings" },
  { id: "recording", label: "录制", icon: "display" },
  { id: "storage", label: "存储位置", icon: "folder" },
  { id: "permissions", label: "权限", icon: "info" },
  { id: "about", label: "关于 DogSC", icon: "sparkles" },
];

const state = { section: "general", prefs: {}, permissions: {}, version: "", encoder: null };

async function boot() {
  setLocale("zh-Hans");
  state.prefs = await api.prefs.all();
  state.permissions = await api.app.permissions();
  state.version = await api.app.version();
  /* Probed once at open; the label is stable per machine. */
  state.encoder = await api.capture.encoder().catch(() => null);

  const theme = await api.app.theme();
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
  api.on("app:theme", (payload) => {
    document.documentElement.dataset.theme = payload.dark ? "dark" : "light";
  });

  document.getElementById("btn-close").innerHTML = icon("close", 15);
  document.getElementById("btn-close").addEventListener("click", () => window.close());

  buildNav();
  render();
}

function buildNav() {
  const nav = document.getElementById("settings-nav");
  nav.innerHTML = "";
  for (const section of SECTIONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "nav-item";
    if (state.section === section.id) button.classList.add("is-selected");
    button.innerHTML = `${icon(section.icon, 15)}<span>${t(section.label)}</span>`;
    button.addEventListener("click", () => {
      state.section = section.id;
      buildNav();
      render();
    });
    nav.appendChild(button);
  }
}

function card(title, hint) {
  const element = document.createElement("section");
  element.className = "settings-card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  element.appendChild(heading);
  if (hint) {
    const note = document.createElement("p");
    note.className = "card-hint";
    note.textContent = hint;
    element.appendChild(note);
  }
  return element;
}

function render() {
  const body = document.getElementById("settings-body");
  body.innerHTML = "";
  switch (state.section) {
    case "general":
      renderGeneral(body);
      break;
    case "recording":
      renderRecording(body);
      break;
    case "storage":
      renderStorage(body);
      break;
    case "permissions":
      renderPermissions(body);
      break;
    case "about":
      renderAbout(body);
      break;
    default:
      break;
  }
}

function renderGeneral(body) {
  const appearance = card(t("外观"), t("界面、声音与文件"));
  appearance.appendChild(
    choiceGroup(
      [
        { value: "system", label: t("跟随系统") },
        { value: "light", label: t("浅色") },
        { value: "dark", label: t("深色") },
      ],
      state.prefs.appearance,
      async (value) => {
        state.prefs = await api.app.setTheme(value);
        render();
      }
    )
  );
  body.appendChild(appearance);

  const preview = card(t("画布与预览"), t("预览与编辑工作区"));
  preview.appendChild(
    choiceGroup(
      [
        { value: "full", label: t("清晰预览") },
        { value: "smooth", label: t("播放更流畅") },
      ],
      state.prefs.previewQuality,
      async (value) => {
        state.prefs = await api.prefs.set("previewQuality", value);
        render();
      }
    )
  );
  const hint = document.createElement("p");
  hint.className = "card-hint";
  hint.textContent = t("「清晰预览」按完整分辨率渲染预览画面；「播放更流畅」降低预览渲染分辨率，大型项目编辑更顺滑。导出画质不受影响。");
  preview.appendChild(hint);
  preview.appendChild(
    switchRow(t("仅在成功导出后播放"), state.prefs.playAfterExport, async (value) => {
      state.prefs = await api.prefs.set("playAfterExport", value);
    })
  );
  const soundRow = document.createElement("div");
  soundRow.className = "path-row";
  soundRow.appendChild(
    switchRow(t("导出完成提示音"), state.prefs.alertSounds !== false, async (value) => {
      state.prefs = await api.prefs.set("alertSounds", value);
      render();
    })
  );
  const audition = document.createElement("button");
  audition.type = "button";
  audition.className = "btn";
  audition.innerHTML = `${icon("speaker", 15)}<span>${t("试听")}</span>`;
  audition.addEventListener("click", () => playChime());
  soundRow.appendChild(audition);
  preview.appendChild(soundRow);
  body.appendChild(preview);

  const windowCard = card(t("窗口与界面状态"), t("清除系统记住的窗口位置、尺寸和全屏记忆状态。"));
  const resetRow = document.createElement("div");
  resetRow.className = "path-row";
  const reset = document.createElement("button");
  reset.type = "button";
  reset.className = "btn";
  reset.innerHTML = `${icon("refresh", 15)}<span>${t("重置布局")}</span>`;
  reset.addEventListener("click", async () => {
    await api.prefs.patch({ editorBounds: null, recorderBounds: null, memoBounds: null });
    toast(t("已成功重置，将在下次打开编辑器窗口时应用默认大小与居中位置。"), {
      icon: "check",
      duration: 3600,
    });
  });
  resetRow.appendChild(reset);
  windowCard.appendChild(resetRow);

  /* The original's "重新开始引导" — replays the first-use guide. */
  const guideRow = document.createElement("div");
  guideRow.className = "path-row";
  const guide = document.createElement("button");
  guide.type = "button";
  guide.className = "btn";
  guide.innerHTML = `${icon("sparkles", 15)}<span>${t("重新开始引导")}</span>`;
  guide.addEventListener("click", async () => {
    await api.prefs.set("onboardingCompleted", false);
    api.windows.openOnboarding();
    window.close();
  });
  guideRow.appendChild(guide);
  windowCard.appendChild(guideRow);
  body.appendChild(windowCard);
}

function renderRecording(body) {
  const card1 = card(t("开始录制时的默认选项"), t("按需开启声音与摄像头。"));

  const devices = document.createElement("div");
  devices.className = "path-row";
  const label = document.createElement("span");
  label.className = "field-label";
  label.style.flex = "1";
  label.textContent = t("默认音频输入");
  const pick = document.createElement("button");
  pick.type = "button";
  pick.className = "btn";
  pick.innerHTML = `${icon("mic", 15)}<span>${t("选择")}</span>`;
  pick.addEventListener("click", async () => {
    const permission = await navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((stream) => {
        stream.getTracks().forEach((track) => track.stop());
        return true;
      })
      .catch(() => false);
    if (!permission) {
      toast(t("麦克风权限") + " · " + t("未授权"), { icon: "info" });
      return;
    }
    const list = await navigator.mediaDevices.enumerateDevices();
    const microphones = list.filter((device) => device.kind === "audioinput");
    if (!microphones.length) {
      toast(t("未发现设备"), { icon: "info" });
      return;
    }
    const { showMenu } = await import("../shared/widgets.js");
    showMenu(
      pick,
      microphones.map((device) => ({
        label: device.label || t("未发现设备"),
        checked: state.prefs.microphoneDeviceId === device.deviceId,
        onSelect: async (value) => {
          state.prefs = await api.prefs.set("microphoneDeviceId", value);
          render();
        },
      })),
      { align: "right" }
    );
  });
  devices.append(label, pick);
  card1.appendChild(devices);

  const deviceName =
    state.prefs.microphoneDeviceId ? t("下次录制将使用：%@。", "所选设备") : t("尚未选择麦克风；进入录制时会自动使用首个可用设备。");
  const deviceHint = document.createElement("p");
  deviceHint.className = "card-hint";
  deviceHint.textContent = deviceName;
  card1.appendChild(deviceHint);

  card1.appendChild(
    switchRow(t("系统声音"), state.prefs.systemAudioEnabled, async (value) => {
      state.prefs = await api.prefs.set("systemAudioEnabled", value);
    })
  );
  card1.appendChild(
    switchRow(t("麦克风"), state.prefs.microphoneEnabled, async (value) => {
      state.prefs = await api.prefs.set("microphoneEnabled", value);
      render();
    })
  );
  card1.appendChild(
    switchRow(t("摄像头"), state.prefs.cameraEnabled, async (value) => {
      state.prefs = await api.prefs.set("cameraEnabled", value);
    })
  );
  card1.appendChild(
    switchRow(t("悬浮摄像头预览"), state.prefs.showFloatingCameraPreview, async (value) => {
      state.prefs = await api.prefs.set("showFloatingCameraPreview", value);
    })
  );
  const cameraPreviewHint = document.createElement("p");
  cameraPreviewHint.className = "card-hint";
  cameraPreviewHint.textContent = t("录制窗口时，在屏幕右下角显示一个摄像头小窗，便于随时确认构图；录制显示器或区域时 Windows 无法把应用自有窗口排除在画面之外，与原版“预览不入画”的行为保持一致，此时不显示。");
  card1.appendChild(cameraPreviewHint);
  const encoderHint = document.createElement("p");
  encoderHint.className = "card-hint";
  encoderHint.textContent = state.encoder?.ok
    ? t("屏幕采集编码器：%@（自动选择）", state.encoder.label)
    : t("屏幕采集编码器：当前不可用，录制时将自动改用备用采集方式。");
  card1.appendChild(encoderHint);
  body.appendChild(card1);

  const card2 = card(t("录制画面中隐藏桌面图标"), t("隐藏桌面文件"));
  card2.appendChild(
    switchRow(t("隐藏桌面文件"), state.prefs.hideDesktopIcons, async (value) => {
      const result = await api.capture.toggleDesktopIcons(value);
      if (!result?.ok) {
        toast(t("操作未完成"), { icon: "info" });
        return;
      }
      state.prefs = await api.prefs.all();
      render();
    })
  );
  body.appendChild(card2);
}

function renderStorage(body) {
  const projectCard = card(t("项目位置"), t("录制成片与草稿项目包的默认保存路径"));
  const projectRow = document.createElement("div");
  projectRow.className = "path-row";
  const projectPath = document.createElement("span");
  projectPath.className = "path-value";
  projectPath.textContent = state.prefs.projectLocation || "";
  const projectButton = document.createElement("button");
  projectButton.type = "button";
  projectButton.className = "btn";
  projectButton.innerHTML = `${icon("folder", 15)}<span>${t("更改%@", t("项目位置"))}</span>`;
  projectButton.addEventListener("click", async () => {
    const folder = await api.project.pickFolder({
      title: t("选择项目自动保存位置"),
      defaultPath: state.prefs.projectLocation,
    });
    if (!folder) return;
    state.prefs = await api.prefs.set("projectLocation", folder);
    render();
  });
  projectRow.append(projectPath, projectButton);
  projectCard.appendChild(projectRow);
  body.appendChild(projectCard);

  const exportCard = card(t("导出位置"), t("视频导出面板记住的默认目标文件夹"));
  const exportRow = document.createElement("div");
  exportRow.className = "path-row";
  const exportPath = document.createElement("span");
  exportPath.className = "path-value";
  exportPath.textContent = state.prefs.exportLocation || "";
  const exportButton = document.createElement("button");
  exportButton.type = "button";
  exportButton.className = "btn";
  exportButton.innerHTML = `${icon("folder", 15)}<span>${t("更改%@", t("导出位置"))}</span>`;
  exportButton.addEventListener("click", async () => {
    const folder = await api.project.pickFolder({
      title: t("选择成片导出位置"),
      defaultPath: state.prefs.exportLocation,
    });
    if (!folder) return;
    state.prefs = await api.prefs.set("exportLocation", folder);
    render();
  });
  exportRow.append(exportPath, exportButton);
  exportCard.appendChild(exportRow);
  body.appendChild(exportCard);
}

function renderPermissions(body) {
  const card1 = card(t("Windows 隐私与系统权限"), t("管理录制所需的系统权限"));
  const entries = [
    {
      key: "screen",
      name: t("屏幕录制权限"),
      desc: t("用于捕获屏幕画面、指定窗口与系统音频流"),
      settings: "screen",
    },
    {
      key: "microphone",
      name: t("麦克风权限"),
      desc: t("用于人声解说录音与音频设备采集"),
      settings: "microphone",
    },
    {
      key: "camera",
      name: t("摄像头权限"),
      desc: t("用于画中画人像出镜与外接相机输入"),
      settings: "camera",
    },
  ];

  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "permission-row";
    const grow = document.createElement("div");
    grow.className = "grow";
    grow.innerHTML = `<div class="name">${entry.name}</div><div class="desc">${entry.desc}</div>`;
    const status = state.permissions[entry.key] || "unknown";
    const pill = document.createElement("span");
    pill.className = `status-pill ${
      status === "granted" ? "granted" : status === "denied" ? "denied" : "unknown"
    }`;
    pill.textContent =
      status === "granted" ? t("已授权") : status === "denied" ? t("未授权") : t("准备中");
    const open = document.createElement("button");
    open.type = "button";
    open.className = "btn";
    open.style.height = "28px";
    open.textContent = t("打开设置");
    open.addEventListener("click", () => api.app.openSystemSettings(entry.settings));
    row.append(grow, pill, open);
    card1.appendChild(row);
  }
  body.appendChild(card1);

  const note = card(t("辅助功能权限"), t("用于记录鼠标移动与点击，生成可编辑的光标轨道"));
  const text = document.createElement("p");
  text.className = "card-hint";
  text.textContent =
    "Windows 上通过底层鼠标钩子记录指针，无需额外授权；如杀毒软件拦截，请允许 DogSC 的 powershell 子进程。";
  note.appendChild(text);
  body.appendChild(note);
}

function renderAbout(body) {
  const card1 = card("");
  const row = document.createElement("div");
  row.className = "about-row";
  const logo = document.createElement("div");
  logo.className = "about-logo";
  logo.textContent = "D";
  const info = document.createElement("div");
  info.className = "col";
  info.innerHTML = `<div style="font-size:15px;font-weight:600">DogSC</span><div class="card-hint" style="margin:2px 0 0">${t(
    "录制、剪辑，让画面自然出彩。"
  )}</div><div class="card-hint" style="margin:4px 0 0">${t("版本")} ${state.version} · Windows</div>`;
  row.append(logo, info);
  card1.appendChild(row);

  const updateRow = document.createElement("div");
  updateRow.className = "path-row";
  const updateHint = document.createElement("span");
  updateHint.className = "card-hint";
  updateHint.style.flex = "1";
  updateHint.style.margin = "0";
  updateHint.textContent = t("移植版未接入自动更新；点击「检查更新」会打开 Releases 页面，可手动下载最新版本。");
  const check = document.createElement("button");
  check.type = "button";
  check.className = "btn";
  check.innerHTML = `${icon("refresh", 15)}<span>${t("检查更新")}</span>`;
  check.addEventListener("click", () =>
    api.app.openExternal("https://github.com/yfc7878/dogsc-windows/releases/latest")
  );
  updateRow.append(updateHint, check);
  card1.appendChild(updateRow);
  body.appendChild(card1);

  const card2 = card(t("免费开源 · 自愿支持"), t("请杯咖啡"));
  const links = document.createElement("div");
  links.className = "path-row";
  for (const [label, url] of [
    [t("移植版源码"), "https://github.com/yfc7878/dogsc-windows"],
    [t("反馈建议"), "https://github.com/yfc7878/dogsc-windows/issues"],
    [t("macOS 原版"), "https://github.com/laogou717/dogsc"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btn";
    button.innerHTML = `${icon("link", 15)}<span>${label}</span>`;
    button.addEventListener("click", () => api.app.openExternal(url));
    links.appendChild(button);
  }
  card2.appendChild(links);
  body.appendChild(card2);
}

boot();
