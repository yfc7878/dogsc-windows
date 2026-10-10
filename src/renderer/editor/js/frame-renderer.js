/**
 * Frame renderer.
 *
 * The single compositing pipeline shared by the editor preview and the export
 * pass, mirroring `SharedFrameRenderer.swift`. Everything the user sees in the
 * preview is produced here, so preview and export can never disagree.
 *
 * Draw order matches the original:
 *   background → screen (crop, scale, position, 3D, corners, stroke, shadow)
 *   → mockup chrome → mosaics → camera → stickers → cursor → opening motion
 */

import {
  CLICK_EFFECT_DURATION,
  clipAtTime,
  evaluateClip,
  easeProgress,
  timelineDuration,
  clipDuration,
} from "./model.js";

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------------- */
/* Layout                                                                    */
/* ------------------------------------------------------------------------- */

/** Resolves the output pixel size for a canvas style + resolution preset. */
export function resolveCanvasSize(document, resolution, sourceSize) {
  const canvas = document.canvas;
  const source = sourceSize || { width: 1920, height: 1080 };
  const crop = canvas.crop;
  const croppedWidth = Math.max(2, source.width * crop.width);
  const croppedHeight = Math.max(2, source.height * crop.height);

  const ratioFor = () => {
    switch (canvas.aspectRatio) {
      case "16:9":
        return 16 / 9;
      case "4:3":
        return 4 / 3;
      case "9:16":
        return 9 / 16;
      case "1:1":
        return 1;
      case "3:4":
        return 3 / 4;
      case "2.39:1":
        return 2.39;
      case "1:2.39":
        return 1 / 2.39;
      case "自定义": {
        const custom = canvas.customAspectRatio || { width: 16, height: 9 };
        return Math.max(0.1, Math.min(10, custom.width / Math.max(custom.height, 0.001)));
      }
      default:
        return croppedWidth / Math.max(croppedHeight, 1);
    }
  };

  const preset = {
    原始素材: null,
    "1080p": { short: 1080, long: 1920 },
    "1440p": { short: 1440, long: 2560 },
    "4K": { short: 2160, long: 3840 },
  }[resolution];

  const even = (value) => Math.max(2, Math.round(value / 2) * 2);
  const ratio = ratioFor();

  if (!preset) {
    if (canvas.aspectRatio === "适应") {
      return { width: even(croppedWidth), height: even(croppedHeight) };
    }
    return ratio >= 1
      ? { width: even(croppedHeight * ratio), height: even(croppedHeight) }
      : { width: even(croppedWidth), height: even(croppedWidth / ratio) };
  }

  if (canvas.aspectRatio === "适应") {
    const ratioClamped = Math.max(0.2, Math.min(5, croppedWidth / Math.max(croppedHeight, 1)));
    return ratioClamped >= 1
      ? { width: even(preset.long), height: even(preset.long / ratioClamped) }
      : { width: even(preset.long * ratioClamped), height: even(preset.long) };
  }

  return ratio >= 1
    ? { width: even(preset.long), height: even(preset.long / ratio) }
    : { width: even(preset.long * ratio), height: even(preset.long) };
}

/**
 * Computes the on-canvas rectangle of the recorded screen at `time`, including
 * the zoom animation and any Screen 3D motion clip.
 */
export function layoutScreen(document, time, width, height) {
  const canvas = document.canvas;
  const crop = canvas.crop;
  const sourceSize = document.__sourceSize || { width: 1920, height: 1080 };

  const croppedWidth = sourceSize.width * crop.width;
  const croppedHeight = sourceSize.height * crop.height;
  const contentRatio = croppedWidth / Math.max(croppedHeight, 1);

  const availableWidth = width - canvas.padding * 2;
  const availableHeight = height - canvas.padding * 2;
  let baseWidth = availableWidth;
  let baseHeight = baseWidth / contentRatio;
  if (baseHeight > availableHeight) {
    baseHeight = availableHeight;
    baseWidth = baseHeight * contentRatio;
  }

  const centerX = canvas.contentPosition.x * width;
  const centerY = canvas.contentPosition.y * height;

  let scale = canvas.contentScale;
  let offsetX = 0;
  let offsetY = 0;
  let rotation = 0;
  let tiltX = 0;
  let tiltY = 0;
  let perspective = 0.5;
  let opacity = 1;
  let cornerRadius = canvas.cornerRadius;

  /* Zoom animation: magnification around an authored focus point. */
  const zoom = clipAtTime(document.timeline.zoomClips, time);
  if (zoom) {
    const evaluated = evaluateClip(zoom, time);
    const progress = evaluated ? evaluated.progress : 1;
    const targetScale = 1 + (zoom.scale - 1) * progress;
    scale *= targetScale;
    /* The focus point stays pinned while the picture expands around it. */
    const fx = (zoom.focus.x - 0.5) * baseWidth * (targetScale - 1);
    const fy = (zoom.focus.y - 0.5) * baseHeight * (targetScale - 1);
    offsetX -= fx;
    offsetY -= fy;
  }

  /* Screen 3D / position-size motion. */
  const motion = clipAtTime(document.timeline.screenMotionClips, time);
  if (motion) {
    const evaluated = evaluateClip(motion, time);
    const progress = evaluated ? evaluated.progress : 1;
    const target = motion.target;
    scale *= 1 + (target.scale - 1) * progress;
    offsetX += (target.position.x - canvas.contentPosition.x) * width * progress;
    offsetY += (target.position.y - canvas.contentPosition.y) * height * progress;
    rotation = target.rotation * progress;
    tiltX = target.tiltX * progress;
    tiltY = target.tiltY * progress;
    perspective = target.perspective;
    opacity = 1 + (target.opacity - 1) * progress;
    cornerRadius = cornerRadius + (target.cornerRadius - cornerRadius) * progress;
  }

  /* Opening sequence: the screen slides and fades in. */
  const opening = openingProgress(document, time, "屏幕");
  if (opening < 1) {
    const ramp = easeProgress(document.opening.motionCurve, opening);
    scale *= 0.86 + 0.14 * ramp;
    offsetY += (1 - ramp) * height * 0.06;
    opacity *= 0.15 + 0.85 * ramp;
  }

  const drawWidth = baseWidth * scale;
  const drawHeight = baseHeight * scale;
  const x = centerX + offsetX - drawWidth / 2;
  const y = centerY + offsetY - drawHeight / 2;

  return {
    x,
    y,
    width: drawWidth,
    height: drawHeight,
    centerX: centerX + offsetX,
    centerY: centerY + offsetY,
    rotation,
    tiltX,
    tiltY,
    perspective,
    opacity,
    cornerRadius,
    zoomScale: zoom ? 1 + (zoom.scale - 1) * (evaluateClip(zoom, time)?.progress ?? 1) : 1,
  };
}

/** 0 → not started, 1 → fully arrived. */
function openingProgress(document, time, element) {
  const opening = document.opening;
  if (!opening?.isEnabled) return 1;
  if (!opening.includedElements.includes(element)) return 1;
  const index = Math.max(0, opening.elementOrder.indexOf(element));
  const start = index * opening.stagger;
  const local = (time - start) / Math.max(opening.duration, 0.001);
  return Math.max(0, Math.min(1, local));
}

/** Camera PiP rectangle for the current time, or null when hidden. */
export function layoutCamera(document, time, width, height, screenLayout) {
  const camera = document.camera;
  if (camera.isHidden) return null;
  if (!document.media?.camera) return null;

  const sourceSize = document.__cameraSize || { width: 1280, height: 720 };
  const shape = camera.shape;

  /* Camera size follows the screen zoom by `scaleDuringZoom`. */
  const coupling = 1 + (screenLayout.zoomScale - 1) * camera.scaleDuringZoom;
  const size = camera.size * coupling;

  let baseWidth;
  let baseHeight;
  switch (shape) {
    case "横向":
      baseWidth = width * size;
      baseHeight = baseWidth * (9 / 16);
      break;
    case "纵向":
      baseHeight = height * size;
      baseWidth = baseHeight * (9 / 16);
      break;
    case "圆形":
      baseWidth = width * size;
      baseHeight = baseWidth;
      break;
    case "原始比例":
      baseHeight = height * size;
      baseWidth = baseHeight * (sourceSize.width / Math.max(sourceSize.height, 1));
      break;
    case "方形":
    default:
      baseWidth = width * size;
      baseHeight = baseWidth;
      break;
  }

  let x = camera.position.x * width;
  let y = camera.position.y * height;
  let opacity = 1;

  const motion = clipAtTime(document.timeline.cameraMotionClips, time);
  if (motion) {
    const evaluated = evaluateClip(motion, time);
    const progress = evaluated ? evaluated.progress : 1;
    const target = motion.target;
    x = x + (target.position.x * width - x) * progress;
    y = y + (target.position.y * height - y) * progress;
    baseWidth *= 1 + (target.scale - 1) * progress;
    baseHeight *= 1 + (target.scale - 1) * progress;
    opacity = 1 + (target.opacity - 1) * progress;
  }

  const opening = openingProgress(document, time, "摄像头");
  if (opening < 1) {
    const ramp = easeProgress(document.opening.motionCurve, opening);
    opacity *= ramp;
    baseWidth *= 0.8 + 0.2 * ramp;
    baseHeight *= 0.8 + 0.2 * ramp;
  }

  return {
    x: x - baseWidth / 2,
    y: y - baseHeight / 2,
    width: baseWidth,
    height: baseHeight,
    centerX: x,
    centerY: y,
    radius: shape === "圆形" ? Math.min(baseWidth, baseHeight) / 2 : (Math.min(baseWidth, baseHeight) / 2) * camera.roundness,
    opacity,
  };
}

/* ------------------------------------------------------------------------- */
/* Drawing helpers                                                           */
/* ------------------------------------------------------------------------- */

function roundRect(ctx, x, y, width, height, radius) {
  const r = Math.max(0, Math.min(radius, Math.min(width, height) / 2));
  ctx.beginPath();
  if (r <= 0.01) {
    ctx.rect(x, y, width, height);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function hexToRgba(hex, alpha = 1) {
  const value = String(hex || "#FFFFFF").replace("#", "");
  const full = value.length === 3 ? value.split("").map((c) => c + c).join("") : value;
  const int = parseInt(full, 16);
  if (!Number.isFinite(int)) return `rgba(255,255,255,${alpha})`;
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ------------------------------------------------------------------------- */
/* Background                                                                */
/* ------------------------------------------------------------------------- */

function drawBackground(ctx, document, time, width, height, sources) {
  const canvas = document.canvas;
  const source = canvas.backgroundSource || { kind: "pattern", patternPreset: "黑曜石网格" };
  const patternScale = canvas.patternScale || 1;
  const patternOpacity = canvas.patternOpacity ?? 1;

  ctx.save();
  ctx.globalAlpha = 1;

  switch (source.kind) {
    case "projectImage":
    case "systemImage": {
      const image = sources.backgroundImage;
      if (image) {
        drawCover(ctx, image, 0, 0, width, height, canvas.backgroundBlur);
      } else {
        drawPattern(ctx, source.patternPreset || "黑曜石网格", width, height, patternScale, patternOpacity);
      }
      break;
    }
    case "projectVideo":
    case "systemVideo": {
      const video = sources.backgroundVideo;
      if (video && video.readyState >= 2) {
        drawCover(ctx, video, 0, 0, width, height, canvas.backgroundBlur);
      } else {
        drawPattern(ctx, "暗夜星阵", width, height, patternScale, patternOpacity);
      }
      break;
    }
    case "dynamicFlow":
      drawDynamic(ctx, source.dynamicPreset || "赛博微流网格", width, height, time, patternScale, patternOpacity);
      break;
    case "pattern":
    default:
      drawPattern(ctx, source.patternPreset || "黑曜石网格", width, height, patternScale, patternOpacity);
      break;
  }

  ctx.restore();
}

function drawCover(ctx, media, x, y, width, height, blur) {
  const mediaWidth = media.videoWidth || media.naturalWidth || media.width;
  const mediaHeight = media.videoHeight || media.naturalHeight || media.height;
  if (!mediaWidth || !mediaHeight) return;
  const scale = Math.max(width / mediaWidth, height / mediaHeight);
  const drawWidth = mediaWidth * scale;
  const drawHeight = mediaHeight * scale;
  ctx.save();
  if (blur) ctx.filter = `blur(${blur}px)`;
  ctx.drawImage(media, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
  ctx.restore();
}

const PATTERN_THEME = {
  黑曜石网格: { base: "#0d0f12", line: "#232a33", accent: "#2f3a47" },
  工程白网格: { base: "#f6f7f9", line: "#dfe3e8", accent: "#c9d0d8" },
  暗夜星阵: { base: "#0b0d10", line: "#1c2129", accent: "#39414d" },
  建筑极简点: { base: "#f2f3f5", line: "#d6d9de", accent: "#b9bec6" },
  立体等角网: { base: "#111318", line: "#232a34", accent: "#38424f" },
};

const CANVAS_FONT = '"Alibaba PuHuiTi 3", "Microsoft YaHei UI", "Segoe UI", sans-serif';

function drawPattern(ctx, preset, width, height, scale, opacity) {
  const theme = PATTERN_THEME[preset] || PATTERN_THEME["黑曜石网格"];
  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.fillStyle = theme.base;
  ctx.fillRect(0, 0, width, height);

  const cell = Math.max(14, (width / 34) * scale);
  ctx.strokeStyle = theme.line;
  ctx.lineWidth = Math.max(1, width / 1600);

  if (preset === "建筑极简点" || preset === "暗夜星阵") {
    ctx.fillStyle = preset === "暗夜星阵" ? "#39414d" : theme.accent;
    const radius = Math.max(1.1, cell * 0.055);
    for (let y = cell / 2; y < height; y += cell) {
      for (let x = cell / 2; x < width; x += cell) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, TAU);
        ctx.fill();
      }
    }
  } else if (preset === "立体等角网") {
    const step = cell * 1.4;
    ctx.strokeStyle = theme.line;
    for (let x = -height; x < width + height; x += step) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x + height, height);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x, height);
      ctx.lineTo(x + height, 0);
      ctx.stroke();
    }
  } else {
    ctx.strokeStyle = theme.line;
    for (let x = 0; x <= width; x += cell) {
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, 0);
      ctx.lineTo(Math.round(x) + 0.5, height);
      ctx.stroke();
    }
    for (let y = 0; y <= height; y += cell) {
      ctx.beginPath();
      ctx.moveTo(0, Math.round(y) + 0.5);
      ctx.lineTo(width, Math.round(y) + 0.5);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawDynamic(ctx, preset, width, height, time, scale, opacity) {
  ctx.save();
  ctx.globalAlpha = opacity;
  if (preset === "极光流体星云") {
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, "#0b1220");
    gradient.addColorStop(0.5, "#12263f");
    gradient.addColorStop(1, "#0a1a2b");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    for (let i = 0; i < 4; i += 1) {
      const phase = time * 0.18 + i * 1.4;
      const cx = width * (0.25 + 0.5 * Math.abs(Math.sin(phase * 0.6 + i)));
      const cy = height * (0.3 + 0.4 * Math.abs(Math.cos(phase * 0.5 + i * 0.7)));
      const radius = Math.max(width, height) * (0.22 + 0.06 * i);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      const hue = ["#3b82f6", "#22d3ee", "#a855f7", "#0ea5e9"][i];
      glow.addColorStop(0, hexToRgba(hue, 0.34));
      glow.addColorStop(1, hexToRgba(hue, 0));
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, width, height);
    }
  } else if (preset === "星辉漫步点阵") {
    ctx.fillStyle = "#0a0c11";
    ctx.fillRect(0, 0, width, height);
    const cell = Math.max(18, (width / 42) * scale);
    for (let y = 0; y < height + cell; y += cell) {
      for (let x = 0; x < width + cell; x += cell) {
        const drift = Math.sin((x * 0.01 + y * 0.012) + time * 0.7) * 0.5 + 0.5;
        const radius = 0.9 + drift * 1.6;
        ctx.fillStyle = `rgba(255, 214, 150, ${0.18 + drift * 0.5})`;
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, TAU);
        ctx.fill();
      }
    }
  } else {
    ctx.fillStyle = "#0c0f14";
    ctx.fillRect(0, 0, width, height);
    const cell = Math.max(16, (width / 38) * scale);
    const offset = (time * 22) % cell;
    ctx.strokeStyle = "rgba(212, 175, 96, 0.32)";
    ctx.lineWidth = Math.max(1, width / 1800);
    for (let x = -cell + offset; x < width + cell; x += cell) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }
    for (let y = -cell + offset * 0.5; y < height + cell; y += cell) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
  }
  ctx.restore();
}

/* ------------------------------------------------------------------------- */
/* Screen content                                                            */
/* ------------------------------------------------------------------------- */

/** Draws the recorded screen into `rect`, honouring crop, corners and 3D. */
function drawScreenContent(ctx, document, rect, sources) {
  const video = sources.screen;
  const crop = document.canvas.crop;
  if (!video || video.readyState < 2) return false;

  const sourceWidth = video.videoWidth || 1920;
  const sourceHeight = video.videoHeight || 1080;
  const sx = crop.x * sourceWidth;
  const sy = crop.y * sourceHeight;
  const sw = Math.max(1, crop.width * sourceWidth);
  const sh = Math.max(1, crop.height * sourceHeight);

  ctx.save();
  ctx.globalAlpha = rect.opacity ?? 1;

  const is3D = hasScreen3D(rect);
  if (is3D) {
    drawPerspective(ctx, video, rect, { sx, sy, sw, sh });
    ctx.restore();
    return true;
  }

  ctx.translate(rect.centerX, rect.centerY);
  if (rect.rotation) ctx.rotate((rect.rotation * Math.PI) / 180);
  ctx.translate(-rect.centerX, -rect.centerY);

  roundRect(ctx, rect.x, rect.y, rect.width, rect.height, rect.cornerRadius);
  ctx.save();
  ctx.clip();
  ctx.drawImage(video, sx, sy, sw, sh, rect.x, rect.y, rect.width, rect.height);
  ctx.restore();

  ctx.restore();
  return true;
}

/* ------------------------------------------------------------------------- */
/* Screen 3D projection                                                      */
/* ------------------------------------------------------------------------- */

/** Whether a layout rect carries enough 3D to need the projective path. */
function hasScreen3D(rect) {
  return Math.abs(rect.tiltX) > 0.01 || Math.abs(rect.tiltY) > 0.01;
}

/**
 * Projects the screen rectangle into the 3D quad.
 *
 * This is a direct port of the original's `ScreenProjection.project`: the card
 * is rotated around X, then Y, then Z, and the result is divided by a camera
 * distance derived from the card's longest side, so `perspective` behaves like
 * a depth rather than a focal length and reads the same on any canvas size.
 * `perspective == 0` is orthographic; with no rotation the projection is the
 * identity, which is why a perspective change alone never moves a flat card.
 */
export function projectedScreenQuad(rect, options = {}) {
  const rotationX = options.rotationX || 0;
  const rotationY = options.rotationY || 0;
  const rotationZ = options.rotationZ || 0;
  const perspective = options.perspective || 0;
  const anchor = options.anchor || null;

  const width = Math.max(rect.width, 0);
  const height = Math.max(rect.height, 0);
  const pivot =
    anchor && Number.isFinite(anchor.x) && Number.isFinite(anchor.y)
      ? anchor
      : { x: rect.x + width / 2, y: rect.y + height / 2 };

  const maximumDimension = Math.max(rect.width, rect.height, 1);
  const depth = Math.min(Math.max(perspective, 0), 2);
  const cameraDistance =
    depth > 0 ? (maximumDimension * 2) / Math.max(depth, 0.0001) : Infinity;

  const radians = (value) => (value * Math.PI) / 180;
  const sinX = Math.sin(radians(rotationX));
  const cosX = Math.cos(radians(rotationX));
  const sinY = Math.sin(radians(rotationY));
  const cosY = Math.cos(radians(rotationY));
  const sinZ = Math.sin(radians(rotationZ));
  const cosZ = Math.cos(radians(rotationZ));

  const project = (x, y) => {
    const xAfterX = x;
    const yAfterX = y * cosX;
    const zAfterX = y * sinX;

    const xAfterY = xAfterX * cosY + zAfterX * sinY;
    const yAfterY = yAfterX;
    const zAfterY = -xAfterX * sinY + zAfterX * cosY;

    const xAfterZ = xAfterY * cosZ - yAfterY * sinZ;
    const yAfterZ = xAfterY * sinZ + yAfterY * cosZ;

    let projectionScale = 1;
    if (Number.isFinite(cameraDistance)) {
      /* The denominator is floored so authored extremes can never produce a
         NaN/Infinity quad. */
      const denominator = Math.max(cameraDistance - zAfterY, cameraDistance * 0.12);
      projectionScale = cameraDistance / denominator;
    }
    return {
      x: pivot.x + xAfterZ * projectionScale,
      y: pivot.y + yAfterZ * projectionScale,
    };
  };

  return {
    topLeft: project(rect.x - pivot.x, rect.y - pivot.y),
    topRight: project(rect.x + width - pivot.x, rect.y - pivot.y),
    bottomRight: project(rect.x + width - pivot.x, rect.y + height - pivot.y),
    bottomLeft: project(rect.x - pivot.x, rect.y + height - pivot.y),
  };
}

/**
 * Maps normalized card coordinates (0..1 across the card) onto the projected
 * quad, using the same eight-parameter homography as the original's
 * `ProjectedScreenPointMapper`. Returns null for degenerate geometry.
 */
function unitSquareHomography(quad) {
  const { topLeft, topRight, bottomRight, bottomLeft } = quad;
  const finite = [topLeft, topRight, bottomRight, bottomLeft].every(
    (point) => Number.isFinite(point.x) && Number.isFinite(point.y)
  );
  if (!finite) return null;

  const dx1 = topRight.x - bottomRight.x;
  const dx2 = bottomLeft.x - bottomRight.x;
  const dx3 = topLeft.x - topRight.x + bottomRight.x - bottomLeft.x;
  const dy1 = topRight.y - bottomRight.y;
  const dy2 = bottomLeft.y - bottomRight.y;
  const dy3 = topLeft.y - topRight.y + bottomRight.y - bottomLeft.y;
  const denominator = dx1 * dy2 - dx2 * dy1;

  let perspectiveX = 0;
  let perspectiveY = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    if (Math.abs(denominator) <= 1e-9) return null;
    perspectiveX = (dx3 * dy2 - dx2 * dy3) / denominator;
    perspectiveY = (dx1 * dy3 - dx3 * dy1) / denominator;
  }

  const a = topRight.x - topLeft.x + perspectiveX * topRight.x;
  const b = bottomLeft.x - topLeft.x + perspectiveY * bottomLeft.x;
  const d = topRight.y - topLeft.y + perspectiveX * topRight.y;
  const e = bottomLeft.y - topLeft.y + perspectiveY * bottomLeft.y;

  return (u, v) => {
    const divisor = perspectiveX * u + perspectiveY * v + 1;
    if (!Number.isFinite(divisor) || Math.abs(divisor) < 1e-9) return null;
    const x = (a * u + b * v + topLeft.x) / divisor;
    const y = (d * u + e * v + topLeft.y) / divisor;
    return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
  };
}

/** The projected quad for a layout rect, or null when the card is flat. */
function screenQuadFor(rect, inflate = 0) {
  if (!hasScreen3D(rect)) return null;
  return projectedScreenQuad(
    {
      x: rect.x - inflate,
      y: rect.y - inflate,
      width: rect.width + inflate * 2,
      height: rect.height + inflate * 2,
    },
    {
      rotationX: rect.tiltX,
      rotationY: rect.tiltY,
      rotationZ: rect.rotation,
      perspective: rect.perspective,
      /* The pivot stays the card's own centre, so inflating for a border keeps
         the projection identical to the content's. */
      anchor: { x: rect.centerX, y: rect.centerY },
    }
  );
}

function traceQuad(ctx, quad) {
  ctx.beginPath();
  ctx.moveTo(quad.topLeft.x, quad.topLeft.y);
  ctx.lineTo(quad.topRight.x, quad.topRight.y);
  ctx.lineTo(quad.bottomRight.x, quad.bottomRight.y);
  ctx.lineTo(quad.bottomLeft.x, quad.bottomLeft.y);
  ctx.closePath();
}

/**
 * Traces a projected quad with rounded corners.
 *
 * The original rounds the card in native source coordinates and only then
 * projects it; Canvas has no projective sampler, so the radius is converted
 * through the projection's average scale instead. That keeps a rounded card
 * rounded under 3D while the content, the shadow and the border all share the
 * exact same outline — a sharp shadow under a rounded card would show black
 * corners through it.
 */
function traceProjectedPath(ctx, quad, rect, cornerRadius) {
  const meanLength = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
  const projectedWidth =
    (meanLength(quad.topLeft, quad.topRight) + meanLength(quad.bottomLeft, quad.bottomRight)) / 2;
  const projectedHeight =
    (meanLength(quad.topLeft, quad.bottomLeft) + meanLength(quad.topRight, quad.bottomRight)) / 2;
  const scaleX = rect.width > 0 ? projectedWidth / rect.width : 1;
  const scaleY = rect.height > 0 ? projectedHeight / rect.height : 1;
  const radius = Math.max(0, cornerRadius) * Math.min(scaleX, scaleY);
  if (radius < 0.5) {
    traceQuad(ctx, quad);
    return;
  }

  const corners = [quad.topLeft, quad.topRight, quad.bottomRight, quad.bottomLeft];
  ctx.beginPath();
  for (let index = 0; index < corners.length; index += 1) {
    const corner = corners[index];
    const next = corners[(index + 1) % corners.length];
    const previous = corners[(index + corners.length - 1) % corners.length];
    const toNext = unitTowards(corner, next, radius);
    const toPrevious = unitTowards(corner, previous, radius);
    if (index === 0) ctx.moveTo(toPrevious.x, toPrevious.y);
    else ctx.lineTo(toPrevious.x, toPrevious.y);
    ctx.quadraticCurveTo(corner.x, corner.y, toNext.x, toNext.y);
  }
  ctx.closePath();
}

/** A point `distance` from `from` along the edge towards `to`, clamped to half the edge. */
function unitTowards(from, to, distance) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy);
  if (length < 0.001) return { x: from.x, y: from.y };
  const step = Math.min(distance, length / 2) / length;
  return { x: from.x + dx * step, y: from.y + dy * step };
}

/**
 * Perspective warp for Screen 3D.
 *
 * Canvas 2D has no projective sampler, so the quad is filled with a grid of
 * small cells, each drawn as the affine transform through its own three
 * corners. Those corners come from the exact homography of the quad, so the
 * result follows the original's single perspective pass — including the
 * Z rotation and the asymmetric foreshortening that a stack of sheared
 * horizontal bands cannot express.
 */
function drawPerspective(ctx, video, rect, source) {
  const quad = screenQuadFor(rect);
  const map = quad && unitSquareHomography(quad);
  if (!map) return false;

  ctx.save();
  traceProjectedPath(ctx, quad, rect, rect.cornerRadius);
  ctx.clip();

  /* The mesh follows the on-screen size: the preview stays cheap, the
     full-resolution export gets the finer grid it needs. */
  const longest = Math.max(rect.width, rect.height);
  const divisions = Math.max(16, Math.min(28, Math.round(longest / 40)));

  /* Cells are drawn as the parallelogram through three of their corners, so a
     shared edge is two straight segments where the projection wants a curve.
     They are pushed outwards by a fixed number of pixels — an absolute overlap,
     not a percentage — because the cells that need it most are the ones the
     projection has squashed flat, where a percentage rounds away to nothing.
     Without it the background shows through as a faint mesh over the card. */
  const overlapPx = 0.75;

  for (let row = 0; row < divisions; row += 1) {
    const v0 = row / divisions;
    const v1 = (row + 1) / divisions;
    for (let column = 0; column < divisions; column += 1) {
      const u0 = column / divisions;
      const u1 = (column + 1) / divisions;

      const p00 = map(u0, v0);
      const p10 = map(u1, v0);
      const p01 = map(u0, v1);
      if (!p00 || !p10 || !p01) continue;

      const sourceX = source.sx + source.sw * u0;
      const sourceY = source.sy + source.sh * v0;
      const sourceWidth = source.sw / divisions;
      const sourceHeight = source.sh / divisions;
      if (sourceWidth < 0.01 || sourceHeight < 0.01) continue;

      const centreX = (p00.x + p10.x + p01.x) / 3;
      const centreY = (p00.y + p10.y + p01.y) / 3;
      const grow = (point) => {
        const dx = point.x - centreX;
        const dy = point.y - centreY;
        const length = Math.hypot(dx, dy);
        if (length < 0.0001) return point;
        return { x: point.x + (dx / length) * overlapPx, y: point.y + (dy / length) * overlapPx };
      };
      const g00 = grow(p00);
      const g10 = grow(p10);
      const g01 = grow(p01);

      ctx.save();
      /* Composed with the caller's transform rather than replacing it, so the
         frame still lands in the device-pixel space the canvas is backed with
         (a preview canvas is backed at `dpr` times its CSS size). */
      ctx.transform(
        (g10.x - g00.x) / sourceWidth,
        (g10.y - g00.y) / sourceWidth,
        (g01.x - g00.x) / sourceHeight,
        (g01.y - g00.y) / sourceHeight,
        g00.x,
        g00.y
      );
      ctx.drawImage(
        video,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        sourceWidth,
        sourceHeight
      );
      ctx.restore();
    }
  }
  ctx.restore();
  return true;
}

function drawScreenShadow(ctx, rect, strength) {
  if (!strength) return;
  ctx.save();
  ctx.shadowColor = `rgba(0, 0, 0, ${0.55 * strength})`;
  ctx.shadowBlur = Math.max(6, rect.width * 0.045 * strength * 2);
  ctx.shadowOffsetY = Math.max(2, rect.height * 0.02 * strength * 2);
  ctx.fillStyle = "#000";
  /* Under 3D the shadow has to follow the tilted card, not its unprojected
     bounding box, or the card looks pasted onto its own shadow. */
  const quad = screenQuadFor(rect);
  if (quad) traceProjectedPath(ctx, quad, rect, rect.cornerRadius);
  else roundRect(ctx, rect.x, rect.y, rect.width, rect.height, rect.cornerRadius);
  ctx.fill();
  ctx.restore();
}

function drawScreenBorder(ctx, rect, document) {
  const width = document.canvas.borderWidth;
  if (!width) return;
  ctx.save();
  ctx.strokeStyle = hexToRgba(document.canvas.borderColor || "#FFFFFF", 1);
  ctx.lineWidth = width;
  /* The border sits half outside the picture, exactly as in 2D, which under
     3D means projecting the inflated rect rather than offsetting the quad. */
  const quad = screenQuadFor(rect, width / 2);
  if (quad) {
    traceProjectedPath(ctx, quad, rect, rect.cornerRadius + width / 2);
    ctx.stroke();
    ctx.restore();
    return;
  }
  roundRect(
    ctx,
    rect.x - width / 2,
    rect.y - width / 2,
    rect.width + width,
    rect.height + width,
    rect.cornerRadius + width / 2
  );
  ctx.stroke();
  ctx.restore();
}

/* ------------------------------------------------------------------------- */
/* Mockup chrome                                                             */
/* ------------------------------------------------------------------------- */

function drawMockup(ctx, document, rect, time) {
  const style = document.canvas.screenFrame;
  if (!style || style === "none") return null;

  const scale = document.canvas.screenFrameScale || 1;
  const toolbarScale = document.canvas.screenFrameToolbarScale || 1;
  const isDark = style === "windowDark" || style === "browserDark";
  const chromeColor = isDark ? "#2b2c2e" : "#e9eaec";
  const lineColor = isDark ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.09)";
  const textColor = isDark ? "rgba(255,255,255,0.72)" : "rgba(0,0,0,0.62)";

  const toolbarHeight =
    style === "browserLight" || style === "browserDark"
      ? Math.max(18, rect.height * 0.055 * toolbarScale)
      : style === "windowLight" || style === "windowDark"
        ? Math.max(14, rect.height * 0.045 * toolbarScale)
        : 0;

  const outerRadius =
    document.canvas.screenFrameOuterCornerRadius ??
    (document.canvas.cornerRadius + 10 * scale);

  const outerX = rect.x;
  const outerY = rect.y - toolbarHeight;
  const outerWidth = rect.width;
  const outerHeight = rect.height + toolbarHeight;

  ctx.save();
  ctx.shadowColor = `rgba(0,0,0,${0.34 * (document.canvas.shadowStrength || 0.28) + 0.08})`;
  ctx.shadowBlur = Math.max(10, rect.width * 0.05);
  ctx.shadowOffsetY = Math.max(3, rect.height * 0.018);
  ctx.fillStyle = chromeColor;
  roundRect(ctx, outerX, outerY, outerWidth, outerHeight, outerRadius);
  ctx.fill();
  ctx.restore();

  if (toolbarHeight > 0) {
    ctx.save();
    ctx.fillStyle = chromeColor;
    roundRect(ctx, outerX, outerY, outerWidth, outerHeight, outerRadius);
    ctx.clip();

    const dotRadius = Math.max(2.6, toolbarHeight * 0.13);
    const dotY = outerY + toolbarHeight / 2;
    const dotX = outerX + toolbarHeight * 0.55;
    const colors = ["#ff5f57", "#febc2e", "#28c840"];
    for (let i = 0; i < 3; i += 1) {
      ctx.fillStyle = colors[i];
      ctx.beginPath();
      ctx.arc(dotX + i * dotRadius * 2.6, dotY, dotRadius, 0, TAU);
      ctx.fill();
    }

    const isBrowser = style === "browserLight" || style === "browserDark";
    const title = isBrowser
      ? document.canvas.screenFrameBrowserAddress || document.canvas.screenFrameTitle || ""
      : document.canvas.screenFrameTitle || "";
    if (title) {
      ctx.fillStyle = textColor;
      ctx.font = `${Math.max(9, toolbarHeight * 0.42)}px ${CANVAS_FONT}`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(title, outerX + outerWidth / 2, dotY, outerWidth * 0.6);
    }

    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(outerX, outerY + toolbarHeight);
    ctx.lineTo(outerX + outerWidth, outerY + toolbarHeight);
    ctx.stroke();
    ctx.restore();
  }

  return { toolbarHeight, outerRadius };
}

/* ------------------------------------------------------------------------- */
/* Camera                                                                    */
/* ------------------------------------------------------------------------- */

function drawCamera(ctx, document, layout, sources) {
  const video = sources.camera;
  if (!layout || !video || video.readyState < 2) return;

  const camera = document.camera;
  const sourceWidth = video.videoWidth || 1280;
  const sourceHeight = video.videoHeight || 720;

  ctx.save();
  ctx.globalAlpha = layout.opacity;

  /* Shadow + border are drawn on the mask silhouette. */
  if (camera.shadowStrength) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${0.5 * camera.shadowStrength})`;
    ctx.shadowBlur = Math.max(6, layout.width * 0.12);
    ctx.shadowOffsetY = Math.max(2, layout.height * 0.05);
    ctx.fillStyle = "#000";
    roundRect(ctx, layout.x, layout.y, layout.width, layout.height, layout.radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundRect(ctx, layout.x, layout.y, layout.width, layout.height, layout.radius);
  ctx.clip();

  /* Aspect-fill inside the mask, honouring the framing offsets. */
  const scale = Math.max(layout.width / sourceWidth, layout.height / sourceHeight) * camera.contentScale;
  const drawWidth = sourceWidth * scale;
  const drawHeight = sourceHeight * scale;
  const offsetX = (camera.contentPosition.x - 0.5) * (drawWidth - layout.width);
  const offsetY = (camera.contentPosition.y - 0.5) * (drawHeight - layout.height);

  if (camera.isMirrored) {
    /* The canvas is flipped horizontally about the mask's right edge, so the
       draw origin has to be expressed in that mirrored space:
         screen_x = (layout.x + layout.width) - local_x
       Solving for the origin that centres the image gives the expression
       below. Getting the sign wrong pushes the picture outside the clip. */
    ctx.translate(layout.x + layout.width, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(
      video,
      layout.width / 2 - drawWidth / 2 + offsetX,
      layout.y + layout.height / 2 - drawHeight / 2 - offsetY,
      drawWidth,
      drawHeight
    );
  } else {
    ctx.drawImage(
      video,
      layout.x + layout.width / 2 - drawWidth / 2 - offsetX,
      layout.y + layout.height / 2 - drawHeight / 2 - offsetY,
      drawWidth,
      drawHeight
    );
  }
  ctx.restore();

  if (camera.borderWidth) {
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.92)";
    ctx.lineWidth = camera.borderWidth;
    roundRect(ctx, layout.x, layout.y, layout.width, layout.height, layout.radius);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

/* ------------------------------------------------------------------------- */
/* Mosaics                                                                   */
/* ------------------------------------------------------------------------- */

function drawMosaics(ctx, document, time, width, height, sources) {
  const clips = document.timeline.mosaicClips || [];
  for (const clip of clips) {
    if (time < clip.startTime || time > clip.startTime + clip.duration) continue;
    const rect = {
      x: clip.rect.x * width,
      y: clip.rect.y * height,
      width: clip.rect.width * width,
      height: clip.rect.height * height,
    };
    ctx.save();
    roundRect(ctx, rect.x, rect.y, rect.width, rect.height, 12);
    ctx.clip();
    if (clip.style === "突出") {
      ctx.fillStyle = `rgba(0, 0, 0, ${0.55 * clip.strength})`;
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
    } else {
      const video = sources.screen;
      if (video && video.readyState >= 2) {
        ctx.filter = `blur(${Math.max(6, 26 * clip.strength)}px)`;
        ctx.drawImage(video, 0, 0, width, height);
        ctx.filter = "none";
      }
    }
    ctx.restore();
  }
}

/* ------------------------------------------------------------------------- */
/* Stickers                                                                  */
/* ------------------------------------------------------------------------- */

function drawStickers(ctx, document, time, width, height, sources) {
  const clips = [...(document.timeline.stickerClips || [])].sort((a, b) => (a.layer || 0) - (b.layer || 0));
  for (const clip of clips) {
    if (time < clip.startTime || time > clip.startTime + clip.duration) continue;
    const image = sources.stickers?.get(clip.source);
    if (!image) continue;

    const local = time - clip.startTime;
    const inDuration = Math.min(clip.animationInDuration, clip.duration / 2);
    const outDuration = Math.min(clip.animationOutDuration, clip.duration / 2);
    let animation = { scale: 1, opacity: 1, offsetX: 0, offsetY: 0 };

    if (clip.animationIn !== "无动画" && local < inDuration) {
      animation = animationState(clip.animationIn, local / Math.max(inDuration, 0.001), true);
    } else if (clip.animationOut !== "无动画" && local > clip.duration - outDuration) {
      animation = animationState(
        clip.animationOut,
        (clip.duration - local) / Math.max(outDuration, 0.001),
        false
      );
    }

    const naturalWidth = image.naturalWidth || image.width || 200;
    const naturalHeight = image.naturalHeight || image.height || 200;
    const targetWidth = width * clip.scale;
    const targetHeight = (targetWidth / naturalWidth) * naturalHeight;

    const opening = openingProgress(document, time, "贴图");
    const openingRamp = opening < 1 ? easeProgress(document.opening.motionCurve, opening) : 1;

    ctx.save();
    ctx.globalAlpha = clip.opacity * animation.opacity * openingRamp;
    ctx.translate(
      clip.position.x * width + animation.offsetX * width,
      clip.position.y * height + animation.offsetY * height
    );
    ctx.rotate((clip.rotation * Math.PI) / 180);
    const scale = animation.scale * (0.85 + 0.15 * openingRamp);
    ctx.scale(scale, scale);

    if (clip.shadowStrength) {
      ctx.shadowColor = `rgba(0,0,0,${0.5 * clip.shadowStrength})`;
      ctx.shadowBlur = Math.max(4, targetWidth * 0.08);
      ctx.shadowOffsetY = Math.max(2, targetHeight * 0.04);
    }
    ctx.drawImage(image, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
    ctx.shadowColor = "transparent";

    if (clip.borderWidth) {
      ctx.strokeStyle = hexToRgba(clip.borderColor || "#FFFFFF", 0.9);
      ctx.lineWidth = clip.borderWidth;
      ctx.strokeRect(-targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
    }
    ctx.restore();
  }
}

function animationState(kind, progress, entering) {
  const p = Math.max(0, Math.min(1, progress));
  const eased = 1 - Math.pow(1 - p, 3);
  const base = { scale: 1, opacity: 1, offsetX: 0, offsetY: 0 };
  const distance = 0.16;
  switch (kind) {
    case "淡入":
    case "淡出":
      return { ...base, opacity: eased };
    case "弹出":
      return { ...base, scale: 0.6 + 0.4 * eased, opacity: eased };
    case "收缩":
      return { ...base, scale: 1.4 - 0.4 * eased, opacity: eased };
    case "从左":
      return { ...base, offsetX: -(1 - eased) * distance, opacity: eased };
    case "从右":
      return { ...base, offsetX: (1 - eased) * distance, opacity: eased };
    case "从上":
      return { ...base, offsetY: -(1 - eased) * distance, opacity: eased };
    case "从下":
      return { ...base, offsetY: (1 - eased) * distance, opacity: eased };
    case "向左":
      return { ...base, offsetX: -(1 - eased) * distance, opacity: eased };
    case "向右":
      return { ...base, offsetX: (1 - eased) * distance, opacity: eased };
    case "向上":
      return { ...base, offsetY: -(1 - eased) * distance, opacity: eased };
    case "向下":
      return { ...base, offsetY: (1 - eased) * distance, opacity: eased };
    default:
      return base;
  }
}

/* ------------------------------------------------------------------------- */
/* Cursor                                                                    */
/* ------------------------------------------------------------------------- */

/**
 * Interpolates the recorded pointer track at `time`.
 *
 * The cursor style's `syncOffset` shifts the whole track against the picture,
 * which is what the original's 音画同步 correction does — it moves the cursor
 * without touching the smoothing parameters.
 */
export function pointerAt(document, time) {
  const samples = document.pointerTrack?.samples || [];
  if (!samples.length) return null;
  const offset = document.cursorStyle?.syncOffset || 0;
  const target = time - offset;
  if (target <= samples[0].t) return samples[0];
  const last = samples[samples.length - 1];
  if (target >= last.t) return last;

  let low = 0;
  let high = samples.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (samples[mid].t <= target) low = mid;
    else high = mid;
  }
  const a = samples[low];
  const b = samples[high];
  const span = Math.max(b.t - a.t, 0.0001);
  const k = Math.max(0, Math.min(1, (target - a.t) / span));
  return {
    t: target,
    x: a.x + (b.x - a.x) * k,
    y: a.y + (b.y - a.y) * k,
    vx: (b.x - a.x) / span,
    vy: (b.y - a.y) / span,
  };
}

export function clicksAround(document, time) {
  const clicks = document.pointerTrack?.clicks || [];
  const offset = document.cursorStyle?.syncOffset || 0;
  const duration = CLICK_EFFECT_DURATION[document.cursorStyle?.clickEffectStyle] || 0.36;
  const target = time - offset;
  return clicks.filter(
    (click) => click.button === "left" && target >= click.t && target <= click.t + duration
  );
}

function drawCursor(ctx, document, time, width, height, screenRect) {
  const style = document.cursorStyle;
  if (style.assetID === "system.hidden") return;

  const point = pointerAt(document, time);
  if (!point) return;

  /* The pointer track is normalised against the recorded frame; map it into
     the on-canvas screen rectangle so it follows crop, zoom and 3D. */
  const x = screenRect.x + point.x * screenRect.width;
  const y = screenRect.y + point.y * screenRect.height;

  if (style.hideWhenIdle) {
    const samples = document.pointerTrack?.samples || [];
    const index = samples.findIndex((sample) => sample.t >= time);
    const previous = samples[Math.max(0, index - 1)];
    const idleFor = previous ? time - previous.t : 0;
    if (idleFor > style.idleDelay) return;
  }

  const size = Math.max(10, height * 0.028 * style.size);

  /* Click feedback is drawn beneath the pointer body. */
  for (const click of clicksAround(document, time)) {
    const local = (time - (style.syncOffset || 0)) - click.t;
    const effect = style.clickEffectStyle;
    const definition = CLICK_EFFECT_DURATION[effect] || 0.36;
    const progress = Math.max(0, Math.min(1, local / definition));
    const cx = screenRect.x + click.x * screenRect.width;
    const cy = screenRect.y + click.y * screenRect.height;
    const color = style.clickColor || "#F2F0EA";
    ctx.save();
    ctx.globalAlpha = (1 - progress) * style.clickOpacity;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    const base = size * 1.6 * style.clickScale;
    if (effect === "glow") {
      const radius = base * (0.6 + progress * 1.3);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
      glow.addColorStop(0, hexToRgba(color, 0.55 * (1 - progress)));
      glow.addColorStop(1, hexToRgba(color, 0));
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, TAU);
      ctx.fill();
    } else if (effect === "pulse") {
      ctx.lineWidth = Math.max(1.4, size * 0.09);
      for (let ring = 0; ring < 2; ring += 1) {
        const ringProgress = Math.max(0, Math.min(1, progress - ring * 0.16));
        ctx.globalAlpha = (1 - ringProgress) * style.clickOpacity * 0.9;
        ctx.beginPath();
        ctx.arc(cx, cy, base * (0.3 + ringProgress * 1.1), 0, TAU);
        ctx.stroke();
      }
    } else if (effect === "burst") {
      ctx.lineWidth = Math.max(1.2, size * 0.075);
      const radius = base * (0.2 + progress * 0.6);
      for (let spoke = 0; spoke < 8; spoke += 1) {
        const angle = (spoke / 8) * TAU + progress * 0.6;
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
        ctx.lineTo(cx + Math.cos(angle) * radius * 1.7, cy + Math.sin(angle) * radius * 1.7);
        ctx.stroke();
      }
    } else {
      ctx.lineWidth = Math.max(1.6, size * 0.1);
      ctx.beginPath();
      ctx.arc(cx, cy, base * (0.25 + progress * 1.2), 0, TAU);
      ctx.stroke();
    }
    ctx.restore();
  }

  ctx.save();
  ctx.translate(x, y);

  /* The pointer body swings against its travel direction, which is the
     "motionlines" feel of the original's cursor presets. */
  const speed = Math.hypot(point.vx || 0, point.vy || 0);
  const swing = Math.max(-1, Math.min(1, (point.vx || 0) * 6)) * (style.motionTiltStrength / 4);
  ctx.rotate(swing * 0.28);

  if (style.assetID === "system.touch-dot") {
    ctx.fillStyle = "rgba(255,255,255,0.28)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.9, 0, TAU);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.28)";
    ctx.lineWidth = Math.max(1, size * 0.06);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.9, 0, TAU);
    ctx.stroke();
    ctx.restore();
    return;
  }

  const drawArrow = (scale) => {
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, size * 1.42);
    ctx.lineTo(size * 0.36, size * 1.06);
    ctx.lineTo(size * 0.62, size * 1.66);
    ctx.lineTo(size * 0.86, size * 1.54);
    ctx.lineTo(size * 0.6, size * 0.96);
    ctx.lineTo(size * 1.0, size * 0.92);
    ctx.closePath();
    ctx.fillStyle = "#ffffff";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.62)";
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.stroke();
  };

  if (style.assetID === "system.pointing-hand") {
    ctx.beginPath();
    ctx.roundRect
      ? ctx.roundRect(-size * 0.12, -size * 0.1, size * 0.62, size * 1.1, size * 0.22)
      : ctx.rect(-size * 0.12, -size * 0.1, size * 0.62, size * 1.1);
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.6)";
    ctx.lineWidth = Math.max(1, size * 0.07);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(size * 0.5, size * 0.36);
    ctx.lineTo(size * 1.0, size * 0.16);
    ctx.lineTo(size * 1.0, size * 0.62);
    ctx.lineTo(size * 0.5, size * 0.68);
    ctx.closePath();
    ctx.fillStyle = "#fff";
    ctx.fill();
    ctx.stroke();
  } else if (style.assetID === "system.crosshair") {
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = Math.max(1.6, size * 0.12);
    ctx.beginPath();
    ctx.moveTo(-size * 0.9, 0);
    ctx.lineTo(size * 0.9, 0);
    ctx.moveTo(0, -size * 0.9);
    ctx.lineTo(0, size * 0.9);
    ctx.stroke();
    ctx.strokeStyle = "rgba(0,0,0,0.5)";
    ctx.lineWidth = Math.max(1, size * 0.05);
    ctx.beginPath();
    ctx.arc(0, 0, size * 0.42, 0, TAU);
    ctx.stroke();
  } else {
    drawArrow(size);
  }

  ctx.restore();
  void speed;
}

/* ------------------------------------------------------------------------- */
/* Entry point                                                               */
/* ------------------------------------------------------------------------- */

/* The interactive selection is injected by the editor to avoid a circular
   import between the renderer and the store. */
const chrome = { selection: null };
export function setInteractiveSelection(value) {
  chrome.selection = value;
}

/**
 * Renders one composited frame.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {object} document  normalised project document
 * @param {number} time      timeline seconds
 * @param {object} options   { width, height, sources, interactive }
 */
export function renderFrame(ctx, document, time, options) {
  const { width, height, sources = {}, scale = 1 } = options;
  ctx.save();
  /* The frame is authored in CSS pixels, but a caller may back its canvas with
     more device pixels than that (the editor preview does, so the composite is
     drawn at native resolution). Honouring the caller's scale is what makes the
     picture fill the canvas: resetting to identity drew the whole frame at
     1/dpr of its size, anchored to the top-left corner, which on a 125% display
     left the right and bottom fifth of the preview unpainted. */
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  /* Padded by a couple of CSS pixels because the backing store is floored
     (`Math.floor(width * dpr)`), so the exact edge can fall a fraction short. */
  ctx.clearRect(-2, -2, width + 4, height + 4);

  drawBackground(ctx, document, time, width, height, sources);

  const rect = layoutScreen(document, time, width, height);

  /* Behind the screen sits an optional background blur of the recording. */
  if (document.canvas.backgroundBlur > 0 && sources.screen?.readyState >= 2) {
    ctx.save();
    ctx.globalAlpha = 0.55;
    ctx.filter = `blur(${document.canvas.backgroundBlur * 1.6}px)`;
    ctx.drawImage(sources.screen, 0, 0, width, height);
    ctx.filter = "none";
    ctx.restore();
  }

  drawScreenShadow(ctx, rect, document.canvas.shadowStrength);

  /* Mockup chrome is the frame *around* the picture, so it is painted before
     the content; the toolbar sits above the recorded rectangle. */
  drawMockup(ctx, document, rect, time);

  const painted = drawScreenContent(ctx, document, rect, sources);
  if (painted) drawScreenBorder(ctx, rect, document);

  drawMosaics(ctx, document, time, width, height, sources);

  const cameraLayout = layoutCamera(document, time, width, height, rect);
  drawCamera(ctx, document, cameraLayout, sources);

  drawStickers(ctx, document, time, width, height, sources);
  drawCursor(ctx, document, time, width, height, rect);

  if (options.interactive) {
    drawSelectionChrome(ctx, document, rect, cameraLayout);
  }

  ctx.restore();
  return { screenRect: rect, cameraRect: cameraLayout };
}

/** Interactive affordances (crop handles, selection outlines). */
function drawSelectionChrome(ctx, document, rect, cameraRect) {
  const selection = chrome.selection;
  if (selection === "screen") {
    ctx.save();
    ctx.strokeStyle = "rgba(94, 204, 145, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    roundRect(ctx, rect.x, rect.y, rect.width, rect.height, rect.cornerRadius);
    ctx.stroke();
    ctx.restore();
  }
  if (selection === "camera" && cameraRect) {
    ctx.save();
    ctx.strokeStyle = "rgba(94, 204, 145, 0.9)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([5, 4]);
    roundRect(ctx, cameraRect.x, cameraRect.y, cameraRect.width, cameraRect.height, cameraRect.radius);
    ctx.stroke();
    ctx.restore();
  }
}

export { timelineDuration, clipDuration, roundRect, hexToRgba };
