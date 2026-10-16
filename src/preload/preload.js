/**
 * Preload bridge.
 *
 * The renderer never touches Node. Everything it needs is exposed here as a
 * narrow, promise-based API, mirroring the capability set the macOS app gets
 * from AppKit / ScreenCaptureKit / AVFoundation.
 */

const { contextBridge, ipcRenderer } = require("electron");

/** Channels the renderer may listen on. Anything else is ignored. */
const INBOUND = new Set([
  "app:theme",
  "app:prefs",
  "recorder:state",
  "recorder:sources",
  "recorder:marker",
  "recorder:elapsed",
  "recorder:warning",
  "capture:command",
  "editor:open-project",
  "editor:menu-command",
  "export:init",
  "export:progress",
  "completion:init",
  "area:init",
  "app:toast",
]);

const listeners = new Map();

ipcRenderer.on("dogsc:event", (_event, envelope) => {
  if (!envelope || !INBOUND.has(envelope.channel)) return;
  const set = listeners.get(envelope.channel);
  if (!set) return;
  for (const callback of set) {
    try {
      callback(envelope.payload);
    } catch (error) {
      console.error("[preload] listener failed", error);
    }
  }
});

function on(channel, callback) {
  if (!listeners.has(channel)) listeners.set(channel, new Set());
  listeners.get(channel).add(callback);
  return () => listeners.get(channel)?.delete(callback);
}

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

contextBridge.exposeInMainWorld("dogsc", {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  },

  on,

  prefs: {
    all: () => invoke("prefs:all"),
    get: (key) => invoke("prefs:get", key),
    set: (key, value) => invoke("prefs:set", { key, value }),
    patch: (partial) => invoke("prefs:patch", partial),
  },

  windows: {
    self: () => invoke("window:self"),
    minimize: () => invoke("window:minimize"),
    toggleMaximize: () => invoke("window:toggle-maximize"),
    close: () => invoke("window:close"),
    setBounds: (bounds) => invoke("window:set-bounds", bounds),
    getBounds: () => invoke("window:get-bounds"),
    setIgnoreMouseEvents: (value) => invoke("window:set-ignore-mouse", value),
    setResizable: (value) => invoke("window:set-resizable", value),
    startDrag: () => invoke("window:start-drag"),
    openEditor: (payload) => invoke("window:open-editor", payload),
    openRecorder: (payload) => invoke("window:open-recorder", payload),
    openMemo: () => invoke("window:open-memo"),
    openSettings: () => invoke("window:open-settings"),
    openExport: (payload) => invoke("window:open-export", payload),
    openOnboarding: () => invoke("window:open-onboarding"),
    openCompletion: (payload) => invoke("window:open-completion", payload),
    /* Pulled by a window's renderer once it is ready to receive it. */
    exportPayload: () => invoke("export:payload"),
    completionPayload: () => invoke("completion:payload"),
    openAreaSelector: (displayId) => invoke("window:open-area-selector", displayId),
    closeByName: (name) => invoke("window:close-named", name),
  },

  system: {
    wallpapers: () => invoke("system:wallpapers"),
  },
  capture: {
    displays: () => invoke("capture:displays"),
    sources: (options) => invoke("capture:sources", options),
    start: (config) => invoke("capture:start", config),
    pause: () => invoke("capture:pause"),
    resume: () => invoke("capture:resume"),
    stop: () => invoke("capture:stop"),
    cancel: () => invoke("capture:cancel"),
    addMarker: () => invoke("capture:add-marker"),
    status: () => invoke("capture:status"),
    toggleDesktopIcons: (hide) => invoke("capture:toggle-desktop-icons", hide),
    toCaptureWindow: (payload) => ipcRenderer.send("capture:to-surface", payload),
    /* Used only by the hidden capture surface. */
    started: (payload) => invoke("capture:started", payload),
    finished: (payload) => invoke("capture:finished", payload),
    warning: (payload) => invoke("capture:warning", payload),
    failed: (payload) => invoke("capture:failed", payload),
    write: (payload) => invoke("capture:write", payload),
    writeFile: (payload) => invoke("capture:write-file", payload),
  },

  project: {
    list: (directory) => invoke("project:list", directory),
    open: (packagePath) => invoke("project:open", packagePath),
    pick: () => invoke("project:pick"),
    save: (payload) => invoke("project:save", payload),
    discard: (packagePath) => invoke("project:discard", packagePath),
    reveal: (target) => invoke("project:reveal", target),
    pickFolder: (options) => invoke("project:pick-folder", options),
    pickFile: (options) => invoke("project:pick-file", options),
    pickSaveFile: (options) => invoke("project:pick-save-file", options),
    importFile: (options) => invoke("project:import-file", options),
    replaceCamera: (payload) => invoke("project:replace-camera", payload),
    exportSources: (payload) => invoke("project:export-sources", payload),
    mediaUrl: (payload) => invoke("project:media-url", payload),
    tempPath: (name) => invoke("project:temp-path", name),
  },

  clipboard: {
    hasImage: () => invoke("clipboard:has-image"),
    readImage: () => invoke("clipboard:read-image"),
  },

  exporter: {
    capabilities: () => invoke("export:capabilities"),
    begin: (payload) => invoke("export:begin", payload),
    chunk: (payload) => invoke("export:chunk", payload),
    finish: (payload) => invoke("export:finish", payload),
    cancel: () => invoke("export:cancel"),
    audioOnly: (payload) => invoke("export:audio-only", payload),
    reveal: (target) => invoke("export:reveal", target),
  },

  app: {
    version: () => invoke("app:version"),
    theme: () => invoke("app:theme"),
    setTheme: (value) => invoke("app:set-theme", value),
    quit: () => invoke("app:quit"),
    openExternal: (url) => invoke("app:open-external", url),
    checkUpdates: () => invoke("app:check-updates"),
    openSystemSettings: (page) => invoke("app:open-system-settings", page),
    permissions: () => invoke("app:permissions"),
    memo: {
      load: () => invoke("memo:load"),
      save: (payload) => invoke("memo:save", payload),
    },
  },

  menu: {
    command: (name) => invoke("menu:command", name),
  },
});
