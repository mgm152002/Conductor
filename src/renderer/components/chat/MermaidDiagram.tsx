import { useEffect, useId, useState } from 'react';
import { useThemeStore } from '../../stores';
import { ChartIcon, DownloadIcon } from '../ui/icons';

// A ```mermaid block from the model, rendered to SVG in the chat. Mermaid is
// loaded lazily (it is large and most messages have no diagram), renders are
// serialized through one chain because mermaid.initialize is global, and
// securityLevel 'strict' keeps model-supplied labels inert. A diagram that
// fails to parse falls back to its source so nothing is lost.

type MermaidApi = typeof import('mermaid').default;

let mermaidPromise: Promise<MermaidApi> | null = null;
let renderChain: Promise<unknown> = Promise.resolve();

function loadMermaid(): Promise<MermaidApi> {
  mermaidPromise ??= import('mermaid').then((mod) => mod.default);
  return mermaidPromise;
}

function renderMermaid(code: string, dark: boolean, id: string): Promise<string> {
  const task = renderChain.then(async () => {
    const mermaid = await loadMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      // Base theme with transparent surroundings and quiet neutral node fills,
      // so the diagram sits on the chat canvas instead of a painted backdrop.
      theme: 'base',
      themeVariables: dark
        ? {
            background: 'transparent',
            mainBkg: '#262b33',
            nodeBorder: '#8b94a3',
            primaryColor: '#262b33',
            primaryTextColor: '#e6ede3',
            secondaryColor: '#20242b',
            tertiaryColor: 'transparent',
            lineColor: '#9aa5b1',
            textColor: '#e6ede3',
          }
        : {
            background: 'transparent',
            mainBkg: '#f1f4f6',
            nodeBorder: '#94a3b8',
            primaryColor: '#f1f4f6',
            primaryTextColor: '#1d2822',
            secondaryColor: '#e6ebee',
            tertiaryColor: 'transparent',
            lineColor: '#64748b',
            textColor: '#1d2822',
          },
      fontFamily: 'inherit',
    });
    try {
      const { svg } = await mermaid.render(id, code);
      return svg;
    } catch (error) {
      // Mermaid leaves its scratch node behind on a failed render.
      document.getElementById(`d${id}`)?.remove();
      throw error;
    }
  });
  renderChain = task.catch(() => undefined);
  return task;
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  window.setTimeout(() => { URL.revokeObjectURL(url); }, 1_000);
}

function svgSize(svg: string): { width: number; height: number } {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const el = doc.querySelector('svg');
  const viewBox = el?.getAttribute('viewBox')?.trim().split(/[\s,]+/).map(Number) ?? [];
  if (viewBox.length === 4 && viewBox.every((n) => Number.isFinite(n)) && viewBox[2]! > 0 && viewBox[3]! > 0) {
    return { width: viewBox[2]!, height: viewBox[3]! };
  }
  return { width: 800, height: 600 };
}

export function MermaidDiagram({ code, complete }: { code: string; complete: boolean }): React.JSX.Element {
  const dark = useThemeStore((s) => s.appearance) === 'dark';
  const rawId = useId();
  const id = `mermaid-${rawId.replace(/[^a-zA-Z0-9]/g, '')}`;
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [pngFailed, setPngFailed] = useState(false);

  useEffect(() => {
    if (!complete) { setSvg(null); setFailed(false); return; }
    let cancelled = false;
    setFailed(false);
    void renderMermaid(code, dark, id)
      .then((rendered) => { if (!cancelled) setSvg(rendered); })
      .catch(() => { if (!cancelled) { setSvg(null); setFailed(true); } });
    return () => { cancelled = true; };
    // id is stable per mount (useId); re-render on source/theme change only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, complete, dark]);

  const downloadButton = 'flex shrink-0 cursor-pointer items-center gap-1 rounded-sm px-1.5 py-0.5 text-3xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
  const downloadSvg = (): void => {
    if (svg !== null) downloadBlob('diagram.svg', new Blob([svg], { type: 'image/svg+xml' }));
  };
  const downloadPng = (): void => {
    if (svg === null) return;
    const { width, height } = svgSize(svg);
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    const image = new Image();
    image.onload = () => {
      try {
        const scale = 2;
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(width * scale);
        canvas.height = Math.round(height * scale);
        const ctx = canvas.getContext('2d');
        if (ctx === null) throw new Error('no 2d context');
        ctx.scale(scale, scale);
        ctx.drawImage(image, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob !== null) downloadBlob('diagram.png', blob);
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

  return (
    <figure className="my-1 bg-transparent" aria-label="Mermaid diagram">
      <figcaption className="flex items-center gap-1.5 px-1 py-1.5 text-2xs font-medium text-muted-foreground">
        <ChartIcon size={12} className="text-primary" />
        <span className="min-w-0 flex-1">{complete ? 'Diagram' : 'Diagram · assembling'}</span>
        {complete && svg !== null ? (
          <>
            <button type="button" onClick={downloadSvg} className={downloadButton} title="Download as SVG" aria-label="Download diagram as SVG">
              <DownloadIcon size={11} /> SVG
            </button>
            <button type="button" onClick={downloadPng} className={downloadButton} title={pngFailed ? 'PNG failed — use SVG' : 'Download as PNG'} aria-label="Download diagram as PNG">
              <DownloadIcon size={11} /> PNG
            </button>
          </>
        ) : null}
      </figcaption>
      {!complete || (svg === null && !failed) ? (
        <div className="flex flex-col gap-2 px-3 py-3" role="status" aria-label="Rendering diagram">
          {[72, 48, 88].map((width, i) => (
            <div key={width} className="animate-pop-in h-3 rounded-sm bg-accent" style={{ width: `${width}%`, animationDelay: `${i * 110}ms` }} />
          ))}
          <p className="text-2xs text-muted-foreground">{complete ? 'Rendering diagram…' : 'Assembling diagram…'}</p>
        </div>
      ) : failed ? (
        <div className="px-3 py-2.5">
          <p className="text-2xs text-destructive-foreground">This diagram could not be rendered. Its source is shown below.</p>
          <pre className="mt-2 overflow-x-auto rounded-lg border border-border bg-code px-3 py-2.5 font-mono text-xs leading-relaxed">{code.trim()}</pre>
        </div>
      ) : (
        <div
          role="img"
          aria-label="Mermaid diagram"
          className="overflow-x-auto bg-transparent px-1 py-2.5 [&>svg]:mx-auto [&>svg]:h-auto [&>svg]:max-w-full"
          dangerouslySetInnerHTML={{ __html: svg! }}
        />
      )}
    </figure>
  );
}
