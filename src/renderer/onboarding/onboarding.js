/**
 * First-use guide.
 *
 * The macOS build walks through screen-recording and accessibility consent and
 * then teaches the workspace. Windows has no equivalent TCC prompts, so the
 * steps explain the Windows privacy switches instead and then walk the same
 * recorder → editor → export tour.
 */

import { setLocale, t } from "../shared/i18n.js";

const api = window.dogsc;

const STEPS = [
  {
    title: "选择录制范围",
    body: "录整个屏幕、一个窗口，或自己框选区域。连接的设备也可以作为录制来源。",
    action: null,
  },
  {
    title: "按需开启声音与摄像头",
    body: "在这里选择麦克风、摄像头和系统声音。只开启这次录制需要的输入。",
    action: null,
  },
  {
    title: "设置保存位置",
    body: "选择项目位置、格式和画质。已有项目也可以从这里打开，继续编辑。",
    action: "storage",
  },
  {
    title: "从这里选择要调整的内容",
    body: "画面、运镜、光标、摄像头与声音，各自的设置都从左侧进入。",
    action: null,
  },
  {
    title: "调整画面外观",
    body: "右侧显示当前选项的详细设置。背景、布局与样机的变化会显示在预览中。",
    action: null,
  },
  {
    title: "在时间线上剪辑",
    body: "移动播放指针定位内容，拖动片段边缘调整长度。吸附和预览可以在时间线上方开关。",
    action: null,
  },
  {
    title: "完成后导出",
    body: "从这里选择导出格式和画质，生成成片。项目会继续保留，方便回来修改。",
    action: null,
  },
];

const state = { index: 0 };

async function boot() {
  setLocale("zh-Hans");
  render();

  document.getElementById("btn-skip").addEventListener("click", finish);
  document.getElementById("btn-next").addEventListener("click", next);
  document.getElementById("btn-back").addEventListener("click", () => {
    state.index = Math.max(0, state.index - 1);
    render();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") finish();
    if (event.key === "ArrowRight" || event.key === "Enter") next();
    if (event.key === "ArrowLeft") {
      state.index = Math.max(0, state.index - 1);
      render();
    }
  });
}

async function next() {
  if (state.index < STEPS.length - 1) {
    state.index += 1;
    render();
    return;
  }
  finish();
}

async function finish() {
  await api.prefs.set("onboardingCompleted", true);
  await api.windows.openRecorder();
  window.close();
}

function render() {
  const step = STEPS[state.index];
  document.getElementById("title").textContent = state.index === 0 ? "丝滑录屏" : t(step.title);
  document.getElementById("message").textContent =
    state.index === 0 ? t("录制、剪辑，让画面自然出彩。") : t(step.body);

  const host = document.getElementById("steps");
  host.innerHTML = "";
  STEPS.forEach((entry, index) => {
    const card = document.createElement("div");
    card.className = "step-card";
    if (index === state.index) card.classList.add("is-current");
    card.innerHTML = `
      <span class="step-index">${index + 1}</span>
      <div class="step-text">
        <h4>${t(entry.title)}</h4>
        <p>${t(entry.body)}</p>
      </div>
    `;
    host.appendChild(card);
  });

  const dots = document.getElementById("dots");
  dots.innerHTML = STEPS.map(
    (_, index) => `<i class="${index === state.index ? "is-active" : ""}"></i>`
  ).join("");

  document.getElementById("btn-back").disabled = state.index === 0;
  document.getElementById("btn-next").textContent =
    state.index === STEPS.length - 1 ? t("进入 DogSC") : t("下一步");
}

boot();
