/**
 * 光标形状轨（pointer-shapes）回归测试。
 *
 * 对齐原版 PointerTrack 的稀疏形状编码（`recordedCursorAssetID` 只在变化
 * 点记录）：
 *   1. 无形状事件时样本保持原样（老项目兼容）。
 *   2. 形状在变化点之后生效（因果性：t >= 变化点）。
 *   3. 多个变化点按时间前向填充。
 *
 * 运行：node tools/test-cursor-shapes.mjs
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { mergeCursorShapes } = require("../src/main/pointer-shapes.js");

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
};

/* 1. 无形状事件：坐标原样，不产生 cursor 字段。 */
{
  const samples = [
    { t: 0.1, x: 1, y: 2 },
    { t: 0.2, x: 3, y: 4 },
  ];
  const merged = mergeCursorShapes(samples, []);
  check(
    "空形状轨：样本原样",
    merged.length === 2 &&
      !("cursor" in merged[0]) &&
      merged[1].x === 3 &&
      merged[1].y === 4,
    JSON.stringify(merged)
  );
}

/* 2. 因果性：形状只影响 t >= 变化点的样本。 */
{
  const samples = [
    { t: 0.0, x: 0, y: 0 },
    { t: 0.5, x: 0, y: 0 },
    { t: 1.0, x: 0, y: 0 },
  ];
  const merged = mergeCursorShapes(samples, [{ t: 0.5, shape: "system.pointing-hand" }]);
  check(
    "变化点之前不生效",
    merged[0].cursor === undefined,
    JSON.stringify(merged[0])
  );
  check(
    "变化点当刻生效（t >= 事件）",
    merged[1].cursor === "system.pointing-hand" &&
      merged[2].cursor === "system.pointing-hand",
    JSON.stringify(merged)
  );
}

/* 3. 多点前向填充。 */
{
  const samples = [];
  for (let t = 0; t <= 1.2; t += 0.1) samples.push({ t: Number(t.toFixed(2)), x: t, y: 0 });
  const merged = mergeCursorShapes(samples, [
    { t: 0.0, shape: "system.arrow" },
    { t: 0.4, shape: "system.pointing-hand" },
    { t: 0.8, shape: "system.ibeam" },
  ]);
  const byTime = new Map(merged.map((s) => [s.t, s.cursor]));
  check("填充：0.3 → 箭头", byTime.get(0.3) === "system.arrow", String(byTime.get(0.3)));
  check("填充：0.4 → 手型（当刻切换）", byTime.get(0.4) === "system.pointing-hand", String(byTime.get(0.4)));
  check("填充：0.7 → 手型", byTime.get(0.7) === "system.pointing-hand", String(byTime.get(0.7)));
  check("填充：0.8 → I 型", byTime.get(0.8) === "system.ibeam", String(byTime.get(0.8)));
  check("填充：1.2 → I 型", byTime.get(1.2) === "system.ibeam", String(byTime.get(1.2)));
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
