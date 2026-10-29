import { useCallback, useState } from 'react';
import { MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_PER_MESSAGE, formatAttachmentSize, type AttachmentSummary } from '@shared/attachments';
import { PaperclipIcon } from '../ui/icons';
import { Button } from '../ui/primitives';
import { AttachmentCard } from './AttachmentCard';
import { AttachmentPreviewDialog } from './AttachmentPreviewDialog';
import type { AttachmentDraftError, AttachmentProgress } from './useAttachmentDraft';

export interface AttachmentTrayProps {
  attachments: readonly AttachmentSummary[];
  onRemove?: ((id: string) => void) | undefined;
  onPick?: (() => void) | undefined;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  progress?: AttachmentProgress | null | undefined;
  errors?: readonly AttachmentDraftError[] | undefined;
  onClearErrors?: (() => void) | undefined;
}

/** Use in composers with draft handlers, or in history with just attachments. */
export function AttachmentTray({ attachments, onRemove, onPick, busy = false, disabled = false, progress, errors = [], onClearErrors }: AttachmentTrayProps): React.JSX.Element {
  const [selected, setSelected] = useState<AttachmentSummary | null>(null);
  const close = useCallback(() => { setSelected(null); }, []);
  const preview = selected && attachments.some(item => item.id === selected.id) ? selected : null;
  // In history there is nothing to edit, so image attachments get a real
  // inline preview instead of the small composer chip.
  const history = onPick === undefined && onRemove === undefined;
  return <div className="min-w-0 max-w-full space-y-2" aria-label="Attachments" aria-busy={busy}>
    {onPick && <div className="flex flex-wrap items-center gap-2">
      <Button variant="ghost" disabled={busy || disabled || attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE} onClick={onPick}><PaperclipIcon />Attach files</Button>
      <span className="text-2xs text-muted-foreground">Up to {MAX_ATTACHMENTS_PER_MESSAGE} files, {formatAttachmentSize(MAX_ATTACHMENT_BYTES)} each</span>
    </div>}
    {!!attachments.length && <ul className={history ? 'flex max-w-full flex-wrap items-start gap-3' : 'flex flex-wrap gap-2'} aria-label="Attached files">
      {attachments.map(attachment => <li key={attachment.id} className="min-w-0 max-w-full"><AttachmentCard attachment={attachment} display={history ? 'history' : 'compact'} onPreview={setSelected} onRemove={onRemove} disabled={busy || disabled} /></li>)}
    </ul>}
    {busy && <div role="status" className="space-y-1 text-xs text-muted-foreground">
      <p>{progress?.fileName ?? 'Updating attachments…'}{progress && progress.total > 0 ? ` (${progress.completed} of ${progress.total} completed)` : ''}</p>
      <progress className="h-1 w-full" aria-label="Attachment progress" {...(progress && progress.total > 0 ? { value: progress.completed, max: progress.total } : {})} />
    </div>}
    {!!errors.length && <div role="alert" className="rounded-lg border border-destructive/25 p-2 text-xs text-destructive-foreground">
      <ul>{errors.map((error, index) => <li key={index} className="break-words"><strong>{error.fileName}:</strong> {error.message}</li>)}</ul>
      {onClearErrors && <Button variant="ghost" size="xs" onClick={onClearErrors}>Dismiss errors</Button>}
    </div>}
    <AttachmentPreviewDialog attachment={preview} onClose={close} />
  </div>;
}
