import { useEffect, useState } from 'react';
import { ATTACHMENT_KIND_LABELS, formatAttachmentSize, type AttachmentPreview, type AttachmentSummary } from '@shared/attachments';
import { cn } from '../../lib/cn';
import { DocumentIcon, ImageIcon, XIcon } from '../ui/icons';

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

  const remove = onRemove !== undefined ? (
    <button
      type="button"
      disabled={disabled}
      onClick={() => { onRemove(attachment.id); }}
      aria-label={`Remove ${attachment.name}`}
      className="absolute top-1 right-1 flex size-5 cursor-pointer items-center justify-center rounded-full bg-background/90 text-foreground opacity-0 shadow-sm transition-opacity group-hover/att:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed"
    >
      <XIcon size={11} />
    </button>
  ) : null;

  // Images: a plain thumbnail. In the composer it is a small square; in a
  // sent message it is a larger preview inside the bubble.
  if (isImage) {
    const history = display === 'history';
    return (
      <div className="group/att relative w-fit">
        <button
          type="button"
          onClick={() => { onPreview(attachment); }}
          aria-label={`Preview ${attachment.name}`}
          title={`${attachment.name} · ${formatAttachmentSize(attachment.sizeBytes)}`}
          className={cn(
            'block cursor-pointer overflow-hidden rounded-lg border border-border/70 bg-muted/40 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
            history ? 'max-w-[min(16rem,100%)]' : 'size-16',
          )}
        >
          {image !== null
            ? <img
                src={image}
                alt={attachment.name}
                loading="lazy"
                decoding="async"
                draggable={false}
                className={history ? 'block h-auto max-h-56 w-auto max-w-full object-contain' : 'size-full object-cover'}
                onError={() => { setThumbnail(null); setFailed(true); }}
              />
            : <span className={cn('flex items-center justify-center text-muted-foreground', history ? 'size-24' : 'size-full')}>
                <ImageIcon size={18} className={failed ? undefined : 'opacity-60'} />
              </span>}
        </button>
        {remove}
      </div>
    );
  }

  // Other files: a slim chip with the name and size.
  return (
    <div className="group/att relative w-fit max-w-full">
      <button
        type="button"
        onClick={() => { onPreview(attachment); }}
        aria-label={`Preview ${attachment.name}`}
        className={cn(
          'flex max-w-64 min-w-0 cursor-pointer items-center gap-2 rounded-lg border border-border/70 bg-background/60 px-2.5 text-left hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring',
          display === 'history' ? 'h-10' : 'h-16',
        )}
      >
        <DocumentIcon size={16} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="block truncate text-xs text-foreground" title={attachment.name}>{attachment.name}</span>
          <span className="block text-3xs text-muted-foreground">{ATTACHMENT_KIND_LABELS[attachment.kind]} · {formatAttachmentSize(attachment.sizeBytes)}</span>
        </span>
      </button>
      {remove}
    </div>
  );
}
