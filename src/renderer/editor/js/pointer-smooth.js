/**
 * 光标轨迹重建：240 Hz 二阶弹簧平滑 + 点击锚定 + 可见性判定。
 *
 * 逐项移植自原版 RecorderCore/PointerTrack.swift，公式与常量对齐参考资料
 * docs/reference-xiaoying-port/src_core_pointer.js：
 *   - 弹簧只追踪"稳定目标"：亚像素抖动不更新目标，间隔过长（指针曾静止）
 *     的跨越不插值，避免合成光标提前移动；
 *   - 点击锚定：在每次点击附近施加一段紧凑的 smoother-step 修正，使平滑后
 *     的路径精确经过点击位置，相邻点击的支撑区间止于两者中点；
 *   - 录制区域外（多显示器移出画面）不画光标，而不是让它贴着画面边缘。
 *
 * 本模块同时提供指针事件构建（pointerEventsFrom / eventsFor），供自动运镜
 * 的跟随镜头复用。
 */

const clamp = (value, minimum, maximum) => Math.min(Math.max(value, minimum), maximum);

const MAX_CONTINUOUS_INPUT_GAP = 0.12;
const MAX_SLOW_MOVE_GAP = 0.5;
const MAX_SLOW_MOVE_DISTANCE = 0.03;
const CLICK_ANCHOR_LEAD = 0.18;
const CLICK_ANCHOR_TRAIL = 0.18;
const SPRING_INTERVAL = 1 / 240;
const JITTER_THRESHOLD = 0.00035;

const isClick = (event) => event.kind === "leftClick" || event.kind === "rightClick";
const isInside = (event) => event.x >= 0 && event.x <= 1 && event.y >= 0 && event.y <= 1;

const smootherStep = (value) => {
  const t = clamp(value, 0, 1);
  return t * t * t * (t * (t * 6 - 15) + 10);
};

/* ------------------------------------------------------------------------- */
/* 指针事件                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * 把项目的 pointerTrack 整理成统一事件列表 { time, x, y, kind }。
 * 采样是移动，点击按键区分左右；滚轮按移动计入（活动判定用），不参与点击。
 */
export function pointerEventsFrom(document) {
  const track = document.pointerTrack;
  if (!track) return [];
  const events = [];
  let index = 0;
  for (const sample of track.samples || []) {
    if (Number.isFinite(sample.t) && Number.isFinite(sample.x) && Number.isFinite(sample.y)) {
      /* `cursor` is the sparse recorded shape (only where it changes), the
         port of the original's `recordedCursorAssetID` per event. */
      const event = { time: sample.t, x: sample.x, y: sample.y, kind: "move", index: index++ };
      if (sample.cursor) event.cursor = sample.cursor;
      events.push(event);
    }
  }
  for (const click of track.clicks || []) {
    if (!Number.isFinite(click.t) || !Number.isFinite(click.x) || !Number.isFinite(click.y)) continue;
    const kind =
      click.button === "left" ? "leftClick" : click.button === "right" ? "rightClick" : "move";
    events.push({ time: click.t, x: click.x, y: click.y, kind, index: index++ });
  }
  return events.sort((a, b) => a.time - b.time || a.index - b.index);
}

/* 事件列表按文档缓存；pointerTrack 在录制后不变，用长度做版本标记即可。 */
const eventCache = new WeakMap();

export function eventsFor(document) {
  const track = document.pointerTrack || {};
  const version = `${track.samples?.length || 0}:${track.clicks?.length || 0}`;
  const hit = eventCache.get(document);
  if (hit && hit.version === version) return hit.events;
  const events = pointerEventsFrom(document);
  eventCache.set(document, { version, events });
  return events;
}

/* ------------------------------------------------------------------------- */
/* 弹簧平滑                                                                   */
/* ------------------------------------------------------------------------- */

/// 间隔过长说明指针曾静止：跨越静止段插值会让合成光标提前移动。
function isContinuousMovement(lower, upper) {
  const duration = upper.time - lower.time;
  if (duration <= 0) return false;
  if (duration <= MAX_CONTINUOUS_INPUT_GAP) return true;
  if (duration > MAX_SLOW_MOVE_GAP) return false;
  const dx = upper.x - lower.x;
  const dy = upper.y - lower.y;
  return dx * dx + dy * dy <= MAX_SLOW_MOVE_DISTANCE * MAX_SLOW_MOVE_DISTANCE;
}

/// 第一个 time > target 的下标。
function upperBound(times, target) {
  let lower = 0;
  let upper = times.length;
  while (lower < upper) {
    const middle = (lower + upper) >> 1;
    if (times[middle] <= target) lower = middle + 1;
    else upper = middle;
  }
  return lower;
}

class PointerTrack {
  constructor(events) {
    this.events = events;
    this.eventTimes = events.map((event) => event.time);
    this.clicks = events.filter(isClick);
    this.clickTimes = this.clicks.map((click) => click.time);
    /* Sparse cursor-shape index, so shape lookups stay O(log n). */
    this.cursorTimes = [];
    this.cursorValues = [];
    for (const event of events) {
      if (event.cursor) {
        this.cursorTimes.push(event.time);
        this.cursorValues.push(event.cursor);
      }
    }
    this.springKey = null;
    this.spring = null;
  }

  /** The recorded shape in effect at `time` (null before the first change). */
  lastCursorAt(time) {
    const index = upperBound(this.cursorTimes, time);
    return index > 0 ? this.cursorValues[index - 1] : null;
  }

  springSamples(motion) {
    const key = `${motion.cursorSpringMass}|${motion.cursorSpringStiffness}|${motion.cursorSpringDamping}`;
    if (this.springKey !== key) {
      this.spring = this.makeSpringSamples(motion);
      this.springKey = key;
    }
    return this.spring;
  }

  makeSpringSamples(motion) {
    const events = this.events;
    if (!events.length) return { times: [], xs: [], ys: [] };
    const first = events[0];
    const last = events[events.length - 1];
    const mass = Math.max(motion.cursorSpringMass ?? 2.8, 0.01);
    const stiffness = Math.max(motion.cursorSpringStiffness ?? 450, 0.01);
    const damping = Math.max(motion.cursorSpringDamping ?? 66, 0.01);
    const settleDuration = Math.max(0.65, 6 * Math.sqrt(mass / stiffness));
    const endTime = Math.max(last.time, first.time) + settleDuration;
    const jitterSquared = JITTER_THRESHOLD * JITTER_THRESHOLD;

    let px = first.x;
    let py = first.y;
    let vx = 0;
    let vy = 0;
    let stableX = first.x;
    let stableY = first.y;
    let eventIndex = 1;
    let sampleTime = first.time;
    const times = [sampleTime];
    const xs = [px];
    const ys = [py];

    while (sampleTime < endTime) {
      const nextTime = Math.min(sampleTime + SPRING_INTERVAL, endTime);
      while (eventIndex < events.length && events[eventIndex].time <= nextTime) eventIndex += 1;
      const lower = events[Math.max(eventIndex - 1, 0)];
      let tx;
      let ty;
      if (eventIndex < events.length) {
        const upper = events[eventIndex];
        if (isContinuousMovement(lower, upper)) {
          const progress = clamp(
            (nextTime - lower.time) / Math.max(upper.time - lower.time, Number.MIN_VALUE),
            0,
            1
          );
          tx = lower.x + (upper.x - lower.x) * progress;
          ty = lower.y + (upper.y - lower.y) * progress;
        } else {
          tx = lower.x;
          ty = lower.y;
        }
      } else {
        tx = last.x;
        ty = last.y;
      }
      // 亚像素抖动不更新目标，弹簧只追踪稳定目标。
      if ((tx - stableX) ** 2 + (ty - stableY) ** 2 >= jitterSquared) {
        stableX = tx;
        stableY = ty;
      }
      const dt = Math.max(nextTime - sampleTime, 0);
      vx += ((stiffness * (stableX - px) - damping * vx) / mass) * dt;
      vy += ((stiffness * (stableY - py) - damping * vy) / mass) * dt;
      px = clamp(px + vx * dt, 0, 1);
      py = clamp(py + vy * dt, 0, 1);
      sampleTime = nextTime;
      times.push(sampleTime);
      xs.push(px);
      ys.push(py);
    }
    return this.anchorClicks({ times, xs, ys });
  }

  /**
   * 在每次点击附近施加一段紧凑的修正，使平滑后的路径精确经过点击位置，
   * 相邻点击的支撑区间止于两者中点，互不拉扯。
   */
  anchorClicks(base) {
    const clicks = this.clicks;
    if (!base.times.length || !clicks.length) return base;

    // 一次归并把点击时刻插进 240 Hz 网格。
    const times = [];
    const xs = [];
    const ys = [];
    let clickIndex = 0;
    for (let i = 0; i < base.times.length; i += 1) {
      while (clickIndex < clicks.length && clicks[clickIndex].time < base.times[i]) {
        const t = clicks[clickIndex].time;
        if (i > 0 && t > base.times[i - 1] && (!times.length || times[times.length - 1] !== t)) {
          const progress = (t - base.times[i - 1]) / (base.times[i] - base.times[i - 1]);
          times.push(t);
          xs.push(base.xs[i - 1] + (base.xs[i] - base.xs[i - 1]) * progress);
          ys.push(base.ys[i - 1] + (base.ys[i] - base.ys[i - 1]) * progress);
        }
        clickIndex += 1;
      }
      times.push(base.times[i]);
      xs.push(base.xs[i]);
      ys.push(base.ys[i]);
    }

    const lastTime = times[times.length - 1];
    for (let c = 0; c < clicks.length; c += 1) {
      const click = clicks[c];
      const anchorIndex = upperBound(times, click.time) - 1;
      if (anchorIndex < 0 || times[anchorIndex] !== click.time) continue;
      const previousTime = c > 0 ? clicks[c - 1].time : null;
      const nextTime = c + 1 < clicks.length ? clicks[c + 1].time : null;
      const supportStart = Math.max(
        times[0],
        click.time - CLICK_ANCHOR_LEAD,
        previousTime === null ? -Infinity : (previousTime + click.time) * 0.5
      );
      const supportEnd = Math.min(
        lastTime,
        click.time + CLICK_ANCHOR_TRAIL,
        nextTime === null ? Infinity : (click.time + nextTime) * 0.5
      );
      const correctionX = click.x - xs[anchorIndex];
      const correctionY = click.y - ys[anchorIndex];
      const from = upperBound(times, supportStart - 1e-12);
      const to = upperBound(times, supportEnd);
      for (let i = from; i < to; i += 1) {
        const t = times[i];
        let weight;
        if (t <= click.time) {
          const span = click.time - supportStart;
          weight = smootherStep(span > 0 ? (t - supportStart) / span : 1);
        } else {
          const span = supportEnd - click.time;
          weight = 1 - smootherStep(span > 0 ? (t - click.time) / span : 1);
        }
        xs[i] = clamp(xs[i] + correctionX * weight, 0, 1);
        ys[i] = clamp(ys[i] + correctionY * weight, 0, 1);
      }
      xs[anchorIndex] = click.x;
      ys[anchorIndex] = click.y;
    }
    return { times, xs, ys };
  }

  springLocation(time, motion) {
    const { times, xs, ys } = this.springSamples(motion);
    if (!times.length) return null;
    if (time <= times[0]) return { x: xs[0], y: ys[0] };
    const last = times.length - 1;
    if (time >= times[last]) return { x: xs[last], y: ys[last] };
    const upper = Math.min(upperBound(times, time), last);
    const lower = Math.max(upper - 1, 0);
    const progress = clamp(
      (time - times[lower]) / Math.max(times[upper] - times[lower], Number.MIN_VALUE),
      0,
      1
    );
    return {
      x: xs[lower] + (xs[upper] - xs[lower]) * progress,
      y: ys[lower] + (ys[upper] - ys[lower]) * progress,
    };
  }

  rawLocation(time) {
    const upperIndex = upperBound(this.eventTimes, time);
    const lower = this.events[Math.max(upperIndex - 1, 0)];
    const upper = this.events[upperIndex];
    if (upper && upper.time > lower.time && isContinuousMovement(lower, upper)) {
      const progress = clamp((time - lower.time) / (upper.time - lower.time), 0, 1);
      return { x: lower.x + (upper.x - lower.x) * progress, y: lower.y + (upper.y - lower.y) * progress };
    }
    return { x: lower.x, y: lower.y };
  }

  /// time 之前最后一个事件的时刻（静止判定用）。
  lastEventTime(time) {
    const index = upperBound(this.eventTimes, time);
    return index > 0 ? this.eventTimes[index - 1] : null;
  }
}

/* 每个文档一个轨实例；事件构建本身也按文档缓存。 */
const trackCache = new WeakMap();

function trackFor(document) {
  const events = eventsFor(document);
  if (!events.length) return null;
  const hit = trackCache.get(document);
  if (hit && hit.events === events) return hit.track;
  const track = new PointerTrack(events);
  trackCache.set(document, { events, track });
  return track;
}

/* ------------------------------------------------------------------------- */
/* 光标状态                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * `time` 时刻的合成光标状态：{ x, y, vx, vy, visible }。
 * - 位置为弹簧平滑 + 点击锚定后的轨迹（与 syncOffset 时间校准一致）；
 * - visible 为 false 表示不该画光标：录制区域外（指针移出画面），或
 *   开启了静止隐藏且超过 idleDelay；
 * - 没有指针数据（或早于第一个事件）时返回 null，调用方直接跳过绘制。
 */
export function cursorStateAt(document, time) {
  const track = trackFor(document);
  if (!track) return null;
  const style = document.cursorStyle || {};
  const motion = document.motion || {};
  const target = time - (style.syncOffset || 0);
  if (target < track.eventTimes[0]) return null;

  const position = track.springLocation(target, motion) || track.rawLocation(target);
  const raw = track.rawLocation(target);
  const lastEvent = track.lastEventTime(target);
  const idleFor = lastEvent === null ? 0 : target - lastEvent;
  const visible = isInside(raw) && (!style.hideWhenIdle || idleFor <= (style.idleDelay || 1.2));

  /* 挥摆动效用：平滑轨迹的有限差分速度。 */
  const h = 1 / 120;
  const before = track.springLocation(target - h, motion) || position;
  const after = track.springLocation(target + h, motion) || position;
  const vx = (after.x - before.x) / (2 * h);
  const vy = (after.y - before.y) / (2 * h);

  /* 录制中此刻显示的光标形状（"系统"样式跟随它切换）。 */
  const cursor = track.lastCursorAt(target);

  return { x: position.x, y: position.y, vx, vy, visible, cursor };
}
