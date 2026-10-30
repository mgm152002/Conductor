import { useState } from 'react';
import type { ChatThread } from '@shared/chat-contract';
import { useChatStore } from '../../stores/chat-store';
import { Alert, Button, Dialog, inputClassName } from '../ui/primitives';

// Renames one casual chat thread. Only the sidebar/header title changes; the
// conversation's messages are never touched.

export interface RenameChatDialogProps {
  thread: ChatThread;
  open: boolean;
  onClose: () => void;
}

export function RenameChatDialog({ thread, open, onClose }: RenameChatDialogProps): React.JSX.Element {
  const [title, setTitle] = useState(thread.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = title.trim().replace(/\s+/g, ' ');

  async function save(): Promise<void> {
    if (busy || clean === '') return;
    if (clean === thread.title) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      const renamed = await window.conductor.chat.rename(thread.id, clean);
      useChatStore.getState().rename(renamed);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not rename the chat');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title="Rename chat"
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
          <span className="text-xs font-medium text-muted-foreground">Chat title</span>
          <input
            value={title}
            onChange={(event) => { setTitle(event.target.value); }}
            maxLength={120}
            aria-label="Chat title"
            className={inputClassName}
          />
        </label>
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}
