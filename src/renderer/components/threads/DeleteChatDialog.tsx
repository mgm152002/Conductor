import { useState } from 'react';
import type { ChatThread } from '@shared/chat-contract';
import { useChatStore } from '../../stores/chat-store';
import { Alert, Button, Dialog } from '../ui/primitives';

// Confirms and deletes one casual chat thread. Conductor removes the thread
// and its stored messages; tasks and project files are never touched.

export interface DeleteChatDialogProps {
  thread: ChatThread;
  open: boolean;
  onClose: () => void;
}

export function DeleteChatDialog({ thread, open, onClose }: DeleteChatDialogProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.conductor.chat.delete(thread.id);
      useChatStore.getState().remove(thread.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the chat');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={thread.title ? `Delete "${thread.title}"?` : 'Delete chat?'}
      description="This removes the chat from Conductor."
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={() => { if (!busy) onClose(); }}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => { void confirm(); }}>
            {busy ? 'Deleting…' : 'Delete chat'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>All messages are removed and cannot be recovered.</p>
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
