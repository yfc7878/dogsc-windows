/**
 * Save-pipeline unit test (persistence badge source of truth).
 *
 * Runs the real `store` outside the browser with a stubbed `window.dogsc`
 * bridge and asserts the state machine the editor's badge reflects:
 * clean → dirty on edits, saving → clean on a settled write, failed on a
 * rejected write, and edits landing mid-save keep the draft dirty.
 */
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/* Derived from this file's location so the suite runs from any checkout path
   (the old absolute path broke `npm test` on every other machine). */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let saveImpl = async () => {};
const probeDoc = {
  media: {},
  canvas: {},
  timeline: { primaryClips: [], zoomClips: [] },
  markers: [],
  pointerTrack: { samples: [], clicks: [] },
};
globalThis.window = {
  dogsc: {
    project: {
      open: async () => ({ ok: true, document: JSON.parse(JSON.stringify(probeDoc)) }),
      save: (payload) => saveImpl(payload),
    },
  },
};

const { store } = await import(pathToFileURL(path.join(ROOT, "src/renderer/editor/js/store.js")).toString());

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
};

const reasons = [];
store.subscribe((_store, reason) => reasons.push(reason));

/* ---- load: a freshly opened project is clean ---- */
await store.load(path.join(ROOT, "probe.dogscproject"));
check("load → clean", store.saveStatus === "clean" && store.revision === 0, `status=${store.saveStatus}`);

/* ---- every edit path marks the draft ---- */
store.commit("probe", () => {});
check("commit → dirty", store.saveStatus === "dirty" && store.dirty === true, `status=${store.saveStatus}`);
store.apply(() => {});
check("apply bumps revision", store.revision === 2, `revision=${store.revision}`);
store.beginGesture();
store.apply(() => {});
store.commitGesture("gesture");
/* The live apply bumps once and the gesture commit finalises it: revision 4. */
check("commitGesture → revision 4", store.revision === 4, `revision=${store.revision}`);
store.undo();
store.redo();
check("undo/redo mark dirty", store.saveStatus === "dirty" && store.revision === 6, `revision=${store.revision}`);

/* ---- a settled write cleans the draft ---- */
let resolveSave;
saveImpl = () => new Promise((resolve) => (resolveSave = resolve));
const pending = store.save();
check("save → saving", store.saveStatus === "saving" && store.saveError === null);
resolveSave();
await pending;
check("settled write → clean", store.saveStatus === "clean" && store.dirty === false, `status=${store.saveStatus}`);
check("save-state notifications fired", reasons.includes("save-state"), reasons.join(","));

/* ---- edits landing mid-save keep the draft dirty ---- */
saveImpl = () => new Promise((resolve) => (resolveSave = resolve));
const pending2 = store.save();
store.commit("during-save", () => {});
resolveSave();
await pending2;
check(
  "edit during save → still dirty",
  store.saveStatus === "dirty" && store.dirty === true,
  `status=${store.saveStatus}`
);

/* ---- a rejected write surfaces as failed (and stays visible) ---- */
saveImpl = () => Promise.reject(new Error("disk full"));
let threw = false;
await store.save().catch(() => (threw = true));
check(
  "rejected write → failed + rethrow",
  threw && store.saveStatus === "failed" && String(store.saveError).includes("disk full"),
  `status=${store.saveStatus} error=${store.saveError}`
);
store.commit("after-failure", () => {});
check("edits keep the failed state visible", store.saveStatus === "failed", `status=${store.saveStatus}`);

/* ---- clicking retry (a new save) settles it ---- */
saveImpl = async () => {};
await store.save();
check("retry → clean", store.saveStatus === "clean" && store.dirty === false, `status=${store.saveStatus}`);

console.log(failures === 0 ? "=== ALL PASS ===" : `=== ${failures} FAILED ===`);
process.exit(failures === 0 ? 0 : 1);
