/**
 * Preference store.
 *
 * Mirrors the macOS original's UserDefaults domain (`cn.laogou.dogsc`) as a
 * single JSON document so settings, the recorder memo and the remembered
 * window geometry all survive restarts the same way they do on macOS.
 */

const fs = require("fs");
const path = require("path");
const { app } = require("electron");

const DEFAULTS = {
  appearance: "system",

  /* Recorder defaults */
  captureKind: "display",
  systemAudioEnabled: true,
  microphoneEnabled: false,
  cameraEnabled: false,
  microphoneDeviceId: null,
  cameraDeviceId: null,
  /* Camera capture quality: 自动 / 4K / 1440p / 1080p / 720p. */
  cameraResolution: "1080p",
  /* Recorder-bar camera menu: mirror the camera picture by default. Seeds the
     new project's camera.isMirrored, which the editor can still toggle. */
  mirrorCamera: true,
  hideDesktopIcons: false,
  showFloatingCameraPreview: true,
  alertSounds: true,

  /* Storage */
  projectLocation: null,
  exportLocation: null,
  playAfterExport: true,

  /* Preview — the original defaults to full-resolution preview (0.1.1). */
  previewQuality: "full",
  /* Timeline clips show the audio waveform instead of thumbnails. */
  waveformClips: false,

  /* Window geometry */
  editorBounds: null,
  recorderBounds: null,
  memoBounds: null,

  /* Recorder memo */
  memo: {
    text: "",
    fontSize: 15,
    opacity: 0.82,
    visible: false,
    reading: false,
  },

  /* Reusable scene + camera layout presets */
  scenePresets: [],
  cameraLayoutPresets: [],

  lastProjectPath: null,
  onboardingCompleted: false,
  schemaVersion: 1,
};

class Preferences {
  constructor() {
    this.file = path.join(app.getPath("userData"), "preferences.json");
    this.data = { ...DEFAULTS };
    /** A write is scheduled but has not hit the disk yet. */
    this.saveTimer = null;
    this.savePending = false;
    this.load();
  }

  load() {
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      const parsed = JSON.parse(raw);
      this.data = mergeDeep({ ...DEFAULTS }, parsed);
    } catch {
      this.data = { ...DEFAULTS };
    }
    this.ensureLocations();
  }

  ensureLocations() {
    if (!this.data.projectLocation) {
      const movies = path.join(app.getPath("videos") || app.getPath("home"), "DogSC");
      this.data.projectLocation = movies;
    }
    if (!this.data.exportLocation) {
      this.data.exportLocation = app.getPath("videos") || app.getPath("home");
    }
    for (const key of ["projectLocation", "exportLocation"]) {
      try {
        fs.mkdirSync(this.data[key], { recursive: true });
      } catch {
        /* the user may point at a removable drive; fall back silently */
      }
    }
  }

  get(key) {
    return key ? this.data[key] : this.data;
  }

  set(key, value) {
    this.data[key] = value;
    this.scheduleSave();
    return value;
  }

  patch(partial) {
    this.data = mergeDeep(this.data, partial);
    this.scheduleSave();
    return this.data;
  }

  /**
   * Debounced save.
   *
   * Writes used to be synchronous and immediate, which was invisible until the
   * window-geometry handlers were wired up: on Windows the `moved` event fires
   * on *every frame of a drag*, so dragging any window hammered the message
   * loop with mkdir + writeFileSync + rename per frame. That stall is what made
   * window drags flicker and jump. Updates now land in memory instantly and the
   * disk write trails 250ms behind the *last* change — a drag only ever writes
   * once, after the mouse settles.
   */
  scheduleSave() {
    this.savePending = true;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.savePending = false;
      this.save();
    }, 250);
  }

  /** Synchronous flush for shutdown paths, so trailing edits are never lost. */
  flushSync() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.savePending) {
      this.savePending = false;
      this.save();
    }
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (error) {
      console.error("[prefs] save failed", error);
    }
  }
}

function mergeDeep(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return patch ?? base;
  for (const [key, value] of Object.entries(patch)) {
    if (
      value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      base[key] &&
      typeof base[key] === "object" &&
      !Array.isArray(base[key])
    ) {
      base[key] = mergeDeep({ ...base[key] }, value);
    } else {
      base[key] = value;
    }
  }
  return base;
}

module.exports = { Preferences, DEFAULTS };
