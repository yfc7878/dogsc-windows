/**
 * Completion chime.
 *
 * The macOS original plays the system "Glass" sound when an export finishes
 * (NSSound, toggleable in Settings, with an audition button). Windows has no
 * equivalent system sound to reach for, so the chime is synthesised with
 * WebAudio: two short sine notes with an exponential decay. Every call is
 * guarded — a machine with no audio device simply stays silent instead of
 * throwing into the export's success path.
 */

let context = null;

function audioContext() {
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  if (!context) context = new Ctor();
  if (context.state === "suspended") context.resume().catch(() => {});
  return context;
}

/** Plays one round of the completion chime. Never throws. */
export function playChime() {
  let ctx;
  try {
    ctx = audioContext();
  } catch {
    return;
  }
  if (!ctx) return;
  try {
    const now = ctx.currentTime;
    const notes = [
      { freq: 987.77, at: 0 }, // B5
      { freq: 1318.51, at: 0.09 }, // E6
    ];
    for (const note of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = note.freq;
      gain.gain.setValueAtTime(0.0001, now + note.at);
      gain.gain.exponentialRampToValueAtTime(0.18, now + note.at + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + note.at + 0.42);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now + note.at);
      osc.stop(now + note.at + 0.45);
    }
  } catch {
    /* a dead audio device must never break the export flow */
  }
}
