/**
 * Editor store.
 *
 * Owns the project document, the media elements, the selection and the undo
 * stack. This is the port of `EditorStore` + `ProjectStore` + `EditorMediaSession`.
 */

import { t } from "../../shared/i18n.js";
import { normalizeDocument, rid, clipDuration, timelineDuration, sourceTimeAt, clipAt } from "./model.js";

/** Effect clips that can be copied, pasted and have attributes transferred. */
const CLIPBOARD_KINDS = ["zoom", "screenMotion", "cameraMotion", "sticker", "mosaic"];

/** Undo titles for pasting, one per clip kind. */
const PASTE_ACTION = {
  zoom: "粘贴缩放片段",
  screenMotion: "粘贴屏幕 3D",
  cameraMotion: "粘贴摄像运动",
  sticker: "粘贴贴图",
  mosaic: "粘贴柔化",
};

const api = window.dogsc;

const MAX_HISTORY = 80;

class EditorStore {
  constructor() {
    this.document = null;
    this.packagePath = null;
    this.selection = { kind: "canvas", id: null };
    this.playhead = 0;
    this.playing = false;
    this.dirty = false;
    this.history = [];
    this.future = [];
    this.media = { screen: null, camera: null, system: null, microphone: null };
    this.backgroundImage = null;
    this.backgroundVideo = null;
    this.stickers = new Map();
    this.listeners = new Set();
    this.zoom = 1;
    this.scrollLeft = 0;
    this.snapping = true;
    this.hoverPreview = false;
    this.restoreCutMode = false;
    this.previewQuality = "smooth";
    this.saving = false;

    /** Copied effect clip, if any (⌘C / ⌘V / ⌘⇧V). */
    this.clipboard = null;
    /** Multi-selection of primary clips, used by range export (⌥X). */
    this.selectedPrimaryIds = new Set();
    this.primaryAnchor = null;
    /** Scene presets, loaded from the preference store. */
    this.__scenePresets = [];
    /** Reusable camera layouts, also stored in the preferences. */
    this.cameraLayoutPresets = [];
    /** Name of the scene preset new recordings start from. */
    this.defaultSceneName = null;
  }

  /* --------------------------------------------------------------------- */
  /* Subscription                                                          */
  /* --------------------------------------------------------------------- */

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(reason = "change") {
    for (const listener of this.listeners) {
      try {
        listener(this, reason);
      } catch (error) {
        console.error("[store] listener failed", error);
      }
    }
  }

  /* --------------------------------------------------------------------- */
  /* Loading                                                               */
  /* --------------------------------------------------------------------- */

  async load(packagePath) {
    const { document } = await api.project.open(packagePath);
    this.packagePath = packagePath;
    this.document = normalizeDocument(document);
    this.selection = { kind: "canvas", id: null };
    this.playhead = 0;
    this.history = [];
    this.future = [];
    this.dirty = false;
    this.clipboard = null;
    this.selectedPrimaryIds = new Set([this.document.timeline.primaryClips[0]?.id].filter(Boolean));
    this.primaryAnchor = this.document.timeline.primaryClips[0]?.id || null;
    await this.loadMedia();
    this.notify("load");
    return this.document;
  }

  async loadMedia() {
    this.disposeMedia();
    const doc = this.document;
    if (!doc) return;

    for (const role of ["screen", "camera", "system", "microphone"]) {
      const entry = doc.media?.[role];
      if (!entry?.path) continue;
      const url = await api.project.mediaUrl({ packagePath: this.packagePath, relative: entry.path });
      if (!url) continue;

      if (role === "screen" || role === "camera") {
        const video = document.createElement("video");
        video.src = url;
        video.preload = "auto";
        video.muted = true;
        video.playsInline = true;
        video.crossOrigin = "anonymous";
        await waitForMetadata(video);
        this.media[role] = video;
        if (role === "screen") {
          doc.__sourceSize = { width: video.videoWidth || 1920, height: video.videoHeight || 1080 };
        } else {
          doc.__cameraSize = { width: video.videoWidth || 1280, height: video.videoHeight || 720 };
        }
      } else {
        const audio = document.createElement("audio");
        audio.src = url;
        audio.preload = "auto";
        audio.crossOrigin = "anonymous";
        this.media[role] = audio;
      }
    }

    /* The recorded duration is authoritative: MediaRecorder output carries no
       reliable container duration, which is exactly what the original handles
       by storing the session length in the project. */
    const recorded = doc.media?.screen?.duration;
    if (recorded && (!doc.timeline.duration || doc.timeline.duration > recorded * 3)) {
      doc.timeline.duration = recorded;
    }

    await this.loadBackground();
    await this.loadStickers();
  }

  async loadBackground() {
    const source = this.document.canvas.backgroundSource;
    if (!source) return;
    if (source.kind === "projectImage" && source.relativePath) {
      const url = await api.project.mediaUrl({
        packagePath: this.packagePath,
        relative: source.relativePath,
      });
      if (url) this.backgroundImage = await loadImage(url);
    } else if (source.kind === "systemImage" && source.absolutePath) {
      const url = `dogsc-media://local/${encodeURIComponent(source.absolutePath)}`;
      this.backgroundImage = await loadImage(url).catch(() => null);
    } else if (source.kind === "projectVideo" && source.relativePath) {
      const url = await api.project.mediaUrl({
        packagePath: this.packagePath,
        relative: source.relativePath,
      });
      if (url) this.backgroundVideo = await makeVideo(url);
    }
  }

  async loadStickers() {
    this.stickers.clear();
    for (const clip of this.document.timeline.stickerClips || []) {
      if (!clip.source || this.stickers.has(clip.source)) continue;
      const url = await api.project.mediaUrl({
        packagePath: this.packagePath,
        relative: clip.source,
      });
      if (!url) continue;
      const image = await loadImage(url).catch(() => null);
      if (image) this.stickers.set(clip.source, image);
    }
  }

  disposeMedia() {
    for (const element of Object.values(this.media)) {
      if (!element) continue;
      try {
        element.pause();
        element.removeAttribute("src");
        element.load();
      } catch {
        /* already disposed */
      }
    }
    this.media = { screen: null, camera: null, system: null, microphone: null };
    this.backgroundImage = null;
    this.backgroundVideo = null;
    this.stickers.clear();
  }

  get sources() {
    return {
      screen: this.media.screen,
      camera: this.media.camera,
      backgroundImage: this.backgroundImage,
      backgroundVideo: this.backgroundVideo,
      stickers: this.stickers,
    };
  }

  /* --------------------------------------------------------------------- */
  /* Mutation + history                                                    */
  /* --------------------------------------------------------------------- */

  /**
   * Applies a mutation as one undoable command.
   * @param {string} actionName  shown in the Undo/Redo menu titles
   * @param {(document: object) => void} mutator
   */
  commit(actionName, mutator) {
    if (!this.document) return;
    this.history.push({ actionName, snapshot: structuredClone(this.document) });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
    mutator(this.document);
    this.dirty = true;
    this.notify("commit");
  }

  /** Mutates without touching history — used for live drags. */
  apply(mutator) {
    if (!this.document) return;
    mutator(this.document);
    this.dirty = true;
    this.notify("live");
  }

  /** Captures the state before a live gesture so it can be undone as one step. */
  beginGesture() {
    this._gestureSnapshot = structuredClone(this.document);
  }

  commitGesture(actionName) {
    if (!this._gestureSnapshot) return;
    this.history.push({ actionName, snapshot: this._gestureSnapshot });
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.future.length = 0;
    this._gestureSnapshot = null;
    this.dirty = true;
    this.notify("commit");
  }

  undo() {
    const entry = this.history.pop();
    if (!entry) return false;
    this.future.push({ actionName: entry.actionName, snapshot: structuredClone(this.document) });
    this.document = entry.snapshot;
    this.clampPlayhead();
    this.notify("undo");
    return true;
  }

  redo() {
    const entry = this.future.pop();
    if (!entry) return false;
    this.history.push({ actionName: entry.actionName, snapshot: structuredClone(this.document) });
    this.document = entry.snapshot;
    this.clampPlayhead();
    this.notify("redo");
    return true;
  }

  get undoTitle() {
    return this.history[this.history.length - 1]?.actionName || null;
  }

  get redoTitle() {
    return this.future[this.future.length - 1]?.actionName || null;
  }

  /* --------------------------------------------------------------------- */
  /* Playhead                                                              */
  /* --------------------------------------------------------------------- */

  get duration() {
    return this.document ? timelineDuration(this.document) : 0;
  }

  setPlayhead(time) {
    if (!this.document) return;
    this.playhead = Math.max(0, Math.min(time, this.duration));
    this.notify("playhead");
  }

  clampPlayhead() {
    this.playhead = Math.max(0, Math.min(this.playhead, this.duration));
  }

  sourceTime(time = this.playhead) {
    return this.document ? sourceTimeAt(this.document, time) : 0;
  }

  activeClip(time = this.playhead) {
    return this.document ? clipAt(this.document, time) : null;
  }

  /* --------------------------------------------------------------------- */
  /* Clipboard                                                             */
  /* --------------------------------------------------------------------- */

  /**
   * Copies the selected effect clip.
   *
   * Matches the original's ⌘C: zoom, Screen 3D, camera motion, stickers and
   * mosaics can all be duplicated, and the copy keeps the full authored
   * configuration rather than just its geometry.
   */
  copySelection() {
    const { kind, id } = this.selection;
    const clip = this.clipFor(kind, id);
    if (!clip || !CLIPBOARD_KINDS.includes(kind)) return false;
    this.clipboard = { kind, clip: structuredClone(clip) };
    this.notify("clipboard");
    return true;
  }

  clipFor(kind, id, document_ = this.document) {
    const timeline = document_?.timeline;
    if (!timeline) return null;
    switch (kind) {
      case "zoom":
        return timeline.zoomClips.find((clip) => clip.id === id) || null;
      case "screenMotion":
        return timeline.screenMotionClips.find((clip) => clip.id === id) || null;
      case "cameraMotion":
        return timeline.cameraMotionClips.find((clip) => clip.id === id) || null;
      case "sticker":
        return timeline.stickerClips.find((clip) => clip.id === id) || null;
      case "mosaic":
        return timeline.mosaicClips.find((clip) => clip.id === id) || null;
      default:
        return null;
    }
  }

  listFor(kind, document_ = this.document) {
    const timeline = document_?.timeline;
    if (!timeline) return null;
    switch (kind) {
      case "zoom":
        return timeline.zoomClips;
      case "screenMotion":
        return timeline.screenMotionClips;
      case "cameraMotion":
        return timeline.cameraMotionClips;
      case "sticker":
        return timeline.stickerClips;
      case "mosaic":
        return timeline.mosaicClips;
      default:
        return null;
    }
  }

  /**
   * Pastes the clipboard copy at `time`.
   * @returns {{ok: boolean, reason?: string}}
   */
  pasteClipboard(time) {
    const clipboard = this.clipboard;
    if (!clipboard) return { ok: false, reason: "empty" };
    if (clipboard.kind === "cameraMotion" && !this.document.media?.camera) {
      return { ok: false, reason: "no-camera" };
    }

    const list = this.listFor(clipboard.kind);
    if (!list) return { ok: false, reason: "unsupported" };

    const duration = clipboard.clip.duration;
    const start = Math.max(0, time);
    if (start + duration > this.duration + 0.01) {
      return { ok: false, reason: "no-room" };
    }
    const overlaps = list.some(
      (entry) => start < entry.startTime + entry.duration - 0.01 && start + duration > entry.startTime + 0.01
    );
    if (overlaps) return { ok: false, reason: "occupied" };

    const id = rid();
    this.commit(PASTE_ACTION[clipboard.kind], (doc) => {
      const target = this.listFor(clipboard.kind, doc);
      target.push({ ...structuredClone(clipboard.clip), id, startTime: start });
      target.sort((a, b) => a.startTime - b.startTime);
    });
    this.select(clipboard.kind, id);
    return { ok: true };
  }

  /**
   * Applies the clipboard clip's authored values to the selected peer of the
   * same kind, keeping that clip's own position and duration (⌘⇧V).
   */
  pasteAttributes() {
    const clipboard = this.clipboard;
    if (!clipboard) return { ok: false, reason: "empty" };
    const { kind, id } = this.selection;
    if (kind !== clipboard.kind) return { ok: false, reason: "mismatch" };
    const target = this.clipFor(kind, id);
    if (!target) return { ok: false, reason: "no-selection" };

    const source = clipboard.clip;
    this.commit(t("粘贴属性"), (doc) => {
      const entry = this.clipFor(kind, id, doc);
      if (!entry) return;
      const { id: _id, startTime: _start, duration: _duration, ...attributes } = source;
      Object.assign(entry, structuredClone(attributes));
    });
    return { ok: true };
  }

  /* --------------------------------------------------------------------- */
  /* Primary clip selection + speed                                        */
  /* --------------------------------------------------------------------- */

  selectPrimary(id, { additive = false, range = false } = {}) {
    if (!this.document) return;
    const clips = this.document.timeline.primaryClips;
    if (range && this.primaryAnchor) {
      const from = clips.findIndex((clip) => clip.id === this.primaryAnchor);
      const to = clips.findIndex((clip) => clip.id === id);
      if (from >= 0 && to >= 0) {
        const [low, high] = from < to ? [from, to] : [to, from];
        this.selectedPrimaryIds = new Set(clips.slice(low, high + 1).map((clip) => clip.id));
      }
    } else if (additive) {
      if (this.selectedPrimaryIds.has(id)) this.selectedPrimaryIds.delete(id);
      else this.selectedPrimaryIds.add(id);
      this.primaryAnchor = id;
    } else {
      this.selectedPrimaryIds = new Set([id]);
      this.primaryAnchor = id;
    }
    this.selection = { kind: "primary", id };
    this.notify("selection");
  }

  isPrimarySelected(id) {
    return this.selectedPrimaryIds.has(id);
  }

  /** The timeline range covered by the current primary selection. */
  selectedRange() {
    const clips = this.document.timeline.primaryClips.filter((clip) =>
      this.selectedPrimaryIds.has(clip.id)
    );
    if (!clips.length) return null;
    const start = Math.min(...clips.map((clip) => clip.startTime));
    const end = Math.max(...clips.map((clip) => clip.startTime + clipDuration(clip)));
    return { start, end, clips };
  }

  /** Changes playback speed, keeping the clip's source material untouched. */
  setSpeed(id, speed) {
    const clip = this.findPrimary(id);
    if (!clip) return;
    const clamped = Math.min(4, Math.max(0.25, speed));
    this.commit(t("调整片段速度"), (doc) => {
      const target = doc.timeline.primaryClips.find((entry) => entry.id === id);
      if (target) target.speed = clamped;
      doc.timeline.primaryClips = reflowClips(doc.timeline.primaryClips);
    });
  }

  /* --------------------------------------------------------------------- */
  /* Scene presets                                                         */
  /* --------------------------------------------------------------------- */

  get scenePresets() {
    return this.__scenePresets || [];
  }

  set scenePresets(value) {
    this.__scenePresets = value;
  }

  /* --------------------------------------------------------------------- */
  /* Saving                                                                */
  /* --------------------------------------------------------------------- */

  async save() {
    if (!this.document || !this.packagePath || this.saving) return null;
    this.saving = true;
    try {
      const serializable = stripRuntime(this.document);
      await api.project.save({ packagePath: this.packagePath, document: serializable });
      this.dirty = false;
      this.notify("saved");
      return this.packagePath;
    } finally {
      this.saving = false;
    }
  }

  /* --------------------------------------------------------------------- */
  /* Media imports                                                         */
  /* --------------------------------------------------------------------- */

  async importSticker(sourcePath) {
    const result = await api.project.importFile({
      source: sourcePath,
      packagePath: this.packagePath,
      relative: `media/stickers/${Date.now()}-${sourcePath.split(/[\\/]/).pop()}`,
    });
    if (!result) return null;
    const url = await api.project.mediaUrl({ packagePath: this.packagePath, relative: result.relative });
    const image = await loadImage(url).catch(() => null);
    if (image) this.stickers.set(result.relative, image);
    return result.relative;
  }

  async importBackground(sourcePath) {
    const result = await api.project.importFile({
      source: sourcePath,
      packagePath: this.packagePath,
      relative: `media/background-${Date.now()}-${sourcePath.split(/[\\/]/).pop()}`,
    });
    if (!result) return null;
    return result.relative;
  }

  /* --------------------------------------------------------------------- */
  /* Selection helpers                                                     */
  /* --------------------------------------------------------------------- */

  select(kind, id = null) {
    this.selection = { kind, id };
    this.notify("selection");
  }

  isSelected(kind, id = null) {
    return this.selection.kind === kind && (id === null || this.selection.id === id);
  }

  selectedZoomClip() {
    return this.selection.kind === "zoom" ? this.findZoom(this.selection.id) : null;
  }

  findZoom(id) {
    return this.document?.timeline.zoomClips.find((clip) => clip.id === id) || null;
  }

  findScreenMotion(id) {
    return this.document?.timeline.screenMotionClips.find((clip) => clip.id === id) || null;
  }

  findCameraMotion(id) {
    return this.document?.timeline.cameraMotionClips.find((clip) => clip.id === id) || null;
  }

  findSticker(id) {
    return this.document?.timeline.stickerClips.find((clip) => clip.id === id) || null;
  }

  findMosaic(id) {
    return this.document?.timeline.mosaicClips.find((clip) => clip.id === id) || null;
  }

  selectedSticker() {
    return this.selection.kind === "sticker" ? this.findSticker(this.selection.id) : null;
  }

  selectedMosaic() {
    return this.selection.kind === "mosaic" ? this.findMosaic(this.selection.id) : null;
  }

  findPrimary(id) {
    return this.document?.timeline.primaryClips.find((clip) => clip.id === id) || null;
  }

  clipIndex(id) {
    return this.document?.timeline.primaryClips.findIndex((clip) => clip.id === id) ?? -1;
  }

  /* --------------------------------------------------------------------- */
  /* Structural edits                                                      */
  /* --------------------------------------------------------------------- */

  splitAtPlayhead() {
    const store = this;
    const time = this.playhead;
    this.commit("分割主片段", (doc) => {
      const clips = doc.timeline.primaryClips;
      const index = clips.findIndex(
        (clip) => time > clip.startTime + 0.05 && time < clip.startTime + clipDuration(clip) - 0.05
      );
      if (index < 0) return;
      const clip = clips[index];
      const offset = time - clip.startTime;
      const left = { ...clip, sourceDuration: offset * (clip.speed || 1) };
      const right = {
        ...clip,
        id: rid(),
        sourceStart: clip.sourceStart + offset * (clip.speed || 1),
        sourceDuration: clip.sourceDuration - offset * (clip.speed || 1),
      };
      doc.timeline.primaryClips = reflowClips([...clips.slice(0, index), left, right, ...clips.slice(index + 1)]);
    });
    void store;
  }

  deleteSelection() {
    const { kind, id } = this.selection;
    if (kind === "primary") {
      if (this.document.timeline.primaryClips.length <= 1) return;
      this.commit("删除主片段", (doc) => {
        doc.timeline.primaryClips = reflowClips(
          doc.timeline.primaryClips.filter((clip) => clip.id !== id)
        );
      });
      this.select("canvas");
      return;
    }
    if (kind === "zoom") {
      this.commit("删除缩放动画", (doc) => {
        doc.timeline.zoomClips = doc.timeline.zoomClips.filter((clip) => clip.id !== id);
      });
      this.select("canvas");
      return;
    }
    if (kind === "screenMotion") {
      this.commit("删除屏幕 3D", (doc) => {
        doc.timeline.screenMotionClips = doc.timeline.screenMotionClips.filter((clip) => clip.id !== id);
      });
      this.select("canvas");
      return;
    }
    if (kind === "cameraMotion") {
      this.commit("删除摄像运动", (doc) => {
        doc.timeline.cameraMotionClips = doc.timeline.cameraMotionClips.filter((clip) => clip.id !== id);
      });
      this.select("canvas");
      return;
    }
    if (kind === "sticker") {
      this.commit("删除贴图", (doc) => {
        doc.timeline.stickerClips = doc.timeline.stickerClips.filter((clip) => clip.id !== id);
      });
      this.select("canvas");
      return;
    }
    if (kind === "primary" && this.selectedPrimaryIds.size > 1) {
      if (this.document.timeline.primaryClips.length - this.selectedPrimaryIds.size < 1) return;
      this.commit("删除主片段", (doc) => {
        doc.timeline.primaryClips = reflowClips(
          doc.timeline.primaryClips.filter((clip) => !this.selectedPrimaryIds.has(clip.id))
        );
      });
      const remaining = this.document.timeline.primaryClips[0]?.id || null;
      this.selectedPrimaryIds = new Set(remaining ? [remaining] : []);
      this.primaryAnchor = remaining;
      this.select("canvas");
      return;
    }
    if (kind === "mosaic") {
      this.commit("删除柔化", (doc) => {
        doc.timeline.mosaicClips = doc.timeline.mosaicClips.filter((clip) => clip.id !== id);
      });
      this.select("canvas");
      return;
    }
    if (kind === "marker") {
      this.commit("删除录制标记", (doc) => {
        doc.markers = doc.markers.filter((marker) => marker.id !== id);
      });
      this.select("canvas");
    }
  }
}

/* ------------------------------------------------------------------------- */
/* Helpers                                                                   */
/* ------------------------------------------------------------------------- */

export function reflowClips(clips) {
  let cursor = 0;
  return clips.map((clip) => {
    const copy = { ...clip, startTime: cursor };
    cursor += clipDuration(copy);
    return copy;
  });
}

/** Removes the runtime-only fields the renderer caches on the document. */
export function stripRuntime(document_) {
  const copy = structuredClone(document_);
  delete copy.__sourceSize;
  delete copy.__cameraSize;
  return copy;
}

function waitForMetadata(video) {
  return new Promise((resolve) => {
    if (video.readyState >= 1) return resolve();
    const done = () => {
      video.removeEventListener("loadedmetadata", done);
      video.removeEventListener("error", done);
      resolve();
    };
    video.addEventListener("loadedmetadata", done);
    video.addEventListener("error", done);
    setTimeout(done, 6000);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = url;
  });
}

function makeVideo(url) {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = "auto";
    video.addEventListener("loadeddata", () => resolve(video), { once: true });
    video.addEventListener("error", () => resolve(null), { once: true });
    setTimeout(() => resolve(video), 6000);
  });
}

export const store = new EditorStore();
