/**
 * Floating camera preview.
 *
 * The port of the original's `CameraPreviewWindowController`: while a window
 * recording runs with the camera on, this small always-on-top bubble shows the
 * camera feed so framing can be checked without opening the editor.
 *
 * The main process opens it only for window sources — on a full-display
 * capture Windows has no way to keep an app-owned window out of the picture,
 * and the original's preview never enters the picture either.
 *
 * The capture surface already holds the camera open; Windows cameras are
 * shared, so a second read-only consumer is fine. If a driver refuses, the
 * bubble says so instead of showing black.
 */

import { icon } from "../shared/icons.js";
import { setLocale, t } from "../shared/i18n.js";
import { enableManualDrag } from "../shared/widgets.js";

const api = window.dogsc;

const video = document.getElementById("video");
const status = document.getElementById("status");

let stream = null;
let mirrored = true;

async function boot() {
  setLocale("zh-Hans");
  document.getElementById("btn-close").innerHTML = icon("close", 11);
  document.getElementById("btn-close").addEventListener("click", () => window.close());

  const params = new URLSearchParams(location.search);
  mirrored = params.get("mirrored") !== "0";
  video.dataset.mirrored = mirrored ? "1" : "0";

  const theme = await api.app.theme();
  document.documentElement.dataset.theme = theme.dark ? "dark" : "light";
  api.on("app:theme", (payload) => {
    document.documentElement.dataset.theme = payload.dark ? "dark" : "light";
  });

  /* The window is frameless; the surface drags it programmatically. */
  enableManualDrag();

  api.on("floating-camera:config", (payload) => {
    if (payload && typeof payload.mirrored === "boolean") {
      mirrored = payload.mirrored;
      video.dataset.mirrored = mirrored ? "1" : "0";
    }
    if (payload?.deviceId && payload.deviceId !== currentDeviceId) {
      openCamera(payload.deviceId);
    }
  });

  const deviceId = params.get("deviceId") || "";
  if (!deviceId) {
    showStatus(t("未选择摄像头。"));
    return;
  }
  await openCamera(deviceId);
}

let currentDeviceId = null;

async function openCamera(deviceId) {
  currentDeviceId = deviceId;
  stopStream();
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: { exact: deviceId } },
      audio: false,
    });
    video.srcObject = stream;
    status.hidden = true;
    video.hidden = false;
    await video.play().catch(() => {});
  } catch (error) {
    console.warn("[floating-camera] preview unavailable:", error?.message || error);
    showStatus(t("摄像头预览暂不可用，录制不受影响。"));
  }
}

function stopStream() {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
  stream = null;
}

function showStatus(message) {
  video.hidden = true;
  status.hidden = false;
  status.textContent = message;
}

window.addEventListener("beforeunload", stopStream);

boot();
