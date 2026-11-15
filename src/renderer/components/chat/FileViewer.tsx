import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import type { PdfAttachmentPreview } from '@shared/attachments';
import type { ArchiveEntry, ArchiveFilePreview, FilePreview } from '@shared/file-preview';
import type { ArtifactFileEntry } from '@shared/generated-artifacts';
import { ChevronRightIcon, DownloadIcon, FileTextIcon, FolderIcon, Spinner } from '../ui/icons';
import { cn } from '../../lib/cn';

// Lazy for the same reason as GeneratedArtifact: the viewer is only needed
// once a file is opened, and it keeps the Markdown import acyclic.
const Markdown = lazy(() => import('./Markdown').then((m) => ({ default: m.Markdown })));

// The in-app viewer for a real file an agent handed back. The main process
// renders the bytes (PDF pages as images, Word and Markdown as formatted
// text, archives as a listing); this shows the result in the artifact panel.

/** 42 → "42 bytes", 1_536 → "1.5 KB". */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} byte${bytes === 1 ? '' : 's'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

export function downloadUrl(url: string, fileName: string): void {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
}

/** The primary Download button in the artifact panel's header. */
export function DownloadButton({ onClick }: { onClick: () => void }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-primary px-2.5 text-xs font-semibold text-primary-foreground transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring">
      <DownloadIcon size={13} />Download
    </button>
  );
}

const ZOOM_STEPS = [0.6, 0.8, 1, 1.25, 1.5, 2] as const;

/** Every page of the PDF, stacked for scrolling, at a chosen zoom. */
function PdfPages({ preview }: { preview: PdfAttachmentPreview }): React.JSX.Element {
  const [zoomIndex, setZoomIndex] = useState(2);
  const zoom = ZOOM_STEPS[zoomIndex]!;
  const rendered = preview.pages.filter((page) => page.dataUrl?.startsWith('data:image/') === true).length;
  const control = 'flex size-6 cursor-pointer items-center justify-center rounded-md text-sm text-muted-foreground hover:bg-accent hover:text-foreground disabled:cursor-default disabled:opacity-40';
  return (
    <div className="flex flex-col gap-3">
      <div className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-2 rounded-lg border border-border bg-background/95 px-2.5 py-1.5 text-2xs text-muted-foreground backdrop-blur">
        <span className="tabular-nums">{preview.pageCount} page{preview.pageCount === 1 ? '' : 's'}</span>
        <div className="flex items-center gap-1" role="group" aria-label="PDF zoom">
          <button type="button" aria-label="Zoom out" disabled={zoomIndex === 0} onClick={() => { setZoomIndex((v) => Math.max(0, v - 1)); }} className={control}>−</button>
          <output className="min-w-9 text-center tabular-nums">{Math.round(zoom * 100)}%</output>
          <button type="button" aria-label="Zoom in" disabled={zoomIndex === ZOOM_STEPS.length - 1} onClick={() => { setZoomIndex((v) => Math.min(ZOOM_STEPS.length - 1, v + 1)); }} className={control}>+</button>
        </div>
      </div>
      <div className="flex flex-col items-center gap-4 overflow-x-auto rounded-xl bg-muted/40 p-4">
        {preview.pages.map((page) => (page.dataUrl?.startsWith('data:image/') === true ? (
          <img
            key={page.pageNumber}
            src={page.dataUrl}
            alt={`Page ${page.pageNumber}`}
            className="max-w-none rounded-sm bg-white shadow-lift"
            style={{ width: `${Math.round(zoom * 100)}%` }}
          />
        ) : (
          <section key={page.pageNumber} aria-label={`Page ${page.pageNumber} text`} className="w-full rounded-sm border border-border bg-card px-5 py-4">
            <p className="mb-2 text-3xs font-medium tracking-wide text-muted-foreground uppercase">Page {page.pageNumber}</p>
            <pre className="font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-foreground">{page.text || 'No text on this page.'}</pre>
          </section>
        )))}
      </div>
      {rendered < preview.pages.length && rendered > 0 ? <p className="text-2xs text-muted-foreground">Pages after {rendered} are shown as text. Download the file for the full layout.</p> : null}
    </div>
  );
}

/** The archive's entries; an entry whose text is known opens in place. */
function ArchiveListing({ preview, contents }: { preview: ArchiveFilePreview; contents: ReadonlyMap<string, string> }): React.JSX.Element {
  const [open, setOpen] = useState<string | null>(null);
  const files = preview.entries.filter((entry) => !entry.directory);
  const row = (entry: ArchiveEntry): React.JSX.Element => {
    const text = contents.get(entry.path);
    const expanded = open === entry.path;
    const depth = entry.path.replace(/\/$/, '').split('/').length - 1;
    const name = entry.path.replace(/\/$/, '').split('/').pop() ?? entry.path;
    const inner = (
      <>
        {entry.directory ? <FolderIcon size={14} className="shrink-0 text-muted-foreground" /> : <FileTextIcon size={14} className="shrink-0 text-muted-foreground" />}
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground" title={entry.path}>{name}{entry.directory ? '/' : ''}</span>
        {!entry.directory ? <span className="shrink-0 text-3xs text-muted-foreground tabular-nums">{formatBytes(entry.sizeBytes)}</span> : null}
        {text !== undefined ? <ChevronRightIcon size={12} className={cn('shrink-0 text-muted-foreground transition-transform', expanded && 'rotate-90')} /> : null}
      </>
    );
    const rowClass = 'flex w-full items-center gap-2 py-1.5 pr-3 text-left';
    const style = { paddingLeft: `${12 + depth * 16}px` };
    return (
      <li key={entry.path}>
        {text !== undefined
          ? <button type="button" aria-expanded={expanded} onClick={() => { setOpen(expanded ? null : entry.path); }} className={cn(rowClass, 'cursor-pointer hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring')} style={style}>{inner}</button>
          : <div className={rowClass} style={style}>{inner}</div>}
        {expanded && text !== undefined ? (
          <pre className="mx-3 mb-2 max-h-96 overflow-auto rounded-lg border border-border bg-code px-3 py-2 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{text || '(Empty file)'}</pre>
        ) : null}
      </li>
    );
  };
  return (
    <div className="flex flex-col gap-2">
      <p className="text-2xs text-muted-foreground">{files.length} file{files.length === 1 ? '' : 's'}, {formatBytes(preview.totalBytes)} unpacked{contents.size > 0 ? '. Select a file to read it' : ''}</p>
      <ul className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
        {[...preview.entries].sort((a, b) => a.path.localeCompare(b.path)).map(row)}
      </ul>
      {preview.truncated ? <p className="text-2xs text-muted-foreground">Showing the first {preview.entries.length} of {preview.entryCount} entries.</p> : null}
    </div>
  );
}

type Loaded = { key: string; preview: FilePreview } | { key: string; error: string };

// Opening the same file again (or remounting while scrolling) must not
// re-render a PDF: keep the last few rendered previews for the session.
const previews = new Map<string, Promise<FilePreview>>();
function loadPreview(key: string, fileName: string, dataBase64: string): Promise<FilePreview> {
  const cached = previews.get(key);
  if (cached !== undefined) return cached;
  const pending = window.conductor.artifacts.preview(fileName, dataBase64);
  previews.set(key, pending);
  void pending.catch(() => { previews.delete(key); });
  if (previews.size > 8) previews.delete(previews.keys().next().value!);
  return pending;
}

/**
 * Shows one file. `cacheKey` identifies the bytes (so reopening is instant);
 * `archiveFiles` supplies the text of a generated archive's entries.
 */
export function FileViewer({ fileName, mimeType, dataBase64, url, cacheKey, archiveFiles, onDownload }: {
  fileName: string;
  mimeType: string;
  dataBase64: string;
  /** Object URL of the same bytes, for media playback. */
  url: string;
  cacheKey: string;
  archiveFiles?: readonly ArtifactFileEntry[] | undefined;
  onDownload: () => void;
}): React.JSX.Element {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const media = mimeType.startsWith('video/') ? 'video' : mimeType.startsWith('audio/') ? 'audio' : null;
  useEffect(() => {
    if (media !== null) return;
    let active = true;
    void loadPreview(cacheKey, fileName, dataBase64).then(
      (preview) => { if (active) setLoaded({ key: cacheKey, preview }); },
      (error: unknown) => { if (active) setLoaded({ key: cacheKey, error: error instanceof Error ? error.message : 'This file could not be opened.' }); },
    );
    return () => { active = false; };
  }, [cacheKey, fileName, dataBase64, media]);
  const contents = useMemo(() => new Map((archiveFiles ?? []).map((file) => [file.path, file.content])), [archiveFiles]);

  if (media === 'video') return <video controls preload="metadata" src={url} className="aspect-video w-full rounded-xl border border-border bg-black" aria-label={fileName} />;
  if (media === 'audio') return <audio controls preload="metadata" src={url} className="w-full" aria-label={fileName} />;

  const current = loaded !== null && loaded.key === cacheKey ? loaded : null;
  if (current === null) {
    return <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner size={13} />Opening {fileName}…</p>;
  }
  const fallback = (message: string): React.JSX.Element => (
    <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-10 text-center">
      <span className="flex size-11 items-center justify-center rounded-xl bg-primary/12 text-primary"><FileTextIcon size={20} /></span>
      <p className="max-w-sm text-sm text-muted-foreground">{message}</p>
      <DownloadButton onClick={onDownload} />
    </div>
  );
  if ('error' in current) return fallback(current.error);
  const { preview } = current;
  return (
    <div className="flex flex-col gap-3">
      {preview.format === 'pdf' ? <PdfPages preview={preview} /> : null}
      {preview.format === 'markdown' ? (
        <div className="px-1">
          <Suspense fallback={<pre className="text-sm break-words whitespace-pre-wrap">{preview.markdown}</pre>}>
            <Markdown text={preview.markdown} />
          </Suspense>
        </div>
      ) : null}
      {preview.format === 'text' ? (
        <pre className="rounded-xl border border-border bg-code px-4 py-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap text-foreground/85">{preview.text || '(Empty file)'}</pre>
      ) : null}
      {preview.format === 'image' ? (
        preview.dataUrl.startsWith('data:image/')
          ? <img src={preview.dataUrl} alt={fileName} className="mx-auto max-w-full rounded-lg border border-border object-contain" />
          : fallback('This image cannot be shown here.')
      ) : null}
      {preview.format === 'archive' ? <ArchiveListing preview={preview} contents={contents} /> : null}
      {preview.format === 'unsupported' ? fallback(preview.message || 'This file cannot be shown here. Download it to open it in another app.') : null}
      {preview.truncated && preview.format !== 'archive' ? <p role="status" className="text-2xs text-muted-foreground">Only part of this file is shown. Download it for the whole thing.</p> : null}
    </div>
  );
}
