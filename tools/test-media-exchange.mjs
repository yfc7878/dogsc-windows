/**
 * 素材交换（media-exchange）回归测试。
 *
 * 对齐原版 `ProjectMediaExchange.swift` 与 `AppModel+ProjectCommands.swift`：
 *   1. 命名与目录规则：标题清理、"-源文件" 去重递增（-2、-3）、扩展名回退。
 *   2. 摄像头替换校验：文件不存在 / 无视频轨 / 时长过短 → 结构化错误。
 *   3. 摄像头替换导入：H.264 直拷（不转码）；MKV / HEVC 转码为 H.264 MP4；
 *      文件落在 media/camera-replacement-<uuid>/camera.<ext>；失败无残留。
 *   4. 源文件导出：屏幕 / 摄像头 / 麦克风 逐字节复制；任一缺失 → 回滚删除。
 *
 * 运行：node tools/test-media-exchange.mjs
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const mediaExchange = require("../src/main/media-exchange.js");
const exporter = require("../src/main/exporter.js");

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dogsc-media-exchange-"));
const ffmpeg = exporter.ffmpegPath();

function makeVideo(file, { codec = "libx264", duration = 1, size = "320x240" } = {}) {
  const args = ["-y", "-f", "lavfi", "-i", `testsrc=duration=${duration}:size=${size}:rate=30`];
  if (codec === "libx265") args.push("-c:v", "libx265", "-pix_fmt", "yuv420p", "-tag:v", "hvc1");
  else args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  args.push(file);
  const result = spawnSync(ffmpeg, args, { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`ffmpeg 生成 ${file} 失败: ${result.stderr?.slice(-300)}`);
  return file;
}

function makeAudioOnly(file) {
  const result = spawnSync(
    ffmpeg,
    ["-y", "-f", "lavfi", "-i", "sine=duration=1", "-c:a", "aac", file],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(`ffmpeg 生成 ${file} 失败: ${result.stderr?.slice(-300)}`);
  return file;
}

/* ------------------------------------------------------------------ */
/* 1. 命名与目录规则                                                   */
/* ------------------------------------------------------------------ */
{
  const { sanitizeProjectTitle, uniqueExportFolder } = mediaExchange;
  check(
    "标题清理：斜杠与冒号变 -",
    sanitizeProjectTitle("a/b:c") === "a-b-c",
    sanitizeProjectTitle("a/b:c")
  );
  check(
    "标题清理：Windows 保留字符",
    sanitizeProjectTitle('x\\y*z?w"v<u>t|s') === "x-y-z-w-v-u-t-s",
    sanitizeProjectTitle('x\\y*z?w"v<u>t|s')
  );
  check("标题清理：空白回退", sanitizeProjectTitle("   ") === "未命名录制");

  const parent = path.join(root, "folders");
  fs.mkdirSync(parent, { recursive: true });
  const first = uniqueExportFolder(parent, "演示-源文件");
  fs.mkdirSync(first, { recursive: true });
  const second = uniqueExportFolder(parent, "演示-源文件");
  fs.mkdirSync(second, { recursive: true });
  const third = uniqueExportFolder(parent, "演示-源文件");
  check(
    "重名递增 -2 / -3",
    path.basename(first) === "演示-源文件" &&
      path.basename(second) === "演示-源文件-2" &&
      path.basename(third) === "演示-源文件-3",
    [first, second, third].map((p) => path.basename(p)).join(" / ")
  );
}

/* ------------------------------------------------------------------ */
/* 2. 摄像头替换校验                                                   */
/* ------------------------------------------------------------------ */
{
  const missing = path.join(root, "不存在.mp4");
  let code = "";
  try {
    await mediaExchange.inspectCameraReplacement(missing);
  } catch (error) {
    code = error.code;
  }
  check("校验：文件不存在 → missing-file", code === "missing-file", code);

  const audioOnly = makeAudioOnly(path.join(root, "纯音频.m4a"));
  code = "";
  try {
    await mediaExchange.inspectCameraReplacement(audioOnly);
  } catch (error) {
    code = error.code;
  }
  check("校验：无视频轨 → no-video-track", code === "no-video-track", code);
}

/* ------------------------------------------------------------------ */
/* 3. 摄像头替换导入                                                   */
/* ------------------------------------------------------------------ */
{
  const pkg = path.join(root, "项目A.dogscproject");
  fs.mkdirSync(pkg, { recursive: true });

  /* 3a. H.264 MP4 直拷 */
  const direct = makeVideo(path.join(root, "direct.mp4"));
  const imported = await mediaExchange.importCameraReplacement({ packagePath: pkg, source: direct });
  const importedAbs = path.join(pkg, imported.path);
  check(
    "导入：路径形如 media/camera-replacement-<uuid>/camera.mp4",
    /^media\/camera-replacement-[0-9a-f-]+\/camera\.mp4$/.test(imported.path),
    imported.path
  );
  check("导入：文件已进入项目包", fs.existsSync(importedAbs));
  check(
    "导入：直拷不转码（字节一致）",
    fs.statSync(direct).size === fs.statSync(importedAbs).size,
    `${fs.statSync(direct).size} vs ${fs.statSync(importedAbs).size}`
  );
  check(
    "导入：时长与尺寸保留",
    Math.abs(imported.duration - 1) < 0.2 && imported.width === 320 && imported.height === 240,
    `${imported.duration.toFixed(3)}s ${imported.width}x${imported.height}`
  );
  check("导入：不带 offset（新素材自己的时间零点）", imported.offset === undefined);

  /* 3b. MKV 容器（内部同为 H.264）→ 必须转码 */
  const mkv = makeVideo(path.join(root, "same-codec.mkv"));
  const transcoded = await mediaExchange.importCameraReplacement({ packagePath: pkg, source: mkv });
  check(
    "导入：MKV 容器转码为 camera.mp4",
    /^media\/camera-replacement-[0-9a-f-]+\/camera\.mp4$/.test(transcoded.path),
    transcoded.path
  );
  const probe = await exporter.probeMedia(path.join(pkg, transcoded.path));
  check("导入：转码输出为 h264", probe?.videoCodec === "h264", JSON.stringify(probe));
  check(
    "导入：转码保留时长",
    Math.abs((probe?.duration ?? 0) - 1) < 0.3,
    String(probe?.duration)
  );

  /* 3b2. HEVC MP4（Chromium 不能解码）→ 必须转码 */
  const hevc = makeVideo(path.join(root, "hevc.mp4"), { codec: "libx265" });
  const fromHevc = await mediaExchange.importCameraReplacement({ packagePath: pkg, source: hevc });
  const hevcProbe = await exporter.probeMedia(path.join(pkg, fromHevc.path));
  check(
    "导入：HEVC 转码为 h264/mp4",
    fromHevc.path.endsWith("camera.mp4") && hevcProbe?.videoCodec === "h264",
    `${fromHevc.path} ${hevcProbe?.videoCodec}`
  );

  /* 3c. 失败无残留：目录里没有半成品 */
  const leftovers = fs
    .readdirSync(path.join(pkg, "media"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("camera-replacement-"));
  check("导入：三次替换产生三个独立目录", leftovers.length === 3, String(leftovers.length));
}

/* ------------------------------------------------------------------ */
/* 4. 源文件导出                                                       */
/* ------------------------------------------------------------------ */
{
  const pkg = path.join(root, "项目B.dogscproject");
  fs.mkdirSync(path.join(pkg, "media"), { recursive: true });
  const media = {
    "media/screen.webm": Buffer.from("screen-bytes"),
    "media/camera.webm": Buffer.from("camera-bytes"),
    "media/microphone.webm": Buffer.from("microphone-bytes"),
  };
  for (const [rel, bytes] of Object.entries(media)) {
    fs.writeFileSync(path.join(pkg, rel), bytes);
  }

  const parent = path.join(root, "exports");
  fs.mkdirSync(parent, { recursive: true });
  const folder = await mediaExchange.exportSources({
    packagePath: pkg,
    title: "我的 录制/1",
    parent,
    references: {
      screen: "media/screen.webm",
      camera: "media/camera.webm",
      microphone: "media/microphone.webm",
    },
  });
  check(
    "导出：目录名清理 + -源文件",
    path.basename(folder) === "我的 录制-1-源文件",
    path.basename(folder)
  );
  check(
    "导出：屏幕 / 摄像头 / 麦克风",
    fs.existsSync(path.join(folder, "屏幕.webm")) &&
      fs.existsSync(path.join(folder, "摄像头.webm")) &&
      fs.existsSync(path.join(folder, "麦克风.webm")),
    fs.readdirSync(folder).join(" / ")
  );
  check(
    "导出：逐字节复制",
    fs.readFileSync(path.join(folder, "屏幕.webm")).equals(media["media/screen.webm"])
  );

  /* 无摄像头 / 麦克风时只导出屏幕（原版 copy 仅在存在时执行） */
  const folder2 = await mediaExchange.exportSources({
    packagePath: pkg,
    title: "我的 录制/1",
    parent,
    references: { screen: "media/screen.webm" },
  });
  check(
    "导出：重名递增且只含屏幕",
    path.basename(folder2) === "我的 录制-1-源文件-2" &&
      fs.readdirSync(folder2).join() === "屏幕.webm",
    `${path.basename(folder2)}: ${fs.readdirSync(folder2).join()}`
  );

  /* 源文件缺失 → 回滚删除整个目录 */
  let code = "";
  try {
    await mediaExchange.exportSources({
      packagePath: pkg,
      title: "坏的",
      parent,
      references: { screen: "media/missing.webm" },
    });
  } catch (error) {
    code = error.code;
  }
  check("导出：缺失源文件 → missing-source", code === "missing-source", code);
  check("导出：失败后目录已回滚", !fs.existsSync(path.join(parent, "坏的-源文件")));
}

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
