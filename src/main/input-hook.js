/**
 * Pointer observer.
 *
 * Produces the editable cursor track the editor needs: a dense sampled path
 * plus discrete click events. macOS gets this from NSEvent global monitors;
 * on Windows the clicks come from a WH_MOUSE_LL hook and the path is sampled
 * from the OS cursor position, which is exactly the shape the original's
 * `PointerTrack` model expects.
 *
 * All emitted coordinates are physical screen pixels, normalised later
 * against the recorded display so a 150% DPI monitor lands in the same place
 * as a 100% one.
 */

const { spawn } = require("child_process");
const { screen } = require("electron");
const { childEnv } = require("./child-env");
const { resolveScript } = require("./paths");

const SAMPLE_INTERVAL_MS = 16; // ~60 Hz, matching the original's sampling
const MOVE_EPSILON = 0.6; // physical px; filters cursor jitter when idle

class PointerTracker {
  constructor() {
    /* Resolved through paths.js: in a packaged build the script has to live
       outside app.asar, because a helper process cannot read from inside the
       archive. */
    this.scriptPath = resolveScript("pointer-observer.ps1");
    this.child = null;
    this.ready = false;
    this.pendingReady = null;

    this.samples = [];
    this.clicks = [];
    this.capturing = false;
    this.sampleTimer = null;
    this.originMs = 0;
    this.lastPoint = null;

    /* Physical rect of the display being recorded, set by startCapture(). */
    this.displayRect = null;
  }

  /* --------------------------------------------------------------------- */
  /* Hook lifecycle                                                        */
  /* --------------------------------------------------------------------- */

  start() {
    if (this.child) return this.pendingReady || Promise.resolve(true);
    this.pendingReady = new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      let buffer = "";
      try {
        this.child = spawn(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            this.scriptPath,
          ],
          /* A trimmed environment: Windows rejects an oversized block. */
          { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env: childEnv() }
        );
      } catch (error) {
        console.error("[pointer] failed to spawn observer", error);
        this.child = null;
        finish(false);
        return;
      }

      this.child.stdout.setEncoding("utf8");
      this.child.stdout.on("data", (chunk) => {
        buffer += chunk;
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop();
        for (const line of lines) this.handleLine(line, finish);
      });

      this.child.stderr.setEncoding("utf8");
      this.child.stderr.on("data", (chunk) => {
        const text = String(chunk).trim();
        if (text) console.error("[pointer]", text);
      });

      this.child.on("exit", () => {
        this.child = null;
        this.ready = false;
        finish(false);
      });

      /* Add-Type compiles the hook on first use; allow for a cold start. */
      setTimeout(() => finish(this.ready), 15000);
    });
    return this.pendingReady;
  }

  handleLine(line, finish) {
    const trimmed = line.trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (event.kind === "ready") {
      this.ready = true;
      finish?.(true);
      return;
    }
    if (event.kind === "error") {
      console.error("[pointer] observer error:", event.message);
      finish?.(false);
      return;
    }
    if (!this.capturing) return;

    if (event.kind === "down") {
      this.clicks.push({
        t: this.now(),
        button: event.button || "left",
        x: event.x,
        y: event.y,
      });
    } else if (event.kind === "wheel" && event.delta) {
      /* Wheel ticks are not a first-class cursor effect in the original, but
         keeping them lets the editor show scroll activity later. */
      this.clicks.push({
        t: this.now(),
        button: "wheel",
        x: event.x,
        y: event.y,
        delta: event.delta,
      });
    }
  }

  stop() {
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        /* the process may already be gone */
      }
      this.child = null;
    }
    this.ready = false;
  }

  /* --------------------------------------------------------------------- */
  /* Capture                                                               */
  /* --------------------------------------------------------------------- */

  /**
   * @param {{x:number,y:number,width:number,height:number}|null} displayRect
   *        physical pixel rect of the recorded display
   */
  async startCapture(displayRect) {
    this.displayRect = displayRect;
    this.samples = [];
    this.clicks = [];
    this.originMs = Date.now();
    this.lastPoint = null;
    this.capturing = true;
    await this.start();
    this.tick();
    this.sampleTimer = setInterval(() => this.tick(), SAMPLE_INTERVAL_MS);
  }

  tick() {
    if (!this.capturing) return;
    let point;
    try {
      point = screen.getCursorScreenPoint(); // DIP
      point = screen.dipToScreenPoint(point); // physical
    } catch {
      return;
    }
    const t = this.now();
    const last = this.lastPoint;
    if (last && Math.abs(last.x - point.x) < MOVE_EPSILON && Math.abs(last.y - point.y) < MOVE_EPSILON) {
      return;
    }
    this.lastPoint = { x: point.x, y: point.y, t };
    this.samples.push({ t, x: point.x, y: point.y });
  }

  stopCapture() {
    this.capturing = false;
    if (this.sampleTimer) {
      clearInterval(this.sampleTimer);
      this.sampleTimer = null;
    }
    /* Never started (a device recording has no desktop pointer track): report
       an empty track rather than a duration measured from the epoch. */
    const duration = this.originMs ? this.now() : 0;
    const rect = this.displayRect;
    const origin = rect ? { x: rect.x, y: rect.y } : { x: 0, y: 0 };
    const width = rect ? rect.width : 1920;
    const height = rect ? rect.height : 1080;

    const samples = this.samples.map((s) => ({
      t: s.t,
      x: (s.x - origin.x) / width,
      y: (s.y - origin.y) / height,
    }));
    const clicks = this.clicks.map((c) => ({
      t: c.t,
      button: c.button,
      delta: c.delta || 0,
      x: (c.x - origin.x) / width,
      y: (c.y - origin.y) / height,
    }));

    this.samples = [];
    this.clicks = [];
    this.displayRect = null;
    this.originMs = 0;
    return { samples, clicks, duration };
  }

  now() {
    return (Date.now() - this.originMs) / 1000;
  }
}

/**
 * Resolves the physical pixel rect of a display so pointer samples can be
 * normalised against the recorded frame.
 */
function physicalRectForDisplay(displayId) {
  const displays = screen.getAllDisplays();
  let display = displays.find((d) => String(d.id) === String(displayId));
  if (!display) display = screen.getPrimaryDisplay();
  const origin = screen.dipToScreenPoint({ x: display.bounds.x, y: display.bounds.y });
  return {
    x: origin.x,
    y: origin.y,
    width: Math.round(display.bounds.width * display.scaleFactor),
    height: Math.round(display.bounds.height * display.scaleFactor),
    scaleFactor: display.scaleFactor,
  };
}

module.exports = { PointerTracker, physicalRectForDisplay };
