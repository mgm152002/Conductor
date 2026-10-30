import { useState } from 'react';
import type { ChatSpace } from '@shared/chat-contract';
import { useChatStore } from '../../stores/chat-store';
import { Alert, Button, Dialog, inputClassName } from '../ui/primitives';

// Spaces group personal chats together; chats in one space share context.
// These dialogs only manage the grouping — deleting a space keeps its chats.

export function SpaceNameDialog({ space, open, onClose, onSaved }: {
  /** Null creates a new space; a space renames it. */
  space: ChatSpace | null;
  open: boolean;
  onClose: () => void;
  onSaved?: ((space: ChatSpace) => void) | undefined;
}): React.JSX.Element {
  const [name, setName] = useState(space?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim().replace(/\s+/g, ' ');
  const creating = space === null;

  async function save(): Promise<void> {
    if (busy || clean === '') return;
    if (!creating && clean === space.name) { onClose(); return; }
    setBusy(true);
    setError(null);
    try {
      const saved = creating
        ? await window.conductor.chat.createSpace(clean)
        : await window.conductor.chat.renameSpace(space.id, clean);
      useChatStore.getState().upsertSpace(saved);
      onSaved?.(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the space');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={creating ? 'New space' : 'Rename space'}
      description={creating
        ? 'Group personal chats in a space so they share context with each other.'
        : 'Choose a new name for this space.'}
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={() => { if (!busy) onClose(); }}>Cancel</Button>
          <Button variant="primary" disabled={busy || clean === ''} onClick={() => { void save(); }}>
            {busy ? 'Saving…' : creating ? 'Create space' : 'Rename'}
          </Button>
        </>
      )}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="text-xs font-medium text-muted-foreground">Space name</span>
          <input
            value={name}
            onChange={(event) => { setName(event.target.value); }}
            maxLength={120}
            aria-label="Space name"
            placeholder="e.g. Trip planning"
            className={inputClassName}
          />
        </label>
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}

export function DeleteSpaceDialog({ space, open, onClose }: {
  space: ChatSpace;
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.conductor.chat.deleteSpace(space.id);
      useChatStore.getState().removeSpace(space.id);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the space');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={`Delete "${space.name}"?`}
      description="This removes the space grouping only."
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={() => { if (!busy) onClose(); }}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={() => { void confirm(); }}>
            {busy ? 'Deleting…' : 'Delete space'}
          </Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>Its chats stay in your personal chats, ungrouped, and stop sharing context through this space.</p>
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
