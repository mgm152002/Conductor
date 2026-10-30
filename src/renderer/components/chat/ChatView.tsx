import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task, Workspace } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { useTaskStore, useUiStore, useWorkspaceStore } from '../../stores';
import { threadKey, threadTasks } from '../../lib/threads';
import { useFocusedTask } from '../workspace/useFocusedTask';
import { useTaskDetails } from '../../hooks/useTaskDetails';
import { buildTimeline, isAgentFallbackEvent, latestActivity, type TimelineItem } from '../../lib/timeline';
import { isWorkingState } from '../../lib/thread-status';
import { formatDuration } from '../../lib/time';
import { cn } from '../../lib/cn';
import { Alert, Button } from '../ui/primitives';
import { CheckIcon, FolderIcon, ListChecksIcon, PlusIcon, XIcon } from '../ui/icons';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { DetailsPanel } from './DetailsPanel';
import { MessagesTimeline } from './MessagesTimeline';
import { PendingApprovalPanel } from './PendingApprovalPanel';
import { PendingQuestionPanel } from './PendingQuestionPanel';
import { EnvironmentCard } from './EnvironmentCard';
import { AgentSetupNotice } from './AgentSetupNotice';
import { Mem0OfflineNotice } from './Mem0OfflineNotice';
import { PlanResults, runLabel } from './PlanCard';
import { PlanDock } from './PlanDock';
import { agentLabel, formatCost, outputRate, usageBreakdown } from '../../lib/usage-format';

// The main surface, in the T3 Code shape: a thread header, a centred message
// timeline, and the composer docked at the bottom, with an optional details
// panel on the right. With no thread selected it shows a draft hero with the
// composer centred; with no project it prompts to add one.

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { setNow(Date.now()); }, 1000);
    return () => { window.clearInterval(timer); };
  }, [active]);
  return now;
}

function StatusLine({ task, details, items }: { task: Task; details: TaskDetails | null; items: TimelineItem[] }): React.JSX.Element | null {
  const working = isWorkingState(task.state);
  const now = useNow(working);
  if (working) {
    // Show what the agent is actually doing right now, not a static label.
    const current = latestActivity(items);
    const label = task.state === 'VERIFYING' ? 'Verifying results'
      : current !== undefined ? current.label
        : task.state === 'RUNNING' ? 'Working' : 'Preparing';
    const runningSteps = details?.steps.filter((step) => step.status === 'running') ?? [];
    const source = runningSteps.length > 1
      ? `${runningSteps.length} agents`
      : runningSteps[0]?.assignedAdapterId !== undefined
        ? agentLabel(runningSteps[0].assignedAdapterId)
        : undefined;
    return (
      <div className="flex min-w-0 items-center gap-2 px-1 text-[13px]" role="status">
        <span className="min-w-0 truncate text-shimmer font-medium" title={label}>
          {label}…
        </span>
        {source !== undefined ? <span className="shrink-0 rounded border border-border/70 px-1 py-px text-3xs text-muted-foreground">{source}</span> : null}
        <span className="ml-auto shrink-0 text-2xs text-muted-foreground tabular-nums">{formatDuration(now - Date.parse(task.createdAt))}</span>
      </div>
    );
  }
  if (task.state === 'BLOCKED' || task.state === 'RECOVERABLE_INTERRUPTION') {
    // The reason is usually already in the timeline as an error; don't repeat it.
    const shown = task.recommendedNextAction !== undefined && items.some((item) => item.kind === 'error' && item.text === task.recommendedNextAction);
    return (
      <Alert tone="warning">
        <p className="font-medium">{task.state === 'BLOCKED' ? 'This task is blocked.' : 'This task was interrupted.'}</p>
        <p className="mt-0.5 text-foreground/80">{task.recommendedNextAction && !shown ? task.recommendedNextAction : 'Fix the issue above, then use Retry or Resume in the header.'}</p>
      </Alert>
    );
  }
  if (task.state === 'WAITING_FOR_APPROVAL') return <p className="px-1 text-xs text-warning">Waiting for your approval below.</p>;
  if (task.state === 'COMPLETED' || task.state === 'FAILED') {
    const verification = details?.verification;
    const criteria = task.acceptanceCriteria;
    const passed = verification?.criteria.filter((c) => c.satisfied).length ?? 0;
    return <VerificationSummary task={task} passed={passed} total={criteria.length} recorded={verification != null} verified={verification?.verified === true} />;
  }
  if (task.state === 'CANCELLED') return <p className="px-1 text-xs text-muted-foreground">Stopped.</p>;
  return null;
}

function VerificationSummary({ task, passed, total, recorded, verified }: { task: Task; passed: number; total: number; recorded: boolean; verified: boolean }): React.JSX.Element {
  const openDetails = useUiStore((s) => s.openDetails);
  const tone = !recorded ? 'text-muted-foreground' : verified ? 'text-success' : 'text-destructive-foreground';
  return (
    <button type="button" onClick={() => { openDetails('checks'); }} className="flex w-full cursor-pointer items-center gap-2 rounded-xl border border-border px-3 py-2 text-left text-xs hover:bg-accent">
      <span className={cn('flex size-5 items-center justify-center rounded-full', !recorded ? 'bg-accent' : verified ? 'bg-success/15' : 'bg-destructive/15', tone)} aria-hidden="true">
        {!recorded ? <ListChecksIcon size={11} /> : verified ? <CheckIcon size={11} /> : <XIcon size={11} />}
      </span>
      <span className={cn('font-medium', tone)}>
        {!recorded ? 'No verification recorded' : verified ? 'Verified' : task.state === 'FAILED' ? 'Failed verification' : 'Verification did not pass'}
      </span>
      {recorded ? <span className="text-muted-foreground">· {passed}/{total} checks passed</span> : null}
      <span className="ml-auto text-muted-foreground">View checks</span>
    </button>
  );
}

/** One message in the thread: the user's request, the agent's work and reply, and its status. */
function Turn({ task, isLatest, onDetails, onLoaded }: { task: Task; isLatest: boolean; onDetails: () => void; onLoaded: () => void }): React.JSX.Element {
  const { details, loading, error, refresh } = useTaskDetails(task);
  // A plan's tasks run in parallel, so their output is shown per task in the
  // plan card; the main timeline keeps the message, task-level events, and
  // agent-switch notices (which must stay visible in the conversation).
  const planned = details?.plan != null;
  const items = useMemo(() => buildTimeline(task, details !== null && planned
    ? { ...details, events: details.events.filter((e) => e.stepId === undefined || e.kind === 'transition' || isAgentFallbackEvent(e)) }
    : details), [task, details, planned]);
  const live = isWorkingState(task.state);
  const total = details?.usage?.total;
  const startedAt = Date.parse(task.createdAt);
  const endedAt = Date.parse(task.updatedAt);
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : undefined;
  const rate = total !== null && total !== undefined ? outputRate(total, durationMs) : undefined;
  useLayoutEffect(() => { onLoaded(); }, [items, task.state, onLoaded]);
  return (
    <section aria-label={`Message: ${task.objective.slice(0, 60)}`} className="group/turn flex flex-col gap-5">
      {error !== null ? <Alert action={<Button size="xs" variant="ghost" onClick={refresh}>Retry details</Button>}>{error}</Alert> : null}
      <MessagesTimeline items={items} live={live} />
      {details !== null && planned ? <PlanResults task={task} details={details} /> : null}
      {loading && details === null ? <p role="status" className="px-1 text-xs text-muted-foreground">Loading task details…</p> : null}
      <StatusLine task={task} details={details} items={items} />
      {total != null && !live ? (
        <p
          className="-mt-3 px-1 text-3xs text-muted-foreground tabular-nums"
          title={[
            `${total.inputTokens.toLocaleString()} input (${total.cachedInputTokens.toLocaleString()} cached)`,
            `${total.outputTokens.toLocaleString()} output${total.reasoningTokens > 0 ? ` (${total.reasoningTokens.toLocaleString()} reasoning)` : ''}`,
            ...(rate !== undefined ? [`${rate.toFixed(1)} output tokens/second`] : []),
            ...(total.costUsd !== undefined ? [formatCost(total.costUsd)] : []),
            ...(durationMs !== undefined ? [`Took ${formatDuration(durationMs)}`] : []),
          ].join(' · ')}
        >
          {usageBreakdown(total, durationMs)} · {total.sessions} agent session{total.sessions === 1 ? '' : 's'}
          {!planned && details?.steps.length === 1 && runLabel(details.steps[0]) !== undefined ? ` · ${runLabel(details.steps[0])}` : ''}
        </p>
      ) : null}
      {!isLatest ? (
        <div className="flex justify-end">
          <button type="button" onClick={onDetails} className="cursor-pointer text-3xs text-muted-foreground opacity-0 transition-opacity group-hover/turn:opacity-100 hover:text-foreground focus-visible:opacity-100">Inspect this message</button>
        </div>
      ) : null}
    </section>
  );
}

function InspectedDetailsPanel({ task }: { task: Task }): React.JSX.Element {
  const { details } = useTaskDetails(task);
  return <DetailsPanel task={task} details={details} />;
}

function Thread({ focused, project }: { focused: Task; project: Workspace | undefined }): React.JSX.Element {
  const key = threadKey(focused);
  const allTasks = useTaskStore((s) => s.tasks);
  const turns = useMemo(() => threadTasks(allTasks, key), [allTasks, key]);
  const latest = turns[turns.length - 1] ?? focused;
  // The details panel follows the focused message (latest by default).
  const inspected = turns.find((t) => t.id === focused.id) ?? latest;
  const { details: latestDetails } = useTaskDetails(latest);
  const detailsOpen = useUiStore((s) => s.detailsOpen);
  const openDetails = useUiStore((s) => s.openDetails);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  // Older turns may not be in the store yet (lists are paged); load the thread.
  useEffect(() => {
    let active = true;
    void window.conductor.task.thread(key).then((list) => { if (active) useTaskStore.getState().setTasks(list); }).catch(() => {});
    return () => { active = false; };
  }, [key, latest.id]);
  useEffect(() => { stick.current = true; }, [key]);

  const follow = useCallback(() => {
    const element = scroller.current;
    if (element !== null && stick.current) element.scrollTop = element.scrollHeight;
  }, []);

  return (
    <div className="thread-layout relative flex min-h-0 min-w-0 flex-1">
      {!detailsOpen ? <EnvironmentCard task={latest} project={project} /> : null}
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader project={project} task={latest} title={turns[0] ?? latest} />
        <div
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          className="min-h-0 flex-1 overflow-y-auto"
        >
          <div className="mx-auto flex w-full max-w-(--chat-max) flex-col gap-8 px-5 pt-6 pb-8">
            {turns.map((turn, index) => (
              <Turn
                key={turn.id}
                task={turn}
                isLatest={index === turns.length - 1}
                onLoaded={follow}
                onDetails={() => { useTaskStore.getState().focus(turn.id); openDetails('plan'); }}
              />
            ))}
          </div>
        </div>
        <div className="shrink-0 px-5">
          <AgentSetupNotice />
          <Mem0OfflineNotice />
          <PendingApprovalPanel task={latest} />
          <PendingQuestionPanel scopeId={latest.id} />
          <PlanDock task={latest} details={latestDetails} />
          <Composer task={latest} currentAgentId={[...(latestDetails?.steps ?? [])].reverse().find((s) => s.assignedAdapterId !== undefined)?.assignedAdapterId} />
        </div>
      </div>
      {detailsOpen ? (
        inspected.id === latest.id
          ? <DetailsPanel task={latest} details={latestDetails} />
          : <InspectedDetailsPanel task={inspected} />
      ) : null}
    </div>
  );
}

function DraftHero(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const project = workspaces.find((w) => w.id === activeWorkspaceId);
  const planMode = useUiStore((s) => s.planMode);
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 py-8">
      <div className="my-auto w-full max-w-(--chat-max) shrink-0">
        <p className="mb-2 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <FolderIcon size={13} />{project?.name ?? 'No project'}
        </p>
        <h2 className="mb-6 text-center text-[28px] font-medium tracking-tight text-foreground">What should we build in <span className="underline decoration-dotted decoration-muted-foreground/60 underline-offset-4">{project?.name ?? 'Conductor'}</span>?</h2>
        <AgentSetupNotice />
        <Mem0OfflineNotice />
        <Composer task={null} autoFocus variant="hero" />
        <p className="mt-3 text-center text-2xs text-muted-foreground/80">
          {planMode
            ? 'Plan mode: the planner writes requirements and a task list to .conductor/plans, then each task runs on its agent. Tasks that don’t depend on each other run in parallel.'
            : 'Conductor routes the task to a connected agent CLI, attaches relevant project context, and verifies the result against your checks.'}
        </p>
      </div>
    </div>
  );
}

function NoProjects(): React.JSX.Element {
  const setAddProjectOpen = useUiStore((s) => s.setAddProjectOpen);
  const loading = useWorkspaceStore((s) => s.loading);
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[10vh] text-center">
      <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border border-border bg-card text-muted-foreground"><FolderIcon size={22} /></div>
      <h2 className="text-lg font-semibold text-foreground">{loading ? 'Loading projects…' : 'Add a project to get started'}</h2>
      <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">A project is a folder your agents work in. Threads, memory and indexed files are kept per project.</p>
      <Button className="mt-5" size="md" variant="primary" onClick={() => { setAddProjectOpen(true); }}><PlusIcon size={14} />Add project</Button>
    </div>
  );
}

export function ChatView(): React.JSX.Element {
  const task = useFocusedTask();
  const draft = useUiStore((s) => s.draft);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const project = workspaces.find((w) => w.id === (task?.workspaceId ?? activeWorkspaceId));
  const showThread = task !== null && !draft;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {workspaces.length === 0 ? (
        <>
          <div className="app-drag h-(--topbar-height) shrink-0 border-b border-border" />
          <NoProjects />
        </>
      ) : showThread ? (
        <Thread key={threadKey(task)} focused={task} project={project} />
      ) : (
        <>
          <ChatHeader project={project} task={null} />
          <DraftHero />
        </>
      )}
    </div>
  );
}
