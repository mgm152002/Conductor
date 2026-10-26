import { useEffect, useState } from 'react';
import { ATTACHMENT_KIND_LABELS, formatAttachmentSize, type AttachmentPreview, type AttachmentSummary } from '@shared/attachments';
import { Markdown } from '../chat/Markdown';
import { Alert, Button, Dialog } from '../ui/primitives';

export interface AttachmentPreviewDialogProps {
  attachment: AttachmentSummary | null;
  onClose: () => void;
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
      {preview?.format === 'pdf' && <div className="space-y-4">
        <p className="text-xs text-muted-foreground">{preview.pageCount} pages · extracted text</p>
        {preview.pages.map(page => <section key={page.pageNumber} aria-label={`Page ${page.pageNumber}`} className="rounded-lg border border-border p-4">
          <h3 className="mb-3 text-xs font-semibold text-muted-foreground">Page {page.pageNumber}</h3>
          <pre className="whitespace-pre-wrap break-words font-sans text-sm">{page.text || 'No extractable text on this page.'}</pre>
        </section>)}
        {!preview.pages.length && <p>No extractable text was found in this PDF.</p>}
      </div>}
      {preview?.format === 'unsupported' && <Alert tone="warning">{preview.message || 'A preview is not available for this file type.'}</Alert>}
      {preview?.truncated && <p role="status" className="mt-4 rounded-lg border border-border p-3 text-xs text-muted-foreground">Preview truncated: only part of this document is shown.</p>}
    </div>
  </Dialog>;
}
