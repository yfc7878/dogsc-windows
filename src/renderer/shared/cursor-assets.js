/**
 * Cursor artwork loader.
 *
 * Fetches the system cursor sprites extracted by the main process (the
 * Windows equivalent of the original's `NSCursor` images) and decodes them
 * into `<img>` elements once per window. Every consumer — the editor preview,
 * the export renderer, the inspector's effect preview — shares this cache.
 *
 * Assets carry `mode: "sprite"` (draw with the hotspot at the pointer) or
 * `mode: "invert"` (a white mask the renderer blends with `difference`, the
 * way Windows shows the I-beam and crosshair over arbitrary content).
 */

let cache = null;
let pending = null;

function loadImage(url) {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * @returns {Promise<Map<string, {image: HTMLImageElement, mode: string,
 *   hotspotX: number, hotspotY: number, width: number, height: number}>>}
 *   Never rejects; an empty map means the vector fallbacks are used.
 */
export function loadCursorAssets() {
  if (cache) return Promise.resolve(cache);
  if (pending) return pending;
  pending = (async () => {
    const map = new Map();
    try {
      const payload = await window.dogsc.cursor.assets();
      for (const asset of payload?.assets || []) {
        if (!asset?.id || !asset.png) continue;
        const image = await loadImage(`data:image/png;base64,${asset.png}`);
        if (!image) continue;
        map.set(asset.id, {
          image,
          mode: asset.mode === "invert" ? "invert" : "sprite",
          hotspotX: Number(asset.hotspotX) || 0,
          hotspotY: Number(asset.hotspotY) || 0,
          width: Number(asset.width) || image.width || 32,
          height: Number(asset.height) || image.height || 32,
        });
      }
    } catch (error) {
      console.error("[cursor-assets] load failed", error);
    }
    cache = map;
    return map;
  })();
  return pending;
}
