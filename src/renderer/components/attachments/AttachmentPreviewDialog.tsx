import { useEffect, useState } from 'react';
import { ATTACHMENT_KIND_LABELS, formatAttachmentSize, type AttachmentPreview, type AttachmentSummary, type PdfAttachmentPreview } from '@shared/attachments';
import { Markdown } from '../chat/Markdown';
import { Alert, Button, Dialog } from '../ui/primitives';

export interface AttachmentPreviewDialogProps {
  attachment: AttachmentSummary | null;
  onClose: () => void;
}

const MIN_PDF_ZOOM = 0.6;
const MAX_PDF_ZOOM = 2;
const PDF_ZOOM_STEP = 0.2;

export function boundedPdfPage(page: number, pageCount: number, delta: number): number {
  return Math.max(1, Math.min(Math.max(1, pageCount), page + delta));
}

export function boundedPdfZoom(zoom: number, delta: number): number {
  return Math.max(MIN_PDF_ZOOM, Math.min(MAX_PDF_ZOOM, Math.round((zoom + delta) * 10) / 10));
}

/** A page-at-a-time visual PDF reader with text fallback for inaccessible pages. */
export function PdfPreview({ preview }: { preview: PdfAttachmentPreview }): React.JSX.Element {
  const [pageNumber, setPageNumber] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [view, setView] = useState<'rendered' | 'text'>(() => preview.pages[0]?.dataUrl ? 'rendered' : 'text');
  const page = preview.pages.find((entry) => entry.pageNumber === pageNumber) ?? preview.pages[0];
  const visualAvailable = page?.dataUrl?.startsWith('data:image/') === true;
  const displayedView = visualAvailable ? view : 'text';
  const changePage = (delta: number): void => {
    const next = boundedPdfPage(pageNumber, preview.pageCount, delta);
    setPageNumber(next);
    const nextPage = preview.pages.find((entry) => entry.pageNumber === next);
    if (!nextPage?.dataUrl?.startsWith('data:image/')) setView('text');
  };
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 p-2">
      <div className="flex items-center gap-1" aria-label="PDF page navigation">
        <Button size="xs" variant="ghost" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => changePage(-1)}>Previous</Button>
        <output className="min-w-20 text-center text-xs text-muted-foreground" aria-live="polite">Page {pageNumber} of {preview.pageCount}</output>
        <Button size="xs" variant="ghost" aria-label="Next page" disabled={pageNumber >= preview.pageCount} onClick={() => changePage(1)}>Next</Button>
      </div>
      <div className="flex items-center gap-1" aria-label="PDF zoom controls">
        <Button size="xs" variant="ghost" aria-label="Zoom out" disabled={zoom <= MIN_PDF_ZOOM} onClick={() => setZoom(value => boundedPdfZoom(value, -PDF_ZOOM_STEP))}>−</Button>
        <output className="min-w-10 text-center text-xs text-muted-foreground">{Math.round(zoom * 100)}%</output>
        <Button size="xs" variant="ghost" aria-label="Zoom in" disabled={zoom >= MAX_PDF_ZOOM} onClick={() => setZoom(value => boundedPdfZoom(value, PDF_ZOOM_STEP))}>+</Button>
      </div>
    </div>
    {visualAvailable && <div className="flex gap-1" role="group" aria-label="PDF view mode">
      <Button size="xs" variant={displayedView === 'rendered' ? 'default' : 'ghost'} onClick={() => setView('rendered')}>Rendered page</Button>
      <Button size="xs" variant={displayedView === 'text' ? 'default' : 'ghost'} onClick={() => setView('text')}>Show extracted text</Button>
    </div>}
    {displayedView === 'rendered' && page?.dataUrl
      ? <div className="overflow-auto rounded-lg border border-border bg-muted/20 p-3"><img src={page.dataUrl} alt={`Rendered PDF page ${page.pageNumber}`} className="mx-auto max-w-none object-contain" style={{ width: `${Math.round(zoom * 100)}%` }} /></div>
      : <section aria-label={`Page ${pageNumber} extracted text`} className="rounded-lg border border-border p-4"><pre className="whitespace-pre-wrap break-words font-sans text-sm">{page?.text || 'No extractable text on this page.'}</pre></section>}
    {!preview.pages.length && <p>No extractable text or render was found in this PDF.</p>}
  </div>;
}

export function AttachmentPreviewDialog({ attachment, onClose }: AttachmentPreviewDialogProps): React.JSX.Element {
  const [result, setResult] = useState<{ id: string; preview?: AttachmentPreview; error?: string } | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  useEffect(() => {
    if (!attachment) return;
    let active = true;
    setResult(null); setImageError(null);
    void window.conductor.attachment.preview(attachment.id).then(
      preview => { if (active) setResult({ id: attachment.id, preview }); },
      () => { if (active) setResult({ id: attachment.id, error: 'This file could not be previewed. Its contents may be unreadable or unavailable.' }); },
    );
    return () => { active = false; };
  }, [attachment]);
  const loaded = result?.id === attachment?.id ? result : null;
  const preview = loaded?.preview;
  return <Dialog open={attachment !== null} onClose={onClose} title={attachment?.name ?? 'Attachment preview'} width="max-w-3xl"
    description={attachment ? `${ATTACHMENT_KIND_LABELS[attachment.kind]} · ${attachment.mimeType} · ${formatAttachmentSize(attachment.sizeBytes)}` : undefined}
    footer={<Button onClick={onClose}>Close preview</Button>}>
    <div className="max-h-[65vh] overflow-auto break-words" tabIndex={0} aria-label="Attachment contents">
      {!loaded && <p role="status" className="text-sm text-muted-foreground">Loading preview…</p>}
      {loaded?.error && <Alert>{loaded.error}</Alert>}
      {preview?.format === 'image' && (imageError === attachment?.id || !preview.dataUrl.startsWith('data:image/')
        ? <Alert>This image cannot be displayed.</Alert>
        : <img src={preview.dataUrl} alt={attachment?.name ?? 'Attachment'} className="mx-auto max-h-[60vh] max-w-full object-contain" onError={() => setImageError(attachment?.id ?? null)} />)}
      {preview?.format === 'markdown' && <Markdown text={preview.markdown} />}
      {preview?.format === 'text' && <pre className="whitespace-pre-wrap break-words text-sm">{preview.text || 'No text was found in this file.'}</pre>}
      {preview?.format === 'pdf' && <PdfPreview preview={preview} />}
      {preview?.format === 'unsupported' && <Alert tone="warning">{preview.message || 'A preview is not available for this file type.'}</Alert>}
      {preview?.truncated && <p role="status" className="mt-4 rounded-lg border border-border p-3 text-xs text-muted-foreground">Preview truncated: only part of this document is shown.</p>}
    </div>
  </Dialog>;
}
