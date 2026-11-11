import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Workspace } from '@shared/domain';
import { useApprovalStore, useQuestionStore, useTaskStore, useThreadTierStore, useUiStore, useWorkspaceStore } from '../../stores';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { groupThreads, type ThreadView } from '../../lib/threads';
import {
  THREAD_TIER_LABELS, classifyThreadTier, formatSnoozeCountdown,
  type ThreadTierId, type ThreadTierInfo, type ThreadTierSignals,
} from '../../lib/thread-tiers';
import { threadStatus, threadTitle } from '../../lib/thread-status';
import { prNumberFromUrl, prPath } from '../../lib/pull-request';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { EntityIcon } from '../ui/EntityIcon';
import { CheckIcon, ClockIcon, FolderPlusIcon, PanelLeftIcon, PullRequestIcon, RotateIcon, TrashIcon } from '../ui/icons';
import { SnoozePickerDialog } from '../threads/SnoozePickerDialog';
import { DeleteThreadDialog } from '../threads/DeleteThreadDialog';
import { AgentSetupNotice } from './AgentSetupNotice';
import { Mem0OfflineNotice } from './Mem0OfflineNotice';
import { Composer } from './Composer';
import { useSandboxAgentStore } from '../../stores/sandbox-agent-store';

// The Work board: where Work opens. The composer sits on top, ready for a new
// thread, and under it every thread from every project is a card in one of
// four columns — what needs you, what agents are working on, what you have
// settled, and what you snoozed. One look answers "what is going on?" without
// expanding a tree; clicking a card opens that thread.

const COLUMNS: Array<{ id: ThreadTierId; empty: string; tone: string; dot: string }> = [
  { id: 'needs-attention', empty: 'Nothing is waiting on you.', tone: 'text-amber-600 dark:text-amber-300', dot: 'bg-amber-500 dark:bg-amber-300' },
  { id: 'working', empty: 'No agents are working.', tone: 'text-sky-600 dark:text-sky-300', dot: 'bg-sky-500 dark:bg-sky-300' },
  { id: 'settled', empty: 'Threads you mark as settled land here.', tone: 'text-emerald-600 dark:text-emerald-300', dot: 'bg-emerald-500 dark:bg-emerald-300' },
  { id: 'snoozed', empty: 'Snooze a thread to hide it until later.', tone: 'text-violet-600 dark:text-violet-300', dot: 'bg-violet-500 dark:bg-violet-300' },
];

/** Cards shown per column before "Show all". */
const COLUMN_LIMIT = 6;

interface BoardCard { thread: ThreadView; info: ThreadTierInfo; pendingApproval: boolean }

function ThreadCard({ card, project, showProject, onSnooze, onDelete }: {
  card: BoardCard;
  project: Workspace | undefined;
  showProject: boolean;
  onSnooze: () => void;
  onDelete: () => void;
}): React.JSX.Element {
  const { thread, info } = card;
  const navigate = useNavigate();
  const { openThread } = useThreadNavigation();
  const pref = useThreadTierStore((s) => s.prefs[thread.key]);
  const status = threadStatus(thread.latest, card.pendingApproval);
  const title = threadTitle(thread.root);
  const prNumber = thread.root.prNumber ?? prNumberFromUrl(thread.root.prUrl);
  const countdown = info.tier === 'snoozed' && pref?.snoozedUntil !== undefined ? formatSnoozeCountdown(pref.snoozedUntil) : null;
  const label = info.tier === 'needs-attention' ? info.attentionLabel
    : info.tier === 'snoozed' ? (countdown !== null ? `Wakes ${countdown}` : 'Snoozed')
      : info.tier === 'working' ? status.label : undefined;
  const action = 'flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring';
  return (
    <li className="group/card relative">
      <button
        type="button"
        onClick={() => {
          // Opening a woken snooze acknowledges it.
          if (info.attentionReason === 'snooze-woke') useThreadTierStore.getState().clear(thread.key);
          void openThread(thread.latest);
        }}
        title={thread.root.objective}
        className="flex w-full cursor-pointer flex-col gap-2 rounded-xl border border-border bg-card p-3 text-left transition-[border-color,box-shadow,transform] duration-150 hover:-translate-y-px hover:border-border-strong hover:shadow-lift focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
      >
        <span className="line-clamp-2 text-[13px] leading-snug font-medium break-words text-foreground">{title}</span>
        <span className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
          {showProject && project !== undefined ? (
            <span className="flex min-w-0 items-center gap-1.5">
              <EntityIcon icon={project.icon ?? null} name={project.name} kind="project" size={14} />
              <span className="truncate">{project.name}</span>
            </span>
          ) : null}
          {label !== undefined ? (
            <span className={cn('flex shrink-0 items-center gap-1 font-medium', info.tier === 'working' ? 'text-sky-600 dark:text-sky-300' : info.tier === 'snoozed' ? '' : status.colorClass)}>
              {info.tier === 'working' ? <span aria-hidden="true" className="eq-bars"><span /><span /><span /></span> : null}
              {label}
            </span>
          ) : null}
          <span className="ml-auto shrink-0 tabular-nums transition-opacity group-focus-within/card:opacity-0 group-hover/card:opacity-0">
            {thread.tasks.length > 1 ? `${thread.tasks.length} msgs, ` : ''}{relativeTime(thread.latest.updatedAt)}
          </span>
        </span>
      </button>
      <span className="pointer-events-none absolute right-2 bottom-2 flex items-center gap-0.5 rounded-lg bg-card opacity-0 transition-opacity group-focus-within/card:pointer-events-auto group-focus-within/card:opacity-100 group-hover/card:pointer-events-auto group-hover/card:opacity-100">
        {thread.root.prUrl !== undefined && prNumber !== null ? (
          <button type="button" className={cn(action, thread.root.prState === 'merged' ? 'text-violet-500' : thread.root.prState === 'closed' ? 'text-destructive' : 'text-success')} aria-label={`Open pull request #${prNumber}: ${title}`} title={`Pull request #${prNumber}`} onClick={() => { navigate(prPath(thread.root.workspaceId, prNumber)); }}>
            <PullRequestIcon size={13} />
          </button>
        ) : null}
        {info.tier !== 'settled' ? (
          <button type="button" className={action} aria-label={`Mark as settled: ${title}`} title="Mark as settled" onClick={() => { useThreadTierStore.getState().markSettled(thread.key, thread.latest.updatedAt); }}>
            <CheckIcon size={13} />
          </button>
        ) : null}
        {info.tier === 'snoozed' || info.tier === 'settled' ? (
          <button type="button" className={action} aria-label={info.tier === 'snoozed' ? `Wake: ${title}` : `Move back to Needs attention: ${title}`} title={info.tier === 'snoozed' ? 'Wake now' : 'Move back to Needs attention'} onClick={() => { useThreadTierStore.getState().clear(thread.key); }}>
            <RotateIcon size={13} />
          </button>
        ) : (
          <button type="button" className={action} aria-label={`Snooze: ${title}`} title="Snooze — choose when it wakes up" onClick={onSnooze}>
            <ClockIcon size={13} />
          </button>
        )}
        <button type="button" className={cn(action, 'hover:text-destructive-foreground')} aria-label={`Delete: ${title}`} title="Delete thread" onClick={onDelete}>
          <TrashIcon size={13} />
        </button>
      </span>
    </li>
  );
}

export function WorkBoard(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const tasks = useTaskStore((s) => s.tasks);
  const approvals = useApprovalStore((s) => s.pending);
  const questions = useQuestionStore((s) => s.pending);
  const prefs = useThreadTierStore((s) => s.prefs);
  const agentThreads = useSandboxAgentStore((s) => s.threads);
  const planMode = useUiStore((s) => s.planMode);
  const panelCollapsed = useUiStore((s) => s.panelCollapsed);
  const { selectProject } = useThreadNavigation();
  /** null shows every project; otherwise only that project's threads. */
  const [filter, setFilter] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Partial<Record<ThreadTierId, boolean>>>({});
  const [snoozing, setSnoozing] = useState<ThreadView | null>(null);
  const [deleting, setDeleting] = useState<ThreadView | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Snoozes wake and countdowns move without any other state change.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 30_000);
    return () => { window.clearInterval(timer); };
  }, []);

  const projects = useMemo(() => new Map(workspaces.map((workspace) => [workspace.id, workspace])), [workspaces]);
  const columns = useMemo(() => {
    const approvalIds = new Set(approvals.map((request) => request.taskId));
    const questionIds = new Set(questions.map((request) => request.taskId));
    const buckets = new Map<ThreadTierId, BoardCard[]>(COLUMNS.map((column) => [column.id, []]));
    for (const thread of groupThreads(Object.values(tasks))) {
      if (!projects.has(thread.root.workspaceId)) continue;
      // Agent conversations live in the Agents tab.
      if (agentThreads[thread.key] !== undefined) continue;
      if (filter !== null && thread.root.workspaceId !== filter) continue;
      const signals: ThreadTierSignals = {
        hasPendingApproval: thread.tasks.some((task) => approvalIds.has(task.id)),
        hasPendingQuestion: thread.tasks.some((task) => questionIds.has(task.id)),
      };
      const info = classifyThreadTier(thread, prefs[thread.key], signals, now);
      buckets.get(info.tier)!.push({ thread, info, pendingApproval: signals.hasPendingApproval });
    }
    return buckets;
  }, [tasks, approvals, questions, prefs, projects, filter, now, agentThreads]);
  const total = [...columns.values()].reduce((sum, cards) => sum + cards.length, 0);
  const activeProject = projects.get(activeWorkspaceId ?? '');
  const chip = 'flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring';

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-(--chat-max) shrink-0 px-5 pt-[clamp(1.5rem,7vh,4rem)] pb-8">
        <h1 className="mb-1.5 text-center font-display text-[26px] leading-tight font-semibold text-foreground">What should we build?</h1>
        <p className="mb-5 text-center text-[13px] text-muted-foreground">
          {activeProject !== undefined ? <>A new thread in <span className="font-medium text-foreground">{activeProject.name}</span>, or pick up one below.</> : 'Start a new thread, or pick up one below.'}
        </p>
        <AgentSetupNotice />
        <Mem0OfflineNotice />
        <Composer task={null} autoFocus variant="hero" />
        {planMode ? (
          <p className="mt-3 text-center text-2xs text-muted-foreground">
            Plan mode: the planner writes requirements and a task list to .conductor/plans, then each task runs on its agent. Tasks that don’t depend on each other run in parallel.
          </p>
        ) : null}
      </div>

      <section aria-label="Thread board" className="mx-auto flex w-full max-w-[88rem] flex-col gap-3 px-6 pb-10">
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Filter threads by project" className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto py-0.5 [scrollbar-width:none]">
            <button type="button" aria-pressed={filter === null} onClick={() => { setFilter(null); }} className={cn(chip, filter === null ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground')}>
              All projects
            </button>
            {workspaces.map((workspace) => (
              <button
                key={workspace.id}
                type="button"
                aria-pressed={filter === workspace.id}
                title={`Show only ${workspace.name}, and start new threads there`}
                onClick={() => { setFilter(workspace.id); void selectProject(workspace.id).catch(() => undefined); }}
                className={cn(chip, 'pl-1.5', filter === workspace.id ? 'border-transparent bg-foreground text-background' : 'border-border text-muted-foreground hover:text-foreground')}
              >
                <EntityIcon icon={workspace.icon ?? null} name={workspace.name} kind="project" size={16} />
                <span className="max-w-40 truncate">{workspace.name}</span>
              </button>
            ))}
            <button type="button" onClick={() => { useUiStore.getState().setAddProjectOpen(true); }} aria-label="Add project" title="Add project" className={cn(chip, 'border-dashed border-border-strong px-2 text-muted-foreground hover:text-foreground')}>
              <FolderPlusIcon size={13} />
            </button>
          </div>
          <button
            type="button"
            onClick={() => { useUiStore.getState().setPanelCollapsed(!panelCollapsed); }}
            aria-pressed={!panelCollapsed}
            title="Show threads as a list at the side (⌘B)"
            className={cn(chip, 'border-border text-muted-foreground hover:text-foreground', !panelCollapsed && 'bg-accent text-foreground')}
          >
            <PanelLeftIcon size={13} />List
          </button>
        </div>

        {total === 0 ? (
          <p className="rounded-xl border border-dashed border-border-strong px-4 py-8 text-center text-[13px] text-muted-foreground">
            No threads yet{filter !== null ? ' in this project' : ''}. Describe what you want above to start the first one.
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(4,minmax(13.5rem,1fr))] items-start gap-3 overflow-x-auto pb-1">
            {COLUMNS.map((column) => {
              const cards = columns.get(column.id) ?? [];
              const showAll = expanded[column.id] === true;
              const visible = showAll ? cards : cards.slice(0, COLUMN_LIMIT);
              return (
                <section key={column.id} aria-label={`${THREAD_TIER_LABELS[column.id]} threads`} className="flex min-w-0 flex-col gap-2 rounded-2xl bg-muted p-2">
                  <h2 className={cn('flex h-6 items-center gap-2 px-1.5 text-xs font-semibold', column.tone)}>
                    <span aria-hidden="true" className={cn('size-1.5 rounded-full', column.dot, column.id === 'working' && cards.length > 0 && 'animate-status-pulse')} />
                    <span className="flex-1">{THREAD_TIER_LABELS[column.id]}</span>
                    <span className="font-medium text-muted-foreground tabular-nums">{cards.length}</span>
                  </h2>
                  {cards.length === 0 ? (
                    <p className="px-1.5 pb-2 text-2xs leading-relaxed text-muted-foreground">{column.empty}</p>
                  ) : (
                    <ul className="flex flex-col gap-2">
                      {visible.map((card) => (
                        <ThreadCard
                          key={card.thread.key}
                          card={card}
                          project={projects.get(card.thread.root.workspaceId)}
                          showProject={filter === null && workspaces.length > 1}
                          onSnooze={() => { setSnoozing(card.thread); }}
                          onDelete={() => { setDeleting(card.thread); }}
                        />
                      ))}
                    </ul>
                  )}
                  {cards.length > COLUMN_LIMIT ? (
                    <button type="button" aria-expanded={showAll} onClick={() => { setExpanded((current) => ({ ...current, [column.id]: !showAll })); }} className="h-7 cursor-pointer rounded-lg text-2xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                      {showAll ? 'Show fewer' : `Show all ${cards.length}`}
                    </button>
                  ) : null}
                </section>
              );
            })}
          </div>
        )}
      </section>
      {snoozing !== null ? (
        <SnoozePickerDialog
          open
          onClose={() => { setSnoozing(null); }}
          onSnooze={(until) => { useThreadTierStore.getState().snooze(snoozing.key, snoozing.latest.updatedAt, until); }}
        />
      ) : null}
      {deleting !== null ? <DeleteThreadDialog thread={deleting} open onClose={() => { setDeleting(null); }} /> : null}
    </div>
  );
}
