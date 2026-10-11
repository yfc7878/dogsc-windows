/**
 * Builds resources/icon.ico from the original macOS artwork.
 *
 * The macOS package ships `AppIconMaster.png` and an `.icns`; Windows needs a
 * multi-resolution `.ico`. ffmpeg has no ICO muxer, so this scales the master
 * to the standard sizes and packs them into the container directly — each
 * entry is stored as a PNG, which Vista and later read natively.
 *
 * Usage: node tools/make-icon.js
 */

const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ffmpeg = require("ffmpeg-static");

const root = path.join(__dirname, "..");
const master = path.join(root, "resources", "AppIconMaster.png");
const target = path.join(root, "resources", "icon.ico");
const work = path.join(root, "resources", ".icon-build");

/** Sizes Windows uses: shell icons, taskbar, alt-tab, and the store tile. */
const SIZES = [16, 24, 32, 48, 64, 128, 256];

function buildPngs() {
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const outputs = [];
  for (const size of SIZES) {
    const output = path.join(work, `icon-${size}.png`);
    execFileSync(
      ffmpeg,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        master,
        "-vf",
        `scale=${size}:${size}:flags=lanczos`,
        "-frames:v",
        "1",
        output,
      ],
      { stdio: ["ignore", "inherit", "inherit"] }
    );
    outputs.push({ size, file: output });
  }
  return outputs;
}

function packIco(entries) {
  const images = entries.map((entry) => ({
    size: entry.size,
    data: fs.readFileSync(entry.file),
  }));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(images.length, 4);

  const directory = Buffer.alloc(16 * images.length);
  let offset = header.length + directory.length;

  images.forEach((image, index) => {
    const entry = directory.subarray(index * 16, index * 16 + 16);
    // 256 is encoded as 0 in the directory.
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 0);
    entry.writeUInt8(image.size >= 256 ? 0 : image.size, 1);
    entry.writeUInt8(0, 2); // palette colours
    entry.writeUInt8(0, 3); // reserved
    entry.writeUInt16LE(1, 4); // colour planes
    entry.writeUInt16LE(32, 6); // bits per pixel
    entry.writeUInt32LE(image.data.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += image.data.length;
  });

  return Buffer.concat([header, directory, ...images.map((image) => image.data)]);
}

function build() {
  if (!fs.existsSync(master)) {
    console.error(`[icon] master artwork missing: ${master}`);
    process.exit(1);
  }
  const entries = buildPngs();
  fs.writeFileSync(target, packIco(entries));
  fs.rmSync(work, { recursive: true, force: true });
  const stat = fs.statSync(target);
  console.log(
    `[icon] ${target} · ${SIZES.join(", ")} px · ${(stat.size / 1024).toFixed(1)} KB`
  );
}

build();
