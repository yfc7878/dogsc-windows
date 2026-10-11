/**
 * 自动运镜回归测试。
 *
 * 1. 差分测试：同一组指针事件分别喂给本项目的 planAutoZoom（src/renderer/
 *    editor/js/auto-zoom.js）与参考实现（docs/reference-xiaoying-port/
 *    src_core_zoom.js，来自 xiaoying8666/dogscwindows，MIT），逐片段对比
 *    startTime / duration / scale / focus / transition，允许 1e-9 误差。
 * 2. 跟随镜头：automaticFocusAt 的行为断言（手动片段返回 null、镜头跟随
 *    指针、进入窗口对准首次点击）。
 *
 * 运行：node tools/test-auto-zoom.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { planAutoZoom, automaticFocusAt } from "../src/renderer/editor/js/auto-zoom.js";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
};

/* ---- 参考实现：拷到临时目录并补一个最小 model 桩，使 require 可解析 ---- */
const referenceDir = path.join(os.tmpdir(), "dogsc-autozoom-ref");
fs.mkdirSync(referenceDir, { recursive: true });
fs.copyFileSync(
  path.join(import.meta.dirname, "..", "docs", "reference-xiaoying-port", "src_core_zoom.js"),
  path.join(referenceDir, "zoom.js")
);
fs.writeFileSync(
  path.join(referenceDir, "model.js"),
  "let n = 0;\nmodule.exports = { clamp: (v, a, b) => Math.min(Math.max(v, a), b), uid: () => `ref-${n++}` };\n"
);
const require = createRequire(import.meta.url);
const reference = require(path.join(referenceDir, "zoom.js"));

/* ---- 构造输入 ---- */
function makeDoc(clicks, samples) {
  return {
    motion: {},
    pointerTrack: {
      clicks: clicks.map((c) => ({ t: c.time, x: c.x, y: c.y, button: c.kind === "rightClick" ? "right" : "left" })),
      samples: samples.map((s) => ({ t: s.time, x: s.x, y: s.y })),
    },
  };
}

/* 把我们的文档形状转成参考实现的事件列表（同一份数据）。 */
function toEvents(clicks, samples) {
  const events = [
    ...samples.map((s) => ({ time: s.time, x: s.x, y: s.y, kind: "move" })),
    ...clicks.map((c) => ({ time: c.time, x: c.x, y: c.y, kind: c.kind || "leftClick" })),
  ];
  return events.sort((a, b) => a.time - b.time);
}

const OPTIONS = { zoomScale: 1.4, easing: "spring", transitionDuration: 0.7, duration: 10 };

function comparePlan(name, clicks, samples) {
  const doc = makeDoc(clicks, samples);
  const mine = planAutoZoom(doc, { ...OPTIONS });
  const theirs = reference.planAutoZoom(toEvents(clicks, samples), { ...OPTIONS });
  const same =
    mine.length === theirs.length &&
    mine.every((clip, i) => {
      const ref = theirs[i];
      return (
        Math.abs(clip.startTime - ref.startTime) < 1e-9 &&
        Math.abs(clip.duration - (ref.endTime - ref.startTime)) < 1e-9 &&
        Math.abs(clip.scale - ref.scale) < 1e-9 &&
        Math.abs(clip.focus.x - ref.focus.x) < 1e-9 &&
        Math.abs(clip.focus.y - ref.focus.y) < 1e-9 &&
        Math.abs(clip.transitionIn - ref.enterDuration) < 1e-9 &&
        Math.abs(clip.transitionOut - ref.exitDuration) < 1e-9 &&
        clip.mode === "自动"
      );
    });
  const summary = mine
    .map((c) => `[${c.startTime.toFixed(3)} +${c.duration.toFixed(3)}s ×${c.scale}]`)
    .join(" ");
  check(`差分 · ${name}`, same, `${mine.length} 段 vs 参考 ${theirs.length} 段 ${summary}`);
  return mine;
}

/* A. 单次点击。 */
comparePlan("单次点击", [{ time: 2.0, x: 0.4, y: 0.5, kind: "leftClick" }], [
  { time: 1.5, x: 0.38, y: 0.5 },
  { time: 2.0, x: 0.4, y: 0.5 },
]);

/* B. 两次点击相隔较远（两个时间组）。 */
comparePlan(
  "两个时间组",
  [
    { time: 2.0, x: 0.4, y: 0.4, kind: "leftClick" },
    { time: 6.0, x: 0.6, y: 0.6, kind: "leftClick" },
  ],
  [
    { time: 1.6, x: 0.4, y: 0.4 },
    { time: 2.0, x: 0.4, y: 0.4 },
    { time: 5.6, x: 0.6, y: 0.6 },
    { time: 6.0, x: 0.6, y: 0.6 },
  ]
);

/* C. 指针活动延长保持：点击后指针持续移动 3 秒。 */
const movingSamples = [];
for (let t = 1.0; t <= 4.0; t += 0.2) movingSamples.push({ time: t, x: 0.3 + t * 0.05, y: 0.5 });
comparePlan("活动延长保持", [{ time: 1.0, x: 0.3, y: 0.5, kind: "leftClick" }], movingSamples);

/* D. 空间分裂：1.4 秒内两次距离很远的点击。 */
comparePlan(
  "空间分裂合并",
  [
    { time: 2.0, x: 0.15, y: 0.5, kind: "leftClick" },
    { time: 2.5, x: 0.85, y: 0.5, kind: "leftClick" },
  ],
  [
    { time: 1.8, x: 0.15, y: 0.5 },
    { time: 2.0, x: 0.15, y: 0.5 },
    { time: 2.5, x: 0.85, y: 0.5 },
  ]
);

/* E. 接近真实录制：5 次点击 + 密集采样。 */
const realClicks = [
  { time: 1.63, x: 0.581, y: 0.505, kind: "leftClick" },
  { time: 3.02, x: 0.444, y: 0.513, kind: "leftClick" },
  { time: 4.45, x: 0.637, y: 0.461, kind: "leftClick" },
  { time: 6.3, x: 0.32, y: 0.72, kind: "leftClick" },
  { time: 8.1, x: 0.28, y: 0.75, kind: "leftClick" },
];
const realSamples = [];
for (let i = 0; i <= 320; i += 1) {
  const time = 1.34 + i * (8.1 - 1.34) / 320;
  realSamples.push({ time, x: 0.58 - 0.3 * (i / 320), y: 0.5 + 0.25 * Math.sin(i / 25) });
}
const realPlan = comparePlan("接近真实录制", realClicks, realSamples);
check("真实场景产出非空", realPlan.length > 0, `${realPlan.length} 段`);

/* ---- 跟随镜头 ---- */
const followDoc = makeDoc(
  [{ time: 2.0, x: 0.3, y: 0.4, kind: "leftClick" }],
  [
    { time: 1.8, x: 0.3, y: 0.4 },
    { time: 2.0, x: 0.3, y: 0.4 },
    { time: 2.6, x: 0.3, y: 0.4 },
    { time: 3.0, x: 0.85, y: 0.75 },
    { time: 4.0, x: 0.85, y: 0.75 },
  ]
);
followDoc.motion = {};
const followClips = planAutoZoom(followDoc, { ...OPTIONS });
check("跟随 · 规划成功", followClips.length === 1, `${followClips.length} 段`);
const clip = followClips[0];

check("跟随 · 手动片段返回 null", automaticFocusAt(followDoc, { ...clip, mode: "手动" }, 3.0) === null);

const entryFocus = automaticFocusAt(followDoc, clip, clip.startTime + 0.35);
check(
  "跟随 · 进入窗口对准首次点击",
  entryFocus && Math.abs(entryFocus.x - 0.3) < 0.03 && Math.abs(entryFocus.y - 0.4) < 0.03,
  `(${entryFocus?.x.toFixed(3)}, ${entryFocus?.y.toFixed(3)}) 期望 ≈(0.3, 0.4)`
);

const lateFocus = automaticFocusAt(followDoc, clip, clip.startTime + clip.duration - 0.05);
check(
  "跟随 · 指针移到右侧后镜头追上",
  lateFocus && lateFocus.x > 0.7 && lateFocus.y > 0.6,
  `(${lateFocus?.x.toFixed(3)}, ${lateFocus?.y.toFixed(3)}) 期望靠近 (0.85, 0.75)`
);

const midFocus = automaticFocusAt(followDoc, clip, 2.75);
check(
  "跟随 · 指针未动时不漂移",
  midFocus && Math.abs(midFocus.x - 0.3) < 0.05 && Math.abs(midFocus.y - 0.4) < 0.05,
  `(${midFocus?.x.toFixed(3)}, ${midFocus?.y.toFixed(3)}) 期望 ≈(0.3, 0.4)`
);

/* 缓存即时性：同一文档反复取值结果一致。 */
const again = automaticFocusAt(followDoc, clip, 2.75);
check("跟随 · 缓存一致性", again && Math.abs(again.x - midFocus.x) < 1e-12 && Math.abs(again.y - midFocus.y) < 1e-12);

console.log(failed === 0 ? "=== ALL PASS ===" : `=== ${failed} FAILED ===`);
process.exit(failed === 0 ? 0 : 1);
