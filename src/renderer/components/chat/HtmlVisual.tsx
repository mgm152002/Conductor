import { useEffect, useMemo, useRef, useState } from 'react';
import { buildVisualSrcDoc, sanitizeVisualHtml, visualAspectRatio } from '../../lib/visuals';
import { useThemeStore } from '../../stores';
import { ChartIcon, DownloadIcon } from '../ui/icons';

// Downloads hand the visual back as a file. SVG keeps the vector original
// (a pure-HTML fragment is wrapped in a foreignObject SVG); PNG rasterizes
// the first SVG at 2x. PNG needs an SVG in the fragment — HTML-only visuals
// offer SVG only.
function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 1_000);
}

function standaloneSvg(code: string, dark: boolean): { svg: string; width: number; height: number } | null {
  const doc = new DOMParser().parseFromString(sanitizeVisualHtml(code), 'text/html');
  const styles = [...doc.querySelectorAll('style')].map((s) => s.textContent ?? '').join('\n');
  const svgEl = doc.querySelector('svg');
  const foreground = dark ? '#e6ede3' : '#1d2822';
  if (svgEl !== null) {
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    const viewBox = clone.viewBox.baseVal;
    const width = viewBox.width > 0 ? viewBox.width : 640;
    const height = viewBox.height > 0 ? viewBox.height : 400;
    clone.setAttribute('width', String(width));
    clone.setAttribute('height', String(height));
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = `text { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; } ${styles}`;
    clone.insertBefore(style, clone.firstChild);
    clone.style.color = foreground;
    return { svg: new XMLSerializer().serializeToString(clone), width, height };
  }
  const body = doc.body.innerHTML;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500" viewBox="0 0 800 500"><style>div { font-family: -apple-system, 'Segoe UI', system-ui, sans-serif; color: ${foreground}; } ${styles}</style><foreignObject width="800" height="500"><div xmlns="http://www.w3.org/1999/xhtml">${body}</div></foreignObject></svg>`;
  return { svg, width: 800, height: 500 };
}

// A model-supplied diagram/chart, rendered live in the chat. The fragment
// is placed in a sandboxed frame with no script permission and an opaque
// origin: it can paint HTML/SVG/CSS but can never run code, reach the app,
// the preload bridge, or the network. Assembly is animated on our side —
// pieces fade/rise in sequence, bars grow — when the frame first mounts.

function Assembling(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-2 px-3 py-3" role="status" aria-label="Assembling visual">
      {[72, 48, 88, 60].map((width, i) => (
        <div
          key={width}
          className="animate-pop-in h-3 rounded-sm bg-accent"
          style={{ width: `${width}%`, animationDelay: `${i * 110}ms` }}
        />
      ))}
      <p className="text-2xs text-muted-foreground">Assembling visual…</p>
    </div>
  );
}

export function HtmlVisual({ code, complete }: { code: string; complete: boolean }): React.JSX.Element {
  const dark = useThemeStore((s) => s.appearance) === 'dark';
  const srcDoc = useMemo(() => buildVisualSrcDoc(code, dark), [code, dark]);
  const ratio = visualAspectRatio(code);
  const [pngFailed, setPngFailed] = useState(false);
  const hasSvg = /<svg[\s>]/i.test(code);
  // The frame has no script permission; allow-same-origin only lets *this*
  // component read its laid-out height so the whole graphic shows with no
  // inner scrollbar. Re-measured whenever the content or width changes.
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  useEffect(() => () => { observerRef.current?.disconnect(); }, []);
  const measure = (): void => {
    const doc = frameRef.current?.contentDocument;
    if (doc === null || doc === undefined) return;
    // Measure the content box, not the document: documentElement.scrollHeight
    // can never be smaller than the frame itself, so it would never shrink.
    const root = doc.querySelector('.cv-root');
    if (root === null) return;
    const height = Math.ceil(root.getBoundingClientRect().bottom + (doc.defaultView?.scrollY ?? 0));
    if (height > 0) setContentHeight(height);
  };
  const onFrameLoad = (): void => {
    measure();
    const doc = frameRef.current?.contentDocument;
    observerRef.current?.disconnect();
    if (doc?.body !== undefined && typeof ResizeObserver !== 'undefined') {
      observerRef.current = new ResizeObserver(measure);
      observerRef.current.observe(doc.body);
      const root = doc.querySelector('.cv-root');
      if (root !== null) observerRef.current.observe(root);
    }
  };

  const downloadSvg = (): void => {
    const standalone = standaloneSvg(code, dark);
    if (standalone !== null) downloadBlob('visual.svg', new Blob([standalone.svg], { type: 'image/svg+xml' }));
  };
  const downloadPng = (): void => {
    const standalone = standaloneSvg(code, dark);
    if (standalone === null) return;
    const url = URL.createObjectURL(new Blob([standalone.svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(standalone.width * scale);
        canvas.height = Math.round(standalone.height * scale);
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        ctx.scale(scale, scale);
        ctx.drawImage(image, 0, 0, standalone.width, standalone.height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob !== null) downloadBlob('visual.png', blob);
          else setPngFailed(true);
        }, 'image/png');
      } catch {
        URL.revokeObjectURL(url);
        setPngFailed(true);
      }
    };
    image.onerror = () => { URL.revokeObjectURL(url); setPngFailed(true); };
    image.src = url;
  };

  const downloadButton = 'flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-3xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <figure className="my-1 bg-transparent" aria-label="Diagram">
      <figcaption className="flex items-center gap-1.5 px-1 py-1.5 text-2xs font-medium text-muted-foreground">
        <ChartIcon size={12} className="text-primary" />
        <span className="min-w-0 flex-1">{complete ? 'Visual' : 'Visual · assembling'}</span>
        {complete ? (
          <>
            <button type="button" onClick={downloadSvg} className={downloadButton} title="Download as SVG" aria-label="Download visual as SVG">
              <DownloadIcon size={11} /> SVG
            </button>
            {hasSvg ? (
              <button type="button" onClick={downloadPng} className={downloadButton} title={pngFailed ? 'PNG failed — use SVG' : 'Download as PNG'} aria-label="Download visual as PNG">
                <DownloadIcon size={11} /> PNG
              </button>
            ) : null}
          </>
        ) : null}
      </figcaption>
      {complete ? (
        <iframe
          title="Visual produced by the agent"
          ref={frameRef}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={onFrameLoad}
          scrolling="no"
          className="block w-full border-0 bg-transparent"
          style={contentHeight !== null
            ? { height: contentHeight, background: 'transparent' }
            : ratio !== null ? { aspectRatio: String(ratio), background: 'transparent' } : { height: 320, background: 'transparent' }}
        />
      ) : (
        <Assembling />
      )}
    </figure>
  );
}
