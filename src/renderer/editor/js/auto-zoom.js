/**
 * 自动运镜（自动缩放规划 + 自动跟随镜头）。
 *
 * 逐项移植自原版 RecorderCore/AutoZoomPlanner.swift 与 ZoomAnimation.swift，
 * 公式与常量对齐参考资料 docs/reference-xiaoying-port/src_core_zoom.js 与
 * src_core_pointer.js（automaticCameraFocus 部分）：
 *
 *   规划：按点击分组 → 空间聚焦区域 → 生成缩放段 → 指针活动延长保持
 *        → 合并连续包络（连续操作时镜头保持，不停下来回弹）。
 *   跟随：进入动画结束后，只有指针走出安全区才移动目标，镜头再用屏幕弹簧
 *        追过去（屏幕弹簧参数取自 document.motion.screenSpring*）。
 *
 * 本模块输出本项目的时间线片段形状（startTime + duration），mode 为 "自动"
 * 的缩放片段在渲染时会用 automaticFocusAt 的焦点覆盖静态 focus。
 * 指针坐标与手动缩放一致，都是相对完整录制帧的归一化坐标；裁切的重定基
 * 由渲染端（layoutScreen）统一处理。
 */

import { rid, timelineDuration } from "./model.js";
import { eventsFor } from "./pointer-smooth.js";

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

const ADJACENCY_TOLERANCE = 1 / 120;
const FOCUS_EDGE_INSET = 0;

/* AutoZoomPlanner.swift 常量。 */
const HOLD_DURATION = 0.9;
const CLICK_GROUP_GAP = 1.4;
const SAFE_INSET = 0.12;
const ACTIVITY_IDLE_GAP = 1.4;
const SETTLE_HOLD = 0.55;
const START_SPACING = 0.16;

/* ProjectPointerTrack.automaticCameraFocus 常量。 */
const FOLLOW_INTERVAL = 1 / 120;
const REST_AREA_RATIO = 0.22;

const isClick = (event) => event.kind === "leftClick" || event.kind === "rightClick";

/* ------------------------------------------------------------------------- */
/* 规划                                                                       */
/* ------------------------------------------------------------------------- */

const clipEnd = (clip) => clip.startTime + clip.duration;
/** 对应参考实现的 effectEndTime：退出动画结束才是"效果真正离场"。 */
const effectEnd = (clip) => clipEnd(clip) + clip.transitionOut;

function constrained(point, safeInset) {
  const inset = clamp(safeInset, 0, 0.5);
  return { x: clamp(point.x, inset, 1 - inset), y: clamp(point.y, inset, 1 - inset) };
}

function makeAutoClip({ startTime, endTime, scale, focus, easing, enterDuration, exitDuration }) {
  const start = Math.max(startTime, 0);
  const end = Math.max(endTime, start);
  return {
    id: rid(),
    startTime: start,
    duration: end - start,
    mode: "自动",
    focus: constrained(focus, FOCUS_EDGE_INSET),
    scale: Math.max(scale ?? 1.6, 1),
    easing,
    transitionIn: clamp(enterDuration ?? 0.7, 0, 5),
    transitionOut: clamp(exitDuration ?? 0.7, 0, 5),
  };
}

function spatialFocusGroups(clicks, maximumSpanX, maximumSpanY) {
  const groups = [];
  for (const click of clicks) {
    const last = groups[groups.length - 1];
    if (
      last &&
      Math.max(last.maxX, click.x) - Math.min(last.minX, click.x) <= maximumSpanX &&
      Math.max(last.maxY, click.y) - Math.min(last.minY, click.y) <= maximumSpanY
    ) {
      last.minX = Math.min(last.minX, click.x);
      last.maxX = Math.max(last.maxX, click.x);
      last.minY = Math.min(last.minY, click.y);
      last.maxY = Math.max(last.maxY, click.y);
    } else {
      groups.push({ firstTime: click.time, minX: click.x, maxX: click.x, minY: click.y, maxY: click.y });
    }
  }
  return groups;
}

function planFromClicks(clicks, { zoomScale, enterDuration, exitDuration, easing }) {
  const temporalGroups = [];
  for (const click of clicks) {
    const group = temporalGroups[temporalGroups.length - 1];
    if (group && click.time - group[group.length - 1].time <= CLICK_GROUP_GAP) group.push(click);
    else temporalGroups.push([click]);
  }

  const animations = [];
  let earliestNextStart = 0;
  for (const group of temporalGroups) {
    const first = group[0];
    const last = group[group.length - 1];
    /* 相邻点击共用一个镜头区域：只有累计点击范围放不进缩放视口时才换区域。 */
    const visibleExtent = 1 / Math.max(zoomScale, 1);
    const focusGroups = spatialFocusGroups(group, visibleExtent * 0.5, visibleExtent * 0.7);
    if (!focusGroups.length) continue;
    /* 点击启动自动镜头，但何时离开由指针活动决定（见 extendHolds）。 */
    const starts = [Math.max(first.time - enterDuration * 0.18, earliestNextStart, 0)];
    for (let i = 1; i < focusGroups.length; i += 1) {
      starts.push(
        Math.max(focusGroups[i].firstTime - enterDuration, starts[starts.length - 1] + START_SPACING)
      );
    }
    for (let i = 0; i < focusGroups.length; i += 1) {
      const start = starts[i];
      const isLast = i === focusGroups.length - 1;
      const end = isLast ? Math.max(last.time + HOLD_DURATION, start + enterDuration) : starts[i + 1];
      if (end - start <= 0.01) continue;
      const g = focusGroups[i];
      animations.push(
        makeAutoClip({
          startTime: start,
          endTime: end,
          scale: zoomScale,
          focus: constrained({ x: (g.minX + g.maxX) / 2, y: (g.minY + g.maxY) / 2 }, SAFE_INSET),
          easing,
          enterDuration,
          exitDuration: isLast ? exitDuration : 0,
        })
      );
    }
    earliestNextStart = animations.length ? effectEnd(animations[animations.length - 1]) : last.time;
  }
  return animations;
}

/**
 * 点击启动自动镜头，但何时离开由指针活动决定：活动连续时保持，停下后再留
 * 一小段（settleHold）再开始退出。
 */
function extendHoldsThroughPointerActivity(planned, clicks, events) {
  if (!planned.length || !clicks.length) return planned;
  const activity = events.filter((event) => event.time >= 0).sort((a, b) => a.time - b.time);
  const result = planned.map((clip) => ({ ...clip }));
  for (let index = 0; index < result.length; index += 1) {
    const clip = result[index];
    if (clip.transitionOut <= 0.001) continue;
    let lastClick = null;
    for (const click of clicks) {
      if (click.time <= clipEnd(clip) + 0.0001) lastClick = click;
      else break;
    }
    if (!lastClick || lastClick.time < clip.startTime - 0.0001) continue;
    const nextStart = index + 1 < result.length ? result[index + 1].startTime : Infinity;
    let previousActivityTime = lastClick.time;
    let activityEndTime = lastClick.time;
    for (const event of activity) {
      if (event.time <= lastClick.time) continue;
      if (event.time >= nextStart - 0.0001) break;
      if (event.time - previousActivityTime > ACTIVITY_IDLE_GAP) break;
      previousActivityTime = event.time;
      activityEndTime = event.time;
    }
    if (activityEndTime <= lastClick.time + 0.0001) continue;
    const extendedEnd = Math.min(Math.max(clipEnd(clip), activityEndTime + SETTLE_HOLD), nextStart);
    if (extendedEnd <= clipEnd(clip) + 0.0001) continue;
    clip.duration = extendedEnd - clip.startTime;
    if (Number.isFinite(nextStart)) {
      clip.transitionOut = Math.min(clip.transitionOut, Math.max(nextStart - extendedEnd, 0));
    }
  }
  return result;
}

/** 一次连续的交互只保留一段缩放包络，避免每段都从零速度重新缓动。 */
function mergeConnectedEnvelopes(animations) {
  const ordered = [...animations]
    .filter((clip) => clip.duration > 0.001)
    .sort((a, b) =>
      a.startTime === b.startTime ? (a.id < b.id ? -1 : 1) : a.startTime - b.startTime
    );
  const result = [];
  for (const animation of ordered) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.transitionOut <= ADJACENCY_TOLERANCE &&
      Math.abs(clipEnd(previous) - animation.startTime) <= ADJACENCY_TOLERANCE &&
      Math.abs(previous.scale - animation.scale) <= 0.000001 &&
      previous.easing === animation.easing
    ) {
      const end = Math.max(clipEnd(previous), clipEnd(animation));
      previous.duration = end - previous.startTime;
      previous.transitionOut = animation.transitionOut;
    } else {
      result.push({ ...animation });
    }
  }
  return result;
}

function clipToDuration(animations, duration) {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const result = [];
  for (const animation of animations) {
    if (animation.startTime >= duration) continue;
    const clipped = { ...animation };
    clipped.duration = Math.min(clipEnd(animation), duration) - animation.startTime;
    clipped.transitionOut = Math.min(
      clipped.transitionOut,
      Math.max(duration - clipEnd(clipped), 0)
    );
    if (clipped.duration > 0.01) result.push(clipped);
  }
  return result;
}

/**
 * 从指针轨迹生成自动运镜片段。options 可覆盖 motion 的默认参数；
 * duration 缺省取时间线时长（超出尾部的片段会被裁到边界）。
 */
export function planAutoZoom(document, options = {}) {
  const motion = document.motion || {};
  const events = eventsFor(document);
  const clicks = events.filter(isClick);
  const transition = clamp(
    options.transitionDuration ?? motion.defaultZoomTransitionDuration ?? 0.7,
    0,
    5
  );
  const planned = planFromClicks(clicks, {
    zoomScale: options.zoomScale ?? motion.defaultZoomScale ?? 1.4,
    enterDuration: transition,
    exitDuration: transition,
    easing: options.easing ?? motion.defaultZoomEasing ?? "spring",
  });
  const extended = extendHoldsThroughPointerActivity(planned, clicks, events);
  const merged = mergeConnectedEnvelopes(extended);
  const duration = options.duration ?? timelineDuration(document);
  return clipToDuration(merged, duration);
}

/* ------------------------------------------------------------------------- */
/* 自动跟随镜头                                                               */
/* ------------------------------------------------------------------------- */

/* 每个片段的 120Hz 焦点采样缓存；片段或弹簧参数变化时自动重建。 */
const cameraCache = new Map();

/**
 * mode 为 "自动" 的缩放片段在 `time` 时刻的实际焦点；手动片段或没有指针
 * 数据时返回 null（调用方回退到 clip.focus）。
 */
export function automaticFocusAt(document, clip, time) {
  if (!clip || clip.mode !== "自动") return null;
  const samples = cameraSamples(document, clip);
  if (!samples || !samples.times.length) return null;
  const { times, xs, ys } = samples;
  const t = clamp(time, clip.startTime, clipEnd(clip));
  const last = times.length - 1;
  if (t <= times[0]) return { x: xs[0], y: ys[0] };
  if (t >= times[last]) return { x: xs[last], y: ys[last] };
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (times[mid] <= t) low = mid;
    else high = mid;
  }
  const span = Math.max(times[high] - times[low], Number.MIN_VALUE);
  const progress = clamp((t - times[low]) / span, 0, 1);
  return {
    x: xs[low] + (xs[high] - xs[low]) * progress,
    y: ys[low] + (ys[high] - ys[low]) * progress,
  };
}

function cameraSamples(document, clip) {
  const motion = document.motion || {};
  const track = document.pointerTrack || {};
  const events = eventsFor(document);
  if (!events.length) return null;
  const key = [
    clip.id,
    clip.startTime,
    clip.duration,
    clip.scale,
    clip.focus?.x,
    clip.focus?.y,
    clip.transitionIn,
    motion.screenSpringMass,
    motion.screenSpringStiffness,
    motion.screenSpringDamping,
    track.samples?.length || 0,
    track.clicks?.length || 0,
  ].join("|");
  const cached = cameraCache.get(key);
  if (cached !== undefined) return cached;
  if (cameraCache.size > 24) cameraCache.clear();
  const samples = buildCameraSamples(clip, events, motion);
  cameraCache.set(key, samples);
  return samples;
}

/**
 * 对应 ProjectPointerTrack.makeAutomaticCameraSamples：以进入窗口内的第一
 * 次点击为初始构图，进入动画结束后开始跟随；指针走出安全区才移动目标，
 * 镜头用屏幕弹簧追过去。返回 120Hz 采样。
 */
function buildCameraSamples(clip, events, motion) {
  const start = clip.startTime;
  const end = clipEnd(clip);
  const duration = end - start;
  if (!(duration > 0)) return null;
  const followStart = Math.min(start + clamp(clip.transitionIn || 0, 0, duration), end);
  const entryClick = events.find((event) => isClick(event) && event.time >= start && event.time <= followStart);
  const entry = entryClick || interpolatedPosition(events, start) || clip.focus || { x: 0.5, y: 0.5 };
  const visibleHalfSpan = 1 / (2 * Math.max(clip.scale, 1));
  const restAreaHalfSpan = Math.max(visibleHalfSpan - 2 * visibleHalfSpan * REST_AREA_RATIO, 0.01);
  const mass = Math.max(motion.screenSpringMass ?? 2.4, 0.01);
  const stiffness = Math.max(motion.screenSpringStiffness ?? 210, 0.01);
  const damping = Math.max(motion.screenSpringDamping ?? 42, 0.01);

  let px = clamp(entry.x, 0, 1);
  let py = clamp(entry.y, 0, 1);
  let tx = px;
  let ty = py;
  let vx = 0;
  let vy = 0;
  let sampleTime = start;
  const times = [sampleTime];
  const xs = [px];
  const ys = [py];
  while (sampleTime < end) {
    const nextTime = Math.min(sampleTime + FOLLOW_INTERVAL, end);
    const cursor = nextTime >= followStart ? interpolatedPosition(events, nextTime) : null;
    if (cursor) {
      if (cursor.x < tx - restAreaHalfSpan || cursor.x > tx + restAreaHalfSpan) tx = clamp(cursor.x, 0, 1);
      if (cursor.y < ty - restAreaHalfSpan || cursor.y > ty + restAreaHalfSpan) ty = clamp(cursor.y, 0, 1);
    }
    const dt = Math.max(nextTime - sampleTime, 0);
    vx += ((stiffness * (tx - px) - damping * vx) / mass) * dt;
    vy += ((stiffness * (ty - py) - damping * vy) / mass) * dt;
    px = clamp(px + vx * dt, 0, 1);
    py = clamp(py + vy * dt, 0, 1);
    sampleTime = nextTime;
    times.push(sampleTime);
    xs.push(px);
    ys.push(py);
  }
  return { times, xs, ys };
}

/** 不做静止判定的线性插值，供自动镜头使用。 */
function interpolatedPosition(events, time) {
  if (!events.length) return null;
  if (time <= events[0].time) return events[0];
  const last = events[events.length - 1];
  if (time >= last.time) return last;
  let low = 0;
  let high = events.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (events[mid].time <= time) low = mid;
    else high = mid;
  }
  const a = events[low];
  const b = events[high];
  const span = Math.max(b.time - a.time, Number.MIN_VALUE);
  const progress = clamp((time - a.time) / span, 0, 1);
  return { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress };
}
