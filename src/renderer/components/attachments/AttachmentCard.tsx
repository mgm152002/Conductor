import { useEffect, useState } from 'react';
import { ATTACHMENT_KIND_LABELS, formatAttachmentSize, type AttachmentPreview, type AttachmentSummary } from '@shared/attachments';
import { cn } from '../../lib/cn';
import { DocumentIcon, ImageIcon, XIcon } from '../ui/icons';
import { Button } from '../ui/primitives';

export interface AttachmentCardProps {
  attachment: AttachmentSummary;
  onPreview: (attachment: AttachmentSummary) => void;
  onRemove?: ((id: string) => void) | undefined;
  disabled?: boolean | undefined;
  /** `history` gives images a real inline preview; `compact` is the composer chip. */
  display?: 'compact' | 'history' | undefined;
}

/** Keep cards safe when a preview service returns a malformed image URL. */
export function imageThumbnailSrc(preview: AttachmentPreview): string | null {
  return preview.format === 'image' && preview.dataUrl.startsWith('data:image/') ? preview.dataUrl : null;
}

/** Prefer the cached 320px thumbnail; fall back to a full preview on older data. */
async function loadThumbnail(id: string): Promise<string | null> {
  try {
    const url = await window.conductor.attachment.thumbnail(id);
    if (url !== null && url.startsWith('data:image/')) return url;
  } catch { /* The preview fallback below reports actionable failures. */ }
  try {
    return imageThumbnailSrc(await window.conductor.attachment.preview(id));
  } catch {
    return null;
  }
}

export function AttachmentCard({ attachment, onPreview, onRemove, disabled, display = 'compact' }: AttachmentCardProps): React.JSX.Element {
  const [thumbnail, setThumbnail] = useState<{ id: string; url: string } | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (attachment.kind !== 'image') return;
    let active = true;
    setFailed(false);
    void loadThumbnail(attachment.id).then(url => {
      if (active && url !== null) setThumbnail({ id: attachment.id, url });
      else if (active) setFailed(true);
    });
    return () => { active = false; };
  }, [attachment.id, attachment.kind]);
  const image = thumbnail?.id === attachment.id ? thumbnail.url : null;
  const isImage = attachment.kind === 'image';

  if (display === 'history' && isImage) {
    return (
      <figure className="group/image w-fit min-w-0 max-w-full">
        <Button
          variant="ghost"
          className={cn('h-auto w-fit max-w-full min-w-0 justify-start overflow-hidden border border-border bg-card p-1 text-left hover:bg-accent', image === null && 'gap-2 px-2.5 py-2')}
          onClick={() => { onPreview(attachment); }}
          aria-label={`Preview ${attachment.name}`}
        >
          {image !== null
            ? <img
                src={image}
                alt={attachment.name}
                loading="lazy"
                decoding="async"
                draggable={false}
                className="block h-auto max-h-48 w-auto min-w-0 max-w-[min(18rem,100%)] rounded-md object-contain"
                onError={() => { setThumbnail(null); setFailed(true); }}
              />
            : failed
              ? <ImageIcon size={24} className="shrink-0 text-muted-foreground" />
              : <span className="flex size-16 items-center justify-center rounded-md bg-muted/50"><ImageIcon size={20} className="text-muted-foreground" /></span>}
          {image === null ? (
            <span className="min-w-0">
              <span className="block max-w-52 truncate text-xs text-foreground" title={attachment.name}>{attachment.name}</span>
              <span className="block text-2xs text-muted-foreground">{failed ? 'Preview unavailable' : 'Loading preview…'}</span>
            </span>
          ) : null}
        </Button>
        {image !== null ? (
          <figcaption className="mt-1 flex max-w-full items-center gap-1 px-0.5 text-2xs text-muted-foreground">
            <ImageIcon size={10} className="shrink-0" />
            <span className="min-w-0 truncate" title={attachment.name}>{attachment.name}</span>
            <span className="shrink-0 text-muted-foreground/70">· {formatAttachmentSize(attachment.sizeBytes)}</span>
          </figcaption>
        ) : null}
        {onRemove !== undefined ? <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => { onRemove(attachment.id); }} aria-label={`Remove ${attachment.name}`}><XIcon size={14} /></Button> : null}
      </figure>
    );
  }

  return <div className="flex max-w-full items-center gap-1 rounded-lg border border-border bg-card p-1">
    <Button variant="ghost" className="h-auto min-w-0 justify-start gap-2 px-2 py-1.5 text-left" onClick={() => { onPreview(attachment); }} aria-label={`Preview ${attachment.name}`}>
      {image !== null
        ? <img src={image} alt={`${attachment.name} thumbnail`} loading="lazy" decoding="async" draggable={false} className="size-9 shrink-0 rounded object-cover" onError={() => { setThumbnail(null); setFailed(true); }} />
        : isImage ? <ImageIcon size={24} /> : <DocumentIcon size={24} />}
      <span className="min-w-0"><span className="block max-w-52 truncate text-xs text-foreground" title={attachment.name}>{attachment.name}</span>
        <span className="block text-2xs text-muted-foreground">{ATTACHMENT_KIND_LABELS[attachment.kind]} · {formatAttachmentSize(attachment.sizeBytes)}</span></span>
    </Button>
    {onRemove && <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => { onRemove(attachment.id); }} aria-label={`Remove ${attachment.name}`}><XIcon size={14} /></Button>}
  </div>;
}
