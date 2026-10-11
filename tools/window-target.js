/**
 * A standalone animated window, used to verify window capture.
 *
 * `desktopCapturer.getSources({types:['window']})` filters out the capturing
 * application's own windows, so the app cannot record a window it created
 * itself. Running this as a separate process produces a window that is
 * genuinely external — visible, repainting, and therefore capturable.
 *
 * Chromium only delivers frames while the captured window is on screen and
 * repainting, so the page animates continuously.
 *
 * Usage: npx electron tools/window-target.js
 */

const { app, BrowserWindow } = require("electron");
const path = require("path");

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 520,
    height: 360,
    x: 80,
    y: 80,
    show: true,
    title: "DogSC 采集验证",
    backgroundColor: "#0d1b26",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  await win.loadFile(path.join(__dirname, "..", "src", "renderer", "probe", "index.html"));
  win.setTitle("DogSC 采集验证");
  win.show();
  win.focus();
  console.log("[window-target] ready");

  /* Nothing to do but keep repainting until the parent kills this process. */
  win.on("closed", () => app.quit());
});
