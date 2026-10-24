import { useMemo, useState } from 'react';
import type { Workspace } from '@shared/domain';
import { useApprovalStore, useTaskStore, useWorkspaceStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';
import { Alert, Button, Dialog } from '../ui/primitives';
import { reportMemoryCleanup } from '../../lib/memory-cleanup';

// Confirms and deletes a project. Conductor removes what it stored for the
// project; the folder on disk is left as it is.

export function DeleteProjectDialog({ project, open, onClose }: { project: Workspace; open: boolean; onClose: () => void }): React.JSX.Element {
  const allTasks = useTaskStore((s) => s.tasks);
  const tasks = useMemo(() => Object.values(allTasks).filter((t) => t.workspaceId === project.id), [allTasks, project.id]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const running = tasks.filter((t) => isWorkingState(t.state) || t.state === 'WAITING_FOR_APPROVAL').length;
  const threads = new Set(tasks.map((t) => t.threadId ?? t.id)).size;

  async function confirm(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const result = await window.conductor.workspace.delete(project.id);
      reportMemoryCleanup(result);
      useTaskStore.getState().removeWorkspace(project.id);
      useWorkspaceStore.getState().remove(project.id);
      useWorkspaceStore.getState().setActive(result.activeWorkspaceId);
      const remainingTasks = new Set(Object.keys(useTaskStore.getState().tasks));
      useApprovalStore.getState().setPending(useApprovalStore.getState().pending.filter((a) => remainingTasks.has(a.taskId)));
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete the project');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={() => { if (!busy) onClose(); }}
      title={`Delete ${project.name}?`}
      description="This removes the project from Conductor."
      footer={(
        <>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy || running > 0} onClick={() => { void confirm(); }}>{busy ? 'Deleting…' : 'Delete project'}</Button>
        </>
      )}
    >
      <div className="flex flex-col gap-3 text-sm text-muted-foreground">
        <p>
          Conductor deletes {threads > 0 ? `${threads} thread${threads === 1 ? '' : 's'} and ` : ''}everything it stored for this project:
          agent output, approvals, usage, plans, project memory and context, and indexed-folder connections. This can’t be undone.
        </p>
        <p>
          The folder <span className="font-mono text-xs text-foreground">{project.rootPath}</span> and its files are not touched,
          including plan documents in <span className="font-mono text-xs">.conductor/plans</span>.
        </p>
        {running > 0 ? <Alert tone="warning">Stop the {running === 1 ? 'running thread' : `${running} running threads`} in this project first.</Alert> : null}
        {error !== null ? <Alert>{error}</Alert> : null}
      </div>
    </Dialog>
  );
}
