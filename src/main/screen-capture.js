/**
 * 屏幕采集（ffmpeg ddagrab / Desktop Duplication）。
 *
 * 对应原版的 ScreenRecorder（ScreenCaptureKit）在 Windows 上的替代实现，
 * 移植方式对齐参考实现 docs/reference-xiaoying-port/src_main_ffmpeg.js：
 *
 *   · ddagrab 恒定帧率采集、不绘制系统光标（光标由编辑器按记录轨迹重合成）；
 *   · 采集端统一按 BT.709 窄范围转换并写入码流标记；
 *   · 硬件编码器逐个试编实测择优（NVENC → Media Foundation → AMF → x264）；
 *   · 第一帧到达时把系统时钟打到 stderr（setpts 技巧），作为全项目的时间
 *     原点：指针轨、摄像头、系统声音和麦克风都以这个时钟对齐。
 *
 * 采集期间写入 matroska（.mkv），停止后用 -c copy 重封装 MP4——不用等
 * moov 就能安全中断。暂停/继续按分段实现：暂停时优雅结束当前段，继续时
 * 开新段，收尾时 concat 合并（两段共用同一编码参数，无缝拼接）。
 */

const { spawn } = require("child_process");
const fsp = require("fs/promises");
const fs = require("fs");
const path = require("path");
const { screen } = require("electron");

const exporter = require("./exporter");
const { childEnv } = require("./child-env");

const FIRST_FRAME_TIMEOUT_MS = 10000;
const STOP_GRACE_MS = 8000;

/* 采集端色彩转换常量，见参考实现。 */
const COLOR_FILTER = "scale=out_color_matrix=bt709:out_range=tv";
const COLOR_TAGS = [
  "-bsf:v",
  "h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1:video_full_range_flag=0",
];

const ENCODERS = [
  {
    name: "h264_nvenc",
    label: "NVIDIA NVENC",
    format: "nv12",
    args: (bitrate) => ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "vbr", "-b:v", String(bitrate), "-maxrate", String(bitrate * 2)],
  },
  {
    name: "h264_mf",
    label: "系统硬件编码（Media Foundation）",
    format: "nv12",
    args: (bitrate) => ["-c:v", "h264_mf", "-hw_encoding", "1", "-b:v", String(bitrate)],
  },
  {
    name: "h264_amf",
    label: "AMD AMF",
    format: "nv12",
    args: (bitrate) => ["-c:v", "h264_amf", "-b:v", String(bitrate)],
  },
  {
    name: "libx264",
    label: "软件编码（x264）",
    format: "yuv420p",
    args: () => ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "17"],
  },
];

/* ------------------------------------------------------------------------- */
/* 能力与编码器探测                                                           */
/* ------------------------------------------------------------------------- */

let capabilityPromise = null;
let detectedEncoder = null;

/**
 * ddagrab 是否可用。分两步实测并缓存：
 *   1) 内置 ffmpeg 是否带 ddagrab 滤镜；
 *   2) 用主输出真实抓 2 帧 —— 远程会话 / 虚拟显示 / 部分混合显卡机器上
 *      Desktop Duplication 不受支持（"Selected output not supported"），
 *      与其在录制时才失败再回退，不如预热时就定性，直接走 Chromium 采集。
 * DOGSC_LEGACY_RECORD=1 可强制走旧采集（诊断用）。
 */
function available() {
  if (process.env.DOGSC_LEGACY_RECORD) return Promise.resolve(false);
  if (!capabilityPromise) {
    capabilityPromise = (async () => {
      try {
        const filters = await new Promise((resolve, reject) => {
          const child = spawn(exporter.ffmpegPath(), ["-hide_banner", "-filters"], { windowsHide: true });
          let out = "";
          child.stdout.on("data", (chunk) => (out += chunk));
          child.on("error", reject);
          child.on("close", () => resolve(out));
        });
        if (!/\sddagrab\s/.test(filters)) return false;
        await exporter.runFfmpeg([
          "-hide_banner", "-loglevel", "error", "-nostats",
          "-filter_complex", "ddagrab=output_idx=0:draw_mouse=0:framerate=30,hwdownload,format=bgra",
          "-frames:v", "2", "-f", "null", "-",
        ]);
        return true;
      } catch {
        return false;
      }
    })();
  }
  return capabilityPromise;
}

/** 逐个试编 10 帧，取第一个真正可用的编码器（驱动过旧时 NVENC 会在此被跳过）。 */
async function detectEncoder() {
  if (detectedEncoder) return detectedEncoder;
  for (const encoder of ENCODERS) {
    try {
      await exporter.runFfmpeg([
        "-hide_banner",
        "-loglevel", "error",
        "-f", "lavfi",
        "-i", "color=c=gray:s=1280x720:r=30",
        "-frames:v", "10",
        "-vf", `format=${encoder.format}`,
        ...encoder.args(8000000),
        "-f", "null",
        "-",
      ]);
      detectedEncoder = encoder;
      return encoder;
    } catch {
      /* 试下一个 */
    }
  }
  throw new Error("没有可用的 H.264 编码器");
}

/** 应用启动后预热：能力+编码器探测提前完成，首个录制不必等。 */
async function warmup() {
  try {
    if (!(await available())) return null;
    return await detectEncoder();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* 来源映射                                                                   */
/* ------------------------------------------------------------------------- */

/** ddagrab 按 DXGI 输出序号选屏：主屏在前，其余按桌面坐标从左到右。 */
function outputIndexFor(displayId) {
  const primaryId = screen.getPrimaryDisplay().id;
  const displays = screen.getAllDisplays().sort(
    (a, b) =>
      (b.id === primaryId) - (a.id === primaryId) ||
      a.bounds.x - b.bounds.x ||
      a.bounds.y - b.bounds.y
  );
  const match = displays.find((display) => String(display.id) === String(displayId));
  return Math.max(0, displays.indexOf(match || displays[0]));
}

/** 采集区域（物理像素）：区域录制取所选显示内的一块，H.264 需要偶数宽高。 */
function captureGeometry(width, height, region, scaleFactor) {
  if (!region) return { width: Math.floor(width), height: Math.floor(height), rect: null };
  const sf = scaleFactor || 1;
  const floorEven = (value) => Math.max(64, Math.floor(value / 2) * 2);
  const left = Math.min(Math.max(Math.round(region.x * sf), 0), Math.max(Math.floor(width) - 64, 0));
  const top = Math.min(Math.max(Math.round(region.y * sf), 0), Math.max(Math.floor(height) - 64, 0));
  const rect = {
    x: left,
    y: top,
    width: floorEven(Math.min(Math.round((region.x + region.width) * sf), Math.floor(width)) - left),
    height: floorEven(Math.min(Math.round((region.y + region.height) * sf), Math.floor(height)) - top),
  };
  return { width: rect.width, height: rect.height, rect };
}

/* ------------------------------------------------------------------------- */
/* 采集会话                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * 开始一次屏幕采集。返回的句柄负责暂停 / 继续 / 收尾。
 *
 * options: { displayId, region, scaleFactor, fps, width, height, workingDir, onStderr }
 * 失败（无 ddagrab / 起不来 / 第一帧超时）时抛出可读错误，由调用方回退。
 */
async function begin({ displayId, region, scaleFactor, fps = 60, width, height, workingDir, onStderr }) {
  const encoder = await detectEncoder();
  const outputIndex = outputIndexFor(displayId);
  const geometry = captureGeometry(width, height, region, scaleFactor);
  const bitrate = Math.round(geometry.width * geometry.height * fps * 0.1);

  const segments = [];
  let current = null;
  let firstFrameTime = null;
  let stderrTail = "";

  async function startSegment() {
    /* 采集写裸 H.264 Annex B 流而非容器：媒体联合会（h264_mf）等编码器
       不保证及时给出 SPS/PPS extradata（"Didn't get extradata"），matroska
       封装会直接写不了头；裸流把参数集放在带内，任何编码器都成立，停止后
       再按帧率重封装成 MP4（与导出管线同一套做法）。 */
    const file = path.join(workingDir, `screen-ff-${segments.length}.h264`);
    let filter = `ddagrab=output_idx=${outputIndex}:draw_mouse=0:framerate=${fps}`;
    if (geometry.rect) {
      filter += `:video_size=${geometry.rect.width}x${geometry.rect.height}:offset_x=${geometry.rect.x}:offset_y=${geometry.rect.y}`;
    }
    /* setpts 里的 print(time(0)) 只在第 0 帧执行一次，把首帧系统时钟打到
       stderr，PTS 本身不变 —— 这就是整个项目的时间原点。 */
    const graph = `${filter},setpts='PTS+0*if(eq(N,0),print(time(0)),0)',hwdownload,format=bgra,${COLOR_FILTER},format=${encoder.format}`;
    const args = [
      "-hide_banner", "-loglevel", "info", "-nostats", "-y",
      "-filter_complex", graph,
      ...encoder.args(bitrate),
      "-g", String(fps),
      ...COLOR_TAGS,
      "-f", "h264", file,
    ];
    /* 与导出一致的极简环境：应用从携带超大环境块的终端启动时（CI、IDE
       终端、沙箱），继承的完整环境会让 ffmpeg 的桌面复制初始化失败
       （"Selected output not supported"）——childEnv() 只转发必要变量。 */
    const child = spawn(exporter.ffmpegPath(), args, {
      windowsHide: true,
      stdio: ["pipe", "ignore", "pipe"],
      env: childEnv(),
    });

    let exited = false;
    let resolveFirst;
    let rejectFirst;
    const firstFrame = new Promise((resolve, reject) => {
      resolveFirst = resolve;
      rejectFirst = reject;
    });
    firstFrame.catch(() => {});
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = (stderrTail + text).slice(-4000);
      if (onStderr) onStderr(text);
      /* ffmpeg 的 eval print() 输出形如 `1791710833.797275` 的裸数字（不同
         版本可能带 "[Eval @ ...]" 前缀，两种都认）。 */
      const match = /(?:\[Eval @ [^\]]+\]\s+)?(\d{9,11}\.\d+)\s*$/m.exec(stderrTail);
      if (match) resolveFirst(Number(match[1]));
    });
    const closed = new Promise((resolve) => {
      child.on("close", (code) => {
        exited = true;
        rejectFirst(new Error(`采集进程退出（${code}）：${stderrTail.trim().split(/\r?\n/).slice(-8).join(" / ")}`));
        resolve(code);
      });
    });
    child.on("error", (error) => rejectFirst(error));

    const stop = async () => {
      if (!exited) {
        try {
          child.stdin.write("q");
        } catch {
          /* 进程已退出 */
        }
        const timer = setTimeout(() => child.kill(), STOP_GRACE_MS);
        await closed;
        clearTimeout(timer);
      }
    };

    return { file, firstFrame, closed, stop, get exited() { return exited; } };
  }

  /* 第一段：第一帧超时视为启动失败（调用方回退到 Chromium 采集）。
     遇到 "Selected output not supported" 时短重试：Chromium 的
     desktopCapturer（列出来源/缩略图）会短暂占用桌面复制会话，ddagrab 需要
     等它释放 —— 通常重试一两次即可，用户真实流程里缩略图与录制相隔几秒，
     几乎不会撞上，但自动化测试会连续调用，必须容错。 */
  let started = false;
  let lastError = null;
  for (let attempt = 0; attempt < 8 && !started; attempt += 1) {
    current = await startSegment();
    try {
      firstFrameTime = await Promise.race([
        current.firstFrame,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`屏幕采集启动超时：${stderrTail.trim().split(/\r?\n/).slice(-3).join(" / ")}`)), FIRST_FRAME_TIMEOUT_MS)
        ),
      ]);
      started = true;
    } catch (error) {
      lastError = error;
      await current.stop().catch(() => {});
      const transient = /Selected output not supported|Failed to configure|DuplicateOutput/i.test(String(error.message));
      if (!transient || attempt === 7) throw error;
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  }
  if (!started) throw lastError || new Error("屏幕采集启动失败");
  segments.push(current);

  let finished = false;

  async function stopCurrent() {
    if (!current) return;
    await current.stop();
    if (fs.existsSync(current.file) && fs.statSync(current.file).size > 4096) {
      current.done = true;
    }
    current = null;
  }

  return {
    get firstFrameTime() { return firstFrameTime; },
    encoder: `${encoder.name} / ${geometry.width}x${geometry.height}@${fps}`,

    /** 暂停：优雅结束当前段（继续时开新段，收尾时拼接）。 */
    async pause() {
      await stopCurrent();
    },

    /** 继续：开一段新视频。 */
    async resume() {
      if (finished || current) return;
      try {
        current = await startSegment();
        await Promise.race([
          current.firstFrame,
          new Promise((_, reject) => setTimeout(() => reject(new Error("采集恢复超时")), FIRST_FRAME_TIMEOUT_MS)),
        ]);
        segments.push(current);
      } catch (error) {
        current = null;
        throw error;
      }
    },

    /**
     * 收尾：停止采集 → 逐段重封装 MP4 →（多段时）concat 合并 → 探测信息 →
     * 抽首帧做封面。返回 { file, duration, width, height, firstFrameTime, encoder }。
     */
    async finish() {
      if (finished) return null;
      finished = true;
      await stopCurrent();

      const usable = segments.filter((segment) => fs.existsSync(segment.file) && fs.statSync(segment.file).size > 4096);
      if (!usable.length) return null;

      const parts = [];
      for (let index = 0; index < usable.length; index += 1) {
        const mp4 = path.join(workingDir, `screen-part-${index}.mp4`);
        /* 裸流按恒定帧率重封装（ddagrab 就是恒定帧率采集）。 */
        await exporter.runFfmpeg([
          "-loglevel", "error",
          "-f", "h264", "-r", String(fps),
          "-i", usable[index].file,
          "-c", "copy", "-movflags", "+faststart", mp4,
        ]);
        parts.push(mp4);
      }

      const output = path.join(workingDir, "screen.mp4");
      if (parts.length === 1) {
        await fsp.rename(parts[0], output);
      } else {
        const list = path.join(workingDir, "concat.txt");
        await fsp.writeFile(list, parts.map((part) => `file '${path.basename(part)}'`).join("\n"), "utf8");
        await exporter.runFfmpeg(["-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
        await Promise.all(parts.map((part) => fsp.rm(part, { force: true })));
      }
      await Promise.all(usable.map((segment) => fsp.rm(segment.file, { force: true })));

      const info = await probeVideo(output);

      /* 封面：首帧 png，缩到 640 宽与渲染层抓图一致。 */
      const poster = path.join(workingDir, "poster.png");
      await exporter
        .runFfmpeg(["-loglevel", "error", "-i", output, "-vf", "scale=640:-2", "-frames:v", "1", "-y", poster])
        .catch(() => {});

      return {
        file: output,
        duration: info.duration,
        width: info.width,
        height: info.height,
        firstFrameTime,
        encoder: `${encoder.name} / ${geometry.width}x${geometry.height}@${fps}`,
      };
    },

    /** 取消：停止并删除所有中间文件。 */
    async cancel() {
      finished = true;
      await stopCurrent();
      await Promise.all(segments.map((segment) => fsp.rm(segment.file, { force: true }).catch(() => {})));
    },
  };
}

/**
 * 崩溃恢复：把中断采集留下的裸 H.264 段离线重封装并拼接成 screen.mp4。
 * 这是 finish() 的收尾部分，不需要活的 ffmpeg 子进程 —— 录制崩溃后重启时
 * 由恢复流程调用。成功后删除裸流段，保证同一工作目录不会二次恢复。
 * 返回值与 finish() 一致（firstFrameTime 不可知，由调用方从清单取）。
 */
async function salvage(workingDir, fps = 60) {
  const names = (await fsp.readdir(workingDir).catch(() => []))
    .filter((name) => /^screen-ff-\d+\.h264$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  const usable = names
    .map((name) => path.join(workingDir, name))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).size > 4096);
  if (!usable.length) return null;

  const parts = [];
  for (let index = 0; index < usable.length; index += 1) {
    const mp4 = path.join(workingDir, `recovered-part-${index}.mp4`);
    await exporter.runFfmpeg([
      "-loglevel", "error",
      "-f", "h264", "-r", String(fps),
      "-i", usable[index],
      "-c", "copy", "-movflags", "+faststart", mp4,
    ]);
    parts.push(mp4);
  }

  const output = path.join(workingDir, "screen.mp4");
  if (parts.length === 1) {
    await fsp.rename(parts[0], output);
  } else {
    const list = path.join(workingDir, "recovered-concat.txt");
    await fsp.writeFile(list, parts.map((part) => `file '${path.basename(part)}'`).join("\n"), "utf8");
    await exporter.runFfmpeg(["-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
    await Promise.all(parts.map((part) => fsp.rm(part, { force: true })));
    await fsp.rm(list, { force: true });
  }
  await Promise.all(usable.map((file) => fsp.rm(file, { force: true })));

  const info = await probeVideo(output);
  if (!info.duration) return null;
  return {
    file: output,
    duration: info.duration,
    width: info.width,
    height: info.height,
    firstFrameTime: null,
  };
}

/** 解析 ffmpeg -i 输出，取时长与视频尺寸（不依赖 ffprobe）。 */
async function probeVideo(file) {  let stderr = "";
  try {
    await exporter.runFfmpeg(["-i", file, "-hide_banner"]);
  } catch (error) {
    /* 探测命令没有输出文件，退出码非 0 是正常的，stderr 里才是信息。 */
    stderr = String(error.message || "");
  }
  const durationMatch = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const videoMatch = /Video:.*?(\d{2,5})x(\d{2,5})/.exec(stderr);
  const duration = durationMatch
    ? Number(durationMatch[1]) * 3600 + Number(durationMatch[2]) * 60 + Number(durationMatch[3])
    : 0;
  return {
    duration,
    width: videoMatch ? Number(videoMatch[1]) : null,
    height: videoMatch ? Number(videoMatch[2]) : null,
  };
}

/**
 * 采集链路诊断（DOGSC_DDAGRAB_LAB=1）：逐段验证滤镜图，输出每一步的
 * 完整 stderr —— ddagrab 相关问题的排障入口。
 */
async function diagnose() {
  const path = require("path");
  const os = require("os");
  const { desktopCapturer } = require("electron");
  const encoder = await detectEncoder().catch(() => null);
  console.log(`[ddagrab-lab] encoder = ${encoder ? encoder.name : "none"}`);

  /* 前情提要实验：界面列出录制来源（真实缩略图）之后再测 ddagrab ——
     验证 Chromium 的桌面捕获会话是否会占住桌面复制。 */
  await desktopCapturer.getSources({ types: ["screen", "window"] }).catch(() => []);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const base = "ddagrab=output_idx=0:draw_mouse=0:framerate=30";
  const clocked = `${base},setpts='PTS+0*if(eq(N,0),print(time(0)),0)'`;
  const variants = [
    ["V1 纯采集", `${base},hwdownload,format=bgra`, ["-frames:v", "2", "-f", "null", "-"]],
    ["V2 +setpts首帧时钟", `${clocked},hwdownload,format=bgra`, ["-frames:v", "2", "-f", "null", "-"]],
    ["V3 +色彩转换(nv12)", `${clocked},hwdownload,format=bgra,${COLOR_FILTER},format=nv12`, ["-frames:v", "2", "-f", "null", "-"]],
  ];
  if (encoder) {
    variants.push([
      `V4 ${encoder.name} + null输出`,
      `${clocked},hwdownload,format=bgra,${COLOR_FILTER},format=${encoder.format}`,
      [...encoder.args(12000000), "-g", "30", "-frames:v", "60", "-f", "null", "-"],
    ]);
    variants.push([
      `V5 完整图+${encoder.name}+裸流`,
      `${clocked},hwdownload,format=bgra,${COLOR_FILTER},format=${encoder.format}`,
      [...encoder.args(12000000), "-g", "30", ...COLOR_TAGS, "-frames:v", "60", "-f", "h264", path.join(os.tmpdir(), "dogsc-ddagrab-lab.h264")],
    ]);
  }
  for (const [name, graph, tail] of variants) {
    try {
      const result = await exporter.runFfmpeg(["-hide_banner", "-loglevel", "verbose", "-nostats", "-y", "-filter_complex", graph, ...tail]);
      const stderr = String(result?.stderr || "");
      const clock = /(?:\[Eval @ [^\]]+\]\s+)?(\d{9,11}\.\d+)\s*$/m.exec(stderr);
      console.log(`[ddagrab-lab] ${name}: PASS${clock ? " (firstFrameClock=" + clock[1] + ")" : ""}`);
      if (name.startsWith("V2")) {
        const clockLines = stderr.split(/\r?\n/).filter((line) => line.includes("Eval") || line.includes("time(0)") || /\d{9,}\.\d+/.test(line));
        console.log(`[ddagrab-lab] V2 clock-line dump: ${JSON.stringify(clockLines.slice(0, 5))}`);
      }
    } catch (error) {
      console.log(`[ddagrab-lab] ${name}: FAIL`);
      const detail = String(error.message).split("\n").slice(1).join(" / ");
      console.log(`[ddagrab-lab] ${name} stderr: …${detail.slice(-1100)}`);
    }
  }
  console.log("[ddagrab-lab] done");
}

/** 轻量 ddagrab 探针（排障用）：抓 2 帧验证当前是否可复制。 */
async function probeDdagrab(label) {
  try {
    await exporter.runFfmpeg([
      "-hide_banner", "-loglevel", "error", "-nostats",
      "-filter_complex", "ddagrab=output_idx=0:draw_mouse=0:framerate=30,hwdownload,format=bgra",
      "-frames:v", "2", "-f", "null", "-",
    ]);
    console.log(`[ddagrab-probe] ${label}: PASS`);
  } catch (error) {
    console.log(`[ddagrab-probe] ${label}: FAIL → ${String(error.message).split("\n").slice(1).join(" / ").slice(-260)}`);
  }
}

/** 排障：以 begin 的真实参数逐级拼装命令，定位失败参数。 */
async function probeDdagrabDeep(label, workingDir) {
  const encoder = detectedEncoder || (await detectEncoder().catch(() => null));
  const graph = `ddagrab=output_idx=0:draw_mouse=0:framerate=30,setpts='PTS+0*if(eq(N,0),print(time(0)),0)',hwdownload,format=bgra,${COLOR_FILTER},format=${encoder ? encoder.format : "nv12"}`;
  const steps = [
    ["C1 图→null", ["-hide_banner", "-loglevel", "error", "-nostats", "-filter_complex", graph, "-frames:v", "10", "-f", "null", "-"]],
    ["C2 图+编码→null", ["-hide_banner", "-loglevel", "error", "-nostats", "-filter_complex", graph, ...(encoder ? encoder.args(6220800) : []), "-g", "30", ...COLOR_TAGS, "-frames:v", "30", "-f", "null", "-"]],
    ["C3 完整命令→文件", ["-hide_banner", "-loglevel", "info", "-nostats", "-y", "-filter_complex", graph, ...(encoder ? encoder.args(6220800) : []), "-g", "30", ...COLOR_TAGS, "-frames:v", "30", "-f", "h264", path.join(workingDir, "probe-c3.h264")]],
  ];
  for (const [name, args] of steps) {
    try {
      await exporter.runFfmpeg(args);
      console.log(`[ddagrab-deep] ${label} ${name}: PASS`);
    } catch (error) {
      console.log(`[ddagrab-deep] ${label} ${name}: FAIL → ${String(error.message).split("\n").slice(1).join(" / ").slice(-300)}`);
      return;
    }
  }
}

module.exports = {
  available,
  warmup,
  detectEncoder,
  outputIndexFor,
  begin,
  salvage,
  probeVideo,
  diagnose,
  probeDdagrab,
  probeDdagrabDeep,
};
