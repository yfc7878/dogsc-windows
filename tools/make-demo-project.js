/**
 * Builds a self-contained `.dogscproject` used to verify the port end to end.
 *
 * The macOS repository ships its screenshots from a real recording; there is
 * no equivalent asset here, so this script synthesises one with ffmpeg:
 * a 12-second 1080p60 screen clip, a camera clip, a system-audio bed and a
 * microphone bed, plus a recorded pointer track with a few clicks.
 *
 * Usage: node tools/make-demo-project.js [outputDir]
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ffmpeg = require("ffmpeg-static");

const root = path.join(__dirname, "..");
const outputDir = process.argv[2] || path.join(root, "demo");
const packagePath = path.join(outputDir, "海岸漫游 · 功能演示.dogscproject");
const mediaDir = path.join(packagePath, "media");

const DURATION = 12;
const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;

function run(args) {
  execFileSync(ffmpeg, ["-hide_banner", "-loglevel", "error", "-y", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function build() {
  fs.mkdirSync(mediaDir, { recursive: true });

  /* Screen: a slow animated gradient that reads as a landscape at a glance. */
  run([
    "-f",
    "lavfi",
    "-i",
    `gradients=size=${WIDTH}x${HEIGHT}:rate=${FPS}:duration=${DURATION}:` +
      "c0=0x0b1e33:c1=0x1d5b7a:c2=0xd9a05b:c3=0x2e6f4f:c4=0x8fb8c9:c5=0x11212f:" +
      "speed=0.035:type=linear",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "20",
    "-pix_fmt",
    "yuv420p",
    path.join(mediaDir, "screen.mp4"),
  ]);

  /* Camera: a soft portrait placeholder with a drifting highlight. */
  run([
    "-f",
    "lavfi",
    "-i",
    `color=c=0x2b3440:s=960x720:r=30:d=${DURATION}`,
    "-vf",
    "drawbox=x='120+60*sin(t)':y=180:w=360:h=360:color=0x4a6b8a@0.9:t=fill," +
      "drawbox=x=300:y=120:w=360:h=420:color=0xd8c2a8@0.85:t=fill",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "22",
    "-pix_fmt",
    "yuv420p",
    path.join(mediaDir, "camera.mp4"),
  ]);

  /* System audio + microphone, so the audio track and export mix are real. */
  run([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=196:duration=${DURATION}:sample_rate=48000`,
    "-af",
    "volume=0.25,tremolo=f=0.4:d=0.4",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    path.join(mediaDir, "system.m4a"),
  ]);
  run([
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=330:duration=${DURATION}:sample_rate=48000`,
    "-af",
    "volume=0.18,tremolo=f=0.25:d=0.6",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
    path.join(mediaDir, "microphone.m4a"),
  ]);

  const document = {
    schemaVersion: 27,
    id: "dogsc-demo",
    name: "海岸漫游 · 功能演示",
    createdAt: new Date().toISOString(),
    capture: {
      kind: "display",
      sourceName: "显示器 1",
      displayId: "1",
      fps: FPS,
      systemAudio: true,
      microphone: true,
      camera: true,
    },
    media: {
      screen: {
        path: "media/screen.mp4",
        duration: DURATION,
        width: WIDTH,
        height: HEIGHT,
      },
      camera: { path: "media/camera.mp4", duration: DURATION, width: 960, height: 720 },
      system: { path: "media/system.m4a", duration: DURATION },
      microphone: { path: "media/microphone.m4a", duration: DURATION },
    },
    pointerTrack: buildPointerTrack(),
    markers: [
      { id: "marker-1", time: 4.0 },
      { id: "marker-2", time: 7.0 },
    ],
    timeline: {
      duration: DURATION,
      primaryClips: [
        { id: "clip-1", sourceStart: 0, sourceDuration: 12, startTime: 0, speed: 1 },
      ],
      zoomClips: [
        {
          id: "zoom-1",
          startTime: 1.4,
          duration: 3.6,
          mode: "自动",
          focus: { x: 0.42, y: 0.46 },
          scale: 1.4,
          transitionIn: 0.7,
          transitionOut: 0.7,
          easing: "spring",
        },
        {
          id: "zoom-2",
          startTime: 6.2,
          duration: 3.4,
          mode: "手动",
          focus: { x: 0.6, y: 0.55 },
          scale: 1.5,
          transitionIn: 0.6,
          transitionOut: 0.6,
          easing: "spring",
        },
      ],
      screenMotionClips: [],
      cameraMotionClips: [],
      stickerClips: [],
      mosaicClips: [],
    },
  };

  fs.writeFileSync(
    path.join(packagePath, "project.json"),
    JSON.stringify(document, null, 2),
    "utf8"
  );

  const total = fs
    .readdirSync(mediaDir)
    .reduce((sum, name) => sum + fs.statSync(path.join(mediaDir, name)).size, 0);
  console.log(`[demo] package: ${packagePath}`);
  console.log(`[demo] media: ${(total / 1024 / 1024).toFixed(1)} MB`);
  return packagePath;
}

/** A believable pointer path: sweeping arcs plus a few discrete clicks. */
function buildPointerTrack() {
  const samples = [];
  const clicks = [];
  const step = 1 / 60;
  for (let time = 0; time <= DURATION; time += step) {
    const t = time / DURATION;
    const x = 0.18 + 0.6 * t + 0.08 * Math.sin(time * 1.6);
    const y = 0.32 + 0.26 * Math.sin(time * 0.9 + 0.6) + 0.08 * Math.cos(time * 2.1);
    samples.push({
      t: Number(time.toFixed(4)),
      x: Number(Math.min(0.97, Math.max(0.03, x)).toFixed(5)),
      y: Number(Math.min(0.97, Math.max(0.03, y)).toFixed(5)),
    });
  }
  for (const time of [1.2, 3.05, 4.6, 6.9, 9.4, 10.8]) {
    const index = Math.min(samples.length - 1, Math.round(time / step));
    clicks.push({
      t: Number(time.toFixed(3)),
      button: "left",
      x: samples[index].x,
      y: samples[index].y,
      delta: 0,
    });
  }
  return { samples, clicks };
}

build();
