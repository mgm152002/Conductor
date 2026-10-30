import { useEffect, useState } from 'react';
import type { Task, Workspace } from '@shared/domain';
import { useApprovalStore, useQuestionStore, useTaskStore, useThreadTierStore, useUiStore } from '../../stores';
import { threadStatus, threadTitle } from '../../lib/thread-status';
import { threadKey, threadTasks } from '../../lib/threads';
import { classifyThreadTier, defaultSnoozeUntil, formatSnoozeCountdown } from '../../lib/thread-tiers';
import { cn } from '../../lib/cn';
import { Button, Dialog } from '../ui/primitives';
import { CheckIcon, ClockIcon, PanelRightIcon, PencilIcon, PlayIcon, PullRequestIcon, RotateIcon } from '../ui/icons';
import { RenameThreadDialog } from '../threads/RenameThreadDialog';

// The 52px thread header: project / thread breadcrumb, a status pill, the
// recovery actions that apply to the current state, and the details toggle.

export function ChatHeader({ project, task, title }: { project: Workspace | undefined; task: Task | null; title?: Task }): React.JSX.Element {
  const pending = useApprovalStore((s) => s.pending);
  const pendingQuestions = useQuestionStore((s) => s.pending);
  const taskMap = useTaskStore((s) => s.tasks);
  const tierPref = useThreadTierStore((s) => (task !== null ? s.prefs[threadKey(title ?? task)] : undefined));
  const detailsOpen = useUiStore((s) => s.detailsOpen);
  const setDetailsOpen = useUiStore((s) => s.setDetailsOpen);
  const [busy, setBusy] = useState<'retry' | 'resume' | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Snooze timer for the open thread: fire exactly at `snoozedUntil` so the
  // header flips from Snoozed to Needs attention ("Snooze ended") when the
  // snooze ends, without waiting for some other state change to re-render.
  useEffect(() => {
    if (tierPref?.mode !== 'snoozed' || tierPref.snoozedUntil === undefined) return;
    const until = Date.parse(tierPref.snoozedUntil);
    if (Number.isNaN(until)) return;
    const delay = until - Date.now();
    if (delay <= 0) { setNow(Date.now()); return; }
    const timer = window.setTimeout(() => { setNow(Date.now()); }, Math.min(delay, 2_147_483_647));
    return () => { window.clearTimeout(timer); };
  }, [tierPref]);
  const [renaming, setRenaming] = useState(false);
  const [confirmResume, setConfirmResume] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = task !== null ? threadStatus(task, pending.some((request) => request.taskId === task.id)) : null;
  // The thread's T3-style tier, so a finished thread can be marked settled (or
  // snoozed / woken) from the thread itself, not only from the sidebar.
  const tierInfo = ((): ReturnType<typeof classifyThreadTier> | null => {
    if (task === null) return null;
    const key = threadKey(title ?? task);
    const tasksInThread = threadTasks(taskMap, key);
    const latest = tasksInThread[tasksInThread.length - 1] ?? task;
    const ids = new Set(tasksInThread.map((item) => item.id));
    return classifyThreadTier(
      { key, root: title ?? task, latest, tasks: tasksInThread.length > 0 ? tasksInThread : [task] },
      tierPref,
      {
        hasPendingApproval: pending.some((request) => ids.has(request.taskId)),
        hasPendingQuestion: pendingQuestions.some((request) => ids.has(request.taskId)),
      },
      now,
    );
  })();
  const snoozeCountdown = tierPref?.mode === 'snoozed' && tierPref.snoozedUntil !== undefined
    ? formatSnoozeCountdown(tierPref.snoozedUntil, now)
    : null;

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
            <span className={cn('size-1.5 rounded-full', status.dotClass, status.pulse && tierInfo?.tier !== 'snoozed' && 'animate-status-pulse')} />
            {tierInfo?.tier === 'needs-attention' ? tierInfo.attentionLabel : tierInfo?.tier === 'snoozed' ? (snoozeCountdown !== null ? `Snoozed · wakes ${snoozeCountdown}` : 'Snoozed') : tierInfo?.tier === 'settled' ? 'Settled' : status.label}
          </span>
        ) : null}
      </div>
      {error !== null ? <span role="alert" className="max-w-64 truncate text-2xs text-destructive-foreground" title={error}>{error}</span> : null}
      {task !== null && task.state === 'COMPLETED' && (title ?? task)?.prUrl === undefined ? (
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          title="Commit this thread's worktree, push its branch, and open a pull request"
          onClick={() => {
            setBusy('retry'); setError(null);
            void window.conductor.github.createPr({ workspaceId: task.workspaceId, threadId: threadKey(title ?? task) })
              .then(async (result) => {
                if (result.status === 'no-changes') setError('No changes to file a PR for');
                await refresh((title ?? task).id);
              })
              .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not file pull request'); })
              .finally(() => { setBusy(null); });
          }}
        >
          <PullRequestIcon size={13} /> File PR
        </Button>
      ) : null}
      {(title ?? task)?.prUrl !== undefined ? (
        <Button
          size="sm"
          variant="outline"
          aria-label={`Open pull request ${(title ?? task)!.prNumber !== undefined ? `#${(title ?? task)!.prNumber} ` : ''}on GitHub`}
          title={`Pull request${(title ?? task)!.prState !== undefined ? ` · ${(title ?? task)!.prState}` : ''} — open on GitHub`}
          onClick={() => { void window.conductor.github.openPr((title ?? task)!.prUrl!).catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not open pull request'); }); }}
          className={cn((title ?? task)!.prState === 'merged' ? 'text-violet-500' : (title ?? task)!.prState === 'closed' ? 'text-destructive' : 'text-success')}
        >
          <PullRequestIcon size={13} />
          {(title ?? task)!.prNumber !== undefined ? `#${(title ?? task)!.prNumber}` : 'PR'}
        </Button>
      ) : null}
      {task !== null && tierInfo !== null ? (
        <>
          {tierInfo.tier !== 'settled' ? (
            <Button size="icon" variant="ghost" aria-label={`Mark thread as settled: ${threadTitle(title ?? task)}`} title="Mark as settled" onClick={() => { useThreadTierStore.getState().markSettled(threadKey(title ?? task), task.updatedAt); }}>
              <CheckIcon size={14} />
            </Button>
          ) : null}
          {tierInfo.tier === 'snoozed' || tierInfo.tier === 'settled' ? (
            <Button size="icon" variant="ghost" aria-label={tierInfo.tier === 'snoozed' ? `Wake thread: ${threadTitle(title ?? task)}` : `Move thread back to Needs attention: ${threadTitle(title ?? task)}`} title={tierInfo.tier === 'snoozed' ? 'Wake now' : 'Move back to Needs attention'} onClick={() => { useThreadTierStore.getState().clear(threadKey(title ?? task)); }}>
              <RotateIcon size={14} />
            </Button>
          ) : (
            <Button size="icon" variant="ghost" aria-label={`Snooze thread until tomorrow: ${threadTitle(title ?? task)}`} title="Snooze until tomorrow 9:00 AM" onClick={() => { useThreadTierStore.getState().snooze(threadKey(title ?? task), task.updatedAt, defaultSnoozeUntil()); }}>
              <ClockIcon size={14} />
            </Button>
          )}
        </>
      ) : null}
      {task !== null ? (
        <Button size="icon" variant="ghost" aria-label={`Rename thread: ${threadTitle(title ?? task)}`} title="Rename thread" onClick={() => { setRenaming(true); }}>
          <PencilIcon size={14} />
        </Button>
      ) : null}
      {task !== null && renaming ? (
        <RenameThreadDialog
          key={threadKey(title ?? task)}
          threadId={threadKey(title ?? task)}
          currentTitle={threadTitle(title ?? task)}
          open
          onClose={() => { setRenaming(false); }}
        />
      ) : null}
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
