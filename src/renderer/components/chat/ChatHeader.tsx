import { useState } from 'react';
import type { Task, Workspace } from '@shared/domain';
import { useApprovalStore, useTaskStore, useUiStore } from '../../stores';
import { threadStatus, threadTitle } from '../../lib/thread-status';
import { cn } from '../../lib/cn';
import { Button, Dialog } from '../ui/primitives';
import { PanelRightIcon, PlayIcon, RotateIcon } from '../ui/icons';

// The 52px thread header: project / thread breadcrumb, a status pill, the
// recovery actions that apply to the current state, and the details toggle.

export function ChatHeader({ project, task, title }: { project: Workspace | undefined; task: Task | null; title?: Task }): React.JSX.Element {
  const pending = useApprovalStore((s) => s.pending);
  const detailsOpen = useUiStore((s) => s.detailsOpen);
  const setDetailsOpen = useUiStore((s) => s.setDetailsOpen);
  const [busy, setBusy] = useState<'retry' | 'resume' | null>(null);
  const [confirmResume, setConfirmResume] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = task !== null ? threadStatus(task, pending.some((request) => request.taskId === task.id)) : null;

  async function refresh(id: string): Promise<void> {
    useTaskStore.getState().upsert(await window.conductor.task.get(id));
    useTaskStore.getState().bumpDetails(id);
  }

  async function retry(): Promise<void> {
    if (task === null) return;
    setBusy('retry'); setError(null);
    try { await window.conductor.task.retry(task.id); await refresh(task.id); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not retry task'); }
    finally { setBusy(null); }
  }

  async function resume(confirmed: boolean): Promise<void> {
    if (task === null) return;
    setBusy('resume'); setError(null);
    try {
      const result = await window.conductor.resume.act({ taskId: task.id, action: 'resume', ...(confirmed ? { confirmed: true } : {}) });
      if (result.status === 'confirmation_required') { setConfirmResume(true); return; }
      setConfirmResume(false);
      await refresh(task.id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not resume task'); }
    finally { setBusy(null); }
  }

  return (
    <header className="app-drag flex min-h-(--topbar-height) shrink-0 flex-wrap items-center gap-2 px-4 py-2">
      <div className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
        {project !== undefined ? (
          <span className="flex min-w-0 max-w-[40%] items-center gap-1.5 text-muted-foreground" title={project.rootPath}>
            <span aria-hidden="true" className="flex size-5 shrink-0 items-center justify-center rounded-md bg-primary/20 text-3xs font-bold text-primary">{project.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'P'}</span>
            <span className="max-w-40 truncate">{project.name}</span>
          </span>
        ) : null}
        {task !== null ? (
          <>
            <span className="text-muted-foreground/50" aria-hidden="true">/</span>
            <h1 className="min-w-0 truncate font-medium text-foreground" title={(title ?? task).objective}>{threadTitle(title ?? task)}</h1>
          </>
        ) : (
          <h1 className="sr-only">New thread</h1>
        )}
        {status !== null ? (
          <span className={cn('ml-1 flex shrink-0 items-center gap-1 text-2xs font-medium', status.colorClass)}>
            <span className={cn('size-1.5 rounded-full', status.dotClass, status.pulse && 'animate-status-pulse')} />
            {status.label}
          </span>
        ) : null}
      </div>
      {error !== null ? <span role="alert" className="max-w-64 truncate text-2xs text-destructive-foreground" title={error}>{error}</span> : null}
      {task?.state === 'BLOCKED' ? (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void retry(); }}><RotateIcon size={13} />{busy === 'retry' ? 'Retrying…' : 'Retry'}</Button>
      ) : null}
      {task !== null && (task.state === 'RECOVERABLE_INTERRUPTION' || task.state === 'BLOCKED') ? (
        <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void resume(false); }}><PlayIcon size={12} />{busy === 'resume' ? 'Resuming…' : 'Resume'}</Button>
      ) : null}
      {task !== null ? (
        <Button size="icon" variant="ghost" aria-label={detailsOpen ? 'Hide details' : 'Show details'} aria-pressed={detailsOpen} title="Plan, checks, files and context" onClick={() => { setDetailsOpen(!detailsOpen); }} className={cn(detailsOpen && 'bg-accent text-foreground')}>
          <PanelRightIcon size={16} />
        </Button>
      ) : null}
      <Dialog
        open={confirmResume}
        onClose={() => { setConfirmResume(false); }}
        title="Confirm resume"
        description="Resuming may repeat an action that already had effects (for example writing files or running commands). Review the work log before continuing."
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setConfirmResume(false); }}>Keep paused</Button>
          <Button size="md" variant="primary" disabled={busy !== null} onClick={() => { void resume(true); }}>Confirm resume</Button>
        </>}
      />
    </header>
  );
}
