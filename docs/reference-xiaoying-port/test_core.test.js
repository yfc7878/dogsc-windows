'use strict';
// 核心算法回归：期望值按 macOS 版 RecorderCore 的公式手算。运行：npm test
const assert = require('node:assert/strict');
const model = require('../src/core/model');
const zoom = require('../src/core/zoom');
const { PointerTrack } = require('../src/core/pointer');
const scene = require('../src/core/scene');
const timeline = require('../src/core/timeline');

const near = (actual, expected, tolerance = 1e-6, label = '') =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} expected ${expected}, got ${actual}`);
const motion = model.defaultMotion();
let passed = 0;
const test = (name, body) => { body(); passed += 1; console.log(`  ok  ${name}`); };

test('缓动曲线端点与中点', () => {
  near(zoom.bezierValue({ x1: 0.65, y1: 0, x2: 0.35, y2: 1 }, 0.5), 0.5, 1e-4);
  near(zoom.springProgress(0, 2.4, 210, 42), 0);
  near(zoom.springProgress(1, 2.4, 210, 42), 1);
  let previous = 0;
  for (let i = 1; i <= 20; i++) {
    const value = zoom.springProgress(i / 20, 2.4, 210, 42);
    assert.ok(value >= previous - 1e-9, '默认弹簧应单调');
    previous = value;
  }
});

test('自动缩放：单次点击', () => {
  const clips = zoom.planAutoZoom([{ time: 2, x: 0.5, y: 0.5, kind: 'leftClick' }]);
  assert.equal(clips.length, 1);
  near(clips[0].startTime, 2 - 0.7 * 0.18);
  near(clips[0].endTime, 2.9);
  near(clips[0].scale, 1.6);
  near(clips[0].exitDuration, 0.7);
  assert.equal(clips[0].origin, 'automatic');
});

test('自动缩放：相邻点击合并为一段，远处点击另起一段', () => {
  const events = [
    { time: 1.0, x: 0.30, y: 0.30, kind: 'leftClick' },
    { time: 1.8, x: 0.34, y: 0.33, kind: 'leftClick' },
    { time: 6.0, x: 0.80, y: 0.70, kind: 'leftClick' },
  ];
  const clips = zoom.planAutoZoom(events);
  assert.equal(clips.length, 2);
  near(clips[0].focus.x, 0.32);
  near(clips[0].endTime, 1.8 + 0.9);
  near(clips[1].focus.x, 0.80);
});

test('自动缩放：边缘点击被安全边距收回，指针活动延长保持', () => {
  const events = [{ time: 1, x: 0.01, y: 0.99, kind: 'leftClick' }];
  for (let t = 1.1; t < 4; t += 0.1) events.push({ time: t, x: 0.02, y: 0.98, kind: 'move' });
  const clips = zoom.planAutoZoom(events);
  near(clips[0].focus.x, 0.12);
  near(clips[0].focus.y, 0.88);
  assert.ok(clips[0].endTime > 4, `保持应延长到指针停下之后，实际 ${clips[0].endTime}`);
});

test('缩放采样与视口变换', () => {
  const ordered = zoom.orderedClips([zoom.makeClip({ startTime: 1, endTime: 3, scale: 2, focus: { x: 0.5, y: 0.5 }, easing: 'linear' })]);
  near(zoom.sampleZoom(ordered, 0.5, motion).scale, 1);
  near(zoom.sampleZoom(ordered, 1.35, motion).scale, 1.5, 1e-4);
  near(zoom.sampleZoom(ordered, 2.5, motion).scale, 2);
  near(zoom.sampleZoom(ordered, 3.35, motion).scale, 1.5, 1e-4);
  near(zoom.sampleZoom(ordered, 4, motion).scale, 1);
  const centered = zoom.viewportTransform({ scale: 2, focus: { x: 0.5, y: 0.5 }, framingProgress: 1 });
  near(centered.translation.x, 0);
  // 角落焦点：完全放大后被构图到 0.30 安全区内。
  const corner = zoom.viewportTransform({ scale: 2, focus: { x: 0, y: 0 }, framingProgress: 1 });
  near(0.5 + 2 * (0 - 0.5) + corner.translation.x, 0.30);
});

test('相接的两段缩放连续过渡', () => {
  const ordered = zoom.orderedClips([
    zoom.makeClip({ startTime: 1, endTime: 2, scale: 2, focus: { x: 0.2, y: 0.2 }, easing: 'linear', exitDuration: 0 }),
    zoom.makeClip({ startTime: 2, endTime: 4, scale: 2, focus: { x: 0.8, y: 0.8 }, easing: 'linear', enterDuration: 1 }),
  ]);
  const middle = zoom.sampleZoom(ordered, 2.5, motion);
  near(middle.scale, 2);
  near(middle.focus.x, 0.5, 1e-4);
});

test('光标弹簧：经过点击点、静止后收敛', () => {
  const events = [{ time: 0, x: 0.1, y: 0.1, kind: 'move' }];
  for (let i = 1; i <= 30; i++) events.push({ time: i / 60, x: 0.1 + i * 0.02, y: 0.1 + i * 0.01, kind: 'move' });
  events.push({ time: 0.5, x: 0.7, y: 0.4, kind: 'leftClick' });
  const track = new PointerTrack(events);
  const style = model.defaultCursorStyle();
  const atClick = track.evaluation(0.5, motion, style);
  near(atClick.position.x, 0.7, 1e-9);
  near(atClick.position.y, 0.4, 1e-9);
  assert.ok(atClick.cursor.clickPhase && atClick.cursor.clickPhase.progress === 0);
  const settled = track.evaluation(3, motion, style);
  near(settled.position.x, 0.7, 1e-3);
  assert.equal(track.evaluation(-1, motion, style).position, null);
  assert.equal(track.evaluation(3, motion, { ...style, hideWhenIdle: true }).cursor, null);
  assert.ok(track.evaluation(3, motion, { ...style, appearance: 'hidden' }).position);
});

test('场景布局：默认留白与阴影', () => {
  const project = model.makeProject({ name: 't', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  const result = scene.evaluateScene(project, { time: 0, width: 1920, height: 1080, sourceAspect: 16 / 9, cameraAspect: 16 / 9, zoomClips: [], pointerTrack: null });
  near(result.screen.finalRect.height, 880);
  near(result.screen.finalRect.y, 100);
  near(result.screen.finalRect.width, 880 * 16 / 9);
  near(result.screen.cornerRadius, 24);
  near(result.screen.shadow.radius, 22);
  // 摄像头：方形、0.29 短边、贴右侧。
  near(result.camera.rect.height, 1080 * 0.29);
  near(result.camera.rect.x, 0.96 * (1920 - 1080 * 0.29));
  near(result.camera.cornerRadius, 1080 * 0.29 * 0.25);
  // 4K 下所有尺寸等比放大。
  const large = scene.evaluateScene(project, { time: 0, width: 3840, height: 2160, sourceAspect: 16 / 9, zoomClips: [], pointerTrack: null });
  near(large.screen.cornerRadius, 48);
  assert.equal(large.camera, null);
});

test('场景布局：零留白时缩放不露出画布边缘', () => {
  const project = model.makeProject({ name: 't', media: { screen: { duration: 10, width: 1920, height: 1080 } }, capture: {} });
  project.canvas.padding = 0;
  const ordered = zoom.orderedClips([zoom.makeClip({ startTime: 0, endTime: 5, scale: 2, focus: { x: 0, y: 0 }, enterDuration: 0 })]);
  const result = scene.evaluateScene(project, { time: 2, width: 1920, height: 1080, sourceAspect: 16 / 9, zoomClips: ordered, pointerTrack: null });
  near(result.screen.finalRect.x, 0);
  near(result.screen.finalRect.y, 0);
  assert.equal(result.screen.cornerRadius, 0);
  assert.equal(result.screen.shadow, null);
});

test('时间线：分割、删除、变速与时间映射', () => {
  let segments = [{ id: 'a', sourceStart: 0, sourceEnd: 10, speed: 1 }];
  segments = timeline.splitAt(segments, 4);
  assert.equal(segments.length, 2);
  segments = timeline.splitAt(segments, 7);
  segments = timeline.removeSegment(segments, segments[1].id); // 剪掉 4–7
  near(timeline.outputDuration(segments), 7);
  near(timeline.locate(segments, 5).sourceTime, 8);
  near(timeline.sourceToOutput(segments, 5), 4); // 被剪掉的时间吸附到后一段起点
  near(timeline.sourceToOutput(segments, 8), 5);
  segments = timeline.setSpeed(segments, segments[0].id, 2);
  near(timeline.outputDuration(segments), 5);
  near(timeline.locate(segments, 1).sourceTime, 2);
  assert.equal(timeline.splitAt(segments, 0.01), null);
  assert.equal(timeline.removeSegment([segments[0]], segments[0].id), null);
  const trimmed = timeline.trimSegment(segments, segments[1].id, 'start', 5, 10);
  near(trimmed[1].sourceStart, 5);
});

test('导出尺寸与码率策略', () => {
  const canvas = model.defaultCanvas();
  assert.deepEqual(model.canvasDimensions(canvas, 'source', { width: 1921, height: 1080 }), { width: 1922, height: 1080 });
  assert.deepEqual(model.canvasDimensions(canvas, 'ultraHD', { width: 1920, height: 1080 }), { width: 3840, height: 2160 });
  assert.deepEqual(model.canvasDimensions({ ...canvas, aspectRatio: 'portrait' }, 'fullHD', { width: 1920, height: 1080 }), { width: 1080, height: 1920 });
  assert.deepEqual(model.canvasDimensions({ ...canvas, aspectRatio: 'square' }, 'source', { width: 1920, height: 1080 }), { width: 1080, height: 1080 });
  assert.equal(model.exportVideoBitrate(1920, 1080, 60), 20_736_000);
  assert.equal(model.exportVideoBitrate(3840, 2160, 60), 82_944_000);
  assert.equal(model.exportVideoBitrate(640, 360, 30), 12_000_000);
});

console.log(`\n${passed} 项通过`);
