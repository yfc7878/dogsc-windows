/**
 * Pointer cursor-shape merging.
 *
 * The Win32 observer reports cursor-shape changes as discrete events; the
 * recorded samples carry a shape only where it changes, forward-filled here so
 * the renderer inherits the last known value — the same sparse encoding the
 * original's pointer events use (`recordedCursorAssetID` per event).
 *
 * Kept free of Electron imports so it can be unit-tested.
 */

/**
 * @param {Array<{t:number,x:number,y:number}>} samples
 * @param {Array<{t:number,shape:string}>} shapeEvents  ascending by `t`
 * @returns {Array<{t:number,x:number,y:number,cursor?:string}>}
 */
function mergeCursorShapes(samples, shapeEvents) {
  if (!Array.isArray(shapeEvents) || shapeEvents.length === 0) {
    return samples.map((sample) => ({ t: sample.t, x: sample.x, y: sample.y }));
  }
  const merged = [];
  let index = 0;
  let current = null;
  for (const sample of samples) {
    while (index < shapeEvents.length && shapeEvents[index].t <= sample.t) {
      current = shapeEvents[index].shape;
      index += 1;
    }
    const entry = { t: sample.t, x: sample.x, y: sample.y };
    if (current) entry.cursor = current;
    merged.push(entry);
  }
  return merged;
}

module.exports = { mergeCursorShapes };
