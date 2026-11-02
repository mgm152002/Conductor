/** Bounding box of the non-white content in a BGRA bitmap (Electron's
 *  NativeImage.toBitmap layout), padded and clamped. Null when blank. */
export interface ImageRect { x: number; y: number; width: number; height: number }

export function contentBounds(bitmap: Uint8Array | Uint8ClampedArray, width: number, height: number, padding = 20): ImageRect | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const b = bitmap[i] ?? 255;
      const g = bitmap[i + 1] ?? 255;
      const r = bitmap[i + 2] ?? 255;
      const a = bitmap[i + 3] ?? 255;
      if (a > 10 && (r < 248 || g < 248 || b < 248)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const x = Math.max(0, minX - padding);
  const y = Math.max(0, minY - padding);
  return {
    x,
    y,
    width: Math.min(width, maxX + padding + 1) - x,
    height: Math.min(height, maxY + padding + 1) - y,
  };
}
