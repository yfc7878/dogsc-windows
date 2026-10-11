/**
 * 光标弹簧平滑回归测试。
 *
 * 1. 差分测试：同一组指针事件分别喂给本项目的 pointer-smooth.js 与参考实现
 *    （docs/reference-xiaoying-port/src_core_pointer.js，来自 xiaoying8666/
 *    dogscwindows，MIT），在 240Hz 时间网格上逐点对比 springLocation /
 *    rawLocation，允许 1e-12 误差。
 * 2. 行为断言：点击锚定精确过点、静止段不提前移动、越界隐藏、静止隐藏、
 *    速度方向、时间校准（syncOffset）。
 *
 * 运行：node tools/test-pointer-smooth.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { cursorStateAt, pointerEventsFrom } from "../src/renderer/editor/js/pointer-smooth.js";

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
};

/* ---- 参考实现 ---- */
const referenceDir = path.join(os.tmpdir(), "dogsc-pointer-ref");
fs.mkdirSync(referenceDir, { recursive: true });
fs.copyFileSync(
  path.join(import.meta.dirname, "..", "docs", "reference-xiaoying-port", "src_core_pointer.js"),
  path.join(referenceDir, "pointer.js")
);
fs.writeFileSync(
  path.join(referenceDir, "model.js"),
  "module.exports = { clamp: (v, a, b) => Math.min(Math.max(v, a), b), CLICK_EFFECTS: {} };\n"
);
const require = createRequire(import.meta.url);
const reference = require(path.join(referenceDir, "pointer.js"));

const MOTION = { cursorSpringMass: 2.8, cursorSpringStiffness: 450, cursorSpringDamping: 66 };

function makeDoc(samples, clicks, style = {}) {
  return {
    motion: MOTION,
    cursorStyle: { syncOffset: 0, hideWhenIdle: false, idleDelay: 1.2, ...style },
    pointerTrack: {
      samples: samples.map((s) => ({ t: s.time, x: s.x, y: s.y })),
      clicks: clicks.map((c) => ({
        t: c.time,
        x: c.x,
        y: c.y,
        button: c.kind === "rightClick" ? "right" : "left",
      })),
    },
  };
}

/* ---- 1. 差分：轨迹逐点一致 ---- */
const samples = [];
let x = 0.2;
let y = 0.3;
for (let i = 0; i < 120; i += 1) {
  const t = i * 0.033;
  x += 0.004 * Math.sin(i / 7);
  y += 0.003 * Math.cos(i / 9);
  samples.push({ time: t, x, y });
}
const clicks = [
  { time: 1.2, x: 0.4, y: 0.35, kind: "leftClick" },
  { time: 2.6, x: 0.62, y: 0.5, kind: "leftClick" },
];
const doc = makeDoc(samples, clicks);
const events = pointerEventsFrom(doc);
const refTrack = new reference.PointerTrack(events);

let maxSpringDelta = 0;
for (let t = 0; t <= 4.1; t += 1 / 240) {
  const mine = cursorStateAt(doc, t);
  const refSpring = refTrack.springLocation(t, MOTION);
  if (!mine || !refSpring) {
    check("差分采样非空", false, `t=${t}`);
    break;
  }
  maxSpringDelta = Math.max(maxSpringDelta, Math.abs(mine.x - refSpring.x), Math.abs(mine.y - refSpring.y));
}
check("差分 · 弹簧轨迹逐点一致 (240Hz)", maxSpringDelta < 1e-12, `最大偏差 ${maxSpringDelta.toExponential(2)}`);

/* ---- 2. 点击锚定：轨迹精确经过点击位置 ---- */
for (const click of clicks) {
  const at = cursorStateAt(doc, click.time);
  const distance = Math.hypot(at.x - click.x, at.y - click.y);
  check(
    `锚定 · 精确经过点击 (${click.time}s)`,
    distance < 1e-9,
    `偏差 ${distance.toExponential(2)}`
  );
}

/* ---- 3. 静止段不提前移动：停在最后位置，不向未来样本插值 ---- */
const gapDoc = makeDoc(
  [
    { time: 0, x: 0.2, y: 0.2 },
    { time: 0.5, x: 0.5, y: 0.5 },
    { time: 3.0, x: 0.9, y: 0.9 },
    { time: 3.2, x: 0.9, y: 0.9 },
  ],
  []
);
const during = cursorStateAt(gapDoc, 1.8);
check(
  "静止段 · 停在最后位置不向未来插值",
  Math.abs(during.x - 0.5) < 0.02 && Math.abs(during.y - 0.5) < 0.02,
  `t=1.8 (${during.x.toFixed(3)}, ${during.y.toFixed(3)}) 期望 ≈(0.5, 0.5)，不接近未来样本 0.9`
);

/* ---- 4. 越界隐藏（指针移到其他显示器） ---- */
const outDoc = makeDoc(
  [
    { time: 0, x: 0.5, y: 0.5 },
    { time: 0.5, x: 1.2, y: 0.5 },
    { time: 1.0, x: 1.2, y: 0.5 },
  ],
  []
);
const outside = cursorStateAt(outDoc, 0.8);
check("越界 · 录制区域外隐藏", outside && outside.visible === false, `visible=${outside?.visible}`);

/* ---- 5. 静止隐藏（hideWhenIdle） ---- */
const idleDoc = makeDoc(
  [
    { time: 0, x: 0.5, y: 0.5 },
    { time: 0.5, x: 0.6, y: 0.5 },
  ],
  [],
  { hideWhenIdle: true, idleDelay: 1.0 }
);
check("静止隐藏 · 阈值内可见", cursorStateAt(idleDoc, 1.2).visible === true);
check("静止隐藏 · 超过阈值隐藏", cursorStateAt(idleDoc, 2.0).visible === false);

/* ---- 6. 速度方向 ---- */
const movingDoc = makeDoc(
  [
    { time: 0, x: 0.2, y: 0.5 },
    { time: 0.5, x: 0.8, y: 0.5 },
    { time: 1.0, x: 0.9, y: 0.6 },
  ],
  []
);
const moving = cursorStateAt(movingDoc, 0.6);
check("速度 · 向右移动 vx>0", moving.vx > 0, `vx=${moving.vx.toFixed(3)}`);

/* ---- 7. 时间校准 syncOffset ---- */
const shiftedDoc = makeDoc(samples, clicks, { syncOffset: 0.5 });
const a = cursorStateAt(doc, 2.0);
const b = cursorStateAt(shiftedDoc, 2.5);
check(
  "校准 · syncOffset 平移轨迹",
  Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12,
  `(${a.x.toFixed(4)}, ${a.y.toFixed(4)}) vs (${b.x.toFixed(4)}, ${b.y.toFixed(4)})`
);

/* ---- 8. 无数据返回 null ---- */
check("无数据 · 返回 null", cursorStateAt(makeDoc([], []), 1.0) === null);

console.log(failed === 0 ? "=== ALL PASS ===" : `=== ${failed} FAILED ===`);
process.exit(failed === 0 ? 0 : 1);
