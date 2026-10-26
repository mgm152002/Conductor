import { useEffect, useState } from 'react';
import { ATTACHMENT_KIND_LABELS, formatAttachmentSize, type AttachmentSummary } from '@shared/attachments';
import { DocumentIcon, ImageIcon, XIcon } from '../ui/icons';
import { Button } from '../ui/primitives';

export interface AttachmentCardProps {
  attachment: AttachmentSummary;
  onPreview: (attachment: AttachmentSummary) => void;
  onRemove?: ((id: string) => void) | undefined;
  disabled?: boolean | undefined;
}

export function AttachmentCard({ attachment, onPreview, onRemove, disabled }: AttachmentCardProps): React.JSX.Element {
  const [thumbnail, setThumbnail] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    if (attachment.kind !== 'image') return;
    let active = true;
    void window.conductor.attachment.preview(attachment.id).then(preview => {
      if (active && preview.format === 'image' && preview.dataUrl.startsWith('data:image/')) setThumbnail({ id: attachment.id, url: preview.dataUrl });
    }).catch(() => { /* The card remains usable; opening it reports preview failures. */ });
    return () => { active = false; };
  }, [attachment.id, attachment.kind]);
  return <div className="flex max-w-full items-center gap-1 rounded-lg border border-border bg-card p-1">
    <Button variant="ghost" className="h-auto min-w-0 justify-start gap-2 px-2 py-1.5 text-left" onClick={() => onPreview(attachment)} aria-label={`Preview ${attachment.name}`}>
      {thumbnail?.id === attachment.id ? <img src={thumbnail.url} alt="" className="size-9 shrink-0 rounded object-cover" onError={() => setThumbnail(null)} />
        : attachment.kind === 'image' ? <ImageIcon size={24} /> : <DocumentIcon size={24} />}
      <span className="min-w-0"><span className="block max-w-52 truncate text-xs text-foreground" title={attachment.name}>{attachment.name}</span>
        <span className="block text-2xs text-muted-foreground">{ATTACHMENT_KIND_LABELS[attachment.kind]} · {formatAttachmentSize(attachment.sizeBytes)}</span></span>
    </Button>
    {onRemove && <Button variant="ghost" size="icon-sm" disabled={disabled} onClick={() => onRemove(attachment.id)} aria-label={`Remove ${attachment.name}`}><XIcon size={14} /></Button>}
  </div>;
}
