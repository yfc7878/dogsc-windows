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
  hideDesktopIcons: false,
  showFloatingCameraPreview: true,
  alertSounds: true,

  /* Storage */
  projectLocation: null,
  exportLocation: null,
  playAfterExport: true,

  /* Preview */
  previewQuality: "smooth",
  /* Timeline clips show the audio waveform instead of thumbnails. */
  waveformClips: false,

  /* Updates */
  autoCheckUpdates: true,

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
    this.save();
    return value;
  }

  patch(partial) {
    this.data = mergeDeep(this.data, partial);
    this.save();
    return this.data;
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
