import { MAX_AGENT_ICON_CHARS } from '@shared/sandbox-agents';

// Agent icons are small square images kept with the agent as data URLs.
// Uploads are cropped to a square and shrunk; generated ones are drawn on a
// canvas from a random seed, in the agent's colour, so "Generate" can be
// pressed again until one fits.

const SIZE = 128;

function canvas(): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const element = document.createElement('canvas');
  element.width = SIZE;
  element.height = SIZE;
  const context = element.getContext('2d');
  if (context === null) throw new Error('Could not draw the icon.');
  return [element, context];
}

function finish(element: HTMLCanvasElement): string {
  // PNG keeps transparency; fall back to JPEG when a busy photo is too big.
  for (const [type, quality] of [['image/png', undefined], ['image/webp', 0.85], ['image/webp', 0.6], ['image/jpeg', 0.7]] as const) {
    const url = element.toDataURL(type, quality);
    if (url.startsWith(`data:${type};`) && url.length <= MAX_AGENT_ICON_CHARS) return url;
  }
  throw new Error('That image is too detailed to use as an icon. Try a simpler one.');
}

/** A picked image file as a square 128px icon. */
export async function fileToIcon(file: File): Promise<string> {
  if (!/^image\/(png|jpeg|webp|gif|bmp|svg\+xml)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, WebP or SVG image.');
  if (file.size > 10 * 1024 * 1024) throw new Error('Choose an image under 10 MB.');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode().catch(() => { throw new Error('That image could not be read.'); });
    const [element, context] = canvas();
    const side = Math.min(image.naturalWidth, image.naturalHeight);
    if (side === 0) throw new Error('That image could not be read.');
    context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, SIZE, SIZE);
    return finish(element);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function rng(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function shift(hex: string, hue: number, lightness: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  const r = ((n >> 16) & 255) / 255; const g = ((n >> 8) & 255) / 255; const b = (n & 255) / 255;
  const max = Math.max(r, g, b); const min = Math.min(r, g, b);
  let h = 0; const l = (max + min) / 2; const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  if (d !== 0) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return `hsl(${Math.round(((h * 60 + hue) % 360 + 360) % 360)} ${Math.round(Math.max(35, s * 100))}% ${Math.round(Math.min(78, Math.max(28, (l + lightness) * 100)))}%)`;
}

/** A new abstract icon in the agent's colour. Different on every call. */
export function generateIcon(color: string, seed = Math.floor(Math.random() * 2 ** 31)): string {
  const random = rng(seed);
  const [element, context] = canvas();
  const from = shift(color, (random() - 0.5) * 50, 0.08);
  const to = shift(color, (random() - 0.5) * 80, -0.12);
  const gradient = context.createLinearGradient(0, 0, SIZE, SIZE);
  gradient.addColorStop(0, from);
  gradient.addColorStop(1, to);
  context.fillStyle = gradient;
  context.fillRect(0, 0, SIZE, SIZE);

  const kind = Math.floor(random() * 4);
  context.fillStyle = 'rgba(255,255,255,0.9)';
  context.strokeStyle = 'rgba(255,255,255,0.9)';
  context.lineCap = 'round';
  context.lineWidth = 9;
  const c = SIZE / 2;
  if (kind === 0) {
    // Orbiting dots around a core.
    context.beginPath(); context.arc(c, c, 14 + random() * 8, 0, Math.PI * 2); context.fill();
    const dots = 3 + Math.floor(random() * 4); const turn = random() * Math.PI;
    for (let i = 0; i < dots; i += 1) {
      const angle = turn + (i / dots) * Math.PI * 2;
      context.globalAlpha = 0.55 + random() * 0.4;
      context.beginPath(); context.arc(c + Math.cos(angle) * 40, c + Math.sin(angle) * 40, 6 + random() * 6, 0, Math.PI * 2); context.fill();
    }
  } else if (kind === 1) {
    // Rising bars.
    const bars = 4 + Math.floor(random() * 2); const width = 64 / bars;
    for (let i = 0; i < bars; i += 1) {
      const height = 24 + random() * 56;
      context.globalAlpha = 0.6 + random() * 0.4;
      context.beginPath(); context.roundRect(32 + i * (width + 2), 100 - height, width - 2, height, 5); context.fill();
    }
  } else if (kind === 2) {
    // Nested rings and a spark.
    context.globalAlpha = 0.9;
    for (let i = 0; i < 3; i += 1) { context.globalAlpha = 0.95 - i * 0.25; context.beginPath(); context.arc(c, c, 14 + i * 16, 0, Math.PI * 2); context.stroke(); }
    context.globalAlpha = 1; context.beginPath(); context.arc(c, c, 6, 0, Math.PI * 2); context.fill();
  } else {
    // A burst of rays.
    const rays = 5 + Math.floor(random() * 5); const turn = random() * Math.PI;
    for (let i = 0; i < rays; i += 1) {
      const angle = turn + (i / rays) * Math.PI * 2; const inner = 16 + random() * 8; const outer = 38 + random() * 16;
      context.globalAlpha = 0.65 + random() * 0.35;
      context.beginPath(); context.moveTo(c + Math.cos(angle) * inner, c + Math.sin(angle) * inner); context.lineTo(c + Math.cos(angle) * outer, c + Math.sin(angle) * outer); context.stroke();
    }
    context.globalAlpha = 1; context.beginPath(); context.arc(c, c, 9, 0, Math.PI * 2); context.fill();
  }
  return finish(element);
}
