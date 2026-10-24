import { useMemo, useState } from 'react';
import { useApprovalStore, useTaskStore } from '../../stores';
import { isWorkingState, threadTitle } from '../../lib/thread-status';
import { reportMemoryCleanup } from '../../lib/memory-cleanup';
import { threadKey, type ThreadView } from '../../lib/threads';
import { Alert, Button, Dialog } from '../ui/primitives';

// Confirms and deletes one conversation thread. Conductor removes what it
// stored for the thread's messages; files in the project folder are untouched.

export function DeleteThreadDialog({ thread, open, onClose }: { thread: ThreadView; open: boolean; onClose: () => void }): React.JSX.Element {
  const allTasks = useTaskStore((s) => s.tasks);
  const tasks = useMemo(() => Object.values(allTasks).filter((task) => threadKey(task) === thread.key), [allTasks, thread.key]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = tasks.length > 0 ? tasks : thread.tasks;
  const running = known.filter((task) => isWorkingState(task.state) || task.state === 'WAITING_FOR_APPROVAL').length;
  const messages = known.length;

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.conductor.task.deleteThread(thread.key);
      reportMemoryCleanup(result);
      useTaskStore.getState().removeThread(thread.key);
      const remainingTasks = new Set(Object.keys(useTaskStore.getState().tasks));
      useApprovalStore.getState().setPending(useApprovalStore.getState().pending.filter((a) => remainingTasks.has(a.taskId)));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the thread');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={`Delete "${threadTitle(thread.root)}"?`}
      description="This removes the thread from Conductor."
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy || running > 0} onClick={() => { void confirm(); }}>{busy ? 'Deleting…' : 'Delete thread'}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          Conductor deletes {messages > 1 ? `${messages} messages and ` : 'the message and '}everything it stored for them:
          agent output, approvals, usage, plans, and task memory and context. This can’t be undone.
        </p>
        <p>Project files, including plan documents in <span className="font-mono text-xs">.conductor/plans</span>, are not touched.</p>
        {running > 0 ? <Alert tone="warning">Stop the running thread before deleting it.</Alert> : null}
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
