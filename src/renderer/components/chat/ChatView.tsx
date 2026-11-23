import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task, Workspace } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { useTaskStore, useUiStore, useWorkspaceStore } from '../../stores';
import { threadKey, threadTasks } from '../../lib/threads';
import { useFocusedTask } from '../workspace/useFocusedTask';
import { useTaskDetails } from '../../hooks/useTaskDetails';
import { betweenTurnHandoff, buildTimeline, turnRun, type TimelineItem, type TurnRun } from '../../lib/timeline';
import { isWorkingState } from '../../lib/thread-status';
import { formatDuration } from '../../lib/time';
import { Alert, Button } from '../ui/primitives';
import { ForkIcon } from '../ui/icons';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { threadTitle } from '../../lib/thread-status';
import { ArtifactRow, DeliveredFiles } from '../workspace/ArtifactsRegion';
import { requestsArtifact } from '../../lib/artifacts';
import { hasArtifactBlock, hasDeliveredFileLink, requestedArtifactKind, synthesizeSpec } from '@shared/generated-artifacts';
import { GeneratedArtifact } from './GeneratedArtifact';
import { ChatHeader } from './ChatHeader';
import { Composer } from './Composer';
import { DetailsPanel } from './DetailsPanel';
import { MessagesTimeline } from './MessagesTimeline';
import { PendingApprovalPanel } from './PendingApprovalPanel';
import { PendingQuestionPanel } from './PendingQuestionPanel';
import { AgentSetupNotice } from './AgentSetupNotice';
import { Mem0OfflineNotice } from './Mem0OfflineNotice';
import { PlanResults, runLabel } from './PlanCard';
import { cn } from '../../lib/cn';
import { ThreadDetailsFloat } from './ThreadDetailsCard';
import { MessageActions } from './MessageActions';
import { useElementHeight } from '../../hooks/useElementHeight';
import { WorkBoard } from './WorkBoard';
import { agentLabel, formatCost, outputRate, usageBreakdown } from '../../lib/usage-format';
import { WorkingIndicator } from './WorkingIndicator';

// The main surface: a thread header, a centred message
// timeline, and the composer docked at the bottom, with an optional details
// panel on the right. With no thread selected it shows the Work board (the
// composer over every thread as cards); with no project it prompts to add one.

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
    // One quiet row while the agent works: three pulsing dots and the elapsed
    // time. What it is doing is already listed in the steps above.
    const label = task.state === 'VERIFYING' ? 'Verifying' : 'Working';
    const runningSteps = details?.steps.filter((step) => step.status === 'running') ?? [];
    const source = runningSteps.length > 1 ? `${runningSteps.length} agents` : undefined;
    const elapsed = Math.max(0, now - Date.parse(task.createdAt));
    return (
      <WorkingIndicator label={label} elapsed={formatDuration(elapsed)} detail={source} />
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
  // Completed and failed turns speak through their reply, errors, artifacts
  // and the stats line — no separate verification banner.
  if (task.state === 'CANCELLED') return <p className="px-1 text-xs text-muted-foreground">Stopped.</p>;
  return null;
}

/** One message in the thread: the user's request, the agent's work and reply, and its status. */
function Turn({ task, isLatest, onDetails, onLoaded, previousRun, onRun, onFork }: {
  task: Task; isLatest: boolean; onDetails?: (() => void) | undefined; onLoaded: () => void;
  /** Start a new thread from this message; absent for read-only history. */
  onFork?: (() => void) | undefined;
  /** The previous turn's CLI/model, so a switch between turns shows a handoff divider like chat. */
  previousRun?: TurnRun | undefined;
  onRun?: ((taskId: string, run: TurnRun) => void) | undefined;
}): React.JSX.Element {
  const { details, loading, error, refresh } = useTaskDetails(task);
  // A plan's tasks run in parallel, so their output is shown per task in the
  // plan card; the main timeline keeps the message and task-level events.
  // A step's agent/model fallback is shown on that task's row and in the
  // pinned plan summary, where it says which task it happened to.
  const planned = details?.plan != null;
  const ownRun = useMemo(() => turnRun(details !== null && planned ? null : details), [details, planned]);
  useEffect(() => {
    if (ownRun !== undefined) onRun?.(task.id, ownRun);
  }, [ownRun, onRun, task.id]);
  const items = useMemo(() => {
    const built = buildTimeline(task, details !== null && planned
      ? { ...details, events: details.events.filter((e) => e.stepId === undefined || e.kind === 'transition') }
      : details);
    // Between-turn switch (e.g. Muse → DeepSeek in the composer): show the
    // handoff divider right after the user's message, as chat threads do.
    const handoff = betweenTurnHandoff(`handoff:${task.id}`, previousRun, ownRun, (id) => agentLabel(id), built, task.createdAt);
    return handoff === null ? built : [built[0]!, handoff, ...built.slice(1)];
  }, [task, details, planned, previousRun, ownRun]);
  const live = isWorkingState(task.state);
  const total = details?.usage?.total;
  const startedAt = Date.parse(task.createdAt);
  const endedAt = Date.parse(task.updatedAt);
  const durationMs = Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, endedAt - startedAt) : undefined;
  const rate = total !== null && total !== undefined ? outputRate(total, durationMs) : undefined;
  useLayoutEffect(() => { onLoaded(); }, [items, task.state, onLoaded]);
  const replyText = items.filter((item) => item.kind === 'assistant').map((item) => item.text).join('\n\n').trim();
  const requestedKind = requestedArtifactKind(task.objective);
  // A generated file is already in the chat when the agent emitted an
  // artifact block, or when the fallback below builds one from plain text.
  // The backend's stored output copy ("Document") would only duplicate it.
  const generatedInChat = !live && replyText !== '' && (hasArtifactBlock(replyText) || (requestedKind !== null && !hasDeliveredFileLink(replyText)));
  return (
    <section aria-label={`Message: ${task.objective.slice(0, 60)}`} className="group/turn flex flex-col gap-5">
      {error !== null ? <Alert action={<Button size="xs" variant="ghost" onClick={refresh}>Retry details</Button>}>{error}</Alert> : null}
      <MessagesTimeline items={items} live={live} />
      {!live && replyText !== '' && requestedKind !== null && !hasArtifactBlock(replyText) && !hasDeliveredFileLink(replyText)
        ? <GeneratedArtifact spec={synthesizeSpec(requestedKind, task.objective, replyText)} />
        : null}
      {/* Files the agent handed back on purpose always show; the stored copy
          of its output only when the request asked for a document. */}
      {details !== null ? <DeliveredFiles taskId={task.id} artifacts={details.artifacts} /> : null}
      {details !== null && details.artifacts.some((artifact) => artifact.delivered !== true) && requestsArtifact(task.objective) && !generatedInChat && !details.artifacts.some((artifact) => artifact.delivered === true) ? (
        <ul className="flex flex-col gap-2" aria-label="Documents from the agent">
          {details.artifacts.filter((artifact) => artifact.delivered !== true).map((artifact) => <ArtifactRow key={artifact.id} taskId={task.id} artifact={artifact} />)}
        </ul>
      ) : null}
      {details !== null && planned ? <PlanResults task={task} details={details} /> : null}
      {loading && details === null && !live ? <p role="status" className="px-1 text-xs text-muted-foreground">Loading task details…</p> : null}
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
      {!live ? (
        <div className="-mt-3 flex items-center">
          <MessageActions text={replyText} at={task.updatedAt} onFork={onFork} className="group-hover/turn:opacity-100" />
          {!isLatest && onDetails !== undefined ? (
            <button type="button" onClick={onDetails} className="ms-auto cursor-pointer text-3xs text-muted-foreground opacity-0 transition-opacity group-hover/turn:opacity-100 hover:text-foreground focus-visible:opacity-100">Inspect this message</button>
          ) : null}
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
  // Each turn reports the CLI/model it ran with once its details load, so the
  // next turn can show a handoff divider when the user switched between turns.
  const [turnRuns, setTurnRuns] = useState<ReadonlyMap<string, TurnRun>>(new Map());
  const reportRun = useCallback((taskId: string, run: TurnRun) => {
    setTurnRuns((current) => {
      const existing = current.get(taskId);
      if (existing?.agentId === run.agentId && existing?.model === run.model) return current;
      return new Map(current).set(taskId, run);
    });
  }, []);
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
  const [dock, dockHeight] = useElementHeight<HTMLDivElement>();
  useLayoutEffect(() => { follow(); }, [dockHeight, follow]);
  const root = turns[0] ?? latest;
  const forkedFrom = isForkRoot(root) ? root.parentTaskId : undefined;

  return (
    <div className="thread-layout relative flex min-h-0 min-w-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <ChatHeader project={project} task={latest} title={turns[0] ?? latest} />
        {/* Inside the column so the compact (narrow-window) variant is in
            flow under the header; the floating variant positions itself
            against .thread-layout from here. */}
        {/* Wide windows: Floating details card (environment and
            subagents). Narrow ones keep the in-flow strip and the plan dock. */}
        {!detailsOpen ? <ThreadDetailsFloat task={latest} project={project} details={latestDetails} /> : null}
        <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scroller}
          onScroll={(event) => {
            const el = event.currentTarget;
            stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          }}
          // Room on the right for the floating details card, so it never covers the chat.
          className={cn('min-h-0 flex-1 overflow-y-auto', !detailsOpen && '@min-[60rem]:pr-[300px]')}
        >
          {/* Bottom padding keeps the last message clear of the floating composer. */}
          <div className="mx-auto flex w-full max-w-(--chat-max) flex-col gap-8 px-5 pt-6" style={{ paddingBottom: dockHeight + 24 }}>
            {forkedFrom !== undefined ? <ForkedHistory sourceId={forkedFrom} onLoaded={follow} depth={0} /> : null}
            {turns.map((turn, index) => (
              <Turn
                key={turn.id}
                task={turn}
                isLatest={index === turns.length - 1}
                onLoaded={follow}
                onDetails={() => { useTaskStore.getState().focus(turn.id); openDetails('files'); }}
                onFork={() => { useUiStore.getState().setForkFrom(turn.id); }}
                previousRun={index > 0 ? turnRuns.get(turns[index - 1]!.id) : undefined}
                onRun={reportRun}
              />
            ))}
          </div>
        </div>
        {/* The composer floats over the end of the conversation; messages
            scroll underneath it, blurred by its glass. */}
        <div ref={dock} className={cn('pointer-events-none absolute inset-x-0 bottom-0 px-5 [&>*]:pointer-events-auto', !detailsOpen && '@min-[60rem]:pr-[320px]')}>
          <AgentSetupNotice />
          <Mem0OfflineNotice />
          <PendingApprovalPanel task={latest} />
          <PendingQuestionPanel scopeId={latest.id} />
          <Composer task={latest} currentAgentId={[...(latestDetails?.steps ?? [])].reverse().find((s) => s.assignedAdapterId !== undefined)?.assignedAdapterId} />
        </div>
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

/** A fork's first message follows on from a message in another thread. */
function isForkRoot(task: Task): boolean {
  return task.parentTaskId !== undefined && task.threadId === task.id;
}

/** The source thread's messages up to and including `sourceId`, loading them if needed. */
function useConversationUpTo(sourceId: string): { source: Task | undefined; turns: Task[] } {
  const tasks = useTaskStore((s) => s.tasks);
  const source = tasks[sourceId];
  const key = source !== undefined ? threadKey(source) : null;
  useEffect(() => {
    if (source !== undefined) return;
    void window.conductor.task.get(sourceId).then((task) => { useTaskStore.getState().upsert(task); }).catch(() => undefined);
  }, [source, sourceId]);
  useEffect(() => {
    if (key === null) return;
    let active = true;
    void window.conductor.task.thread(key).then((list) => { if (active) useTaskStore.getState().setTasks(list); }).catch(() => undefined);
    return () => { active = false; };
  }, [key]);
  const turns = useMemo(() => (source === undefined || key === null ? [] : threadTasks(tasks, key)
    .filter((t) => t.createdAt < source.createdAt || t.id === source.id)), [tasks, key, source]);
  return { source, turns };
}

/** What a fork carries over: the source conversation, then a divider naming it. */
function ForkedHistory({ sourceId, onLoaded, depth }: { sourceId: string; onLoaded: () => void; depth: number }): React.JSX.Element | null {
  const { source, turns } = useConversationUpTo(sourceId);
  const navigate = useThreadNavigation();
  if (source === undefined) return null;
  const root = turns[0];
  const sourceRoot = root !== undefined && isForkRoot(root) && depth < 4 ? root.parentTaskId : undefined;
  return (
    <>
      {sourceRoot !== undefined ? <ForkedHistory sourceId={sourceRoot} onLoaded={onLoaded} depth={depth + 1} /> : null}
      {turns.map((turn) => <Turn key={turn.id} task={turn} isLatest={false} onLoaded={onLoaded} />)}
      {depth === 0 ? (
        <div className="flex items-center gap-3 text-xs text-muted-foreground" role="separator">
          <span className="h-px flex-1 bg-border" />
          <button type="button" onClick={() => { void navigate.openThread(source); }} className="flex cursor-pointer items-center gap-1.5 hover:text-foreground">
            <ForkIcon size={12} />Forked from {threadTitle(root ?? source)}
          </button>
          <span className="h-px flex-1 bg-border" />
        </div>
      ) : null}
    </>
  );
}

/** Forking a message: the conversation so far, and a composer that starts the new thread. */
function ForkDraft({ sourceId, project }: { sourceId: string; project: Workspace | undefined }): React.JSX.Element {
  const { source, turns } = useConversationUpTo(sourceId);
  const scroller = useRef<HTMLDivElement>(null);
  const [dock, dockHeight] = useElementHeight<HTMLDivElement>();
  const toBottom = useCallback(() => {
    const element = scroller.current;
    if (element !== null) element.scrollTop = element.scrollHeight;
  }, []);
  useLayoutEffect(() => { toBottom(); }, [dockHeight, turns.length, toBottom]);
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="window-header flex shrink-0 items-center gap-2 px-4">
        <ForkIcon size={14} className="shrink-0 text-muted-foreground" />
        <h1 className="min-w-0 truncate text-[13px] font-medium text-foreground">
          Fork of {turns[0] !== undefined ? threadTitle(turns[0]) : 'thread'}
        </h1>
        {project !== undefined ? <span className="shrink-0 text-xs text-muted-foreground">· {project.name}</span> : null}
        <Button size="sm" variant="ghost" className="ms-auto" onClick={() => { useUiStore.getState().setForkFrom(null); }}>Cancel</Button>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-(--chat-max) flex-col gap-8 px-5 pt-6" style={{ paddingBottom: dockHeight + 24 }}>
            {turns[0] !== undefined && isForkRoot(turns[0]) ? <ForkedHistory sourceId={turns[0].parentTaskId!} onLoaded={toBottom} depth={1} /> : null}
            {turns.map((turn) => <Turn key={turn.id} task={turn} isLatest={false} onLoaded={toBottom} />)}
            <p className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span className="flex items-center gap-1.5"><ForkIcon size={12} />Your next message starts a new thread from here</span>
              <span className="h-px flex-1 bg-border" />
            </p>
          </div>
        </div>
        <div ref={dock} className="pointer-events-none absolute inset-x-0 bottom-0 px-5 [&>*]:pointer-events-auto">
          {source !== undefined ? <Composer task={null} fork={source} autoFocus /> : null}
        </div>
      </div>
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
  const forkFrom = useUiStore((s) => s.forkFrom);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {forkFrom !== null ? (
        <ForkDraft key={forkFrom} sourceId={forkFrom} project={workspaces.find((w) => w.id === useTaskStore.getState().tasks[forkFrom]?.workspaceId) ?? project} />
      ) : showThread ? (
        <Thread key={threadKey(task)} focused={task} project={project} />
      ) : (
        <WorkBoard />
      )}
    </div>
  );
}
