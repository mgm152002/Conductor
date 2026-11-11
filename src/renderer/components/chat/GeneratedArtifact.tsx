import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import {
  ARTIFACT_KIND_META, artifactFileName, normalizeSpec, type ArtifactImageData, type GeneratedArtifactSpec,
} from '@shared/generated-artifacts';
import { ChevronRightIcon, DownloadIcon, FileTextIcon, PlayIcon, Spinner, XIcon } from '../ui/icons';
import { cn } from '../../lib/cn';
import { buildVisualSrcDoc, normalizeSvgForImage } from '../../lib/visuals';
import { contentBounds } from '@shared/content-bounds';
import { useThemeStore } from '../../stores';

// Lazy, like MessagesTimeline: this chunk is only needed when a preview is
// opened, and it keeps the Markdown <-> GeneratedArtifact import acyclic.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

/** In-app preview: documents render their formatted content; decks step through slides. */
function ArtifactPreview({ spec }: { spec: GeneratedArtifactSpec }): React.JSX.Element {
  const slides = spec.slides ?? [];
  const [index, setIndex] = useState(0);
  const dark = useThemeStore((s) => s.appearance) === 'dark';
  if (spec.kind === 'presentation') {
    const slide = slides[Math.min(index, Math.max(0, slides.length - 1))];
    return (
      <div className="flex flex-col gap-2">
        <div className="flex aspect-video w-full flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-card px-6 py-5">
          <p className="text-lg font-semibold text-foreground">{slide?.title}</p>
          {slide?.body ? <p className="text-sm whitespace-pre-wrap text-muted-foreground">{slide.body}</p> : null}
          <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-foreground">
            {slide?.bullets.map((bullet, i) => <li key={i}>{bullet}</li>)}
          </ul>
          {slide?.svg ? (
            <iframe
              title={`Diagram on slide: ${slide.title}`}
              sandbox=""
              srcDoc={buildVisualSrcDoc(slide.svg, dark)}
              className="block min-h-44 w-full flex-1 border-0 bg-transparent"
            />
          ) : null}
        </div>
        <div className="flex items-center justify-between text-2xs text-muted-foreground">
          <button type="button" disabled={index <= 0} onClick={() => { setIndex((v) => Math.max(0, v - 1)); }} className="cursor-pointer rounded-sm px-1.5 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40">Previous</button>
          <span className="tabular-nums">Slide {Math.min(index + 1, slides.length)} of {slides.length}</span>
          <button type="button" disabled={index >= slides.length - 1} onClick={() => { setIndex((v) => Math.min(slides.length - 1, v + 1)); }} className="cursor-pointer rounded-sm px-1.5 py-0.5 hover:bg-accent hover:text-foreground disabled:opacity-40">Next</button>
        </div>
      </div>
    );
  }
  const markdown = spec.content ?? slides.map((s) => `# ${s.title}\n${s.body ?? ''}\n${s.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n');
  return (
    <div className="px-1">
      <Suspense fallback={<p className="text-sm text-muted-foreground">Loading preview…</p>}>
        <Markdown text={markdown} />
      </Suspense>
    </div>
  );
}

// A deliverable Conductor generated from an agent's artifact spec. In the
// conversation it is one compact card (what it is, its state, Download);
// clicking the card opens the artifact panel at the right of the window with
// the preview. A video shows its render canvas under the card while it
// records, then plays in the panel.

/** 42 → "42 bytes", 1_536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * The artifact card shown in a conversation. The card itself opens the
 * artifact; `action` is the trailing control (usually Download).
 */
export function ArtifactCard({ icon, title, meta, onOpen, open = false, busy = false, progress, error = false, action, label }: {
  icon: ReactNode;
  title: string;
  /** One line under the title: kind, size or state. */
  meta: ReactNode;
  /** Omit while there is nothing to open yet. */
  onOpen?: (() => void) | undefined;
  open?: boolean;
  busy?: boolean;
  /** 0–1 while generating; draws a progress line on the card's lower edge. */
  progress?: number | undefined;
  error?: boolean;
  action?: ReactNode;
  label: string;
}): React.JSX.Element {
  return (
    <div className={cn(
      'group/artifact relative flex max-w-md items-stretch overflow-hidden rounded-xl border bg-card transition-[border-color,box-shadow]',
      open ? 'border-primary/50 shadow-lift' : error ? 'border-destructive/30' : 'border-border hover:border-border-strong hover:shadow-lift',
    )}>
      <button
        type="button"
        onClick={onOpen}
        disabled={onOpen === undefined}
        aria-expanded={onOpen !== undefined ? open : undefined}
        aria-label={label}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pr-2 pl-2.5 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring disabled:cursor-default"
      >
        <span className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', error ? 'bg-destructive/10 text-destructive-foreground' : 'bg-primary/12 text-primary')}>
          {busy ? <Spinner size={16} /> : icon}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate text-[13px] font-medium text-foreground" title={title}>{title}</span>
          <span className={cn('truncate text-2xs', error ? 'text-destructive-foreground' : 'text-muted-foreground')}>{meta}</span>
        </span>
        {onOpen !== undefined ? <ChevronRightIcon size={14} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'translate-x-0.5 text-primary')} /> : null}
      </button>
      {action !== undefined ? <div className="flex shrink-0 items-center border-l border-border px-1.5">{action}</div> : null}
      {progress !== undefined ? (
        <span aria-hidden="true" className="absolute inset-x-0 bottom-0 h-0.5 bg-accent">
          <span className="block h-full bg-primary transition-[width] duration-200" style={{ width: `${Math.max(6, Math.min(1, progress) * 100)}%` }} />
        </span>
      ) : null}
    </div>
  );
}

/** The trailing icon button on an artifact card or in the panel header. */
export function ArtifactAction({ label, onClick, children }: { label: string; onClick: () => void; children: ReactNode }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} aria-label={label} title={label} className="flex size-8 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      {children}
    </button>
  );
}

/**
 * The artifact panel: a sheet docked to the right edge of the window, under
 * the top bar, showing one artifact. Escape or the close button dismisses it;
 * the conversation stays usable beside it.
 */
export function ArtifactPanel({ title, meta, icon, actions, onClose, children }: {
  title: string;
  meta: ReactNode;
  icon: ReactNode;
  actions?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}): React.JSX.Element | null {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); closeRef.current(); }
    };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, []);
  if (typeof document === 'undefined') return null;
  return createPortal(
    <aside
      role="complementary"
      aria-label={`Artifact: ${title}`}
      className="animate-slide-in fixed top-(--bar-height) right-0 bottom-0 z-40 flex w-[min(44rem,58vw)] min-w-[22rem] flex-col border-l border-border bg-background shadow-pop"
    >
      <header className="flex h-(--topbar-height) shrink-0 items-center gap-2.5 border-b border-border pr-2 pl-4">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">{icon}</span>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[13px] leading-tight font-semibold text-foreground" title={title}>{title}</h2>
          <p className="truncate text-3xs text-muted-foreground">{meta}</p>
        </div>
        {actions}
        <ArtifactAction label="Close artifact" onClick={onClose}><XIcon size={15} /></ArtifactAction>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">{children}</div>
    </aside>,
    document.body,
  );
}

interface Ready { url: string; fileName: string; sizeBytes: number; missingDiagrams?: number; missingReason?: string }
type State = { status: 'generating'; progress: number } | { status: 'ready'; ready: Ready } | { status: 'failed'; error: string };

// Session cache so scrolling/remounting never regenerates a file (a video
// render takes real time).
const cache = new Map<string, Promise<Ready>>();

function download(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

const VIDEO_W = 1280;
const VIDEO_H = 720;

function wrapText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const last = out[out.length - 1];
    if (last !== undefined && ctx.measureText(`${last} ${word}`).width < maxWidth) out[out.length - 1] = `${last} ${word}`;
    else out.push(word);
  }
  return out.length > 0 ? out : [''];
}

/** Render the scenes to a WebM by painting them on a canvas while it records. */
async function generateVideo(spec: GeneratedArtifactSpec, canvas: HTMLCanvasElement, onProgress: (value: number) => void): Promise<Ready> {
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('Video canvas is unavailable');
  const slides = (spec.slides ?? []).slice(0, 12);
  if (slides.length === 0) throw new Error('The video has no scenes');
  const stream = canvas.captureStream(30);
  // MP4 first: MediaRecorder WebM has no duration metadata (duration is
  // Infinity), which leaves the player at 0:00 with a dead progress bar.
  // MP4 recordings carry real durations and play/seek everywhere.
  const mimeType = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((candidate) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(candidate)) ?? '';
  const recorder = new MediaRecorder(stream, mimeType === '' ? undefined : { mimeType, videoBitsPerSecond: 2_500_000 });
  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data); };
  const stopped = new Promise<void>((resolve) => { recorder.onstop = () => { resolve(); }; });
  const totalMs = slides.reduce((sum, s) => sum + (s.durationSeconds ?? 2.5) * 1000, 0);
  recorder.start(250);
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const draw = (now: number): void => {
      const elapsed = now - started;
      onProgress(Math.min(1, elapsed / totalMs));
      let cursor = 0;
      let index = slides.length - 1;
      let local = (slides[index]?.durationSeconds ?? 2.5) * 1000;
      for (let i = 0; i < slides.length; i += 1) {
        const duration = (slides[i]?.durationSeconds ?? 2.5) * 1000;
        if (elapsed < cursor + duration) { index = i; local = elapsed - cursor; break; }
        cursor += duration;
      }
      const slide = slides[index]!;
      const duration = (slide.durationSeconds ?? 2.5) * 1000;
      const fade = Math.min(1, local / 350, (duration - local) / 350);
      const gradient = ctx.createLinearGradient(0, 0, VIDEO_W, VIDEO_H);
      gradient.addColorStop(0, '#101613');
      gradient.addColorStop(1, '#1d2b23');
      ctx.globalAlpha = 1;
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, VIDEO_W, VIDEO_H);
      ctx.globalAlpha = Math.max(0.25, fade);
      ctx.fillStyle = '#e9f0e8';
      ctx.font = '600 54px -apple-system, "Segoe UI", sans-serif';
      let y = 150;
      for (const line of wrapText(ctx, slide.title, VIDEO_W - 160).slice(0, 3)) { ctx.fillText(line, 80, y); y += 64; }
      ctx.font = '400 30px -apple-system, "Segoe UI", sans-serif';
      ctx.fillStyle = '#c4d2c6';
      y += 24;
      for (const bullet of slide.bullets.slice(0, 6)) {
        for (const line of wrapText(ctx, `• ${bullet}`, VIDEO_W - 200).slice(0, 2)) { ctx.fillText(line, 100, y); y += 42; }
      }
      if (slide.body !== undefined && slide.bullets.length === 0) {
        for (const line of wrapText(ctx, slide.body, VIDEO_W - 160).slice(0, 8)) { ctx.fillText(line, 80, y); y += 42; }
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = '#3f5a49';
      ctx.fillRect(80, VIDEO_H - 56, VIDEO_W - 160, 6);
      ctx.fillStyle = '#9fd3a8';
      ctx.fillRect(80, VIDEO_H - 56, (VIDEO_W - 160) * Math.min(1, elapsed / totalMs), 6);
      ctx.fillStyle = '#7d8f83';
      ctx.font = '400 22px -apple-system, "Segoe UI", sans-serif';
      ctx.fillText(`${index + 1} / ${slides.length}`, VIDEO_W - 150, 64);
      if (elapsed >= totalMs) { resolve(); return; }
      requestAnimationFrame(draw);
    };
    requestAnimationFrame(draw);
  });
  recorder.stop();
  await stopped;
  const recordedType = (recorder.mimeType || mimeType || 'video/webm').split(';')[0]!;
  const blob = new Blob(chunks, { type: recordedType });
  const fileName = artifactFileName(spec).replace(/\.(webm|mp4)$/, recordedType === 'video/mp4' ? '.mp4' : '.webm');
  return { url: URL.createObjectURL(blob), fileName, sizeBytes: blob.size };
}

function extractSvg(fragment: string): string | null {
  const match = /<svg[\s\S]*?<\/svg>/i.exec(fragment);
  return match !== null ? match[0] : fragment.trim().startsWith('<svg') ? fragment.trim() : null;
}

/** Load one standalone SVG text as an image and paint it to a raster. */
async function paintSvg(svgText: string, kind: GeneratedArtifactSpec['kind']): Promise<ArtifactImageData> {
  const url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => { reject(new Error('Diagram render timed out')); }, 10_000);
      image.onload = () => { window.clearTimeout(timer); resolve(); };
      image.onerror = () => { window.clearTimeout(timer); reject(new Error('Could not render a diagram')); };
      image.src = url;
    });
    const naturalWidth = image.naturalWidth > 0 ? image.naturalWidth : 1200;
    const naturalHeight = image.naturalHeight > 0 ? image.naturalHeight : 800;
    const scale = Math.min(1, 1400 / naturalWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(naturalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Image canvas is unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    // Crop surrounding white so the diagram embeds at full size, not as a
    // small card inside a big white frame.
    let outCanvas = canvas;
    try {
      const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const bounds = contentBounds(pixels.data, canvas.width, canvas.height, 12);
      if (bounds !== null && (bounds.width < canvas.width || bounds.height < canvas.height)) {
        outCanvas = document.createElement('canvas');
        outCanvas.width = bounds.width;
        outCanvas.height = bounds.height;
        const outCtx = outCanvas.getContext('2d');
        if (outCtx !== null) {
          outCtx.fillStyle = '#ffffff';
          outCtx.fillRect(0, 0, bounds.width, bounds.height);
          outCtx.drawImage(canvas, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
        }
      }
    } catch { /* keep the uncropped paint */ }
    const mime = kind === 'pdf' ? 'image/jpeg' : 'image/png';
    const dataUrl = outCanvas.toDataURL(mime, 0.92);
    return { dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), width: outCanvas.width, height: outCanvas.height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Rasterize an agent diagram so the file generators can embed it (JPEG for
 * PDF, PNG otherwise). Tries the SVG directly in the renderer; if that
 * fails — or the "diagram" is really an HTML fragment — the main process
 * paints it in an offscreen window and captures it (a foreignObject paint
 * would taint the canvas and cannot be exported).
 */
async function rasterizeSvg(fragment: string, kind: GeneratedArtifactSpec['kind']): Promise<ArtifactImageData> {
  const standalone = normalizeSvgForImage(fragment);
  if (standalone !== null) {
    try { return await paintSvg(standalone, kind); } catch { /* fall through to the main-process paint */ }
  }
  const html = buildVisualSrcDoc(fragment, false).replace('background: transparent', 'background: #ffffff');
  const painted = await window.conductor.artifacts.rasterize(html);
  if (kind !== 'pdf') return painted;
  // The capture is PNG; PDFs embed JPEG — repaint it through a canvas.
  const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(painted.dataBase64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => { image.onload = () => { resolve(); }; image.onerror = () => { reject(new Error('Could not convert diagram')); }; image.src = url; });
    const canvas = document.createElement('canvas');
    canvas.width = painted.width;
    canvas.height = painted.height;
    const ctx = canvas.getContext('2d');
    if (ctx === null) throw new Error('Image canvas is unavailable');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(image, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    return { dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), width: painted.width, height: painted.height };
  } finally { URL.revokeObjectURL(url); }
}

/**
 * Replace every SVG in the spec (slide diagrams and ```svg fences in the
 * content) with a raster image the generators can embed, referenced by id.
 */
async function prepareSpec(input: GeneratedArtifactSpec): Promise<{ spec: GeneratedArtifactSpec; images: Record<string, ArtifactImageData>; missing: number; missingReason?: string }> {
  const spec = normalizeSpec(input);
  const images: Record<string, ArtifactImageData> = {};
  let missing = 0;
  let missingReason: string | undefined;
  // A diagram that cannot be rasterized must never kill the whole file:
  // skip that image and keep generating the text deliverable.
  const tryRasterize = async (svg: string): Promise<ArtifactImageData | null> => {
    try { return await rasterizeSvg(svg, spec.kind); } catch (error) {
      missingReason ??= error instanceof Error ? error.message : 'render failed';
      console.warn('[conductor] a diagram could not be embedded in the generated file:', error);
      return null;
    }
  };
  const slides = (spec.slides ?? []).map((slide) => ({ ...slide }));
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i]!;
    if (slide.svg !== undefined) {
      const id = `slide-${i}`;
      const raster = await tryRasterize(slide.svg);
      if (raster !== null) {
        images[id] = raster;
        slide.imageId = id;
      } else missing += 1;
    }
  }
  let content = spec.content ?? '';
  const fence = /```(?:svg|html|visual)[^\S\r\n]*\r?\n([\s\S]*?)```/g;
  let rebuilt = '';
  let last = 0;
  let count = 0;
  for (const match of content.matchAll(fence)) {
    const svg = extractSvg(match[1] ?? '');
    if (svg === null) continue;
    const raster = await tryRasterize(svg);
    if (raster === null) { missing += 1; continue; } // keep the fence; the file renders a placeholder
    const id = `img-${count}`;
    count += 1;
    images[id] = raster;
    rebuilt += content.slice(last, match.index ?? 0);
    rebuilt += `\n[[conductor-image:${id}]]\n`;
    last = (match.index ?? 0) + match[0].length;
  }
  content = rebuilt + content.slice(last);
  if (spec.kind !== 'presentation') {
    // Slide diagrams also belong in documents/PDFs: place each under its
    // slide's heading in the content, or at the end when there is no match.
    for (const slide of slides) {
      if (slide.imageId === undefined) continue;
      const marker = `[[conductor-image:${slide.imageId}]]`;
      if (content.includes(marker)) continue;
      const heading = `# ${slide.title}`;
      const at = content.indexOf(heading);
      if (at >= 0) {
        const lineEnd = content.indexOf('\n', at);
        content = `${content.slice(0, lineEnd + 1)}\n${marker}\n${content.slice(lineEnd + 1)}`;
      } else {
        content += `\n\n${marker}\n`;
      }
    }
  }
  return { spec: { ...spec, slides, content }, images, missing, ...(missingReason !== undefined ? { missingReason } : {}) };
}

function generate(spec: GeneratedArtifactSpec, canvas: HTMLCanvasElement | null, onProgress: (value: number) => void): Promise<Ready> {
  const key = JSON.stringify(spec);
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const pending = (async (): Promise<Ready> => {
    if (spec.kind === 'video') {
      if (canvas === null) throw new Error('Video canvas is unavailable');
      return generateVideo(spec, canvas, onProgress);
    }
    onProgress(0.35);
    // Rasterize embedded SVGs and clamp to the IPC schema caps, whatever
    // built this spec.
    const prepared = await prepareSpec(spec);
    const file = await window.conductor.artifacts.generate(prepared.spec, prepared.images);
    onProgress(0.9);
    const blob = base64ToBlob(file.dataBase64, file.mimeType);
    return { url: URL.createObjectURL(blob), fileName: file.fileName, sizeBytes: file.sizeBytes, ...(prepared.missing > 0 ? { missingDiagrams: prepared.missing, ...(prepared.missingReason !== undefined ? { missingReason: prepared.missingReason } : {}) } : {}) };
  })();
  cache.set(key, pending);
  void pending.catch(() => { cache.delete(key); });
  return pending;
}

/** The live canvas a video is painted and recorded on while it renders. */
function VideoCanvas({ canvasRef }: { canvasRef: React.RefObject<HTMLCanvasElement | null> }): React.JSX.Element {
  return <canvas ref={canvasRef} width={VIDEO_W} height={VIDEO_H} className="mt-2 aspect-video w-full max-w-md rounded-xl border border-border" aria-hidden="true" />;
}

export function GeneratedArtifact({ spec, complete = true }: { spec: GeneratedArtifactSpec | null; complete?: boolean }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [state, setState] = useState<State>({ status: 'generating', progress: 0 });
  const [previewOpen, setPreviewOpen] = useState(false);
  // Keyed by value, not object identity: reply re-renders re-parse the spec
  // into a fresh object, which must not restart (or flicker) generation.
  const specKey = spec === null ? null : JSON.stringify(spec);

  useEffect(() => {
    if (!complete || specKey === null) return;
    const parsed = JSON.parse(specKey) as GeneratedArtifactSpec;
    let active = true;
    setState({ status: 'generating', progress: 0 });
    // The video canvas must be mounted before it can record; it renders as
    // part of the generating state, so wait a frame for it.
    const frame = requestAnimationFrame(() => {
      void generate(parsed, canvasRef.current, (progress) => { if (active) setState({ status: 'generating', progress }); })
        .then((ready) => { if (active) setState({ status: 'ready', ready }); })
        .catch((error: unknown) => { if (active) setState({ status: 'failed', error: error instanceof Error ? error.message : 'Could not generate the file' }); });
    });
    return () => { active = false; cancelAnimationFrame(frame); };
  }, [specKey, complete]);

  const kind = spec?.kind ?? 'pdf';
  const meta = ARTIFACT_KIND_META[kind];
  const icon = kind === 'video' ? <PlayIcon size={17} /> : <FileTextIcon size={17} />;
  if (!complete) {
    return (
      <div className="my-1" role="status" aria-label={`Generating ${meta.label.toLowerCase()}…`}>
        <ArtifactCard icon={icon} busy progress={0.15} title={spec?.title ?? meta.label} meta={<span className="text-shimmer">Writing {meta.label.toLowerCase()}…</span>} label={`Generating ${meta.label.toLowerCase()}`} />
      </div>
    );
  }
  if (spec === null) {
    return <p className="bg-transparent px-1 py-1 text-2xs text-muted-foreground">The agent’s file description could not be read, so no file was created.</p>;
  }

  const ready = state.status === 'ready' ? state.ready : null;
  const cardMeta = state.status === 'generating'
    ? <span className="text-shimmer">Generating {meta.label.toLowerCase()}…{spec.kind === 'video' ? ` ${Math.round(state.progress * 100)}%` : ''}</span>
    : state.status === 'failed'
      ? `Could not generate this ${meta.label.toLowerCase()}: ${state.error}`
      : `${meta.label}, ${formatBytes(state.ready.sizeBytes)}. Click to open`;
  return (
    <figure className="my-1" aria-label={`${meta.label}: ${spec.title}`}>
      <div role={state.status === 'failed' ? 'alert' : state.status === 'generating' ? 'status' : undefined}>
        <ArtifactCard
          icon={icon}
          title={spec.title}
          meta={cardMeta}
          busy={state.status === 'generating'}
          progress={state.status === 'generating' ? state.progress : undefined}
          error={state.status === 'failed'}
          open={previewOpen}
          onOpen={ready !== null ? () => { setPreviewOpen((v) => !v); } : undefined}
          label={ready !== null ? `${previewOpen ? 'Close' : 'Open'} ${ready.fileName}` : `${meta.label}: ${spec.title}`}
          action={ready !== null ? (
            <ArtifactAction label={`Download ${ready.fileName}`} onClick={() => { download(ready.url, ready.fileName); }}><DownloadIcon size={15} /></ArtifactAction>
          ) : undefined}
        />
      </div>
      {state.status === 'generating' && spec.kind === 'video' ? <VideoCanvas canvasRef={canvasRef} /> : null}
      {ready !== null && ready.missingDiagrams !== undefined ? (
        <p className="mt-1.5 px-1 text-2xs text-muted-foreground">{ready.missingDiagrams} diagram{ready.missingDiagrams === 1 ? '' : 's'} could not be embedded in the file{ready.missingReason !== undefined ? ` (${ready.missingReason})` : ''}; the preview still shows {ready.missingDiagrams === 1 ? 'it' : 'them'}.</p>
      ) : null}
      {ready !== null && previewOpen ? (
        <ArtifactPanel
          title={spec.title}
          meta={`${ready.fileName}, ${formatBytes(ready.sizeBytes)}`}
          icon={kind === 'video' ? <PlayIcon size={14} /> : <FileTextIcon size={14} />}
          onClose={() => { setPreviewOpen(false); }}
          actions={(
            <button type="button" onClick={() => { download(ready.url, ready.fileName); }} className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-semibold text-primary-foreground transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
              <DownloadIcon size={13} />Download
            </button>
          )}
        >
          {spec.kind === 'video'
            ? <video controls preload="metadata" src={ready.url} className="aspect-video w-full rounded-xl border border-border bg-black" aria-label={spec.title} />
            : <ArtifactPreview spec={spec} />}
        </ArtifactPanel>
      ) : null}
    </figure>
  );
}
