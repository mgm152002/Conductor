import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTaskStore, isTerminalTask, tasksForWorkspace } from '../../stores/task-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useUiStore } from '../../stores/ui-store';
import { threadStatus, threadTitle } from '../../lib/thread-status';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Alert, Button, EmptyState } from '../ui/primitives';
import { FolderIcon, RotateIcon, SquarePenIcon, TicketIcon } from '../ui/icons';

export function TaskList({ history = false }: { history?: boolean }): React.JSX.Element {
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const allTasks = useTaskStore((state) => state.tasks);
  const focus = useTaskStore((state) => state.focus);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [resuming, setResuming] = useState<string | null>(null);
  const [pendingResumeId, setPendingResumeId] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const navigate = useNavigate();
  const tasks = tasksForWorkspace(allTasks, workspaceId).filter((task) => history || !isTerminalTask(task));
  const refresh = useCallback(() => { setVersion((value) => value + 1); }, []);

  useEffect(() => {
    let active = true;
    setError(null);
    if (workspaceId === null) { setLoading(false); return; }
    setLoading(true);
    const request = history ? window.conductor.task.list({ workspaceId, limit: 500 }) : window.conductor.task.listActive();
    void request.then((list) => {
      if (active) useTaskStore.getState().setTasks(list);
    }).catch((err: unknown) => {
      if (active) setError(err instanceof Error ? err.message : 'Could not load tasks');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [workspaceId, version, history]);

  async function cancel(id: string): Promise<void> {
    setCancelling(id);
    setError(null);
    try {
      await window.conductor.task.cancel(id);
      const details = await window.conductor.task.details(id);
      useTaskStore.getState().upsert(details.task);
      useTaskStore.getState().bumpDetails(id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not cancel task');
    } finally { setCancelling(null); }
  }

  async function retryTask(id: string): Promise<void> {
    setRetrying(id);
    setError(null);
    try {
      await window.conductor.task.retry(id);
      useTaskStore.getState().upsert(await window.conductor.task.get(id));
      useTaskStore.getState().bumpDetails(id);
      focus(id);
      useUiStore.getState().setDraft(false);
      navigate('/work');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not retry task'); }
    finally { setRetrying(null); }
  }

  async function resumeTask(id: string, confirmed = false): Promise<void> {
    setResuming(id);
    setError(null);
    try {
      const result = await window.conductor.resume.act({ taskId: id, action: 'resume', ...(confirmed ? { confirmed: true } : {}) });
      if (result.status === 'confirmation_required') { setPendingResumeId(id); return; }
      setPendingResumeId(null);
      useTaskStore.getState().upsert(await window.conductor.task.get(id));
      useTaskStore.getState().bumpDetails(id);
      focus(id);
      useUiStore.getState().setDraft(false);
      navigate('/work');
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not resume task'); }
    finally { setResuming(null); }
  }

  return (
    <section className="flex flex-col gap-3" aria-label={history ? 'Task history' : 'Running tasks'}>
      <header className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-foreground">{history ? 'Task history' : 'In progress'} <span className="ml-1 font-normal text-muted-foreground tabular-nums">{tasks.length}</span></h2>
        <Button size="sm" variant="ghost" onClick={refresh} disabled={loading || workspaceId === null}><RotateIcon size={12} />{loading ? 'Loading…' : 'Refresh'}</Button>
      </header>
      {error !== null ? <Alert>{error}</Alert> : null}
      {workspaceId === null ? (
        <div className="group-card"><EmptyState icon={<FolderIcon size={20} />} title="No project selected" description="Select a project to see its tasks."><Button size="md" variant="outline" onClick={() => { navigate('/projects'); }}>Open Projects</Button></EmptyState></div>
      ) : tasks.length === 0 && !loading ? (
        <div className="group-card">
          <EmptyState
            icon={<TicketIcon size={20} />}
            title={history ? 'No task history yet' : 'Nothing is running'}
            description={history ? 'Tasks you run in this project are listed here.' : 'Agents working in this project show up here while they run, wait on you, or are paused.'}
          >
            {history ? null : <Button size="md" variant="primary" onClick={() => { focus(null); useUiStore.getState().setDraft(true); navigate('/work'); }}><SquarePenIcon size={14} />New thread</Button>}
          </EmptyState>
        </div>
      ) : null}
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => {
          const status = threadStatus(task, false);
          const acting = retrying !== null || cancelling !== null || resuming !== null;
          return (
          <li key={task.id} className="row-in group-card flex flex-col gap-3 p-4">
            <div className="flex items-start gap-3">
            <button type="button" title="Open this thread" className="flex min-w-0 flex-1 cursor-pointer flex-col gap-1.5 rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" onClick={() => { focus(task.id); useUiStore.getState().setDraft(false); navigate('/work'); }}>
              <span className="line-clamp-3 break-words text-sm font-medium text-foreground">{threadTitle(task)}</span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                <span className={cn('flex items-center gap-1.5 font-medium', status.colorClass)}>
                  <span aria-hidden="true" className={cn('size-1.5 rounded-full', status.dotClass, status.pulse && 'animate-status-pulse')} />
                  {status.label}
                </span>
                <time dateTime={task.updatedAt} title={new Date(task.updatedAt).toLocaleString()}>{relativeTime(task.updatedAt)}</time>
              </span>
              {task.recommendedNextAction ? <span className="text-xs text-muted-foreground">{task.recommendedNextAction}</span> : null}
            </button>
            <div className="flex shrink-0 items-center gap-1.5">
              {task.state === 'BLOCKED' ? <Button size="sm" variant="primary" disabled={acting} onClick={() => { void retryTask(task.id); }}>{retrying === task.id ? 'Retrying…' : 'Retry'}</Button> : null}
              {task.state === 'RECOVERABLE_INTERRUPTION' || task.state === 'BLOCKED' ? <Button size="sm" variant="outline" disabled={acting} onClick={() => { void resumeTask(task.id); }}>{resuming === task.id ? 'Resuming…' : 'Resume'}</Button> : null}
              {!isTerminalTask(task) ? <Button size="sm" variant="ghost" disabled={acting} onClick={() => { void cancel(task.id); }}>{cancelling === task.id ? 'Cancelling…' : 'Cancel'}</Button> : null}
            </div>
            </div>
            {pendingResumeId === task.id ? (
              <div role="alertdialog" aria-label="Confirm resume" className="rounded-lg border border-warning/30 bg-warning/6 p-3 text-xs text-foreground">
                <p>Resuming will re-execute an unfinished consequential action, such as a command, write, external message, or payment. Continue?</p>
                <div className="mt-2 flex gap-2">
                  <Button size="sm" variant="default" disabled={resuming !== null} onClick={() => { void resumeTask(task.id, true); }}>Confirm resume</Button>
                  <Button size="sm" variant="ghost" disabled={resuming !== null} onClick={() => { setPendingResumeId(null); }}>Keep paused</Button>
                </div>
              </div>
            ) : null}
          </li>
          );
        })}
      </ul>
      {history && tasks.length >= 500 ? <p className="text-xs text-muted-foreground">Showing up to 500 recent tasks in this workspace.</p> : null}
    </section>
  );
}
