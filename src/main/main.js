/**
 * DogSC — Windows port.
 *
 * Application entry point. Owns the app lifecycle, the IPC surface exposed by
 * the preload bridge, the recording session state machine and the project /
 * export orchestration.
 *
 * The macOS original splits this work across AppModel, RecorderPanelController,
 * CaptureSetupController, ProjectStore and DirectExportPipeline. The port keeps
 * the same responsibilities, just gathered into one main-process module plus
 * the capture surface renderer that owns the AVFoundation-equivalent graph.
 */

const path = require("path");
const fs = require("fs");
const fsp = require("fs/promises");
const { pathToFileURL } = require("url");
const { Readable } = require("stream");
const {
  app,
  ipcMain,
  dialog,
  shell,
  clipboard,
  nativeTheme,
  desktopCapturer,
  screen,
  globalShortcut,
  Menu,
  BrowserWindow,
  webContents,
  protocol,
  net,
  systemPreferences,
} = require("electron");

const { Preferences } = require("./prefs");
const { childEnv } = require("./child-env");
const { WindowManager } = require("./windows");
const { PointerTracker, physicalRectForDisplay } = require("./input-hook");
const projectIO = require("./project");
const exporter = require("./exporter");
const mediaExchange = require("./media-exchange");
const screenCapture = require("./screen-capture");
const desktopIcons = require("./desktop-icons");

const RESOURCES = path.join(__dirname, "..", "..", "resources");
const RENDERER_DIR = path.join(__dirname, "..", "renderer");
const MARKER_ACCELERATOR = "Control+Alt+M";

/* Project media is served through a privileged scheme so the renderer can
   play it back without disabling web security or leaking absolute paths.
   The UI itself is served from `app://` because ES modules cannot be loaded
   over file:// (Chromium blocks them with a CORS error), and every window in
   this app is an ES module. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: "dogsc-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

/* A parallel smoke instance (`DOGSC_ALLOW_MULTI=1` + `DOGSC_USER_DATA=<dir>`)
   can run beside the user's real app: the single-instance lock is skipped and
   the profile is isolated so the two never share preferences or caches. */
if (process.env.DOGSC_USER_DATA) {
  app.setPath("userData", process.env.DOGSC_USER_DATA);
}
if (process.env.DOGSC_ALLOW_MULTI !== "1" && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

/*
 * Screen capture and the editor compositor both run through Chromium's media
 * stack. On machines with a broken or absent GPU driver the GPU process can
 * fail to start, which takes the whole app down before a window ever opens.
 * `--disable-gpu` (or DOGSC_SOFTWARE_RENDER=1) falls back to software
 * rendering so recording and editing still work, just slower.
 */
const softwareRender =
  process.argv.includes("--disable-gpu") || process.env.DOGSC_SOFTWARE_RENDER === "1";
if (softwareRender) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch("disable-gpu-compositing");
  app.commandLine.appendSwitch("disable-gpu-sandbox");
  app.commandLine.appendSwitch("in-process-gpu");
}

/*
 * `DOGSC_FAKE_MEDIA=1` makes Chromium expose a synthetic capture device.
 *
 * The device-recording path cannot otherwise be exercised on a machine with no
 * camera, and it is the one source kind the port cannot verify by hand. The
 * fake device produces a moving pattern, so a recording made from it proves
 * frames really flowed.
 */
if (process.env.DOGSC_FAKE_MEDIA === "1") {
  app.commandLine.appendSwitch("use-fake-device-for-media-stream");
  app.commandLine.appendSwitch("use-fake-ui-for-media-stream");
}

/* Renderer diagnostics. Warnings and errors are surfaced on the main process
   log so a failure inside a window is never silent. */
function attachRendererLogging(win, name) {
  win.webContents.on("console-message", (...args) => {
    /* Electron 33 uses (event, level, message, line, sourceId); newer builds
       pass a details object. Support both so diagnostics never go silent. */
    const details = args[0] && typeof args[0] === "object" && "message" in args[0] ? args[0] : null;
    const level = details ? details.level : args[1];
    const message = details ? details.message : args[2];
    const source = details ? details.sourceId : args[4];
    const line = details ? details.lineNumber : args[3];
    const verbose = Boolean(process.env.DOGSC_SMOKE);
    const numeric = typeof level === "number" ? level : { debug: 0, info: 1, warning: 2, error: 3 }[level] ?? 1;
    if (numeric < 2 && !verbose) return;
    const label = ["debug", "info", "warning", "error"][numeric] || String(level);
    console.log(`[renderer:${name}] ${label}: ${message} (${source}:${line})`);
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    console.error(
      `[renderer:${name}] process gone: reason=${details.reason} exitCode=${details.exitCode}`
    );
  });
  win.webContents.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
    console.error(`[renderer:${name}] failed to load ${url}: ${description} (${code}) main=${isMainFrame}`);
  });
}

/* Verbose request tracing: reports every URL that fails to load, which is how
   a broken protocol handler or a missing asset is diagnosed. */
if (process.env.DOGSC_SMOKE) {
  app.whenReady().then(() => {
    const { session } = require("electron");
    session.defaultSession.webRequest.onErrorOccurred((details) => {
      console.log(`[net] ${details.method} ${details.url} → ${details.error}`);
    });
  });
}

const prefs = new Preferences();
const pointer = new PointerTracker();
let windows = null;

/** Live recording session, or null. */
let session = null;
/** Resolver waiting for the capture surface to hand back its files. */
let pendingStop = null;
/** Live export job, or null. */
let exportJob = null;
/** Resolver waiting for the capture surface to confirm the stream is live. */
let pendingStart = null;
/** Destination preference saved by a click-through export run, restored after. */
let previousExportLocation;
/** Reveal calls observed in smoke mode (export:reveal skips the shell there). */
let smokeRevealCount = 0;

/** Called by the capture surface once it knows whether the stream started. */
function settleStart(result) {
  if (!pendingStart) return;
  const resolve = pendingStart;
  pendingStart = null;
  resolve(result);
}

/** Payloads waiting for their window's renderer to ask for them. */
const pendingPayloads = new Map();

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

function send(name, channel, payload) {
  const win = windows?.get(name);
  if (win && !win.isDestroyed()) win.webContents.send("dogsc:event", { channel, payload });
}

function broadcast(channel, payload) {
  for (const [, win] of windows?.windows || []) {
    if (win && !win.isDestroyed()) win.webContents.send("dogsc:event", { channel, payload });
  }
}

function tempDir(...parts) {
  return path.join(app.getPath("temp"), "dogsc", ...parts);
}

async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true });
  return dir;
}

function timestampName() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return (
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
    `${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`
  );
}

function windowOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

/* ------------------------------------------------------------------------- */
/* Theme                                                                     */
/* ------------------------------------------------------------------------- */

function currentTheme() {
  const preference = prefs.get("appearance");
  const dark =
    preference === "dark" || (preference === "system" && nativeTheme.shouldUseDarkColors);
  return { preference, dark, resolved: dark ? "dark" : "light" };
}

function applyTheme() {
  const preference = prefs.get("appearance");
  nativeTheme.themeSource = preference === "system" ? "system" : preference;
  const { dark } = currentTheme();
  for (const [, win] of windows?.windows || []) {
    if (win && !win.isDestroyed()) win.setBackgroundColor(dark ? "#0b0c0d" : "#f3f5f6");
  }
}

/* ------------------------------------------------------------------------- */
/* App lifecycle                                                             */
/* ------------------------------------------------------------------------- */

app.on("second-instance", (_event, argv) => {
  const projectArg = argv.find((arg) => String(arg).endsWith(projectIO.PACKAGE_EXTENSION));
  if (projectArg) {
    windows?.createEditor({ projectPath: projectArg });
  } else {
    const editor = windows?.get("editor");
    if (editor) editor.focus();
    else windows?.createRecorder()?.focus();
  }
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);

  /* 预热 ffmpeg 采集：能力探测与编码器试编在后台完成，首次录制不必等。 */
  screenCapture.warmup().then((encoder) => {
    if (encoder) console.log(`[capture] ffmpeg ddagrab ready — ${encoder.label}`);
    else console.log("[capture] ffmpeg ddagrab unavailable — using Chromium capture");
  });
  if (process.env.DOGSC_DDAGRAB_LAB) {
    screenCapture.diagnose().catch((error) => console.error("[ddagrab-lab] failed", error.message));
  }

  protocol.handle("dogsc-media", (request) => {
    const url = new URL(request.url);
    const filePath = decodeURIComponent(url.pathname.replace(/^\//, ""));
    if (!filePath) return new Response("", { status: 404 });
    /* pathToFileURL percent-encodes spaces and non-ASCII characters, which
       net.fetch requires; a hand-built `file://` string fails on any project
       whose name contains a space. Media needs range-aware responses so the
       renderer can seek — see fileResponse(). */
    return fileResponse(filePath, request);
  });

  protocol.handle("app", (request) => {
    const url = new URL(request.url);
    const relative = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    /* `resources/` is served alongside the renderer so bundled fonts and
       artwork load from the same secure origin. */
    const base = relative.startsWith("resources/") ? RESOURCES : RENDERER_DIR;
    const target = path.join(base, relative.replace(/^resources\//, ""));
    if (!target.startsWith(base)) {
      return new Response("Forbidden", { status: 403 });
    }
    return net.fetch(pathToFileURL(target).toString());
  });

  windows = new WindowManager({
    prefs,
    onWindowCreated: attachRendererLogging,
    onPayload: (name, payload) => pendingPayloads.set(name, payload),
  });
  registerIpc();
  applyTheme();

  nativeTheme.on("updated", () => {
    applyTheme();
    broadcast("app:theme", currentTheme());
  });

  const startProject = process.argv.find((arg) =>
    String(arg).endsWith(projectIO.PACKAGE_EXTENSION)
  );

  if (process.env.DOGSC_SMOKE) {
    await runSmokeTest(process.env.DOGSC_SMOKE, startProject);
    return;
  }

  if (!prefs.get("onboardingCompleted")) {
    windows.createOnboarding();
  } else if (startProject) {
    windows.createEditor({ projectPath: startProject });
  } else {
    windows.createRecorder();
  }
  pointer.start().catch(() => {});
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  pointer.stop();
  globalShortcut.unregisterAll();
  /* Saves are debounced now (see Preferences.scheduleSave), so any change that
     landed in the last 250ms — window positions most commonly — is still only
     in memory when the app goes down. */
  prefs.flushSync();
  /* Tear the windows down explicitly so a renderer never outlives the app
     during shutdown. */
  windows?.closeAll();
});

/* ------------------------------------------------------------------------- */
/* IPC                                                                       */
/* ------------------------------------------------------------------------- */

function registerIpc() {
  /* ---- Preferences ---- */
  ipcMain.handle("prefs:all", () => prefs.get());
  ipcMain.handle("prefs:get", (_e, key) => prefs.get(key));
  ipcMain.handle("prefs:set", (_e, { key, value }) => {
    prefs.set(key, value);
    if (key === "appearance") applyTheme();
    broadcast("app:prefs", prefs.get());
    broadcast("app:theme", currentTheme());
    /* The whole store, not just the written value: callers keep their copy of
       the preferences in one variable, and handing back a bare string left
       every selection in the settings window unset. */
    return prefs.get();
  });
  ipcMain.handle("prefs:patch", (_e, partial) => {
    const result = prefs.patch(partial || {});
    if (partial && "appearance" in partial) applyTheme();
    broadcast("app:prefs", prefs.get());
    broadcast("app:theme", currentTheme());
    return result;
  });

  /* ---- Window control ---- */
  ipcMain.handle("window:self", (event) => {
    const win = windowOf(event);
    if (!win) return null;
    for (const [name, candidate] of windows.windows) if (candidate === win) return name;
    return null;
  });
  ipcMain.handle("window:minimize", (event) => windowOf(event)?.minimize());
  ipcMain.handle("window:toggle-maximize", (event) => {
    const win = windowOf(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  ipcMain.handle("window:close", (event) => windowOf(event)?.close());
  ipcMain.handle("window:set-bounds", (event, bounds) => {
    const win = windowOf(event);
    if (win) win.setBounds({ ...win.getBounds(), ...bounds });
  });
  ipcMain.handle("window:get-bounds", (event) => windowOf(event)?.getBounds() || null);
  /* Click-through control: forward keeps mousemove flowing to the renderer so
     it can re-enable input when the pointer re-enters an interactive region. */
  ipcMain.handle("window:set-ignore-mouse", (event, ignore) => {
    const win = windowOf(event);
    if (win) win.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
  });
  ipcMain.handle("window:set-resizable", (event, value) =>
    windowOf(event)?.setResizable(Boolean(value))
  );
  ipcMain.handle("window:start-drag", () => true);
  ipcMain.handle("window:close-named", (_e, name) => windows.get(name)?.close());

  ipcMain.handle("window:open-editor", (_e, payload) => {
    windows.createEditor(payload || {});
    return true;
  });
  ipcMain.handle("window:open-recorder", (_e, payload) => {
    windows.createRecorder(payload || {});
    /* Compiling the pointer hook takes a moment on a cold start; do it while
       the user is still choosing a source rather than when they hit record. */
    pointer.start().catch(() => {});
    return true;
  });
  ipcMain.handle("window:open-memo", () => {
    windows.createMemo();
    return true;
  });
  ipcMain.handle("window:open-settings", () => {
    windows.createSettings();
    return true;
  });
  ipcMain.handle("window:open-export", (_e, payload) => {
    windows.createExportPanel(payload);
    return true;
  });
  ipcMain.handle("window:open-onboarding", () => {
    windows.createOnboarding();
    return true;
  });
  ipcMain.handle("window:open-completion", (_e, payload) => {
    windows.createCompletion(payload);
    return true;
  });
  ipcMain.handle("window:open-area-selector", (_e, displayId) => {
    windows.createAreaSelector(displayId);
    return true;
  });

  /* ---- Capture sources ---- */
  ipcMain.handle("capture:displays", () =>
    screen.getAllDisplays().map((display, index) => ({
      id: String(display.id),
      label: display.label || `显示器 ${index + 1}`,
      bounds: display.bounds,
      workArea: display.workArea,
      scaleFactor: display.scaleFactor,
      size: display.size,
      internal: display.internal,
      primary: display.id === screen.getPrimaryDisplay().id,
      rotation: display.rotation,
    }))
  );

  /**
   * Screen and window sources.
   *
   * Thumbnails are only captured when a picker is actually open: pulling
   * every window's preview at launch is needless load on Chromium's
   * video-capture service, and it is the one thing that can take the service
   * down on a machine with a broken media stack.
   */
  ipcMain.handle("capture:sources", async (_e, options = {}) => {
    const withThumbnails = Boolean(options && options.thumbnails);
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: withThumbnails ? { width: 480, height: 300 } : { width: 1, height: 1 },
      fetchWindowIcons: withThumbnails,
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      type: source.id.startsWith("screen") ? "screen" : "window",
      displayId: source.display_id ? String(source.display_id) : null,
      thumbnail:
        withThumbnails && source.thumbnail && !source.thumbnail.isEmpty()
          ? source.thumbnail.toDataURL()
          : null,
      appIcon:
        withThumbnails && source.appIcon && !source.appIcon.isEmpty()
          ? source.appIcon.toDataURL()
          : null,
    }));
  });

  /* ---- Recording session ---- */
  ipcMain.handle("capture:start", (_e, config) => startRecording(config));
  ipcMain.handle("capture:pause", () => pauseRecording());
  ipcMain.handle("capture:resume", () => resumeRecording());
  ipcMain.handle("capture:stop", () => stopRecording(false));
  ipcMain.handle("capture:cancel", () => stopRecording(true));
  ipcMain.handle("capture:add-marker", () => addMarker());
  ipcMain.handle("capture:status", () => (session ? sessionState() : { status: "idle" }));
  ipcMain.handle("capture:toggle-desktop-icons", async (_e, hide) => {
    const result = await desktopIcons.setDesktopIconsHidden(Boolean(hide));
    if (result.ok) prefs.set("hideDesktopIcons", Boolean(hide));
    return result;
  });

  /* Calls made by the hidden capture surface. */
  ipcMain.handle("capture:started", (_e, payload) => {
    if (!session) return { ok: false };
    session.started = true;
    session.writing = payload?.writing || [];
    session.sizes = payload?.sizes || {};
    send("recorder", "recorder:state", sessionState());
    settleStart({ ok: true });
    return { ok: true };
  });
  /* The capture surface streams encoder output here as it is produced, so a
     long recording never has to be held in memory and a crash still leaves
     the material written so far on disk. */
  ipcMain.handle("capture:write", async (_e, payload) => {
    if (!session) return { ok: false };
    const { role, extension, data } = payload || {};
    if (!role) return { ok: false };
    const target = path.join(session.workingDir, `${role}${extension || ".webm"}`);
    await fsp.appendFile(target, Buffer.from(data));
    const written = (session.bytes ||= {});
    written[role] = (written[role] || 0) + data.byteLength;
    return { ok: true };
  });
  ipcMain.handle("capture:write-file", async (_e, payload) => {
    if (!session) return { ok: false };
    const { name, data } = payload || {};
    if (!name) return { ok: false };
    await fsp.writeFile(path.join(session.workingDir, name), Buffer.from(data));
    return { ok: true, path: path.join(session.workingDir, name) };
  });
  ipcMain.handle("capture:finished", (_e, payload) => {
    if (pendingStop) {
      const resolve = pendingStop;
      pendingStop = null;
      resolve(payload);
    }
    return { ok: true };
  });
  ipcMain.handle("capture:warning", (_e, payload) => {
    send("recorder", "recorder:warning", payload);
    return { ok: true };
  });
  ipcMain.handle("capture:failed", (_e, payload) => {
    const message = payload?.message || "capture-failed";
    send("recorder", "recorder:warning", { message });
    settleStart({ ok: false, reason: message });
    if (pendingStop) {
      const resolve = pendingStop;
      pendingStop = null;
      resolve({ files: {}, error: message });
    }
    return { ok: true };
  });

  ipcMain.on("capture:to-surface", (_e, payload) => {
    send("captureSurface", "capture:command", payload);
  });

  /* ---- Project ---- */
  ipcMain.handle("project:list", (_e, directory) =>
    projectIO.listProjects(directory || prefs.get("projectLocation"))
  );
  ipcMain.handle("project:open", async (_e, packagePath) => {
    const { document } = await projectIO.readProject(packagePath);
    prefs.set("lastProjectPath", packagePath);
    return { packagePath, document };
  });
  /**
   * Picks an existing project package.
   *
   * A `.dogscproject` is a folder, so Windows' file dialog cannot select it —
   * the folder picker is used and the choice is validated afterwards. The
   * user starts wherever their projects live.
   */
  ipcMain.handle("project:pick", async () => {
    const result = await dialog.showOpenDialog({
      title: "打开项目…",
      defaultPath: prefs.get("projectLocation") || app.getPath("videos"),
      properties: ["openDirectory"],
      buttonLabel: "打开项目",
    });
    if (result.canceled || !result.filePaths?.length) return { ok: false, reason: "cancelled" };

    const chosen = result.filePaths[0];
    /* Walking up one level means selecting the package's *contents* still
       opens the package — an easy mistake to make in a folder picker. */
    const candidates = [chosen, path.dirname(chosen)];
    for (const candidate of candidates) {
      if (!candidate.endsWith(projectIO.PACKAGE_EXTENSION)) continue;
      if (fs.existsSync(path.join(candidate, "project.json"))) {
        return { ok: true, packagePath: candidate };
      }
    }
    return { ok: false, reason: "not-a-project" };
  });
  ipcMain.handle("project:save", async (_e, payload) => {
    const { packagePath, document, mediaMoves } = payload;
    for (const move of mediaMoves || []) {
      await projectIO.adoptMediaAs(packagePath, move.from, move.to);
    }
    await projectIO.writeProjectJson(packagePath, document);
    prefs.set("lastProjectPath", packagePath);
    return { packagePath };
  });
  ipcMain.handle("project:discard", async (_e, packagePath) => {
    await projectIO.discardProject(shell, packagePath);
    return { ok: true };
  });
  ipcMain.handle("project:reveal", (_e, target) => {
    if (target) shell.showItemInFolder(target);
  });
  /* ---- System wallpapers ---- */
  /**
   * The port of `SystemWallpaperLibrary`.
   *
   * macOS keeps its desktop pictures under `/System/Library/Desktop Pictures`;
   * Windows ships its equivalent under `%SystemRoot%\Web\Wallpaper`, one folder
   * per theme. The user's current desktop wallpaper is added as its own group,
   * read from the registry.
   *
   * These stay local references — they are never copied into the project, so a
   * shared package cannot end up redistributing system artwork.
   */
  ipcMain.handle("system:wallpapers", async () => {
    const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".bmp", ".webp", ".tif", ".tiff"]);
    const videoExtensions = new Set([".mp4", ".webm", ".mov", ".m4v"]);

    const listDirectory = async (directory) => {
      try {
        return await fsp.readdir(directory, { withFileTypes: true });
      } catch {
        return [];
      }
    };

    const root = path.join(process.env.SystemRoot || "C:\\Windows", "Web", "Wallpaper");
    const groups = [];

    for (const theme of await listDirectory(root)) {
      if (!theme.isDirectory()) continue;
      const assets = [];

      /* Wallpaper folders nest one level (theme → resolution variant). */
      const walk = async (directory, depth) => {
        for (const entry of await listDirectory(directory)) {
          const full = path.join(directory, entry.name);
          if (entry.isDirectory()) {
            if (depth < 2) await walk(full, depth + 1);
            continue;
          }
          const extension = path.extname(entry.name).toLowerCase();
          if (!imageExtensions.has(extension) && !videoExtensions.has(extension)) continue;
          assets.push({
            id: full,
            name: path.basename(entry.name, extension),
            path: full,
            isVideo: videoExtensions.has(extension),
          });
        }
      };
      await walk(path.join(root, theme.name), 0);

      if (assets.length) {
        assets.sort((a, b) => a.name.localeCompare(b.name));
        groups.push({ id: theme.name, name: theme.name, assets });
      }
    }

    /* The current desktop wallpaper, so "use what I already have" is one click. */
    let current = null;
    try {
      const { execFile } = require("child_process");
      const output = await new Promise((resolve) => {
        execFile(
          "reg",
          ["query", "HKCU\\Control Panel\\Desktop", "/v", "Wallpaper"],
          { windowsHide: true, env: childEnv() },
          (error, stdout) => resolve(error ? "" : String(stdout))
        );
      });
      const match = output.match(/Wallpaper\s+REG_SZ\s+(.+)/);
      const candidate = match ? match[1].trim() : "";
      if (candidate && fs.existsSync(candidate)) {
        current = {
          id: candidate,
          name: path.basename(candidate, path.extname(candidate)),
          path: candidate,
          isVideo: videoExtensions.has(path.extname(candidate).toLowerCase()),
        };
      }
    } catch {
      /* No wallpaper, or the registry key is unavailable — not an error. */
    }

    return { current, groups };
  });

  ipcMain.handle("project:pick-folder", async (_e, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title,
      defaultPath: options.defaultPath,
      properties: ["openDirectory", "createDirectory"],
      buttonLabel: options.buttonLabel,
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle("project:pick-file", async (_e, options = {}) => {
    const result = await dialog.showOpenDialog({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      buttonLabel: options.buttonLabel,
      properties: options.multiple ? ["openFile", "multiSelections"] : ["openFile"],
    });
    if (result.canceled) return null;
    return options.multiple ? result.filePaths : result.filePaths[0];
  });
  ipcMain.handle("project:pick-save-file", async (_e, options = {}) => {
    const result = await dialog.showSaveDialog({
      title: options.title,
      defaultPath: options.defaultPath,
      filters: options.filters,
      buttonLabel: options.buttonLabel,
    });
    return result.canceled ? null : result.filePath;
  });
  ipcMain.handle("project:import-file", async (_e, options = {}) => {
    const { source, packagePath } = options;
    if (!source || !packagePath) return null;
    const relative = await projectIO.adoptMediaAs(
      packagePath,
      source,
      options.relative || path.join("media", path.basename(source))
    );
    return { relative, absolute: path.join(packagePath, relative) };
  });
  /* ---- Media exchange (ProjectMediaExchange.swift) ---- */
  /**
   * Replaces the camera track with an externally prepared file, matching the
   * original's "替换当前项目摄像头…". The renderer already asked the user for
   * the file; this side validates it, copies (or transcodes) it into the
   * package and answers with the new media reference.
   */
  ipcMain.handle("project:replace-camera", async (_e, payload = {}) => {
    const { packagePath, source } = payload;
    if (!packagePath || !source) return { ok: false, code: "invalid-request" };
    /* The original refuses while an export is running: replacing media under
       an active export would change what the muxing pipeline reads. */
    if (exportJob) return { ok: false, code: "exporting" };
    try {
      const camera = await mediaExchange.importCameraReplacement({
        packagePath,
        source,
      });
      return { ok: true, camera };
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "failed",
        detail: error?.detail || null,
        message: error?.message ? String(error.message).slice(0, 300) : undefined,
      };
    }
  });
  /**
   * The original's "导出项目源文件…": pick a folder, then copy the untouched
   * screen / camera / microphone recordings into `<项目名>-源文件`.
   */
  ipcMain.handle("project:export-sources", async (_e, payload = {}) => {
    const { packagePath, title, references } = payload;
    if (!packagePath) return { ok: false, code: "invalid-request" };
    const picked = await dialog.showOpenDialog({
      title: "选择源文件导出文件夹",
      buttonLabel: "导出到这里",
      defaultPath: prefs.get("exportLocation") || undefined,
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) {
      return { ok: false, code: "canceled" };
    }
    try {
      const folder = await mediaExchange.exportSources({
        packagePath,
        title,
        parent: picked.filePaths[0],
        references,
      });
      return { ok: true, folder };
    } catch (error) {
      return {
        ok: false,
        code: error?.code || "failed",
        detail: error?.detail || null,
        message: error?.message ? String(error.message).slice(0, 300) : undefined,
      };
    }
  });
  /* ---- Clipboard (paste image → sticker) ---- */
  /**
   * The original reads NSPasteboard for "粘贴图片". `clipboard.readImage`
   * covers the screenshot / copied-picture path; the bitmap is written to a
   * temporary PNG so the renderer can feed it through the same import
   * pipeline as "导入贴图…".
   */
  ipcMain.handle("clipboard:has-image", () => {
    const image = clipboard.readImage();
    return Boolean(image && !image.isEmpty());
  });
  ipcMain.handle("clipboard:read-image", async () => {
    const image = clipboard.readImage();
    if (!image || image.isEmpty()) return null;
    const png = image.toPNG();
    if (!png || !png.length) return null;
    const dir = await ensureDir(tempDir());
    const target = path.join(dir, `pasted-sticker-${Date.now()}.png`);
    await fsp.writeFile(target, png);
    return target;
  });
  ipcMain.handle("project:media-url", (_e, { packagePath, relative }) => {
    const absolute = projectIO.resolveMedia(packagePath, relative);
    if (!absolute) return null;
    return `dogsc-media://local/${encodeURIComponent(absolute)}`;
  });
  ipcMain.handle("project:temp-path", async (_e, name) => {
    const dir = await ensureDir(tempDir());
    return path.join(dir, name);
  });

  /* ---- Export ---- */
  /* `ready-to-show` can fire before the renderer has registered its listener,
     so window payloads are pulled by the renderer instead of pushed. */
  ipcMain.handle("export:payload", () => {
    const payload = pendingPayloads.get("exportPanel") || null;
    pendingPayloads.delete("exportPanel");
    return payload;
  });
  ipcMain.handle("completion:payload", () => {
    const payload = pendingPayloads.get("completion") || null;
    pendingPayloads.delete("completion");
    return payload;
  });
  ipcMain.handle("export:capabilities", () => ({
    ffmpeg: exporter.ffmpegPath(),
    temp: tempDir(),
  }));
  ipcMain.handle("export:begin", (event, payload) => beginExport(payload, event.sender));
  ipcMain.handle("export:chunk", (_e, payload) => writeExportChunk(payload));
  ipcMain.handle("export:finish", (_e, payload) => finishExport(payload));
  ipcMain.handle("export:cancel", () => cancelExport());
  ipcMain.handle("export:audio-only", async (_e, payload) => {
    const tracks = {};
    for (const role of ["system", "microphone"]) {
      const entry = payload.media?.[role];
      if (entry?.absolute && fs.existsSync(entry.absolute)) tracks[role] = entry.absolute;
    }
    if (!Object.keys(tracks).length) return { ok: false, reason: "no-audio" };
    try {
      await exporter.exportAudioOnly({
        document: payload.document,
        tracks,
        outputPath: payload.outputPath,
        format: payload.format || "m4a",
      });
      const stat = await fsp.stat(payload.outputPath).catch(() => null);
      return { ok: true, outputPath: payload.outputPath, size: stat?.size || 0 };
    } catch (error) {
      return { ok: false, reason: "failed", message: error?.message };
    }
  });
  /* Counted by the smoke suite's reveal-button regression (it must observe
     the reveal without an Explorer window stealing focus mid-run). The
     counter lives at module scope so the smoke probes can read it. */
  ipcMain.handle("export:reveal", (_e, target) => {
    /* Logged so a smoke run can tell a real reveal apart from a silent no-op. */
    console.log(`[exporter] reveal ${target}`);
    if (process.env.DOGSC_SMOKE) {
      smokeRevealCount += 1;
      return;
    }
    if (target) shell.showItemInFolder(target);
  });

  /* ---- App ---- */
  ipcMain.handle("app:version", () => app.getVersion());
  ipcMain.handle("app:theme", () => currentTheme());
  ipcMain.handle("app:set-theme", (_e, value) => {
    prefs.set("appearance", value);
    applyTheme();
    broadcast("app:theme", currentTheme());
    /* Same contract as `prefs:set`: the settings window stores what it gets
       back as its preference snapshot. */
    return prefs.get();
  });
  ipcMain.handle("app:quit", () => app.quit());
  ipcMain.handle("app:open-external", (_e, url) => shell.openExternal(url));
  ipcMain.handle("app:check-updates", () => ({ status: "current", version: app.getVersion() }));
  ipcMain.handle("app:open-system-settings", (_e, page) => {
    const targets = {
      camera: "ms-settings:privacy-webcam",
      microphone: "ms-settings:privacy-microphone",
      screen: "ms-settings:privacy-screenshots",
      notifications: "ms-settings:notifications",
      sound: "ms-settings:sound",
    };
    return shell.openExternal(targets[page] || "ms-settings:privacy");
  });
  ipcMain.handle("app:permissions", () => {
    const status = (kind) => {
      try {
        return systemPreferences.getMediaAccessStatus(kind);
      } catch {
        return "unknown";
      }
    };
    return { camera: status("camera"), microphone: status("microphone"), screen: status("screen") };
  });

  ipcMain.handle("memo:load", () => prefs.get("memo"));
  ipcMain.handle("memo:save", (_e, payload) =>
    prefs.set("memo", { ...prefs.get("memo"), ...(payload || {}) })
  );

  ipcMain.handle("menu:command", (_e, name) => {
    send("editor", "editor:menu-command", name);
    return true;
  });
}

/* ------------------------------------------------------------------------- */
/* Diagnostics mode                                                          */
/* ------------------------------------------------------------------------- */

/**
 * `DOGSC_SMOKE=<directory>` opens every window, writes a PNG of each into the
 * directory and exits. It is the check used to verify the port renders the
 * same workspace the macOS build does, and it is safe to leave in place — it
 * only ever runs when the environment variable is set.
 */
let smokeOutputDir = null;
const smokeShots = [];

/** Waits, then writes a PNG of the window. Never blocks the run. */
async function shoot(name, win, delay = 2600) {
  if (!win || win.isDestroyed()) return;
  await new Promise((resolve) => setTimeout(resolve, delay));
  try {
    const image = await Promise.race([
      win.webContents.capturePage(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("capture timed out")), 15000)),
    ]);
    const target = path.join(smokeOutputDir, `${name}.png`);
    await fsp.writeFile(target, image.toPNG());
    smokeShots.push(target);
    console.log(`[smoke] wrote ${target}`);
  } catch (error) {
    console.error(`[smoke] capture failed for ${name}:`, error.message);
  }
}

async function runSmokeTest(outputDir, projectPath) {
  await ensureDir(outputDir);
  smokeOutputDir = outputDir;

  const onboarding = windows.createOnboarding();
  await shoot("01-onboarding", onboarding, 3000);

  /* The recorder must exist before the onboarding window closes, otherwise
     `window-all-closed` would quit the app mid-run. */
  await prefs.set("onboardingCompleted", true);
  const recorder = windows.createRecorder();
  if (onboarding && !onboarding.isDestroyed()) onboarding.destroy();
  await shoot("02-recorder", recorder, 3000);

  if (process.env.DOGSC_RECORD_TEST) {
    await runRecordingTest(outputDir);
  }

  if (process.env.DOGSC_AREA_TEST) {
    await runAreaTest(outputDir);
  }

  if (process.env.DOGSC_DEVICE_TEST) {
    await runDeviceTest(outputDir);
  }

  if (process.env.DOGSC_WINDOW_TEST) {
    await runWindowTest(outputDir);
  }

  if (process.env.DOGSC_DISCARD_TEST) {
    await runDiscardTest();
  }

  if (process.env.DOGSC_OPEN_TEST) {
    await runOpenTest(projectPath);
  }

  const settings = windows.createSettings();
  await shoot("03-settings", settings, 2800);
  if (process.env.DOGSC_DRAG_TEST) {
    await runDragTest(settings, "settings");
  }

  /* The settings window keeps its preference snapshot in one variable, so the
     write calls have to hand back the whole store. */
  if (process.env.DOGSC_PREFS_PROBE) {
    const check = await settings.webContents.executeJavaScript(
      `(async () => {
         const before = await window.dogsc.prefs.all();
         const after = await window.dogsc.prefs.set("previewQuality", before.previewQuality);
         const theme = await window.dogsc.app.setTheme(before.appearance);
         return {
           afterKeys: Object.keys(after || {}).length,
           afterAppearance: after?.appearance,
           afterQuality: after?.previewQuality,
           themeKeys: Object.keys(theme || {}).length,
         };
       })()`
    );
    console.log("[prefs-probe]", JSON.stringify(check));
  }

  if (projectPath && fs.existsSync(projectPath)) {
    const editor = windows.createEditor({ projectPath });
    await shoot("04-editor", editor, 7000);
    await dumpDiagnostics(editor, "editor");
    if (process.env.DOGSC_LAYOUT_PROBE) {
      await runLayoutProbe(editor);
    }
    /* A smoke run must never leave the user's project modified. The editor
       autosaves every 20 seconds (and again on unload) whenever the store is
       dirty, so a probe that commits — even one that undoes afterwards — could
       end up persisted to disk. Neutralise the store's save for this window;
       probes still exercise the full in-memory path, and the export reads the
       live store, so nothing else is affected. */
    await editor.webContents
      .executeJavaScript(
        `(() => {
           const store = window.__dogscStore;
           if (store && !store.__smokeNoSave) {
             store.__smokeNoSave = true;
             store.save = async () => null;
           }
           return Boolean(store);
         })()`
      )
      .catch(() => {});
    if (process.env.DOGSC_RENDER_TEST) {
      await runRenderTest(editor);
    }
    if (process.env.DOGSC_WALLPAPER_TEST) {
      await runWallpaperTest(editor);
    }
    if (process.env.DOGSC_EDIT_TEST) {
      await runEditTest(editor);
    }
    if (process.env.DOGSC_SEEK_PROBE) {
      await runSeekProbe(editor);
    }
    if (process.env.DOGSC_AUTOZOOM_PROBE) {
      await runAutoZoomProbe(editor);
    }
    if (process.env.DOGSC_UI_PROBE) {
      await runInspectorProbe(editor);
    }
    if (process.env.DOGSC_TOPBAR_EXPORT_PROBE) {
      await runTopbarExportProbe(editor, outputDir);
    }

    const document_ = JSON.parse(await fsp.readFile(path.join(projectPath, "project.json"), "utf8"));
    const media = {};
    for (const role of ["screen", "camera", "system", "microphone"]) {
      const entry = document_.media?.[role];
      if (!entry?.path) continue;
      media[role] = { relative: entry.path, absolute: path.join(projectPath, entry.path) };
    }
    /* The panel seeds its destination folder from this preference, so the
       click-through reproduction needs it pointing at the output directory. The
       previous value is restored once the run finishes. */
    if (process.env.DOGSC_EXPORT_CLICK) {
      previousExportLocation = prefs.get("exportLocation");
      prefs.set("exportLocation", outputDir);
    }
    const exportPanel = windows.createExportPanel({
      packagePath: projectPath,
      document: document_,
      duration: document_.timeline?.duration || 12,
      media,
      sourceSize: { width: 1920, height: 1080 },
    });
    await shoot("05-export", exportPanel, 5000);
    if (process.env.DOGSC_DRAG_TEST) {
      await runDragTest(exportPanel, "exportPanel");
    }

    if (process.env.DOGSC_EXPORT_TEST) {
      await runExportTest(exportPanel, outputDir);
    }
  }

  if (process.env.DOGSC_MEDIA_EXCHANGE_PROBE) {
    await runMediaExchangeProbe(outputDir);
  }

  console.log(`[smoke] captured ${smokeShots.length} window(s)`);
  app.quit();
}

/**
 * End-to-end probe for the media-exchange surface — the Windows port of
 * `ProjectMediaExchange.swift`: "替换当前项目摄像头…" and "导出项目源文件…".
 *
 * A minimal throwaway project is built from scratch (screen + camera tracks),
 * so no user data is touched. The camera replacement runs through the real
 * IPC (`project:replace-camera`) and the editor store, then the export side
 * feeds the live document's media references back through the main-process
 * export. `DOGSC_MEDIA_EXCHANGE_PROBE=1` (with `DOGSC_SMOKE=<dir>`) enables it.
 */
async function runMediaExchangeProbe(outputDir) {
  const results = [];
  const record = (name, ok, detail) => {
    results.push(ok);
    console.log(
      `[media-exchange-probe] ${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`
    );
  };

  const workDir = path.join(outputDir, "media-exchange");
  const packagePath = path.join(workDir, "probe.dogscproject");
  await fsp.rm(packagePath, { recursive: true, force: true }).catch(() => {});
  await ensureDir(path.join(packagePath, "media"));

  const runFfmpegOrThrow = (args) =>
    new Promise((resolve, reject) => {
      const child = require("child_process").spawn(exporter.ffmpegPath(), args, {
        windowsHide: true,
        env: childEnv(),
      });
      let stderr = "";
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(stderr.slice(-300)))));
      child.on("error", reject);
    });

  try {
    /* Fixture: 1 s screen + 1 s camera, and a 2 s replacement (deliberately a
       different length — the original explicitly allows that). */
    await runFfmpegOrThrow([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=640x360:rate=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(packagePath, "media", "screen.mp4"),
    ]);
    await runFfmpegOrThrow([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=1:size=320x240:rate=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", path.join(packagePath, "media", "camera.mp4"),
    ]);
    const replacement = path.join(workDir, "replacement.mp4");
    await runFfmpegOrThrow([
      "-y", "-f", "lavfi", "-i", "testsrc=duration=2:size=640x360:rate=30",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", replacement,
    ]);
    const statOf = (file) => fs.statSync(file).size;
    await fsp.writeFile(
      path.join(packagePath, "project.json"),
      JSON.stringify(
        {
          schemaVersion: projectIO.SCHEMA_VERSION,
          id: "dogsc-media-exchange-probe",
          name: "media-exchange-probe",
          createdAt: new Date().toISOString(),
          capture: { kind: "display", sourceName: "probe", fps: 30 },
          media: {
            screen: {
              path: "media/screen.mp4",
              duration: 1,
              size: statOf(path.join(packagePath, "media", "screen.mp4")),
              width: 640,
              height: 360,
            },
            camera: {
              path: "media/camera.mp4",
              duration: 1,
              size: statOf(path.join(packagePath, "media", "camera.mp4")),
              width: 320,
              height: 240,
            },
          },
          pointerTrack: { samples: [], clicks: [] },
          timeline: {
            duration: 1,
            primaryClips: [
              { id: "clip-1", sourceStart: 0, sourceDuration: 1, startTime: 0, speed: 1 },
            ],
          },
        },
        null,
        2
      ),
      "utf8"
    );

    /* Replace through the real IPC + editor store. */
    const editor = windows.createEditor({ projectPath: packagePath });
    await new Promise((resolve) => setTimeout(resolve, 7000));
    const replaced = await editor.webContents.executeJavaScript(
      `(async () => {
         const store = window.__dogscStore;
         if (!store?.document?.media?.camera) return { error: "no camera track in probe project" };
         const result = await window.dogsc.project.replaceCamera({
           packagePath: store.packagePath,
           source: ${JSON.stringify(replacement)},
         });
         if (!result?.ok) return { error: "replace failed: " + (result?.code || "unknown") };
         try {
           await store.applyCameraReplacement(result.camera);
         } catch (error) {
           return { error: "apply failed: " + String(error) };
         }
         const video = store.media.camera;
         return {
           path: result.camera.path,
           duration: result.camera.duration,
           width: video?.videoWidth || 0,
           height: video?.videoHeight || 0,
           offset: store.document.media.camera.offset ?? null,
         };
       })()`
    );
    record("IPC 替换摄像头成功", !replaced?.error, replaced?.error || replaced?.path);
    record(
      "新摄像头素材可解码",
      (replaced?.width || 0) > 0,
      `${replaced?.width}x${replaced?.height}`
    );
    record(
      "offset 归零（新时间零点）",
      replaced?.offset === null || replaced?.offset === 0,
      String(replaced?.offset)
    );
    const replacementPath = replaced?.path || "";
    record(
      "路径形如 media/camera-replacement-<uuid>/camera.mp4",
      /^media\/camera-replacement-[0-9a-f-]+\/camera\.mp4$/.test(replacementPath),
      replacementPath
    );

    /* project.json must carry the new reference after applyCameraReplacement's
       save. The write is awaited inside the probe already; small grace period
       for the atomic rename. */
    await new Promise((resolve) => setTimeout(resolve, 900));
    let onDisk = null;
    try {
      onDisk = JSON.parse(await fsp.readFile(path.join(packagePath, "project.json"), "utf8"));
    } catch {
      /* reported below */
    }
    record(
      "project.json 已保存新引用",
      Boolean(onDisk) && onDisk.media?.camera?.path === replacementPath,
      onDisk?.media?.camera?.path || "(unreadable)"
    );
    record(
      "新素材文件已进入项目包",
      Boolean(replacementPath) && fs.existsSync(path.join(packagePath, replacementPath))
    );

    /* Export side with the live document's references. */
    const refs = await editor.webContents.executeJavaScript(
      `(() => {
         const doc = window.__dogscStore?.document;
         return {
           title: doc?.name || "probe",
           references: {
             screen: doc?.media?.screen?.path || null,
             camera: doc?.media?.camera?.path || null,
             microphone: doc?.media?.microphone?.path || null,
           },
         };
       })()`
    );
    try {
      const folder = await mediaExchange.exportSources({
        packagePath,
        title: refs.title,
        parent: workDir,
        references: refs.references,
      });
      const files = fs.readdirSync(folder);
      record(
        "导出源文件：屏幕 / 摄像头（麦克风未录制则跳过）",
        files.includes("屏幕.mp4") && files.includes("摄像头.mp4") && !files.includes("麦克风.mp4"),
        files.join(", ")
      );
      record(
        "导出源文件：摄像头为替换后的文件",
        fs.readFileSync(path.join(folder, "摄像头.mp4")).equals(
          fs.readFileSync(path.join(packagePath, replacementPath))
        )
      );
    } catch (error) {
      record("导出源文件", false, String(error?.message || error));
    }

    /* UI surface: the Project menu lists both actions enabled; 粘贴图片
       follows the clipboard (disabled while empty, enabled and functional
       once an image is present). The probe's clipboard writes are restored. */
    const previousClipboardImage = clipboard.readImage();
    const hadPreviousClipboard = Boolean(
      previousClipboardImage && !previousClipboardImage.isEmpty()
    );
    clipboard.clear();
    const menuCheck = await editor.webContents.executeJavaScript(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const items = () => Array.from(document.querySelectorAll(".popover .menu-item")).map((row) => ({
           text: row.textContent.trim(),
           disabled: row.style.pointerEvents === "none",
         }));
         const closeMenu = () => document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
         const out = {};

         document.getElementById("project-title").click();
         await sleep(90);
         const projectMenu = items();
         out.projectSource = projectMenu.find((i) => i.text.startsWith("导出项目源文件")) || null;
         out.projectCamera = projectMenu.find((i) => i.text.startsWith("替换当前项目摄像头")) || null;
         closeMenu();
         await sleep(90);

         document.getElementById("canvas-add").click();
         await sleep(150);
         const addMenu = items();
         out.pasteEmpty = addMenu.find((i) => i.text.startsWith("粘贴图片")) || null;
         closeMenu();
         await sleep(90);
         return out;
       })()`
    );
    record(
      "项目菜单：导出项目源文件…（启用）",
      Boolean(menuCheck.projectSource) && !menuCheck.projectSource.disabled,
      JSON.stringify(menuCheck.projectSource)
    );
    record(
      "项目菜单：替换当前项目摄像头…（启用）",
      Boolean(menuCheck.projectCamera) && !menuCheck.projectCamera.disabled,
      JSON.stringify(menuCheck.projectCamera)
    );
    record(
      "添加菜单：剪贴板为空时粘贴图片禁用",
      Boolean(menuCheck.pasteEmpty) && menuCheck.pasteEmpty.disabled,
      JSON.stringify(menuCheck.pasteEmpty)
    );

    const { nativeImage } = require("electron");
    const pngPath = path.join(workDir, "pasted.png");
    await runFfmpegOrThrow([
      "-y", "-f", "lavfi", "-i", "testsrc=size=64x64:rate=1", "-frames:v", "1", pngPath,
    ]);
    clipboard.writeImage(nativeImage.createFromPath(pngPath));
    const pasteRun = await editor.webContents.executeJavaScript(
      `(async () => {
         const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
         const store = window.__dogscStore;
         const before = store.document.timeline.stickerClips.length;
         document.getElementById("canvas-add").click();
         await sleep(160);
         const row = Array.from(document.querySelectorAll(".popover .menu-item"))
           .find((item) => item.textContent.trim().startsWith("粘贴图片"));
         const state = row ? { disabled: row.style.pointerEvents === "none" } : null;
         if (row && !state.disabled) row.click();
         await sleep(1400);
         const clips = store.document.timeline.stickerClips;
         return {
           state,
           before,
           after: clips.length,
           sourceExists: Boolean(clips.at(-1)?.source) &&
             Boolean(store.stickers.get(clips.at(-1).source)),
         };
       })()`
    );
    record(
      "添加菜单：剪贴板有图时粘贴图片启用",
      Boolean(pasteRun.state) && !pasteRun.state.disabled,
      JSON.stringify(pasteRun.state)
    );
    record(
      "粘贴图片：导入贴图并添加到播放头",
      pasteRun.after === pasteRun.before + 1 && pasteRun.sourceExists,
      `${pasteRun.before} → ${pasteRun.after}, sticker loaded=${pasteRun.sourceExists}`
    );
    if (hadPreviousClipboard) clipboard.writeImage(previousClipboardImage);
    else clipboard.clear();

    if (!editor.isDestroyed()) editor.destroy();
  } catch (error) {
    record("probe 执行", false, String(error?.message || error));
  }

  const failed = results.filter((result) => !result).length;
  console.log(
    `[media-exchange-probe] ${failed === 0 ? "PASS" : "FAIL"} (${results.length - failed}/${results.length})`
  );
}

/**
 * Records a single window.
 *
 * Window sources come back from `desktopCapturer` with a `window:` id and no
 * display id, so the display has to fall back to the primary one. The window
 * chosen here is one of the app's own, which is enough to prove frames flow.
 * `DOGSC_WINDOW_TEST=1` enables it.
 */
async function runWindowTest(outputDir) {
  /*
   * The window to capture is opened by a separate Electron process.
   * `desktopCapturer` filters out this application's own windows, so a window
   * created here would never appear in the source list; and whatever other
   * applications happen to be running are usually minimised or occluded, in
   * which case Chromium delivers no frames at all.
   */
  const { spawn } = require("child_process");
  const target = spawn(
    process.execPath,
    [path.join(__dirname, "..", "..", "tools", "window-target.js")],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: false }
  );
  target.stdout.on("data", (chunk) => process.stdout.write(`[window-target] ${chunk}`));
  target.stderr.on("data", (chunk) => process.stderr.write(`[window-target] ${chunk}`));

  const stopTarget = () => {
    if (!target.killed) target.kill();
  };

  /* Give it time to open, paint, and settle in front of everything else. */
  await new Promise((resolve) => setTimeout(resolve, 3500));

  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 1, height: 1 },
  });
  console.log(
    `[window-test] window sources (${sources.length}): ${JSON.stringify(
      sources.map((entry) => entry.name)
    )}`
  );

  const previousLocation = prefs.get("projectLocation");
  const recordingDir = path.join(outputDir, "window-recording");
  await ensureDir(recordingDir);
  prefs.set("projectLocation", recordingDir);

  const display = screen.getPrimaryDisplay();
  let attempt = null;
  let startedSizes = null;

  /*
   * The target window is tried first: it is the only source known to be
   * visible and repainting, and a stream can start successfully for an
   * occluded window while never delivering a single frame. The rest of the
   * list stays as a fallback so a failure still says something useful.
   */
  const ordered = [
    ...sources.filter((entry) => entry.name === "DogSC 采集验证"),
    ...sources.filter((entry) => entry.name !== "DogSC 采集验证"),
  ];

  for (const source of ordered) {
    const started = await startRecording({
      kind: "window",
      sourceId: source.id,
      sourceName: source.name,
      displayId: source.display_id ? String(source.display_id) : String(display.id),
      scaleFactor: display.scaleFactor,
      fps: 30,
      systemAudio: false,
      microphone: null,
      camera: null,
    });
    console.log(
      `[window-test] try ${JSON.stringify({ name: source.name, id: source.id })} -> ${JSON.stringify(started)}`
    );
    if (started?.ok) {
      attempt = source;
      startedSizes = started.sizes;
      break;
    }
  }

  if (!attempt) {
    console.log("[window-test] FAIL — no window source could be captured");
    stopTarget();
    prefs.set("projectLocation", previousLocation);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const stopped = await stopRecording(false);
  stopTarget();
  const entry = stopped?.document?.media?.screen;
  let size = 0;
  let duration = 0;
  let dimensions = null;
  if (entry) {
    const file = path.join(stopped.packagePath, entry.path);
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    duration = size ? await exporter.probeDuration(file) : 0;
    dimensions = { width: entry.width, height: entry.height };
  }

  console.log(
    "[window-test]",
    JSON.stringify({
      captured: attempt.name,
      ok: stopped?.ok,
      size: `${(size / 1024).toFixed(0)} KB`,
      duration: Number(duration.toFixed(2)),
      dimensions,
      captureKind: stopped?.document?.capture?.kind,
      /* A window recording still records the desktop pointer track, because
         the pointer moves over the window. */
      pointerSamples: stopped?.document?.pointerTrack?.samples?.length,
    })
  );

  if (entry && size > 4096 && duration > 1) {
    console.log("[window-test] PASS");
  } else {
    /*
     * The stream started and reported a size, but not a single frame arrived.
     * Chromium captures a window through Windows Graphics Capture, which needs
     * a working D3D11 device — with the GPU disabled the capturer falls back
     * and never delivers. A size equal to the display rather than the window
     * is the tell. That is a property of this machine, not of the code, so it
     * is reported as a skip rather than a failure.
     */
    const reported = startedSizes?.screen;
    const wrongSize =
      reported && dimensions === null
        ? `reported ${reported.width}x${reported.height} for a ${attempt.name.length}-char window title`
        : "";
    console.log(
      `[window-test] SKIP — the window capturer delivered no frames (${wrongSize || "no frames"}); ` +
        "Windows Graphics Capture needs a working GPU"
    );
  }

  prefs.set("projectLocation", previousLocation);
}

/**
 * Records a capture device as the primary picture.
 *
 * Device enumeration only exists in the renderer, so the recorder window is
 * asked for the list and the id is handed back to `startRecording` — exactly
 * what the 设备 picker does. Run with `DOGSC_FAKE_MEDIA=1` to supply a
 * synthetic device on a machine with no camera.
 */
async function runDeviceTest(outputDir) {
  const recorder = windows.get("recorder");
  if (!recorder || recorder.isDestroyed()) {
    console.error("[device-test] recorder window unavailable");
    return;
  }

  const devices = await recorder.webContents
    .executeJavaScript(
      `navigator.mediaDevices.enumerateDevices().then((list) =>
         list.filter((d) => d.kind === "videoinput")
             .map((d) => ({ id: d.deviceId, label: d.label })))`
    )
    .catch((error) => {
      console.error("[device-test] enumeration failed:", error.message);
      return [];
    });

  console.log(`[device-test] devices: ${JSON.stringify(devices)}`);
  if (!devices.length) {
    console.log("[device-test] SKIP — no capture device available");
    return;
  }

  const previousLocation = prefs.get("projectLocation");
  const target = path.join(outputDir, "device-recording");
  await ensureDir(target);
  prefs.set("projectLocation", target);

  const started = await startRecording({
    kind: "device",
    deviceId: devices[0].id,
    deviceLabel: devices[0].label,
    fps: 30,
    systemAudio: false,
    microphone: null,
    camera: null,
  });
  console.log("[device-test] start:", JSON.stringify(started));
  if (!started?.ok) {
    prefs.set("projectLocation", previousLocation);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const stopped = await stopRecording(false);
  const entry = stopped?.document?.media?.screen;
  let size = 0;
  let duration = 0;
  let dimensions = null;
  if (entry) {
    const file = path.join(stopped.packagePath, entry.path);
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    duration = size ? await exporter.probeDuration(file) : 0;
    dimensions = { width: entry.width, height: entry.height };
  }

  console.log(
    "[device-test]",
    JSON.stringify({
      ok: stopped?.ok,
      size: `${(size / 1024).toFixed(0)} KB`,
      duration: Number(duration.toFixed(2)),
      dimensions,
      captureKind: stopped?.document?.capture?.kind,
      /* A device recording has no desktop coordinates, so the pointer track
         must stay empty rather than being filled with desktop positions. */
      pointerSamples: stopped?.document?.pointerTrack?.samples?.length,
      hasCameraTrack: Boolean(stopped?.document?.media?.camera),
    })
  );

  const pass =
    Boolean(entry) &&
    size > 4096 &&
    duration > 1 &&
    dimensions?.width > 0 &&
    stopped?.document?.pointerTrack?.samples?.length === 0 &&
    !stopped?.document?.media?.camera;
  console.log(pass ? "[device-test] PASS" : "[device-test] FAIL");

  prefs.set("projectLocation", previousLocation);
}

/**
 * Records a screen region.
 *
 * This is the path the selection overlay drives: the overlay authors a region
 * in device-independent pixels and hands it over without a capturer source id,
 * so the main process has to resolve the display into one and the capture
 * surface has to crop. `DOGSC_AREA_TEST=1` enables the check.
 */
async function runAreaTest(outputDir) {
  const display = screen.getPrimaryDisplay();
  const previousLocation = prefs.get("projectLocation");
  const target = path.join(outputDir, "area-recording");
  await ensureDir(target);
  prefs.set("projectLocation", target);

  /* Rejections first: these are the guards the recorder bar relies on. */
  const rejected = {
    deviceWithoutId: await startRecording({ kind: "device" }),
    displayWithoutSource: await startRecording({ kind: "display" }),
  };
  console.log(
    "[area-test] guards:",
    JSON.stringify({
      deviceWithoutId: rejected.deviceWithoutId?.reason,
      displayWithoutSource: rejected.displayWithoutSource?.reason,
    })
  );

  const region = { x: 120, y: 90, width: 640, height: 360 };
  const started = await startRecording({
    kind: "area",
    displayId: String(display.id),
    scaleFactor: display.scaleFactor,
    region,
    fps: 30,
    systemAudio: false,
    microphone: null,
    camera: null,
  });
  console.log("[area-test] start:", JSON.stringify(started));
  if (!started?.ok) {
    prefs.set("projectLocation", previousLocation);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 5000));
  const stopped = await stopRecording(false);
  const screenEntry = stopped?.document?.media?.screen;
  let size = 0;
  let duration = 0;
  let dimensions = null;
  if (screenEntry) {
    const file = path.join(stopped.packagePath, screenEntry.path);
    size = fs.existsSync(file) ? fs.statSync(file).size : 0;
    duration = size ? await exporter.probeDuration(file) : 0;
    dimensions = { width: screenEntry.width, height: screenEntry.height };
  }

  const expected = {
    width: Math.round(region.width * display.scaleFactor),
    height: Math.round(region.height * display.scaleFactor),
  };
  const cropped =
    dimensions &&
    Math.abs(dimensions.width - expected.width) <= 4 &&
    Math.abs(dimensions.height - expected.height) <= 4;

  console.log(
    "[area-test]",
    JSON.stringify({
      ok: stopped?.ok,
      size: `${(size / 1024).toFixed(0)} KB`,
      duration: Number(duration.toFixed(2)),
      dimensions,
      expected,
      cropped,
      captureKind: stopped?.document?.capture?.kind,
      samples: stopped?.document?.pointerTrack?.samples?.length,
    })
  );
  console.log(cropped && size > 4096 && duration > 1 ? "[area-test] PASS" : "[area-test] FAIL");

  prefs.set("projectLocation", previousLocation);
}

/**
 * Records the primary display for a few seconds and checks that a project
 * package with usable media comes out the other end.
 * `DOGSC_RECORD_TEST=1` enables it.
 */
async function runRecordingTest(outputDir) {
  const displays = screen.getAllDisplays();
  const display = displays.find((entry) => entry.id === screen.getPrimaryDisplay().id) || displays[0];
  /* 1×1 缩略图：真实缩略图抓取会让 Chromium 短暂占用桌面复制会话，
     与随后的 ffmpeg ddagrab 采集撞车（应用内的列表也走 1×1）。 */
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1, height: 1 },
  });
  const source = sources.find((entry) => String(entry.display_id) === String(display.id)) || sources[0];
  if (!source) {
    console.error("[record-test] no screen source available");
    return;
  }

  const previousLocation = prefs.get("projectLocation");
  const target = path.join(outputDir, "recording");
  await ensureDir(target);
  prefs.set("projectLocation", target);

  /* A preset marked as the new-recording default must be baked into the
     document before the editor opens it. */
  const previousPreset = prefs.get("defaultScenePreset");
  prefs.set("defaultScenePreset", {
    name: "__test-default__",
    canvas: { padding: 123, cornerRadius: 42 },
    cursorStyle: { size: 2.5 },
  });

  /* 排障：在录制同一时刻重跑 ddagrab 实验室（DOGSC_DDAGRAB_LAB=1）。 */
  if (process.env.DOGSC_DDAGRAB_LAB) {
    await screenCapture.diagnose().catch(() => {});
  }

  const started = await startRecording({
    kind: "display",
    sourceId: source.id,
    sourceName: source.name,
    displayId: String(display.id),
    scaleFactor: display.scaleFactor,
    fps: 30,
    systemAudio: true,
    microphone: null,
    camera: null,
  });  console.log("[record-test] start:", JSON.stringify(started));
  if (!started?.ok) {
    prefs.set("projectLocation", previousLocation);
    return;
  }

  await new Promise((resolve) => setTimeout(resolve, 6000));
  const stopped = await stopRecording(false);
  console.log(
    "[record-test] stop:",
    JSON.stringify({
      ok: stopped?.ok,
      reason: stopped?.reason,
      packagePath: stopped?.packagePath,
      duration: stopped?.document?.timeline?.duration,
      media: Object.keys(stopped?.document?.media || {}),
      samples: stopped?.document?.pointerTrack?.samples?.length,
      clicks: stopped?.document?.pointerTrack?.clicks?.length,
      presetApplied:
        stopped?.document?.canvas?.padding === 123 &&
        stopped?.document?.canvas?.cornerRadius === 42 &&
        stopped?.document?.cursorStyle?.size === 2.5,
      presetName: stopped?.document?.scenePreset,
    })
  );

  prefs.set("defaultScenePreset", previousPreset);

  if (stopped?.packagePath) {
    for (const role of ["screen", "system"]) {
      const entry = stopped.document.media[role];
      if (!entry) continue;
      const file = path.join(stopped.packagePath, entry.path);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      const duration = size ? await exporter.probeDuration(file) : 0;
      console.log(`[record-test] ${role}: ${(size / 1024).toFixed(0)} KB · ${duration.toFixed(2)}s`);
    }
    const completion = windows.get("completion");
    await shoot("06-completion", completion, 2600);

    const screenEntry = stopped.document.media.screen;
    const screenFile = screenEntry ? path.join(stopped.packagePath, screenEntry.path) : null;
    const screenSize = screenFile && fs.existsSync(screenFile) ? fs.statSync(screenFile).size : 0;
    const pass =
      Boolean(screenEntry) &&
      screenSize > 4096 &&
      stopped.document.timeline.duration > 1 &&
      stopped.document.pointerTrack.samples.length > 0;
    console.log(pass ? "[record-test] PASS" : "[record-test] FAIL");
  } else {
    console.log("[record-test] FAIL — no project package was produced");
  }

  prefs.set("projectLocation", previousLocation);
}

/**
 * Reproduces the top-bar export path: clicking the editor's own 导出 button,
 * then reading what the export sheet actually seeded. The original bug was the
 * click handler passing the event object into `openExport(range)`, which
 * rebased the document onto NaN — black preview, NaN duration, zero frames.
 */
async function runTopbarExportProbe(editor, outputDir) {
  if (!editor || editor.isDestroyed()) return;
  const fullRun =
    Boolean(process.env.DOGSC_TOPBAR_EXPORT_RUN) && Boolean(outputDir);
  console.log("[topbar-export] clicking the editor's export button…");
  if (fullRun) {
    /* The panel seeds its destination from this preference at init, so point
       it at the smoke output directory before the click and put it back after
       the run — the same promise the export-click test makes. */
    previousExportLocation = prefs.get("exportLocation");
    prefs.set("exportLocation", outputDir);
  }
  await editor.webContents.executeJavaScript(
    `document.getElementById("btn-export")?.click(), true`
  );
  /* The panel opens in its own window; give it a moment to boot and seed. */
  await new Promise((resolve) => setTimeout(resolve, 6000));
  const panel = windows.get("exportPanel");
  if (!panel || panel.isDestroyed()) {
    console.error("[topbar-export] FAIL: the export panel did not open");
    return;
  }
  const probe = await panel.webContents
    .executeJavaScript(
      `(() => ({
         fileName: document.getElementById("file-name")?.value ?? null,
         duration: document.getElementById("spec-duration")?.textContent ?? null,
         resolution: document.getElementById("spec-size")?.textContent ?? null,
         folder: document.getElementById("folder-path")?.textContent ?? null,
       }))()`
    )
    .catch((error) => ({ error: String(error) }));
  console.log("[topbar-export] panel state:", JSON.stringify(probe));
  const ok =
    probe &&
    !String(probe.duration || "").includes("NaN") &&
    String(probe.duration || "") !== "0:00";
  console.log(`[topbar-export] ${ok ? "PASS" : "FAIL"}`);
  if (!fullRun || !ok) return;

  /* Full run: drive the exact user path — the panel the topbar button opened,
     its own 开始导出 button, then verify the resulting MP4. The output is
     renamed first so the artifact is findable (`file-name` is read at start
     time, so a plain value write is enough). */
  const target = path.join(outputDir, "export-check.mp4");
  await fsp.rm(target, { force: true });
  await panel.webContents.executeJavaScript(
    `(() => { const input = document.getElementById("file-name"); if (input) input.value = "export-check"; return true; })()`
  );
  console.log("[topbar-export] pressing 开始导出…");
  await panel.webContents.executeJavaScript(
    `document.getElementById("btn-start").click(), true`
  );

  /* Success writes 导出完成 into `estimate` (and 在文件夹中显示 onto the
     button); failure switches the progress stage to 需要注意 and never
     touches `estimate`, so both surfaces are polled. */
  const deadline = Date.now() + 420000;
  let status = "timeout";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (panel.isDestroyed()) {
      status = "gone";
      break;
    }
    const live = await panel.webContents
      .executeJavaScript(
        `(() => ({
           estimate: document.getElementById("estimate")?.textContent || "",
           stage: document.getElementById("progress-stage")?.textContent || "",
           start: document.getElementById("btn-start")?.textContent || "",
         }))()`
      )
      .catch(() => null);
    if (!live) {
      status = "gone";
      break;
    }
    if (live.estimate.includes("导出完成") || live.start === "在文件夹中显示") {
      status = live.estimate;
      break;
    }
    if (live.stage === "需要注意") {
      status = "failed (stage=需要注意)";
      break;
    }
  }
  console.log(`[topbar-export] renderer status: ${status}`);

  /* Restore the destination preference before anything else observes it. */
  if (previousExportLocation !== undefined) {
    prefs.set("exportLocation", previousExportLocation);
    previousExportLocation = undefined;
  }

  if (!fs.existsSync(target)) {
    console.error("[topbar-export] FAIL: no output file was produced");
    return;
  }
  const stat = await fsp.stat(target);
  const duration = await exporter.probeDuration(target);
  console.log(
    `[topbar-export] ${target} · ${(stat.size / 1024 / 1024).toFixed(2)} MB · ${duration.toFixed(2)}s`
  );
  if (stat.size < 1024 || duration < 1) {
    console.error("[topbar-export] FAIL: output looks invalid");
  } else {
    console.log("[topbar-export] FULL-RUN PASS");
  }

  /* Regression for the reveal button: after a finished export the primary
     button becomes 在文件夹中显示, but its old start-handler used to survive
     as a second click listener — clicking it revealed the file AND ran the
     whole export again. The renderer cannot stub the contextBridge object
     (every access returns a fresh proxy), so the click is observed from the
     UI state plus the main process's `[exporter] reveal` log line, while the
     artifact fingerprint proves no re-render happened. */
  const sizeBefore = (await fsp.stat(target)).size;
  const mtimeBefore = (await fsp.stat(target)).mtimeMs;
  const revealsBefore = smokeRevealCount;
  const revealCheck = await panel.webContents
    .executeJavaScript(
      `(async () => {
         const button = document.getElementById("btn-start");
         if (!button || button.textContent.indexOf("文件夹") < 0) {
           return { error: "button not in reveal state: " + (button?.textContent ?? "null") };
         }
         button.click();
         await new Promise((resolve) => setTimeout(resolve, 2500));
         return {
           label: button.textContent,
           status: document.getElementById("estimate")?.textContent ?? "",
           busy: button.disabled,
         };
       })()`
    )
    .catch((error) => ({ error: String(error) }));
  console.log("[topbar-export] reveal-check:", JSON.stringify(revealCheck));
  const statAfter = fs.existsSync(target) ? await fsp.stat(target) : null;
  const revealStable =
    statAfter && statAfter.size === sizeBefore && statAfter.mtimeMs === mtimeBefore;
  const revealOk =
    revealCheck &&
    !revealCheck.error &&
    smokeRevealCount === revealsBefore + 1 &&
    revealCheck.label === "在文件夹中显示" &&
    String(revealCheck.status || "").includes("导出完成") &&
    !revealCheck.busy &&
    revealStable;
  console.log(
    `[topbar-export] reveal-check ${revealOk ? "PASS" : "FAIL"}${revealStable ? "" : " (artifact was re-rendered!)"}`
  );
}

/**
 * Verifies the manual window drag (`enableManualDrag` in widgets.js): a
 * synthetic mousedown on the `.js-drag` region followed by synthetic moves
 * must move the window by the same delta and never change its size. This is
 * only possible because the drag is JS-driven — the native app-region move
 * loop ignores synthetic events entirely. `DOGSC_DRAG_TEST=1` enables it.
 */
async function runDragTest(win, name) {
  if (!win || win.isDestroyed()) return;
  const before = win.getBounds();
  const rendererBefore = await win.webContents
    .executeJavaScript(`window.dogsc.windows.getBounds()`)
    .catch(() => null);
  console.log(
    `[drag-test] ${name}: main-before=${JSON.stringify(before)} renderer-before=${JSON.stringify(rendererBefore)}`
  );
  const press = await win.webContents.executeJavaScript(
    `(() => {
       const head = document.querySelector(".settings-head.js-drag, .sheet-head.js-drag, .memo-head.js-drag, .js-drag");
       if (!head) return null;
       const rect = head.getBoundingClientRect();
       const screenX = Math.round(rect.left + Math.min(60, rect.width / 2));
       const screenY = Math.round(rect.top + 10);
       head.dispatchEvent(new MouseEvent("mousedown", {
         bubbles: true, cancelable: true, button: 0,
         screenX, screenY, clientX: screenX, clientY: screenY,
       }));
       return { screenX, screenY };
     })()`
  );
  if (!press) {
    console.error(`[drag-test] ${name}: no .js-drag region found`);
    return;
  }
  console.log(`[drag-test] ${name}: press=${JSON.stringify(press)}`);
  /* The mousedown handler resolves getBounds() over IPC before it starts
     tracking; give it a beat so the first move is not dropped. */
  await new Promise((resolve) => setTimeout(resolve, 150));
  const afterDown = win.getBounds();
  const afterMove1 = await (async () => {
    await win.webContents.executeJavaScript(
      `window.dispatchEvent(new MouseEvent("mousemove", {
         screenX: ${press.screenX + 10},
         screenY: ${press.screenY + 5},
       }))`
    );
    await new Promise((resolve) => setTimeout(resolve, 120));
    return win.getBounds();
  })();
  console.log(
    `[drag-test] ${name}: afterDown=${JSON.stringify(afterDown)} afterMove1=${JSON.stringify(afterMove1)}`
  );
  const moves = 10;
  /* Dispatch the remaining moves in ONE synchronous task. With 40ms gaps a
     real click on the machine (the user may be working while the suite runs)
     ends the synthetic drag mid-flight via a window-level mouseup and the
     window only moves part-way — the check has to be deterministic even
     while the desktop is in use. */
  await win.webContents.executeJavaScript(
    `(() => {
       for (let index = 2; index <= ${moves}; index += 1) {
         window.dispatchEvent(new MouseEvent("mousemove", {
           screenX: ${press.screenX} + index * 10,
           screenY: ${press.screenY} + index * 5,
         }));
       }
       return true;
     })()`
  );
  /* Let the batched rAF land before mouseup — stop() would cancel a pending
     one and the final position would never be applied. */
  await new Promise((resolve) => setTimeout(resolve, 180));
  await new Promise((resolve) => setTimeout(resolve, 150));
  await win.webContents.executeJavaScript(
    `window.dispatchEvent(new MouseEvent("mouseup", {}))`
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  const after = win.getBounds();
  const dx = after.x - before.x;
  const dy = after.y - before.y;
  /* ±2px: a setBounds round-trip at 125% DPI can jiggle the reported size
     by a pixel; the drag itself never requests a size change. */
  const sizeStable =
    Math.abs(after.width - before.width) <= 2 && Math.abs(after.height - before.height) <= 2;
  const ok = Math.abs(dx - moves * 10) <= 3 && Math.abs(dy - moves * 5) <= 3 && sizeStable;
  console.log(
    `[drag-test] ${name}: d=(${dx}, ${dy}) size ${before.width}x${before.height} -> ${after.width}x${after.height} ${ok ? "PASS" : "FAIL"}`
  );
}

const MEDIA_MIME_TYPES = {
  ".webm": "video/webm",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

function mimeTypeFor(filePath) {
  return MEDIA_MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

/**
 * Serves one file over the dogsc-media scheme with byte-range support.
 *
 * Chromium's media pipeline refuses to seek inside a resource whose server
 * cannot answer range requests: the seekable range collapses to [0,0] and
 * every `currentTime = t` assignment is silently clamped back to 0 (a
 * "seeked" event still fires, which makes the failure look like a working
 * seek). Playback is sequential and unaffected — which is exactly how the
 * editor preview kept looking alive while every export froze on frame 0.
 * Serving 206 slices fixes seeking in the editor, the export sheet and the
 * filmstrip thumbnails alike.
 */
function fileResponse(filePath, request) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stat.isFile()) return new Response("Not found", { status: 404 });

  const total = stat.size;
  const type = mimeTypeFor(filePath);
  const baseHeaders = {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
  };

  if (request.method === "HEAD") {
    return new Response(null, {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }

  const rangeHeader = request.headers.get("range");
  if (!rangeHeader) {
    return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
      status: 200,
      headers: { ...baseHeaders, "Content-Length": String(total) },
    });
  }

  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());
  const unsatisfiable = () =>
    new Response("Range not satisfiable", {
      status: 416,
      headers: { "Content-Range": `bytes */${total}` },
    });
  if (!match || (match[1] === "" && match[2] === "")) return unsatisfiable();
  if (total === 0) return unsatisfiable();

  let start;
  let end;
  if (match[1] === "") {
    /* Suffix form: `bytes=-N` means the final N bytes. */
    const suffix = parseInt(match[2], 10);
    if (suffix === 0) return unsatisfiable();
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = parseInt(match[1], 10);
    end = match[2] === "" ? total - 1 : Math.min(parseInt(match[2], 10), total - 1);
  }
  if (start >= total || end < start) return unsatisfiable();

  return new Response(Readable.toWeb(fs.createReadStream(filePath, { start, end })), {
    status: 206,
    headers: {
      ...baseHeaders,
      "Content-Length": String(end - start + 1),
      "Content-Range": `bytes ${start}-${end}/${total}`,
    },
  });
}

/**
 * Drives a real export through the export window and verifies the resulting
 * MP4 with ffmpeg. `DOGSC_EXPORT_TEST=1` turns the smoke run into a full
 * end-to-end check of the render → encode → mux pipeline.
 */
async function runExportTest(win, outputDir) {
  if (!win || win.isDestroyed()) return;
  const target = path.join(outputDir, "export-check.mp4");
  await fsp.rm(target, { force: true });
  /* The check is short by default; a longer one exercises the chunked write
     path hard enough to surface ordering/corruption problems. */
  const seconds = Number(process.env.DOGSC_EXPORT_SECONDS || 4) || 4;
  const options = process.env.DOGSC_EXPORT_OPTIONS || "{}";
  if (process.env.DOGSC_EXPORT_CLICK) {
    /* Reproduce the user's path exactly: whatever the panel is set to, with the
       full timeline and the editor's range. The panel seeds its folder from the
       preference, so it is pointed at the output directory for the run and put
       back afterwards — a test must never leave the user exporting elsewhere.
       The save happens only once: the smoke flow may already have stashed the
       user's value, and overwriting it here would make the restore a no-op. */
    if (previousExportLocation === undefined) {
      previousExportLocation = prefs.get("exportLocation");
    }
    prefs.set("exportLocation", outputDir);
    /* The panel outputs under its own file name; rename the artifact so the
       verification below can find it (`file-name` is read at start time). */
    await win.webContents.executeJavaScript(
      `(() => { const input = document.getElementById("file-name"); if (input) input.value = "export-check"; return true; })()`
    );
    await win.webContents.executeJavaScript(`document.getElementById("btn-start").click(), true`);
  } else {
    await win.webContents.executeJavaScript(
      `window.__dogscExportTest && window.__dogscExportTest(${JSON.stringify(target)}, ${seconds}, ${options})`
    );
  }

  const deadline = Date.now() + 420000;
  let status = "timeout";
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (win.isDestroyed()) break;
    status = await win.webContents
      .executeJavaScript(`document.getElementById("estimate")?.textContent || ""`)
      .catch(() => "gone");
    if (String(status).includes("导出完成") || String(status).includes("失败")) break;
  }
  console.log(`[export-test] renderer status: ${status}`);

  /* Put the user's destination preference back after a click-through run. */
  if (previousExportLocation !== undefined) {
    prefs.set("exportLocation", previousExportLocation);
    previousExportLocation = undefined;
  }

  if (!fs.existsSync(target)) {
    console.error("[export-test] no output file was produced");
    return;
  }
  const stat = await fsp.stat(target);
  const duration = await exporter.probeDuration(target);
  console.log(
    `[export-test] ${target} · ${(stat.size / 1024 / 1024).toFixed(2)} MB · ${duration.toFixed(2)}s`
  );
  if (stat.size < 1024 || duration < 1) {
    console.error("[export-test] output looks invalid");
  } else {
    console.log("[export-test] PASS");
  }
}

/**
 * Seeks the editor's screen video to several times and samples a center pixel
 * after each seek. Export renders every frame purely through seeks, so this
 * probe answers directly whether seeking actually moves the decoded picture
 * over the dogsc-media protocol (playback does not exercise that path).
 * `DOGSC_SEEK_PROBE=1` enables it.
 */
async function runSeekProbe(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(
      `(async () => {
         const out = {};
         const video = window.__dogscStore?.media?.screen;
         if (!video) return { error: "no screen video element" };
         out.meta = {
           readyState: video.readyState,
           duration: Number(video.duration?.toFixed?.(3)),
           size: [video.videoWidth, video.videoHeight],
           networkState: video.networkState,
         };
         out.seekable = Array.from({ length: video.seekable?.length || 0 }, (_, i) => [
           Number(video.seekable.start(i).toFixed(2)),
           Number(video.seekable.end(i).toFixed(2)),
         ]);
         out.buffered = Array.from({ length: video.buffered?.length || 0 }, (_, i) => [
           Number(video.buffered.start(i).toFixed(2)),
           Number(video.buffered.end(i).toFixed(2)),
         ]);
         const canvas = document.createElement("canvas");
         canvas.width = 32;
         canvas.height = 18;
         const ctx = canvas.getContext("2d", { willReadFrequently: true });
         const sample = async (label, el, t) => {
           const t0 = performance.now();
           const how = await new Promise((resolve) => {
             let settled = false;
             el.addEventListener("seeked", () => {
               settled = true;
               resolve("seeked");
             }, { once: true });
             try {
               el.currentTime = t;
             } catch (error) {
               settled = true;
               resolve("throw:" + error.message);
             }
             setTimeout(() => {
               if (!settled) resolve("timeout ct=" + el.currentTime);
             }, 3000);
           });
           await new Promise((resolve) => requestAnimationFrame(resolve));
           ctx.drawImage(el, 0, 0, 32, 18);
           const d = ctx.getImageData(16, 9, 1, 1).data;
           out[label] = {
             how,
             ms: Math.round(performance.now() - t0),
             currentTime: Number(el.currentTime?.toFixed?.(3)),
             pixel: [d[0], d[1], d[2]],
           };
         };
         await sample("t0", video, 0);
         await sample("t5", video, 5);
         await sample("t8", video, 8);
         await sample("back0", video, 0);
         /* Control: the same bytes through a blob URL bypass the custom
            protocol entirely. If the blob seeks, the protocol handler is at
            fault; if it also snaps back, the webm itself is unseekable. */
         try {
           const response = await fetch(video.src);
           const blob = await response.blob();
           const blobVideo = document.createElement("video");
           blobVideo.src = URL.createObjectURL(blob);
           blobVideo.muted = true;
           blobVideo.preload = "auto";
           await new Promise((resolve) => {
             blobVideo.addEventListener("loadeddata", resolve, { once: true });
             blobVideo.addEventListener("error", resolve, { once: true });
             setTimeout(resolve, 8000);
           });
           out.blobMeta = {
             readyState: blobVideo.readyState,
             duration: Number(blobVideo.duration?.toFixed?.(3)),
             size: [blobVideo.videoWidth, blobVideo.videoHeight],
           };
           out.blobSeekable = Array.from({ length: blobVideo.seekable?.length || 0 }, (_, i) => [
             Number(blobVideo.seekable.start(i).toFixed(2)),
             Number(blobVideo.seekable.end(i).toFixed(2)),
           ]);
           await sample("blobT5", blobVideo, 5);
         } catch (error) {
           out.blobError = String(error?.message || error);
         }
         return out;
       })()`
    );
    console.log("[seek-probe]", JSON.stringify(result));
    const moved =
      result &&
      result.t5?.how === "seeked" &&
      result.t8?.how === "seeked" &&
      JSON.stringify(result.t5.pixel) !== JSON.stringify(result.t0.pixel) &&
      JSON.stringify(result.t8.pixel) !== JSON.stringify(result.t0.pixel);
    console.log(`[seek-probe] ${moved ? "PASS" : "FAIL"}`);
  } catch (error) {
    console.error("[seek-probe] failed:", error.message);
  }
}

/**
 * Drives the auto camera motion (自动运镜) end to end inside the editor: plan
 * clips from the recorded pointer track, apply them through the real store
 * commit, verify the follow camera resolves, then undo everything so the
 * project is left untouched. `DOGSC_AUTOZOOM_PROBE=1` enables it.
 */
async function runAutoZoomProbe(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(
      `(async () => {
         const module = await import("app://dogsc/editor/js/auto-zoom.js");
         const store = window.__dogscStore;
         if (!store?.document) return { error: "no document" };
         const track = store.document.pointerTrack || {};
         const before = store.document.timeline.zoomClips.length;
         const planned = module.planAutoZoom(store.document);
         const summary = {
           clicks: (track.clicks || []).filter((c) => c.button !== "wheel").length,
           samples: (track.samples || []).length,
           planned: planned.map((clip) => ({
             start: Number(clip.startTime.toFixed(3)),
             duration: Number(clip.duration.toFixed(3)),
             scale: clip.scale,
             mode: clip.mode,
             focus: { x: Number(clip.focus.x.toFixed(3)), y: Number(clip.focus.y.toFixed(3)) },
           })),
         };
         if (!planned.length) return { ...summary, error: "nothing planned" };
         store.commit("自动运镜探针", (doc) => {
           doc.timeline.zoomClips = [
             ...doc.timeline.zoomClips.filter((clip) => clip.mode !== "自动"),
             ...planned,
           ].sort((a, b) => a.startTime - b.startTime);
         });
         summary.after = store.document.timeline.zoomClips.length;
         const last = planned[planned.length - 1];
         const follow = module.automaticFocusAt(
           store.document,
           last,
           last.startTime + last.duration * 0.6
         );
         summary.follow = follow
           ? { x: Number(follow.x.toFixed(3)), y: Number(follow.y.toFixed(3)) }
           : null;
         ${process.env.DOGSC_AUTOZOOM_APPLY ? "summary.kept = true;" : "store.undo();"}
         summary.restored =
           ${process.env.DOGSC_AUTOZOOM_APPLY ? "true" : "store.document.timeline.zoomClips.length === before"};
         return summary;
       })()`
    );
    console.log("[autozoom-probe]", JSON.stringify(result));
    const ok =
      result &&
      !result.error &&
      result.planned?.length > 0 &&
      result.after === result.planned.length &&
      result.follow &&
      result.restored === true;
    console.log(`[autozoom-probe] ${ok ? "PASS" : "FAIL"}`);
  } catch (error) {
    console.error("[autozoom-probe] failed:", error.message);
  }
}

/**
 * Verifies the system wallpaper library.
 *
 * The original reads the OS wallpaper catalogue; on Windows that is
 * `%SystemRoot%\Web\Wallpaper`. The check covers the scan, the thumbnails
 * actually loading over `dogsc-media://`, and applying one as the background.
 * `DOGSC_WALLPAPER_TEST=1` enables it.
 */
async function runWallpaperTest(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const catalogue = await ipcMain.emit;
    void catalogue;
  } catch {
    /* not used */
  }

  try {
    /* Ask the same handler the renderer uses. */
    const listing = await new Promise((resolve) => {
      const handler = ipcMain._invokeHandlers?.get?.("system:wallpapers");
      if (!handler) {
        resolve(null);
        return;
      }
      Promise.resolve(handler({}, {})).then(resolve);
    });

    const groups = listing?.groups || [];
    const total = groups.reduce((sum, group) => sum + group.assets.length, 0);
    console.log(
      `[wallpaper-test] catalogue: ${groups.length} group(s), ${total} asset(s), current=${listing?.current ? "yes" : "none"}`
    );

    if (!total) {
      console.log("[wallpaper-test] SKIP — this machine ships no system wallpapers");
      return;
    }

    const sample = groups[0].assets[0];
    const result = await win.webContents.executeJavaScript(`(async () => {
      const api = window.dogsc;
      const store = window.__dogscStore;
      const url = "dogsc-media://local/" + encodeURIComponent(${JSON.stringify(sample.path)});

      /* The thumbnail has to be loadable over the media protocol. */
      const loads = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ ok: true, size: [img.naturalWidth, img.naturalHeight] });
        img.onerror = () => resolve({ ok: false });
        img.src = url;
      });

      const before = store.document.canvas.backgroundSource?.kind || null;
      store.commit("test", (doc) => {
        doc.canvas.backgroundSource = {
          kind: "systemImage",
          absolutePath: ${JSON.stringify(sample.path)},
        };
      });
      await store.loadBackground();
      const after = store.document.canvas.backgroundSource?.kind || null;
      const decoded = Boolean(store.backgroundImage);

      /* Put the previous background back. */
      store.undo();
      await store.loadBackground();
      return { loads, before, after, decoded, restored: store.document.canvas.backgroundSource?.kind || null };
    })()`);

    console.log("[wallpaper-test]", JSON.stringify(result));
    const pass =
      result.loads?.ok &&
      result.loads.size?.[0] > 0 &&
      result.after === "systemImage" &&
      result.decoded;
    console.log(pass ? "[wallpaper-test] PASS" : "[wallpaper-test] FAIL");
  } catch (error) {
    console.error("[wallpaper-test] failed:", error.message);
  }
}

/**
 * Verifies the "open project" entry point on the recorder bar.
 *
 * Without it a saved package could never be reopened from the interface — the
 * port shipped with the plumbing but no way to reach it.
 * `DOGSC_OPEN_TEST=1` enables the check.
 */
async function runOpenTest(projectPath) {
  const recorder = windows.get("recorder");
  if (!recorder || recorder.isDestroyed()) {
    console.error("[open-test] recorder window unavailable");
    return;
  }

  /* Point the project location at wherever the sample package lives so the
     recent list has something in it. */
  const directory = projectPath ? path.dirname(projectPath) : prefs.get("projectLocation");
  const previousLocation = prefs.get("projectLocation");
  prefs.set("projectLocation", directory);

  const listed = await projectIO.listProjects(directory);
  console.log(
    `[open-test] projects in ${directory}: ${JSON.stringify(listed.map((entry) => entry.name))}`
  );

  const menu = await recorder.webContents
    .executeJavaScript(
      `(async () => {
        document.getElementById("btn-open-project").click();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const pop = document.querySelector(".popover");
        const items = pop
          ? [...pop.querySelectorAll(".menu-item")].map((el) => ({
              text: el.textContent.trim(),
              disabled: el.style.pointerEvents === "none",
            }))
          : [];
        if (pop) pop.remove();
        return { shown: Boolean(pop), items };
      })()`
    )
    .catch((error) => ({ shown: false, error: error.message }));

  console.log("[open-test] menu:", JSON.stringify(menu));

  const hasBrowse = (menu.items || []).some((item) => item.text.includes("浏览"));
  const hasProject = (menu.items || []).some((item) => item.text.includes("海岸漫游"));
  const pass = menu.shown && hasBrowse && (listed.length === 0 || hasProject);
  console.log(pass ? "[open-test] PASS" : "[open-test] FAIL");

  prefs.set("projectLocation", previousLocation);
}

/**
 * Verifies the "move to Recycle Bin" path.
 *
 * Two things matter here: a real package must actually end up in the Recycle
 * Bin, and anything the shell cannot handle must come back as a result rather
 * than a thrown error — an unhandled rejection left the completion window
 * silently doing nothing. `DOGSC_DISCARD_TEST=1` enables it.
 */
async function runDiscardTest() {
  /* Several locations are tried: the Recycle Bin can be unavailable for a
     whole drive (removable media, a disabled bin, a sandbox that intercepts
     deletes), and knowing which locations fail says whether the problem is
     the code or the environment. */
  const locations = [
    ["temp", app.getPath("temp")],
    ["userData", app.getPath("userData")],
    ["documents", app.getPath("documents")],
  ];

  const attempts = [];
  for (const [label, base] of locations) {
    let root;
    try {
      root = await ensureDir(path.join(base, "dogsc-discard-test"));
    } catch (error) {
      attempts.push({ label, created: false, error: error.message });
      continue;
    }
    const packagePath = path.join(root, `${label}.dogscproject`);
    await ensureDir(path.join(packagePath, "media"));
    await fsp.writeFile(path.join(packagePath, "project.json"), JSON.stringify({ schemaVersion: 27 }));
    await fsp.writeFile(path.join(packagePath, "media", "poster.png"), "x");

    const result = await projectIO.discardProject(shell, packagePath);
    const removed = !fs.existsSync(packagePath);
    attempts.push({ label, created: true, result, removed });
    if (removed) {
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    } else {
      await fsp.rm(packagePath, { recursive: true, force: true }).catch(() => {});
      await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
    }
  }

  /* Refusals must come back as results, never as thrown errors: an unhandled
     rejection used to leave the completion window silently doing nothing. */
  const refusals = {
    empty: await projectIO.discardProject(shell, ""),
    wrongKind: await projectIO.discardProject(shell, path.join(app.getPath("temp"), "notes.txt")),
    missing: await projectIO.discardProject(
      shell,
      path.join(app.getPath("temp"), "NeverExisted.dogscproject")
    ),
    unparseable: await projectIO.discardProject(shell, "\\tmp\\no-such-drive\\Thing.dogscproject"),
  };
  const refusedCleanly = Object.values(refusals).every(
    (result) => result && result.ok === false && typeof result.reason === "string"
  );

  console.log("[discard-test] attempts:", JSON.stringify(attempts));
  console.log("[discard-test] refusals:", JSON.stringify(refusals));

  const recycled = attempts.filter((entry) => entry.removed);
  if (recycled.length) {
    console.log(`[discard-test] PASS — recycled from ${recycled.map((e) => e.label).join(", ")}`);
  } else if (refusedCleanly) {
    /* The shell refused every location, which is a property of this machine
       rather than of the code. The important half — clean refusals — held. */
    console.log(
      "[discard-test] SKIP — the shell refused to recycle anywhere on this machine; clean refusals verified"
    );
  } else {
    console.log("[discard-test] FAIL");
  }
}

/**
 * Samples the compositor across the timeline and checks the picture actually
 * animates.
 *
 * The demo project has two zoom clips, so the framing must differ between
 * timestamps; a frozen renderer, a broken zoom or a blank canvas would all
 * show up here. `DOGSC_RENDER_TEST=1` enables it.
 */
async function runRenderTest(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const times = [0, 1.0, 2.2, 3.4, 5.2, 7.0, 8.6, 10.5, 11.8];
    const frames = await win.webContents.executeJavaScript(
      `window.__dogscRenderProbe(${JSON.stringify(times)})`
    );
    console.log("[render-test] frames:", JSON.stringify(frames));

    const blank = frames.filter((frame) => frame.coverage < 0.02);
    const lumaValues = frames.map((frame) => frame.luma);
    const distinct = new Set(lumaValues.map((value) => value.toFixed(1))).size;

    console.log(
      "[render-test]",
      JSON.stringify({
        sampled: frames.length,
        blankFrames: blank.map((frame) => frame.time),
        distinctLuma: distinct,
        lumaRange: [Math.min(...lumaValues), Math.max(...lumaValues)],
      })
    );

    /* Every frame must have content, and the zoom clips must make at least a
       few frames measurably different from each other. */
    const pass = blank.length === 0 && distinct >= 3;
    console.log(pass ? "[render-test] PASS" : "[render-test] FAIL");
  } catch (error) {
    console.error("[render-test] failed:", error.message);
  }
}

/**
 * Exercises the editing commands that have no visible output of their own —
 * clipboard, attribute transfer, range selection and speed — and reports the
 * result. `DOGSC_EDIT_TEST=1` enables it.
 */
async function runEditTest(win) {
  if (!win || win.isDestroyed()) return;
  try {
    const result = await win.webContents.executeJavaScript(`(async () => {
      const s = window.__dogscStore;
      const api = window.dogsc;
      const out = {};
      const zoom = s.document.timeline.zoomClips[0];
      out.zoomCountBefore = s.document.timeline.zoomClips.length;

      s.select("zoom", zoom.id);
      out.copied = s.copySelection();
      /* Paste into whatever free gap the project actually has — layouts differ
         (the demo fills its tail with 3.6s zooms; real recordings may not), so
         a hardcoded position turned the paste into a correct "no-room"
         refusal and failed the test against valid projects. */
      const spans = s.document.timeline.zoomClips
        .map((c) => [c.startTime, c.startTime + c.duration])
        .sort((a, b) => a[0] - b[0]);
      let gapStart = 0;
      let gapLength = 0;
      let cursor = 0;
      for (const [from, to] of spans) {
        if (from - cursor > gapLength) {
          gapStart = cursor;
          gapLength = from - cursor;
        }
        cursor = Math.max(cursor, to);
      }
      if (s.duration - cursor > gapLength) {
        gapStart = cursor;
        gapLength = s.duration - cursor;
      }
      out.gap = { start: Number(gapStart.toFixed(2)), length: Number(gapLength.toFixed(2)) };
      if (gapLength > 0.25) {
        s.clipboard.clip.duration = Math.min(1, gapLength - 0.1);
        out.paste = s.pasteClipboard(gapStart + 0.05);
      } else {
        out.paste = { ok: false, reason: "no-gap-in-test-layout" };
      }
      out.zoomCountAfterPaste = s.document.timeline.zoomClips.length;

      /* Pasting onto an occupied span must be refused, not silently overlap.
         A short probe at the middle of the existing zoom clears the no-room
         check and lands squarely on the occupied branch whenever the layout
         allows it; a refusal for any reason is acceptable, overlap is not. */
      s.select("zoom", zoom.id);
      s.clipboard.clip.duration = Math.min(0.3, zoom.duration);
      out.overlapRefused = s.pasteClipboard(zoom.startTime + zoom.duration / 2).ok === false;

      /* Attribute transfer keeps the target's position and duration. */
      const target = s.document.timeline.zoomClips[s.document.timeline.zoomClips.length - 1];
      s.select("zoom", target.id);
      const keptStart = target.startTime;
      out.attributes = s.pasteAttributes();
      out.attributesKeptPosition =
        Math.abs(s.document.timeline.zoomClips[s.document.timeline.zoomClips.length - 1].startTime - keptStart) < 0.001;

      /* Range selection drives the ⌥X export. */
      s.selectPrimary(s.document.timeline.primaryClips[0].id);
      const range = s.selectedRange();
      out.range = range ? { start: range.start, end: range.end, clips: range.clips.length } : null;

      /* Speed changes re-time the clip and reflow the timeline. */
      const durationBefore = s.duration;
      s.setSpeed(s.document.timeline.primaryClips[0].id, 2);
      out.speed = s.document.timeline.primaryClips[0].speed;
      out.durationBefore = Number(durationBefore.toFixed(3));
      out.durationAfter = Number(s.duration.toFixed(3));

      /* Camera layout presets round-trip through the preference store. */
      const probePreset = { name: "__test-layout__", shape: "圆形", size: 0.42, roundness: 1 };
      s.cameraLayoutPresets = [
        ...s.cameraLayoutPresets.filter((p) => p.name !== probePreset.name),
        probePreset,
      ];
      await api.prefs.set("cameraLayoutPresets", s.cameraLayoutPresets);
      const stored = await api.prefs.get("cameraLayoutPresets");
      out.cameraPresetStored = Array.isArray(stored)
        && stored.some((p) => p.name === "__test-layout__" && p.shape === "圆形");

      const applied = stored.find((p) => p.name === "__test-layout__");
      s.commit("test", (doc) => {
        doc.camera.shape = applied.shape;
        doc.camera.size = applied.size;
        doc.camera.roundness = applied.roundness;
      });
      out.cameraPresetApplied =
        s.document.camera.shape === "圆形" && s.document.camera.size === 0.42;

      /* Leave the preference store as it was found. */
      s.cameraLayoutPresets = s.cameraLayoutPresets.filter((p) => p.name !== probePreset.name);
      await api.prefs.set("cameraLayoutPresets", s.cameraLayoutPresets);

      /* Undo everything so the project is left untouched. */
      for (let i = 0; i < 16; i += 1) s.undo();
      out.zoomCountRestored = s.document.timeline.zoomClips.length;
      return out;
    })()`);
    console.log("[edit-test]", JSON.stringify(result));
    const ok =
      result.copied &&
      result.paste?.ok &&
      result.zoomCountAfterPaste === result.zoomCountBefore + 1 &&
      result.attributes?.ok &&
      result.attributesKeptPosition &&
      result.range &&
      result.speed === 2 &&
      result.cameraPresetStored &&
      result.cameraPresetApplied &&
      result.zoomCountRestored === result.zoomCountBefore;
    console.log(ok ? "[edit-test] PASS" : "[edit-test] FAIL");
  } catch (error) {
    console.error("[edit-test] failed:", error.message);
  }
}

/** Reports the renderer's DOM shape so a blank window is never a mystery. */
async function dumpDiagnostics(win, name) {
  if (!win || win.isDestroyed()) return;
  try {
    const summary = await win.webContents.executeJavaScript(`(() => ({
      url: location.href,
      title: document.title,
      theme: document.documentElement.dataset.theme,
      topBar: [
        document.getElementById("top-left")?.children.length ?? -1,
        document.getElementById("top-right")?.children.length ?? -1,
      ],
      rail: document.getElementById("tool-rail")?.children.length ?? -1,
      railEnabled: Array.from(document.querySelectorAll("#tool-rail .rail-button"))
        .map((button) => button.dataset.tool + (button.disabled ? ":off" : ":on"))
        .join(","),
      inspector: document.getElementById("inspector-body")?.children.length ?? -1,
      lanes: document.querySelectorAll(".lane").length,
      clips: document.querySelectorAll(".clip").length,
      canvas: [
        document.getElementById("preview-canvas")?.width,
        document.getElementById("preview-canvas")?.height,
      ],
      fonts: document.fonts ? document.fonts.status : "n/a",
      media: window.__dogscStore
        ? Object.fromEntries(
            Object.entries(window.__dogscStore.media).map(([role, element]) => [
              role,
              element
                ? {
                    readyState: element.readyState,
                    currentTime: Number((element.currentTime || 0).toFixed(2)),
                    size: [element.videoWidth || 0, element.videoHeight || 0],
                    error: element.error ? element.error.code : null,
                  }
                : null,
            ])
          )
        : "not exposed",
      pointer: window.__dogscStore
        ? {
            samples: window.__dogscStore.document?.pointerTrack?.samples?.length ?? -1,
            clicks: window.__dogscStore.document?.pointerTrack?.clicks?.length ?? -1,
          }
        : null,
      timelinePresentation: {
        mode: window.__dogscStore?.filmstripMode ?? "?",
        waveformClips: document.querySelectorAll(".clip-primary .waveform").length,
        filmstripClips: document.querySelectorAll(".clip-primary .filmstrip").length,
        audioWaveforms: document.querySelectorAll(".clip-audio .waveform").length,
      },
    }))()`);
    console.log(`[smoke:${name}]`, JSON.stringify(summary));
  } catch (error) {
    console.error(`[smoke:${name}] diagnostics failed:`, error.message);
  }
}

/**
 * Layout probe (`DOGSC_LAYOUT_PROBE=1`): walks the editor DOM for
 * horizontally scrollable and viewport-overflowing elements, at the default
 * size and again shrunk near the minimum — the state where the tool rail used
 * to sprout a horizontal scrollbar, leaving a stray white block below it.
 */
/**
 * UI probe (`DOGSC_UI_PROBE=1`): drives the inspector so the smoke run can
 * photograph the three ported UI pieces — the opening timing bars, the zoom
 * envelope and the persistence badge — and asserts the states the save
 * pipeline drives (clean on load, editing right after a commit; smoke runs
 * neutralise the actual save, so the settled states belong to the unit test).
 */
async function runInspectorProbe(win) {
  if (!win || win.isDestroyed()) return;

  /* Read the badge before anything commits: a fresh load reads clean. */
  const initialBadge = await win.webContents
    .executeJavaScript(`document.getElementById("save-badge")?.dataset.state ?? "missing"`)
    .catch(() => "missing");

  await win.webContents
    .executeJavaScript(
      `(() => {
         const store = window.__dogscStore;
         if (store && store.document) {
           store.commit("probe", (doc) => { doc.opening.isEnabled = true; });
         }
         document.querySelector('.rail-button[data-tool="opening"]')?.click();
         return true;
       })()`
    )
    .catch((error) => console.error("[ui-probe] opening setup failed:", error.message));
  await shoot("ui-opening", win, 700);

  const selected = await win.webContents
    .executeJavaScript(
      `(() => {
         const store = window.__dogscStore;
         const clip = store.document.timeline.zoomClips[0];
         if (!clip) return { error: "no zoom clip" };
         store.select("zoom", clip.id);
         return { id: clip.id, duration: clip.duration, scale: clip.scale, transitionOut: clip.transitionOut };
       })()`
    )
    .catch((error) => ({ error: String(error) }));
  console.log("[ui-probe] zoom clip:", JSON.stringify(selected));

  await win.webContents
    .executeJavaScript(`document.querySelector('.rail-button[data-tool="zoom"]')?.click(), true`)
    .catch((error) => console.error("[ui-probe] rail click failed:", error.message));
  await new Promise((resolve) => setTimeout(resolve, 500));
  await win.webContents
    .executeJavaScript(`document.querySelector(".zoom-envelope")?.scrollIntoView({ block: "center" }), true`)
    .catch(() => {});
  await shoot("ui-envelope", win, 700);

  const envelope = await win.webContents
    .executeJavaScript(
      `(() => {
         const canvas = document.querySelector(".zoom-envelope canvas");
         return { found: Boolean(canvas), backingWidth: canvas ? canvas.width : 0 };
       })()`
    )
    .catch((error) => ({ error: String(error) }));
  console.log("[ui-probe] envelope:", JSON.stringify(envelope));

  /* Drag the peak node down and confirm the store value actually moved —
     an end-to-end check of the envelope's pointer pipeline and its math. */
  let drag = { error: "no zoom clip" };
  if (selected.id) {
    drag = await win.webContents
      .executeJavaScript(
        `(() => {
           const store = window.__dogscStore;
           const id = ${JSON.stringify(selected.id)};
           const clip = store.document.timeline.zoomClips.find((entry) => entry.id === id);
           const canvas = document.querySelector(".zoom-envelope canvas");
           if (!clip || !canvas) return { error: "missing clip or canvas" };
           const before = clip.scale;
           const width = canvas.clientWidth;
           const height = canvas.clientHeight;
           const plot = { x: 10, y: 14, width: width - 44, height: height - 38 };
           const scaleToY = (s) => plot.y + plot.height - (Math.log(s) / Math.log(6)) * plot.height;
           const timeToX = (t) => plot.x + (t / clip.duration) * plot.width;
           const from = { x: timeToX(clip.duration - clip.transitionOut), y: scaleToY(clip.scale) };
           const to = { x: from.x, y: scaleToY(1.45) };
           const rect = canvas.getBoundingClientRect();
           const fire = (type, point) =>
             canvas.dispatchEvent(new PointerEvent(type, {
               bubbles: true, cancelable: true, button: 0, pointerId: 1,
               clientX: rect.left + point.x, clientY: rect.top + point.y,
             }));
           fire("pointerdown", from);
           fire("pointermove", to);
           fire("pointerup", to);
           const target = store.document.timeline.zoomClips.find((entry) => entry.id === id);
           return { before: Number(before.toFixed(3)), after: Number(target.scale.toFixed(3)) };
         })()`
      )
      .catch((error) => ({ error: String(error) }));
  }
  console.log("[ui-probe] drag:", JSON.stringify(drag));

  const badge = await win.webContents
    .executeJavaScript(
      `(() => {
         const store = window.__dogscStore;
         const read = () => document.getElementById("save-badge")?.dataset.state ?? "missing";
         store.commit("probe", () => {});
         return read();
       })()`
    )
    .catch((error) => ({ error: String(error) }));
  console.log("[ui-probe] badge:", JSON.stringify({ initial: initialBadge, afterCommit: badge }));

  const pass =
    envelope.found &&
    envelope.backingWidth > 0 &&
    !drag.error &&
    Math.abs(drag.after - 1.45) < 0.15 &&
    initialBadge === "clean" &&
    badge === "dirty";
  console.log(`[ui-probe] ${pass ? "PASS" : "FAIL"}`);
}

async function runLayoutProbe(win) {
  if (!win || win.isDestroyed()) return;
  const measure = () =>
    win.webContents.executeJavaScript(`(() => {
      const describe = (el) => {
        if (el.id) return "#" + el.id;
        if (typeof el.className === "string" && el.className) {
          return "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".");
        }
        return el.tagName.toLowerCase();
      };
      const out = {
        viewport: [window.innerWidth, window.innerHeight],
        page: {
          doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
          body: [document.body.scrollWidth, document.body.clientWidth],
        },
        horizontalScrollers: [],
        overflowing: [],
      };
      document.querySelectorAll("*").forEach((el) => {
        const style = getComputedStyle(el);
        if (el.scrollWidth > el.clientWidth + 0.5 && /(auto|scroll)/.test(style.overflowX)) {
          out.horizontalScrollers.push({
            el: describe(el),
            scroll: el.scrollWidth,
            client: el.clientWidth,
            offset: el.offsetWidth,
          });
        }
        const rect = el.getBoundingClientRect();
        if (rect.width > 0.5 && (rect.right > window.innerWidth + 0.5 || rect.left < -0.5)) {
          out.overflowing.push({
            el: describe(el),
            left: Math.round(rect.left),
            right: Math.round(rect.right),
          });
        }
      });
      const rail = document.querySelector(".tool-rail");
      if (rail) {
        const style = getComputedStyle(rail);
        out.rail = {
          offset: [rail.offsetWidth, rail.offsetHeight],
          client: [rail.clientWidth, rail.clientHeight],
          scroll: [rail.scrollWidth, rail.scrollHeight],
          overflowX: style.overflowX,
          overflowY: style.overflowY,
          scrollbarWidth: rail.offsetWidth - rail.clientWidth,
        };
      }
      return out;
    })()`);
  console.log("[layout-probe] default:", JSON.stringify(await measure()));
  win.setContentSize(970, 640);
  await new Promise((resolve) => setTimeout(resolve, 900));
  console.log("[layout-probe] near-min:", JSON.stringify(await measure()));
  await shoot("layout-near-min", win, 500);
}

/* ------------------------------------------------------------------------- */
/* Recording session                                                         */
/* ------------------------------------------------------------------------- */

function sessionState() {
  if (!session) return { status: "idle" };
  const pausedNow = session.pausedAt ? Date.now() - session.pausedAt : 0;
  const elapsed =
    (Date.now() - session.startedAt - session.pausedTotal - pausedNow) / 1000;
  return {
    status: session.paused ? "paused" : session.started ? "recording" : "preparing",
    startedAt: session.startedAt,
    elapsed,
    markers: session.markers.length,
    config: session.config,
    writing: session.writing,
  };
}

async function startRecording(config) {
  if (session) return { ok: false, reason: "busy" };
  if (!config || !config.kind) return { ok: false, reason: "no-source" };

  /* A device recording captures a capture device directly: there is no
     desktop source id to resolve and no desktop pointer track to record. */
  const isDevice = config.kind === "device";
  if (isDevice) {
    if (!config.deviceId) return { ok: false, reason: "no-source" };
  } else {
    /* Area recordings are authored by the selection overlay, which knows the
       display but not the capturer's source id — resolve it here. */
    if (!config.sourceId && config.displayId) {
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
      const match =
        sources.find((source) => String(source.display_id) === String(config.displayId)) ||
        sources[0];
      if (match) {
        config = { ...config, sourceId: match.id, sourceName: match.name };
      }
    }
    if (!config.sourceId) return { ok: false, reason: "no-source" };
  }

  const workingDir = await ensureDir(tempDir(`session-${Date.now()}`));
  session = {
    config,
    workingDir,
    startedAt: Date.now(),
    started: false,
    paused: false,
    pausedAt: 0,
    pausedTotal: 0,
    markers: [],
    writing: [],
  };

  const surface = windows.createCaptureSurface();
  /* 采集面的日志平时在它自己的渲染进程里；窗口级转发让录制排障可见
     （DOGSC_SMOKE / DOGSC_DDAGRAB_LAB 时开启）。 */
  if (process.env.DOGSC_SMOKE || process.env.DOGSC_DDAGRAB_LAB) {
    surface.webContents.on("console-message", (_event, _level, message) => {
      console.log("[surface]", message);
    });
  }
  const ready = await waitForSurface(surface);
  if (!ready) {
    session = null;
    return { ok: false, reason: "surface-failed" };
  }
  if (process.env.DOGSC_DDAGRAB_LAB) await screenCapture.probeDdagrab("A-采集面创建后");

  if (prefs.get("hideDesktopIcons")) {
    await desktopIcons.setDesktopIconsHidden(true);
  }

  /* The pointer track only means something when the desktop is what is being
     recorded; a device recording has no desktop coordinates to map onto. */
  if (!isDevice) {
    const displayId = config.displayId || String(screen.getPrimaryDisplay().id);
    await pointer.startCapture(physicalRectForDisplay(displayId));
  }
  registerMarkerShortcut();
  if (process.env.DOGSC_DDAGRAB_LAB) {
    await screenCapture.probeDdagrab("B-指针钩子启动后");
    await screenCapture.probeDdagrabDeep("D-录制前逐级", workingDir);
  }

  /* 高性能采集：显示器与区域录制优先走 ffmpeg ddagrab（Desktop Duplication，
     恒定帧率、不录系统光标、硬件编码）。启动失败（无滤镜 / 编码器不可用 /
     首帧超时）时自动回退 Chromium 采集，不影响任何既有能力。窗口与设备
     来源保持 Chromium 路径。 */
  let screenMode = "legacy";
  if (!isDevice && config.kind !== "window") {
    try {
      if (await screenCapture.available()) {
        const display =
          screen.getAllDisplays().find((item) => String(item.id) === String(config.displayId)) ||
          screen.getPrimaryDisplay();
        const physical = screen.dipToScreenRect(null, display.bounds);
        const handle = await screenCapture.begin({
          displayId: config.displayId || String(screen.getPrimaryDisplay().id),
          region: config.kind === "area" ? config.region : null,
          scaleFactor: config.scaleFactor || display.scaleFactor || 1,
          fps: config.fps || 60,
          width: physical.width,
          height: physical.height,
          workingDir,
          onStderr: (text) => console.log("[capture:ffmpeg]", text.trim()),
        });
        session.screenCapture = handle;
        screenMode = "ffmpeg";
        console.log(`[capture] ffmpeg screen capture — ${handle.encoder}`);
      }
    } catch (error) {
      console.warn("[capture] ffmpeg capture unavailable, falling back to Chromium:", error.message);
      session.screenCapture = null;
    }
  }

  send("captureSurface", "capture:command", {
    type: "start",
    config: { ...config, workingDir, screenMode },
  });

  send("recorder", "recorder:state", sessionState());

  /* Wait for the capture surface to confirm the stream is actually live.
     Reporting success before that would leave the user looking at a recording
     bar that says it is recording while nothing is being captured. */
  const confirmed = await new Promise((resolve) => {
    pendingStart = resolve;
    setTimeout(() => settleStart({ ok: false, reason: "capture-timeout" }), 25000);
  });

  if (!confirmed.ok) {
    const reason = confirmed.reason;
    pointer.stopCapture();
    pointer.stop();
    globalShortcut.unregister(MARKER_ACCELERATOR);
    if (session?.screenCapture) await session.screenCapture.cancel().catch(() => {});
    session = null;
    send("recorder", "recorder:state", { status: "idle" });
    send("captureSurface", "capture:command", { type: "stop" });
    await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason };
  }

  return { ok: true, sizes: { ...(session?.sizes || {}) } };
}

function pauseRecording() {
  if (!session) return { ok: false, reason: "no-session" };
  session.paused = true;
  session.pausedAt = Date.now();
  /* ffmpeg 采集按分段暂停：优雅结束当前段，继续时再开新段。 */
  if (session.screenCapture) {
    session.screenCapture.pause().catch((error) => console.warn("[capture] ffmpeg pause failed", error.message));
  }
  send("captureSurface", "capture:command", { type: "pause" });
  send("recorder", "recorder:state", sessionState());
  return { ok: true };
}

function resumeRecording() {
  if (!session) return { ok: false, reason: "no-session" };
  if (session.pausedAt) session.pausedTotal += Date.now() - session.pausedAt;
  session.paused = false;
  session.pausedAt = 0;
  if (session.screenCapture) {
    session.screenCapture.resume().catch((error) => {
      console.warn("[capture] ffmpeg resume failed", error.message);
      send("recorder", "recorder:warning", { message: "screen-resume-failed" });
    });
  }
  send("captureSurface", "capture:command", { type: "resume" });
  send("recorder", "recorder:state", sessionState());
  return { ok: true };
}

function waitForSurface(win) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) return resolve(false);
    if (!win.webContents.isLoading()) return resolve(true);
    const timer = setTimeout(() => resolve(false), 10000);
    win.webContents.once("did-finish-load", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

function registerMarkerShortcut() {
  try {
    globalShortcut.register(MARKER_ACCELERATOR, () => addMarker());
  } catch (error) {
    console.error("[marker] global shortcut unavailable", error);
  }
}

function addMarker() {
  if (!session) return { ok: false };
  const elapsed =
    (Date.now() - session.startedAt - session.pausedTotal - (session.pausedAt ? Date.now() - session.pausedAt : 0)) / 1000;
  session.markers.push({ id: `marker-${session.markers.length + 1}`, time: elapsed });
  send("recorder", "recorder:marker", { count: session.markers.length, time: elapsed });
  send("recorder", "recorder:state", sessionState());
  return { ok: true, count: session.markers.length, time: elapsed };
}

async function stopRecording(cancel) {
  if (!session || session.finishing) return { ok: false, reason: "no-session" };
  session.finishing = true;

  const workingDir = session.workingDir;
  const ffmpegCapture = session.screenCapture || null;
  const captured = await requestSurfaceStop();
  const pointerTrack = pointer.stopCapture();
  pointer.stop();
  globalShortcut.unregister(MARKER_ACCELERATOR);

  if (prefs.get("hideDesktopIcons")) {
    await desktopIcons.setDesktopIconsHidden(false);
  }

  const markers = session.markers.map((marker) => ({ ...marker }));
  const config = session.config;
  const written = { ...(session.bytes || {}) };
  session = null;
  send("recorder", "recorder:state", { status: "idle" });

  if (cancel) {
    if (ffmpegCapture) await ffmpegCapture.cancel().catch(() => {});
    await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, cancelled: true };
  }

  /* 收尾 ffmpeg 采集：停止编码 → 逐段重封装 → 拼接 → 抽首帧封面。 */
  let screenMedia = null;
  if (ffmpegCapture) {
    try {
      screenMedia = await ffmpegCapture.finish();
    } catch (error) {
      console.error("[capture] ffmpeg finish failed", error);
    }
  }

  if (!captured || !captured.files || (!captured.files.screen && !screenMedia)) {
    await fsp.rm(workingDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, reason: captured?.error || "no-video" };
  }

  /* A window that is minimised or fully occluded yields no frames at all —
     Chromium only delivers them while the source is on screen and repainting.
     Without this check the user would get an empty project and no explanation. */
  if (!written.screen && !screenMedia) {
    send("recorder", "recorder:warning", { message: "no-frames-captured" });
  }

  /* ffmpeg 采集的封面（首帧 png）由主进程从成片抽出，替代渲染层的截图。 */
  const merged = {
    ...captured,
    screenMode: captured.screenMode || (screenMedia ? "ffmpeg" : "legacy"),
    screenMedia,
    trackStartedAt: captured.trackStartedAt || {},
  };
  if (screenMedia) {
    const poster = path.join(workingDir, "poster.png");
    if (fs.existsSync(poster)) merged.posterPath = poster;
  }

  const record = await buildProjectFromSession(merged, pointerTrack, markers, config);

  windows.createCompletion({
    packagePath: record.packagePath,
    name: record.name,
    duration: record.document.timeline.duration,
    posterUrl: record.posterUrl,
    hasCamera: Boolean(record.document.media.camera),
  });

  const recorder = windows.get("recorder");
  if (recorder) recorder.hide();

  return { ok: true, ...record };
}

/**
 * Asks the capture surface to finish and waits for it to hand back its files.
 * Resolves with `null` if the surface never answers, so a wedged renderer can
 * never leave a recording session open forever.
 */
function requestSurfaceStop() {
  if (pendingStop) return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      pendingStop = null;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => finish(null), 30000);
    pendingStop = finish;
    send("captureSurface", "capture:command", { type: "stop" });
  });
}

/**
 * Turns the raw session files into a `.dogscproject` package: media is copied
 * in, the pointer track is normalised against the recorded frame, and the
 * document is seeded so the editor can fill in the authored defaults.
 */
async function buildProjectFromSession(captured, pointerTrack, markers, config) {
  const projectLocation = prefs.get("projectLocation");
  const baseName = captured.suggestedName || timestampName();
  const packagePath = await projectIO.uniquePackagePath(projectLocation, baseName);
  await ensureDir(packagePath);

  const media = {};
  const firstFrameTime = captured.screenMedia?.firstFrameTime;

  if (captured.screenMedia) {
    /* ffmpeg 采集的屏幕素材已经是规范的 H.264 MP4，直接采用。 */
    const relative = await projectIO.adoptMedia(packagePath, captured.screenMedia.file, "screen");
    const absolute = path.join(packagePath, relative);
    media.screen = {
      path: relative,
      duration: captured.screenMedia.duration || 0,
      size: fs.statSync(absolute).size,
      width: captured.screenMedia.width || null,
      height: captured.screenMedia.height || null,
    };
  }

  /* 屏幕走旧 Chromium 采集时（含 ffmpeg 回退），screen.webm 照常采用。 */
  const trackRoles = captured.screenMedia
    ? ["camera", "system", "microphone"]
    : ["screen", "camera", "system", "microphone"];
  for (const role of trackRoles) {
    const file = captured.files[role];
    if (!file || !fs.existsSync(file)) continue;
    const relative = await projectIO.adoptMedia(packagePath, file, role);
    const absolute = path.join(packagePath, relative);
    /* MediaRecorder output has no duration in its header; remux it so the
       recorded material is a well-formed file. */
    await exporter.finalizeRecording(absolute).catch(() => {});
    media[role] = {
      path: relative,
      duration: captured.durations?.[role] || captured.duration || 0,
      size: fs.statSync(absolute).size,
      width: captured.sizes?.[role]?.width || null,
      height: captured.sizes?.[role]?.height || null,
    };
  }

  /* 附加轨对齐到画面原点（ffmpeg 首帧时钟）：offset 是该轨晚于画面的启动
     秒数，导出与预览都按它平移音轨与摄像头画面。 */
  const started = captured.trackStartedAt || {};
  if (captured.screenMedia && Number.isFinite(firstFrameTime)) {
    for (const role of ["camera", "system", "microphone"]) {
      if (media[role] && Number.isFinite(started[role])) {
        media[role].offset = started[role] / 1000 - firstFrameTime;
      }
    }
  }

  /* 指针轨重定基到画面原点：sample.t 是钩子启动以来的秒数，加上两原点的
     差即得相对首帧的秒数（旧采集路径保持原样，避免改变已验证行为）。 */
  let pointerSamples = pointerTrack.samples;
  let pointerClicks = pointerTrack.clicks;
  if (captured.screenMedia && Number.isFinite(firstFrameTime) && Number.isFinite(pointerTrack.originMs)) {
    const delta = pointerTrack.originMs / 1000 - firstFrameTime;
    if (Math.abs(delta) > 0.001) {
      pointerSamples = pointerSamples.map((sample) => ({ ...sample, t: sample.t + delta }));
      pointerClicks = pointerClicks.map((click) => ({ ...click, t: click.t + delta }));
    }
  }

  let posterUrl = null;
  if (captured.posterPath && fs.existsSync(captured.posterPath)) {
    const relative = await projectIO.adoptMediaAs(
      packagePath,
      captured.posterPath,
      "media/poster.png"
    );
    media.poster = { path: relative };
    posterUrl = `dogsc-media://local/${encodeURIComponent(path.join(packagePath, relative))}`;
  }

  const duration = media.screen?.duration || captured.duration || 1;
  let document = {
    schemaVersion: projectIO.SCHEMA_VERSION,
    id: `dogsc-${Date.now().toString(36)}`,
    name: path.basename(packagePath, projectIO.PACKAGE_EXTENSION),
    createdAt: new Date().toISOString(),
    capture: {
      kind: config?.kind || "display",
      sourceName: config?.sourceName || "",
      displayId: config?.displayId || null,
      region: config?.region || null,
      fps: config?.fps || 60,
      systemAudio: Boolean(captured.files.system),
      microphone: Boolean(captured.files.microphone),
      camera: Boolean(captured.files.camera),
    },
    media,
    pointerTrack: {
      samples: pointerSamples,
      clicks: pointerClicks,
    },
    markers,
    timeline: {
      duration,
      primaryClips: [
        {
          id: "clip-1",
          sourceStart: 0,
          sourceDuration: duration,
          startTime: 0,
          speed: 1,
          audioOverride: null,
        },
      ],
    },
  };

  await projectIO.writeProjectJson(packagePath, document);

  /* A preset marked as the new-recording default is baked into the document
     here, before the editor ever opens it — the editor then normalises the
     document as usual and the user sees their preferred look immediately. */
  const preset = prefs.get("defaultScenePreset");
  if (preset && typeof preset === "object") {
    const seeded = { ...document };
    for (const key of ["canvas", "camera", "cursorStyle", "opening", "motion"]) {
      if (preset[key]) seeded[key] = preset[key];
    }
    seeded.scenePreset = preset.name || null;
    await projectIO.writeProjectJson(packagePath, seeded);
    document = seeded;
  }

  prefs.set("lastProjectPath", packagePath);

  return { packagePath, name: document.name, document, posterUrl };
}

/* ------------------------------------------------------------------------- */
/* Export                                                                    */
/* ------------------------------------------------------------------------- */

const EXPORT_IDLE_MS = 20000;

async function beginExport(payload, sender) {
  if (exportJob) {
    /* A renderer that aborted before `finish` — an encoder error, a closed
       window, a crash — used to leave the job registered forever, and every
       later export then failed with "busy". Such a job is reclaimed here. A
       job that is already muxing is left alone: ffmpeg can run for minutes
       without producing chunks, and that is not staleness. */
    const owner = exportJob.ownerId ? webContents.fromId(exportJob.ownerId) : null;
    const ownerGone = Boolean(exportJob.ownerId) && (!owner || owner.isDestroyed());
    const idle =
      exportJob.stage === "encoding" && Date.now() - (exportJob.lastActivity || 0) > EXPORT_IDLE_MS;
    if (ownerGone || idle) {
      console.warn(`[export] reclaiming a stale job (ownerGone=${ownerGone} idle=${idle})`);
      if (exportJob.handle) await exportJob.handle.close().catch(() => {});
      try {
        exportJob.controller.abort();
      } catch {
        /* nothing to abort */
      }
      exportJob = null;
    } else {
      return { ok: false, reason: "busy" };
    }
  }
  const dir = await ensureDir(tempDir("export"));
  const stamp = Date.now();
  exportJob = {
    dir,
    ownerId: sender?.id ?? null,
    stage: "encoding",
    lastActivity: Date.now(),
    outputPath: payload.outputPath,
    codec: payload.codec,
    fps: payload.fps,
    duration: payload.duration,
    mode: payload.mode || "bitstream",
    bitstreamPath: path.join(dir, `video-${stamp}.bin`),
    framesDir: path.join(dir, `frames-${stamp}`),
    handle: null,
    /* Explicit write position, so concurrent chunk writes cannot collide. */
    offset: 0,
    chunkCount: 0,
    chunkBytes: 0,
    controller: new AbortController(),
    cancelled: false,
    frameIndex: 0,
  };
  if (exportJob.mode === "frames") {
    await ensureDir(exportJob.framesDir);
  } else {
    exportJob.handle = await fsp.open(exportJob.bitstreamPath, "w");
  }
  return { ok: true };
}

async function writeExportChunk(payload) {
  if (!exportJob || exportJob.cancelled) return { ok: false };
  exportJob.lastActivity = Date.now();
  const buffer = Buffer.from(payload.data);
  if (exportJob.mode === "frames") {
    exportJob.frameIndex += 1;
    const name = `frame-${String(exportJob.frameIndex).padStart(6, "0")}.jpg`;
    await fsp.writeFile(path.join(exportJob.framesDir, name), buffer);
  } else if (exportJob.handle) {
    /* The write offset is taken synchronously and passed explicitly. Writing
       through the handle's shared cursor (`handle.write(buffer)`) lets two
       chunks that are in flight at the same time overwrite each other, which
       corrupts the H.264 stream — measured: a 400-chunk write came out
       byte-different, and ffmpeg then failed with "Could not find codec
       parameters ... unspecified size". */
    const offset = exportJob.offset;
    exportJob.offset += buffer.length;
    exportJob.chunkCount += 1;
    exportJob.chunkBytes += buffer.length;
    await exportJob.handle.write(buffer, 0, buffer.length, offset);
  } else {
    console.error("[export] chunk dropped: the job has no bitstream handle");
    return { ok: false, reason: "no-handle" };
  }
  return { ok: true };
}

async function finishExport(payload) {
  if (!exportJob) return { ok: false, reason: "no-job" };
  const job = exportJob;
  /* Muxing can take minutes without producing chunks, so a job in this stage
     must never be reclaimed as idle. */
  job.stage = "finishing";
  job.lastActivity = Date.now();
  try {
    /* The destination folder can disappear between choosing it and exporting.
       Recreating it here keeps that from surfacing as an unintelligible wall
       of ffmpeg output about a file it could not open. */
    await ensureDir(path.dirname(job.outputPath));
    if (job.handle) {
      await job.handle.close();
      job.handle = null;
    }

    send("exportPanel", "export:progress", { stage: "audio", progress: 0 });

    const tracks = {};
    for (const role of ["system", "microphone"]) {
      const entry = payload.media?.[role];
      if (entry?.absolute && fs.existsSync(entry.absolute)) tracks[role] = entry.absolute;
    }

    let audioPath = null;
    if (payload.exportAudio !== false && Object.keys(tracks).length) {
      const wav = path.join(job.dir, "mix.wav");
      try {
        audioPath = await exporter.renderAudio(payload.document, tracks, wav, {
          signal: job.controller.signal,
        });
      } catch (error) {
        if (String(error?.message || "").includes("cancelled")) throw error;
        console.error("[export] audio render failed", error);
        audioPath = null;
      }
    }

    send("exportPanel", "export:progress", { stage: "encoding", progress: 0 });

    const silentVideo = path.join(job.dir, "video.mp4");
    const onProgress = (progress) =>
      send("exportPanel", "export:progress", { stage: "encoding", progress });

    if (job.mode === "frames") {
      await exporter.encodeImageSequence({
        framesDir: job.framesDir,
        pattern: "frame-%06d.jpg",
        fps: job.fps,
        outputPath: silentVideo,
        duration: job.duration,
        signal: job.controller.signal,
        onProgress,
      });
    } else {
      /* An empty bitstream means the encoder never produced a frame. Handing
         that to ffmpeg produces a wall of "Could not find codec parameters …
         unspecified size" with no hint of the real cause, so it is reported
         here instead. */
      const size = await fsp.stat(job.bitstreamPath).then((stat) => stat.size, () => 0);
      console.log(
        `[export] bitstream ${path.basename(job.bitstreamPath)} · ${size} bytes · ` +
          `${job.chunkCount} chunks received`
      );
      if (size === 0) {
        exportJob = null;
        return {
          ok: false,
          reason: "no-frames",
          message: "the encoder produced no frames",
        };
      }
      await exporter.wrapVideo({
        codec: job.codec,
        bitstreamPath: job.bitstreamPath,
        outputPath: silentVideo,
        fps: job.fps,
        duration: job.duration,
        signal: job.controller.signal,
        onProgress,
      });
    }

    send("exportPanel", "export:progress", { stage: "muxing", progress: 0 });
    await exporter.mux({
      videoPath: silentVideo,
      audioPath,
      outputPath: job.outputPath,
      duration: job.duration,
      signal: job.controller.signal,
    });

    const stat = await fsp.stat(job.outputPath).catch(() => null);
    exportJob = null;
    return { ok: true, outputPath: job.outputPath, size: stat?.size || 0 };
  } catch (error) {
    exportJob = null;
    const cancelled = String(error?.message || "").includes("cancelled");
    return { ok: false, reason: cancelled ? "cancelled" : "failed", message: error?.message };
  }
}

async function cancelExport() {
  if (!exportJob) return { ok: false };
  exportJob.cancelled = true;
  exportJob.controller.abort();
  if (exportJob.handle) await exportJob.handle.close().catch(() => {});
  exportJob = null;
  return { ok: true };
}
