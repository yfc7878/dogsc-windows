/**
 * Window management.
 *
 * Reproduces the macOS original's window set:
 *   · RecorderPanelController  → the floating, always-on-top recorder bar
 *   · RecorderMemo             → an independent floating notes window
 *   · CaptureAreaSelection     → a full-display drag-to-select overlay
 *   · NativeScreenRecording    → a hidden surface that owns the capture graph
 *   · EditorView               → the main editing workspace
 *   · EditorExportViews        → the export sheet
 *   · AppSettingsWindowController → the settings window
 */

const path = require("path");
const { BrowserWindow, screen, shell, nativeTheme } = require("electron");

const RENDERER = path.join(__dirname, "..", "renderer");
const PRELOAD = path.join(__dirname, "..", "preload", "preload.js");

/* Geometry taken from the original's authored window sizes. */
const SIZES = {
  recorder: { width: 722, height: 104 },
  recorderExpanded: { width: 722, height: 104 },
  memo: { width: 336, height: 420 },
  editor: { width: 1180, height: 780 },
  exportPanel: { width: 900, height: 664 },
  settings: { width: 760, height: 580 },
  onboarding: { width: 880, height: 592 },
  completion: { width: 720, height: 540 },
  windowPicker: { width: 520, height: 420 },
};

class WindowManager {
  constructor({ prefs, onClosed, onWindowCreated, onPayload } = {}) {
    this.prefs = prefs;
    this.onClosed = onClosed;
    this.onWindowCreated = onWindowCreated;
    /** Stores a payload until the target renderer asks for it. */
    this.onPayload = onPayload || (() => {});
    this.windows = new Map();
  }

  get(name) {
    const win = this.windows.get(name);
    return win && !win.isDestroyed() ? win : null;
  }

  has(name) {
    return Boolean(this.get(name));
  }

  baseOptions(overrides = {}) {
    const theme = this.prefs.get("appearance") || "system";
    return {
      show: false,
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0c0d" : "#f3f5f6",
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
      ...overrides,
    };
  }

  /**
   * Loads a page over the privileged `app://` scheme.
   *
   * The window is registered (and diagnostics attached) *before* the load so a
   * failure during module evaluation is reported instead of being lost.
   */
  load(win, name, page, query = {}) {
    this.track(name, win);
    /* ES modules cannot be loaded from file:// — Chromium blocks them with a
       CORS error — so the UI is served over `app://`. */
    const url = new URL(`app://dogsc/${page}/index.html`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    win.loadURL(url.toString());
    return win;
  }

  track(name, win) {
    if (this.windows.get(name) === win) return win; // already registered
    this.windows.set(name, win);
    this.onWindowCreated?.(win, name);
    win.on("closed", () => {
      this.windows.delete(name);
      this.onClosed?.(name);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url);
      return { action: "deny" };
    });
    return win;
  }

  /* --------------------------------------------------------------------- */
  /* Recorder bar                                                          */
  /* --------------------------------------------------------------------- */

  createRecorder({ displayId } = {}) {
    const existing = this.get("recorder");
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }
    const size = SIZES.recorder;
    const bounds = this.prefs.get("recorderBounds");
    const area = bounds || defaultRecorderBounds(size);
    const win = new BrowserWindow(
      this.baseOptions({
        width: size.width,
        height: size.height,
        x: area.x,
        y: area.y,
        frame: false,
        transparent: true,
        resizable: false,
        movable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        maximizable: false,
        minimizable: false,
        fullscreenable: false,
      })
    );
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.load(win, "recorder", "recorder", { displayId });
    win.once("ready-to-show", () => win.showInactive());
    win.on("moved", () => {
      if (!win.isDestroyed()) this.prefs.set("recorderBounds", win.getBounds());
    });
    return this.track("recorder", win);
  }

  /* --------------------------------------------------------------------- */
  /* Memo                                                                  */
  /* --------------------------------------------------------------------- */

  createMemo() {
    const existing = this.get("memo");
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }
    const size = SIZES.memo;
    const saved = this.prefs.get("memoBounds");
    const win = new BrowserWindow(
      this.baseOptions({
        width: saved?.width || size.width,
        height: saved?.height || size.height,
        x: saved?.x,
        y: saved?.y,
        minWidth: 240,
        minHeight: 200,
        frame: false,
        transparent: true,
        resizable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
      })
    );
    win.setAlwaysOnTop(true, "floating");
    this.load(win, "memo", "memo");
    win.once("ready-to-show", () => win.showInactive());
    const remember = () => {
      if (!win.isDestroyed()) this.prefs.set("memoBounds", win.getBounds());
    };
    win.on("resized", remember);
    win.on("moved", remember);
    return this.track("memo", win);
  }

  /* --------------------------------------------------------------------- */
  /* Area selection overlay                                                */
  /* --------------------------------------------------------------------- */

  createAreaSelector(displayId) {
    const existing = this.get("areaSelector");
    if (existing) existing.close();
    const displays = screen.getAllDisplays();
    const display = displays.find((d) => String(d.id) === String(displayId)) || screen.getPrimaryDisplay();
    const win = new BrowserWindow(
      this.baseOptions({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        fullscreenable: false,
      })
    );
    win.setAlwaysOnTop(true, "screen-saver");
    this.load(win, "areaSelector", "area-selector", { displayId: display.id });
    win.once("ready-to-show", () => win.show());
    return this.track("areaSelector", win);
  }

  /* --------------------------------------------------------------------- */
  /* Hidden capture surface                                                */
  /* --------------------------------------------------------------------- */

  createCaptureSurface() {
    const existing = this.get("captureSurface");
    if (existing) return existing;
    const win = new BrowserWindow(
      this.baseOptions({
        width: 480,
        height: 320,
        show: false,
        frame: false,
        skipTaskbar: true,
        webPreferences: {
          preload: PRELOAD,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
          backgroundThrottling: false,
          offscreen: false,
        },
      })
    );
    this.load(win, "captureSurface", "capture");
    return this.track("captureSurface", win);
  }

  /* --------------------------------------------------------------------- */
  /* Editor                                                                */
  /* --------------------------------------------------------------------- */

  createEditor({ projectPath } = {}) {
    const existing = this.get("editor");
    if (existing) {
      existing.show();
      existing.focus();
      if (projectPath) existing.webContents.send("editor:open-project", projectPath);
      return existing;
    }
    const saved = this.prefs.get("editorBounds");
    const size = SIZES.editor;
    const win = new BrowserWindow(
      this.baseOptions({
        width: saved?.width || size.width,
        height: saved?.height || size.height,
        x: saved?.x,
        y: saved?.y,
        minWidth: 940,
        minHeight: 620,
        frame: false,
        title: "DogSC",
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0c0d" : "#f3f5f6",
      })
    );
    this.load(win, "editor", "editor", { project: projectPath || "" });
    win.once("ready-to-show", () => win.show());
    const remember = () => {
      if (!win.isDestroyed() && !win.isMinimized() && !win.isMaximized()) {
        this.prefs.set("editorBounds", win.getBounds());
      }
    };
    win.on("resized", remember);
    win.on("moved", remember);
    return this.track("editor", win);
  }

  /* --------------------------------------------------------------------- */
  /* Export sheet                                                          */
  /* --------------------------------------------------------------------- */

  createExportPanel(payload) {
    const existing = this.get("exportPanel");
    if (existing) {
      existing.close();
    }
    const parent = this.get("editor");
    const win = new BrowserWindow(
      this.baseOptions({
        width: SIZES.exportPanel.width,
        height: SIZES.exportPanel.height,
        parent: parent || undefined,
        modal: false,
        frame: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#121314" : "#fafbfb",
      })
    );
    this.load(win, "exportPanel", "export");
    win.once("ready-to-show", () => win.show());
    if (payload) this.onPayload("exportPanel", payload);
    return this.track("exportPanel", win);
  }

  /* --------------------------------------------------------------------- */
  /* Settings                                                              */
  /* --------------------------------------------------------------------- */

  createSettings() {
    const existing = this.get("settings");
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }
    const win = new BrowserWindow(
      this.baseOptions({
        width: SIZES.settings.width,
        height: SIZES.settings.height,
        minWidth: 680,
        minHeight: 480,
        frame: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#0b0c0d" : "#f3f5f6",
      })
    );
    this.load(win, "settings", "settings");
    win.once("ready-to-show", () => win.show());
    return this.track("settings", win);
  }

  /* --------------------------------------------------------------------- */
  /* Onboarding                                                            */
  /* --------------------------------------------------------------------- */

  createOnboarding() {
    const existing = this.get("onboarding");
    if (existing) {
      existing.show();
      existing.focus();
      return existing;
    }
    const win = new BrowserWindow(
      this.baseOptions({
        width: SIZES.onboarding.width,
        height: SIZES.onboarding.height,
        frame: false,
        resizable: false,
        backgroundColor: "#0b0c0d",
      })
    );
    this.load(win, "onboarding", "onboarding");
    win.once("ready-to-show", () => win.show());
    return this.track("onboarding", win);
  }

  /* --------------------------------------------------------------------- */
  /* Recording completion card                                             */
  /* --------------------------------------------------------------------- */

  createCompletion(payload) {
    const existing = this.get("completion");
    if (existing) existing.close();
    const win = new BrowserWindow(
      this.baseOptions({
        width: SIZES.completion.width,
        height: SIZES.completion.height,
        frame: false,
        resizable: false,
        maximizable: false,
        minimizable: false,
        backgroundColor: nativeTheme.shouldUseDarkColors ? "#121314" : "#fafbfb",
      })
    );
    this.load(win, "completion", "completion");
    win.once("ready-to-show", () => win.show());
    if (payload) this.onPayload("completion", payload);
    return this.track("completion", win);
  }

  closeAll() {
    for (const win of this.windows.values()) {
      if (win && !win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }
}

function defaultRecorderBounds(size) {
  const display = screen.getPrimaryDisplay();
  const { x, y, width, height } = display.workArea;
  return {
    x: Math.round(x + (width - size.width) / 2),
    y: Math.round(y + height - size.height - 48),
  };
}

module.exports = { WindowManager, SIZES };
