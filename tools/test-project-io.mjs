/**
 * Project package I/O unit test (two-stage commit + schema guard).
 *
 * `src/main/project.js` is pure Node, so the real module runs against a temp
 * directory: the outgoing revision is preserved on every publish, a damaged
 * `project.json` falls back to `project.previous.json`, and a package from a
 * future schema is refused instead of silently downgraded.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const projectIO = await import(
  pathToFileURL(path.join(ROOT, "src/main/project.js")).toString()
);

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "dogsc-project-io-"));

let failures = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures += 1;
};

/* ---- first write: no previous, clean publish ---- */
const pkg = path.join(tmp, "First.dogscproject");
await projectIO.writeProjectJson(pkg, { name: "First", schemaVersion: 27 });
const doc1 = JSON.parse(await fsp.readFile(path.join(pkg, "project.json"), "utf8"));
check("first write publishes v27", doc1.schemaVersion === 27 && doc1.name === "First");
check(
  "first write leaves no previous",
  !fs.existsSync(path.join(pkg, "project.previous.json"))
);
check(
  "no staging turds left behind",
  fs.readdirSync(pkg).every((name) => !name.includes(".tmp")),
  fs.readdirSync(pkg).join(",")
);

/* ---- second write: the outgoing revision is preserved ---- */
await projectIO.writeProjectJson(pkg, { name: "First renamed" });
const previous = JSON.parse(
  await fsp.readFile(path.join(pkg, "project.previous.json"), "utf8")
);
const doc2 = JSON.parse(await fsp.readFile(path.join(pkg, "project.json"), "utf8"));
check("previous holds the outgoing revision", previous.name === "First", `prev=${previous.name}`);
check("main holds the new revision", doc2.name === "First renamed");

/* ---- an older outgoing schema also gets a migration backup ---- */
const old = path.join(tmp, "Old.dogscproject");
await fsp.mkdir(old, { recursive: true });
await fsp.writeFile(
  path.join(old, "project.json"),
  JSON.stringify({ name: "Old", schemaVersion: 24 })
);
await projectIO.writeProjectJson(old, { name: "Old upgraded" });
check(
  "migration backup kept for v24 → v27",
  fs.existsSync(path.join(old, "project-v24-before-migration.json")),
  fs.readdirSync(old).join(",")
);

/* ---- a damaged main falls back to the previous revision ---- */
const damaged = path.join(tmp, "Damaged.dogscproject");
await projectIO.writeProjectJson(damaged, { name: "Good" });
await projectIO.writeProjectJson(damaged, { name: "Better" });
await fsp.writeFile(path.join(damaged, "project.json"), "{ this is not json");
const opened = await projectIO.readProject(damaged);
check("damaged main falls back", opened.document.name === "Good", `name=${opened.document.name}`);
check("fallback is flagged", opened.recoveredFromPreviousRevision === true);

/* ---- a damaged main with no previous still throws ---- */
const orphan = path.join(tmp, "Orphan.dogscproject");
await fsp.mkdir(orphan, { recursive: true });
await fsp.writeFile(path.join(orphan, "project.json"), "nope");
let threw = false;
await projectIO.readProject(orphan).catch(() => (threw = true));
check("damaged without previous throws", threw);

/* ---- a future schema is refused, and never falls back ---- */
const future = path.join(tmp, "Future.dogscproject");
await fsp.mkdir(future, { recursive: true });
await fsp.writeFile(
  path.join(future, "project.json"),
  JSON.stringify({ name: "Future", schemaVersion: 99 })
);
let futureError = null;
await projectIO.readProject(future).catch((error) => (futureError = error));
check(
  "future schema throws a coded error",
  futureError?.code === "unsupportedFutureVersion",
  String(futureError)
);
check("future schema reports its version", futureError?.schemaVersion === 99);

await fsp.writeFile(
  path.join(future, "project.previous.json"),
  JSON.stringify({ name: "Future old", schemaVersion: 27 })
);
let futureError2 = null;
await projectIO.readProject(future).catch((error) => (futureError2 = error));
check(
  "future schema never falls back to previous",
  futureError2?.code === "unsupportedFutureVersion"
);

/* ---- a missing schemaVersion is legacy, not future ---- */
const legacy = path.join(tmp, "Legacy.dogscproject");
await fsp.mkdir(legacy, { recursive: true });
await fsp.writeFile(path.join(legacy, "project.json"), JSON.stringify({ name: "Legacy" }));
const legacyOpened = await projectIO.readProject(legacy);
check(
  "missing schemaVersion opens as legacy",
  legacyOpened.document.name === "Legacy" && legacyOpened.recoveredFromPreviousRevision === false
);

/* ---- pointer journal round-trip ---- */
const tracked = path.join(tmp, "Tracked.dogscproject");
await projectIO.writeProjectJson(tracked, { name: "Tracked" });
const relative = await projectIO.writePointerJournal(
  tracked,
  [
    { t: 0.123456, x: 0.51234, y: 0.25888, cursor: "system.arrow" },
    { t: 1.5, x: 0.6, y: 0.3 },
  ],
  [{ t: 2.25, x: 0.7, y: 0.35, button: 0, delta: 0 }]
);
check("journal relative path", relative === "events/pointer.jsonl", relative);
const journal = await projectIO.readPointerJournal(tracked, relative);
check(
  "journal samples round-trip",
  journal.samples.length === 2 &&
    Math.abs(journal.samples[0].t - 0.1235) < 1e-6 &&
    journal.samples[0].cursor === "system.arrow"
);
check("journal clicks round-trip", journal.clicks.length === 1 && Math.abs(journal.clicks[0].t - 2.25) < 1e-6);
check("journal lives inside the package", fs.existsSync(path.join(tracked, "events", "pointer.jsonl")));

/* ---- package-relative path guard ---- */
check("plain relative resolves", projectIO.resolveInsidePackage(pkg, "media/screen.mp4") !== null);
check("absolute path refused", projectIO.resolveInsidePackage(pkg, "C:\\Windows\\evil") === null);
check("drive-letter path refused", projectIO.resolveInsidePackage(pkg, "D:/evil") === null);
check(".. escape refused", projectIO.resolveInsidePackage(pkg, "../evil.json") === null);
check("nested .. escape refused", projectIO.resolveInsidePackage(pkg, "media/../../evil.json") === null);
check(
  "hostile media path resolves to null",
  projectIO.resolveMedia(pkg, "..\\..\\Windows\\system32\\config\\SAM") === null
);

await fsp.rm(tmp, { recursive: true, force: true });

console.log(failures === 0 ? "=== ALL PASS ===" : `=== ${failures} FAILED ===`);
process.exit(failures === 0 ? 0 : 1);
