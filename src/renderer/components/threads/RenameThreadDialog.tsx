import { useState } from 'react';
import { useTaskStore } from '../../stores';
import { Alert, Button, Dialog, inputClassName } from '../ui/primitives';

// Renames one Work conversation thread. The new title is stored on the
// thread's root task; its first message (the objective) is never changed.

export interface RenameThreadDialogProps {
  /** The thread key: the root task's thread id. */
  threadId: string;
  /** The title currently shown for the thread. */
  currentTitle: string;
  open: boolean;
  onClose: () => void;
}

export function RenameThreadDialog({ threadId, currentTitle, open, onClose }: RenameThreadDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(currentTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = title.trim().replace(/\s+/g, ' ');

  async function save(): Promise<void> {
    if (busy || clean === '') return;
    if (clean === currentTitle) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      const root = await window.conductor.task.renameThread(threadId, clean);
      useTaskStore.getState().upsert(root);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the thread');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title="Rename thread"
      description="Choose a new title for this conversation."
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={() => { if (!busy) onClose(); }}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy || clean === ''} onClick={() => { void save(); }}>
            {busy ? 'Renaming…' : 'Rename'}
          </Button>
        </>
      )}
    >
      <form
        className="flex flex-col gap-3"
        onSubmit={(event) => { event.preventDefault(); void save(); }}
      >
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Thread title</span>
          <input
            value={title}
            onChange={(event) => { setTitle(event.target.value); }}
            maxLength={120}
            aria-label="Thread title"
            className={inputClassName}
          />
        </label>
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}
