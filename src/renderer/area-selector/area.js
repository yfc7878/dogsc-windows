/**
 * Capture area selector.
 *
 * Drag to author a recording rectangle. The overlay reports the selection in
 * device-independent pixels; the capture surface scales it to the display's
 * physical pixels, which keeps the result identical on mixed-DPI setups.
 */

import { t, setLocale } from "../shared/i18n.js";

const api = window.dogsc;

const overlay = document.getElementById("overlay");
const selection = document.getElementById("selection");
const sizeTag = document.getElementById("size-tag");
const hint = document.getElementById("hint");
const confirmBar = document.getElementById("confirm-bar");
const dims = document.getElementById("dims");

const MIN_SIZE = 32;

const state = {
  origin: null,
  current: null,
  rect: null,
  dragging: false,
  handle: null,
  startRect: null,
  startPoint: null,
  displayId: null,
  scaleFactor: 1,
  /** Set while the recorder bar is being brought forward, so the blur handler
      does not mistake that for the user clicking away. */
  confirming: false,
};

async function boot() {
  setLocale("zh-Hans");
  const params = new URLSearchParams(location.search);
  state.displayId = params.get("displayId");

  const displays = await api.capture.displays();
  const display = displays.find((entry) => String(entry.id) === String(state.displayId));
  if (display) state.scaleFactor = display.scaleFactor;

  /* Restore the previous selection on this display, so re-recording the same
     region does not mean dragging it out again. A different display (or a
     first run) starts from an empty overlay. */
  const prefs = await api.prefs.all();
  const last = prefs.lastAreaRegion;
  if (
    last &&
    String(last.displayId) === String(state.displayId) &&
    Number(last.width) >= MIN_SIZE &&
    Number(last.height) >= MIN_SIZE
  ) {
    state.rect = clampToViewport({
      x: Number(last.x) || 0,
      y: Number(last.y) || 0,
      width: Number(last.width) || 0,
      height: Number(last.height) || 0,
    });
    paint();
  }

  document.getElementById("btn-cancel").addEventListener("click", () => window.close());
  document.getElementById("btn-confirm").addEventListener("click", confirm);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") window.close();
    if (event.key === "Enter" && state.rect) confirm();
  });

  /* Clicking away cancels the selection — but not while `confirm()` is
     bringing the recorder bar forward, which blurs this window on purpose. */
  window.addEventListener("blur", () => {
    if (state.confirming) return;
    window.close();
  });
}

/* ------------------------------------------------------------------------- */

function pointFromEvent(event) {
  return { x: event.clientX, y: event.clientY };
}

function normalize(origin, current) {
  return {
    x: Math.min(origin.x, current.x),
    y: Math.min(origin.y, current.y),
    width: Math.abs(current.x - origin.x),
    height: Math.abs(current.y - origin.y),
  };
}

function clampToViewport(rect) {
  const x = Math.max(0, Math.min(rect.x, window.innerWidth - MIN_SIZE));
  const y = Math.max(0, Math.min(rect.y, window.innerHeight - MIN_SIZE));
  return {
    x,
    y,
    width: Math.max(MIN_SIZE, Math.min(rect.width, window.innerWidth - x)),
    height: Math.max(MIN_SIZE, Math.min(rect.height, window.innerHeight - y)),
  };
}

function paint() {
  if (!state.rect) {
    selection.hidden = true;
    confirmBar.hidden = true;
    hint.hidden = false;
    return;
  }
  hint.hidden = true;
  selection.hidden = false;
  const { x, y, width, height } = state.rect;
  selection.style.left = `${x}px`;
  selection.style.top = `${y}px`;
  selection.style.width = `${width}px`;
  selection.style.height = `${height}px`;

  const physicalWidth = Math.round(width * state.scaleFactor);
  const physicalHeight = Math.round(height * state.scaleFactor);
  const label = `${physicalWidth} × ${physicalHeight}`;
  sizeTag.textContent = label;
  sizeTag.style.left = "0px";

  confirmBar.hidden = false;
  dims.textContent = label;

  /* Keep the confirm bar inside the viewport, below the selection. */
  const barWidth = confirmBar.offsetWidth || 280;
  let left = x + width - barWidth;
  left = Math.max(10, Math.min(left, window.innerWidth - barWidth - 10));
  let top = y + height + 12;
  if (top + 52 > window.innerHeight) top = Math.max(10, y - 60);
  confirmBar.style.left = `${left}px`;
  confirmBar.style.top = `${top}px`;
}

/* ------------------------------------------------------------------------- */
/* Drag handling                                                             */
/* ------------------------------------------------------------------------- */

overlay.addEventListener("mousedown", (event) => {
  if (event.target.closest(".confirm-bar")) return;
  const handle = event.target.closest(".handle");
  if (handle) {
    state.dragging = true;
    state.handle = handle.dataset.handle;
    state.startRect = { ...state.rect };
    state.startPoint = pointFromEvent(event);
    return;
  }
  state.dragging = true;
  state.handle = null;
  state.origin = pointFromEvent(event);
  state.current = state.origin;
  state.rect = { x: state.origin.x, y: state.origin.y, width: 0, height: 0 };
  paint();
});

window.addEventListener("mousemove", (event) => {
  if (!state.dragging) return;
  const point = pointFromEvent(event);

  if (state.handle && state.startRect) {
    const dx = point.x - state.startPoint.x;
    const dy = point.y - state.startPoint.y;
    let { x, y, width, height } = state.startRect;
    const right = x + width;
    const bottom = y + height;
    if (state.handle.includes("w")) {
      x = Math.min(x + dx, right - MIN_SIZE);
      width = right - x;
    }
    if (state.handle.includes("e")) width = Math.max(MIN_SIZE, width + dx);
    if (state.handle.includes("n")) {
      y = Math.min(y + dy, bottom - MIN_SIZE);
      height = bottom - y;
    }
    if (state.handle.includes("s")) height = Math.max(MIN_SIZE, height + dy);
    state.rect = clampToViewport({ x, y, width, height });
  } else {
    state.current = point;
    state.rect = clampToViewport(normalize(state.origin, state.current));
  }
  paint();
});

window.addEventListener("mouseup", () => {
  state.dragging = false;
  state.handle = null;
  if (state.rect && (state.rect.width < MIN_SIZE || state.rect.height < MIN_SIZE)) {
    state.rect = null;
  }
  paint();
});

/* ------------------------------------------------------------------------- */

async function confirm() {
  if (!state.rect || state.confirming) return;
  state.confirming = true;
  const region = {
    x: Math.round(state.rect.x),
    y: Math.round(state.rect.y),
    width: Math.round(state.rect.width),
    height: Math.round(state.rect.height),
  };
  await api.prefs.set("lastAreaRegion", { ...region, displayId: state.displayId });

  /* The recorder bar owns the capture session, so it is brought forward and
     asked to start with the authored region. The main process resolves the
     display into a capturer source id. */
  await api.windows.openRecorder();
  await api.capture.start({
    kind: "area",
    displayId: state.displayId,
    scaleFactor: state.scaleFactor,
    region,
    fps: 60,
    systemAudio: true,
    microphone: null,
    camera: null,
  });
  window.close();
}

boot();
