import { describe, expect, it } from 'vitest';
import { contentBounds } from '@shared/content-bounds';

function bitmap(width: number, height: number, dark: { x: number; y: number; w: number; h: number } | null): Buffer {
  const buffer = Buffer.alloc(width * height * 4, 255);
  if (dark !== null) {
    for (let y = dark.y; y < dark.y + dark.h; y += 1) {
      for (let x = dark.x; x < dark.x + dark.w; x += 1) {
        const i = (y * width + x) * 4;
        buffer[i] = 20; buffer[i + 1] = 30; buffer[i + 2] = 25; buffer[i + 3] = 255;
      }
    }
  }
  return buffer;
}

describe('contentBounds', () => {
  it('crops a full-window capture to the diagram, with padding clamped to the edges', () => {
    // Diagram occupying a small strip near the top of a 100x80 capture.
    expect(contentBounds(bitmap(100, 80, { x: 30, y: 5, w: 40, h: 10 }), 100, 80, 10))
      .toEqual({ x: 20, y: 0, width: 60, height: 25 });
  });

  it('returns null for a blank capture', () => {
    expect(contentBounds(bitmap(20, 20, null), 20, 20)).toBeNull();
  });
});
