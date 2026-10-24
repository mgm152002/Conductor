import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTaskStore, isTerminalTask, tasksForWorkspace } from '../../stores/task-store';
import { useWorkspaceStore } from '../../stores/workspace-store';
import { useUiStore } from '../../stores/ui-store';

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
        <h2 className="text-sm font-semibold text-foreground">{history ? 'Task history' : 'In progress'} <span className="text-muted-foreground/80">({tasks.length})</span></h2>
        <button type="button" onClick={refresh} disabled={loading || workspaceId === null} className="rounded-md border border-input px-3 py-1 text-xs disabled:opacity-40">{loading ? 'Loading…' : 'Refresh'}</button>
      </header>
      {error !== null ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
      {workspaceId === null ? <p className="text-sm text-muted-foreground">Select a workspace in Projects to see its tasks.</p> : tasks.length === 0 && !loading ? <p className="text-sm text-muted-foreground">{history ? 'No task history in this workspace yet.' : 'No active tasks in this workspace.'}</p> : null}
      <ul className="flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.id} className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
            <div className="flex items-start gap-3">
            <button type="button" className="flex min-w-0 flex-1 flex-col gap-1 text-left" onClick={() => { focus(task.id); useUiStore.getState().setDraft(false); navigate('/work'); }}>
              <span className="whitespace-pre-wrap break-words text-sm font-medium text-foreground">{task.objective}</span>
              <span className="text-xs text-muted-foreground">{task.state.toLowerCase().replace(/_/g, ' ')} · <time dateTime={task.updatedAt}>{new Date(task.updatedAt).toLocaleString()}</time></span>
              {task.recommendedNextAction ? <span className="text-xs text-muted-foreground">{task.recommendedNextAction}</span> : null}
              <span className="text-xs text-primary">Inspect task →</span>
            </button>
            <div className="flex shrink-0 flex-col gap-2">
              {task.state === 'BLOCKED' ? <button type="button" disabled={retrying !== null || cancelling !== null || resuming !== null} onClick={() => { void retryTask(task.id); }} className="rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground disabled:opacity-40">{retrying === task.id ? 'Retrying…' : 'Retry'}</button> : null}
              {task.state === 'RECOVERABLE_INTERRUPTION' || task.state === 'BLOCKED' ? <button type="button" disabled={retrying !== null || cancelling !== null || resuming !== null} onClick={() => { void resumeTask(task.id); }} className="rounded-md border border-input px-3 py-1.5 text-xs disabled:opacity-40">{resuming === task.id ? 'Resuming…' : 'Resume'}</button> : null}
              {!isTerminalTask(task) ? <button type="button" disabled={cancelling !== null || retrying !== null || resuming !== null} onClick={() => { void cancel(task.id); }} className="rounded-md border border-input px-3 py-1.5 text-xs disabled:opacity-40">{cancelling === task.id ? 'Cancelling…' : 'Cancel'}</button> : null}
            </div>
            </div>
            {pendingResumeId === task.id ? <div role="alertdialog" aria-label="Confirm resume" className="rounded-md border border-warning/30 bg-warning/6 p-3 text-xs text-foreground"><p>Resuming will re-execute an unfinished consequential action, such as a command, write, external message, or payment. Continue?</p><div className="mt-2 flex gap-2"><button type="button" disabled={resuming !== null} onClick={() => { void resumeTask(task.id, true); }} className="rounded-md bg-amber-700 px-3 py-1.5 font-medium text-white disabled:opacity-40">Confirm resume</button><button type="button" disabled={resuming !== null} onClick={() => { setPendingResumeId(null); }} className="rounded-md border border-warning/40 px-3 py-1.5 disabled:opacity-40">Keep paused</button></div></div> : null}
          </li>
        ))}
      </ul>
      {history && tasks.length >= 500 ? <p className="text-xs text-muted-foreground">Showing up to 500 recent tasks in this workspace.</p> : null}
    </section>
  );
}
