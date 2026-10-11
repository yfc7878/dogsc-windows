/**
 * Recorder memo.
 *
 * A floating notes surface that stays out of the recording. Text, font size
 * and background opacity are persisted to the preference store so the notes
 * survive a restart, exactly like the original's on-device document.
 */

import { icon } from "../shared/icons.js";
import { setLocale, t } from "../shared/i18n.js";
import { attachTooltip, enableManualDrag, toast } from "../shared/widgets.js";

const api = window.dogsc;

/* The memo is frameless; its title bar moves the window programmatically
   because CSS app-region drag strobes on Windows here (same fix as the
   recorder bar, which has always dragged this way). */
enableManualDrag();

const editor = document.getElementById("editor");
const reader = document.getElementById("reader");
const surface = document.getElementById("surface");
const opacity = document.getElementById("opacity");
const sizeLabel = document.getElementById("size-label");

const state = { fontSize: 15, opacity: 0.82, reading: false, saveTimer: null };

async function boot() {
  setLocale("zh-Hans");
  const prefs = await api.prefs.all();
  const memo = prefs.memo || {};

  state.fontSize = memo.fontSize || 15;
  state.opacity = memo.opacity ?? 0.82;
  state.reading = Boolean(memo.reading);
  editor.value = memo.text || "";
  opacity.value = String(state.opacity);

  const theme = await api.app.theme();
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
  api.on("app:theme", (payload) => {
    document.documentElement.dataset.theme = payload.dark ? "dark" : "light";
  });

  document.getElementById("btn-read").innerHTML = icon(state.reading ? "text" : "eye", 16);
  document.getElementById("btn-close").innerHTML = icon("close", 15);
  document.getElementById("btn-smaller").innerHTML = icon("minus", 15);
  document.getElementById("btn-bigger").innerHTML = icon("plus", 15);

  attachTooltip(document.getElementById("btn-read"), t("切换到阅读，避免误改文稿"));
  attachTooltip(document.getElementById("btn-smaller"), t("缩小备忘录字号"));
  attachTooltip(document.getElementById("btn-bigger"), t("放大备忘录字号"));

  applyAppearance();
  renderMode();

  editor.addEventListener("input", scheduleSave);
  editor.addEventListener("keydown", (event) => event.stopPropagation());

  document.getElementById("btn-read").addEventListener("click", () => {
    state.reading = !state.reading;
    document.getElementById("btn-read").innerHTML = icon(state.reading ? "text" : "eye", 16);
    renderMode();
    persist();
  });
  document.getElementById("btn-close").addEventListener("click", async () => {
    await persist();
    window.close();
  });
  document.getElementById("btn-smaller").addEventListener("click", () => changeSize(-1));
  document.getElementById("btn-bigger").addEventListener("click", () => changeSize(1));

  opacity.addEventListener("input", () => {
    state.opacity = Number(opacity.value);
    applyAppearance();
    scheduleSave();
  });

  window.addEventListener("beforeunload", () => persist());
}

function changeSize(delta) {
  state.fontSize = Math.max(10, Math.min(40, state.fontSize + delta));
  applyAppearance();
  scheduleSave();
}

function applyAppearance() {
  editor.style.fontSize = `${state.fontSize}px`;
  reader.style.fontSize = `${state.fontSize}px`;
  sizeLabel.textContent = String(state.fontSize);
  const theme = document.documentElement.dataset.theme;
  const base = theme === "dark" ? "28, 29, 31" : "255, 255, 255";
  surface.style.background = `rgba(${base}, ${state.opacity})`;
}

function renderMode() {
  editor.hidden = state.reading;
  reader.hidden = !state.reading;
  if (state.reading) {
    reader.textContent = editor.value || t("写下或粘贴要讲的内容…");
  } else {
    editor.focus();
  }
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(persist, 400);
}

async function persist() {
  clearTimeout(state.saveTimer);
  await api.app.memo.save({
    text: editor.value,
    fontSize: state.fontSize,
    opacity: state.opacity,
    reading: state.reading,
    visible: true,
  });
}

boot();
