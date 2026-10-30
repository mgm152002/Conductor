import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { ChatThread } from '@shared/chat-contract';
import type { Task, Workspace } from '@shared/domain';
import { NAV_ENTRIES, type NavEntryId } from '../navigation';
import { useApprovalStore, useQuestionStore, useTaskStore, useThreadTierStore, useUiStore, useWorkspaceStore } from '../stores';
import { isTerminalTask } from '../stores/task-store';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { pickFocusedTask } from './workspace/useFocusedTask';
import { threadStatus, threadTitle } from '../lib/thread-status';
import { relativeTime } from '../lib/time';
import { groupThreads, threadKey, type ThreadView } from '../lib/threads';
import {
  classifyThreadTier, defaultSnoozeUntil, groupThreadsByTier,
  type ThreadTierId, type ThreadTierInfo, type ThreadTierSignals,
} from '../lib/thread-tiers';
import { cn } from '../lib/cn';
import { Kbd } from './ui/primitives';
import { SuggestionsInbox } from './suggestions/SuggestionsInbox';
import {
  BrainIcon, CheckIcon, ChevronRightIcon, ClockIcon, LayersIcon, ListChecksIcon, PencilIcon, PlugIcon,
  PlusIcon, PullRequestIcon, RotateIcon, SettingsIcon, SparklesIcon, SquarePenIcon, TrashIcon, UsageIcon, WorkflowIcon,
} from './ui/icons';
import { DeleteProjectDialog } from './projects/DeleteProjectDialog';
import { ProjectPullRequestsDialog } from './projects/ProjectPullRequestsDialog';
import { DeleteChatDialog } from './threads/DeleteChatDialog';
import { DeleteThreadDialog } from './threads/DeleteThreadDialog';
import { RenameChatDialog } from './threads/RenameChatDialog';
import { RenameThreadDialog } from './threads/RenameThreadDialog';
import { SurfaceTabs } from './SurfaceTabs';
import { useChatStore } from '../stores/chat-store';

// The left sidebar, laid out like T3 Code: a draggable title-bar strip, a
// "New thread" action, projects as collapsible groups with their threads
// (tasks) and live status pills, and the secondary destinations at the bottom.

const NAV_ICONS: Partial<Record<NavEntryId, (p: { size?: number }) => React.JSX.Element>> = {
  projects: LayersIcon,
  'active-tasks': ListChecksIcon,
  learning: BrainIcon,
  workflows: WorkflowIcon,
  skills: SparklesIcon,
  'connected-apps': PlugIcon,
  memory: BrainIcon,
  usage: UsageIcon,
  settings: SettingsIcon,
};

const NAV_LABELS: Partial<Record<NavEntryId, string>> = {
  'connected-apps': 'Connections',
};

const ATTENTION_PILL_CLASSES: Record<string, { text: string; dot: string }> = {
  question: { text: 'text-amber-600 dark:text-amber-300/90', dot: 'bg-amber-500 dark:bg-amber-300/90' },
  approval: { text: 'text-amber-600 dark:text-amber-300/90', dot: 'bg-amber-500 dark:bg-amber-300/90' },
  completed: { text: 'text-emerald-600 dark:text-emerald-300/90', dot: 'bg-emerald-500 dark:bg-emerald-300/90' },
  failed: { text: 'text-red-600 dark:text-red-300/90', dot: 'bg-red-500 dark:bg-red-300/90' },
  blocked: { text: 'text-orange-600 dark:text-orange-300/90', dot: 'bg-orange-500 dark:bg-orange-300/90' },
  interrupted: { text: 'text-violet-600 dark:text-violet-300/90', dot: 'bg-violet-500 dark:bg-violet-300/90' },
  'snooze-woke': { text: 'text-violet-600 dark:text-violet-300/90', dot: 'bg-violet-500 dark:bg-violet-300/90' },
};

function ThreadRow({ thread, selected, pendingApproval, tierInfo, snoozedUntil, onOpen, onRename, onDelete, onMarkSettled, onSnooze, onClearTier }: {
  thread: ThreadView;
  selected: boolean;
  pendingApproval: boolean;
  tierInfo: ThreadTierInfo;
  snoozedUntil?: string | undefined;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
  onMarkSettled: () => void;
  onSnooze: () => void;
  onClearTier: () => void;
}): React.JSX.Element {
  const task = thread.latest;
  const status = threadStatus(task, pendingApproval);
  const title = threadTitle(thread.root);
  const attentionPill = tierInfo.tier === 'needs-attention' && tierInfo.attentionReason !== undefined
    ? ATTENTION_PILL_CLASSES[tierInfo.attentionReason]
    : undefined;
  const showPill = attentionPill !== undefined || tierInfo.tier === 'snoozed' || status.active || task.state === 'FAILED';
  return (
    <li
      className={cn(
        'group/thread relative flex items-center rounded-lg transition-colors',
        'focus-within:bg-sidebar-row-hover',
        selected ? 'bg-sidebar-row-active text-sidebar-foreground shadow-xs dark:shadow-none' : 'text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
        title={thread.root.objective}
        className="flex min-w-0 flex-1 cursor-pointer flex-col gap-px rounded-lg py-1.5 pr-2 pl-3 text-left transition-[padding] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring group-hover/thread:pr-28 group-focus-within/thread:pr-28"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-[13px] leading-tight">{title}</span>
          {showPill ? (
            <span className={cn('flex shrink-0 items-center gap-1 text-3xs font-medium transition-opacity group-hover/thread:opacity-0 group-focus-within/thread:opacity-0', attentionPill?.text ?? status.colorClass)}>
              <span className={cn('size-1.5 rounded-full', attentionPill?.dot ?? status.dotClass, status.pulse && tierInfo.tier !== 'snoozed' && 'animate-status-pulse')} />
              {tierInfo.tier === 'needs-attention' ? tierInfo.attentionLabel : tierInfo.tier === 'snoozed' ? 'Snoozed' : status.label}
            </span>
          ) : (
            <span className="shrink-0 text-3xs text-sidebar-muted-foreground/70 tabular-nums transition-opacity group-hover/thread:opacity-0 group-focus-within/thread:opacity-0">{relativeTime(task.updatedAt)}</span>
          )}
        </span>
        <span className={cn('flex w-full min-w-0 items-center gap-1.5 text-3xs text-sidebar-muted-foreground/80', thread.root.prUrl !== undefined && 'pr-7')}>
          <span className="truncate font-mono">{`conductor/${thread.key.slice(0, 8)}`}</span>
          {thread.tasks.length > 1 ? <span className="shrink-0 tabular-nums" title={`${thread.tasks.length} messages`}>· {thread.tasks.length} messages</span> : null}
          {tierInfo.tier === 'snoozed' && snoozedUntil !== undefined ? <span className="shrink-0 truncate">· wakes {new Date(snoozedUntil).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span> : null}
        </span>
      </button>
      {thread.root.prUrl !== undefined ? (
        <button
          type="button"
          onClick={() => { void window.conductor.github.openPr(thread.root.prUrl!).catch(() => undefined); }}
          aria-label={`Open pull request ${thread.root.prNumber !== undefined ? `#${thread.root.prNumber} ` : ''}for thread: ${threadTitle(thread.root)}`}
          title={`Pull request${thread.root.prNumber !== undefined ? ` #${thread.root.prNumber}` : ''}${thread.root.prState !== undefined ? ` · ${thread.root.prState}` : ''} — open on GitHub`}
          className={cn(
            'absolute right-1 bottom-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring',
            thread.root.prState === 'merged' ? 'text-violet-500' : thread.root.prState === 'closed' ? 'text-destructive' : 'text-success',
          )}
        >
          <PullRequestIcon size={13} />
        </button>
      ) : null}
      {/* Hover actions overlay the row instead of reserving layout space, so
          titles/timestamps use the full row width when they are hidden. */}
      <span className="pointer-events-none absolute top-1 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100">
        {tierInfo.tier !== 'settled' ? (
          <button
            type="button"
            onClick={onMarkSettled}
            aria-label={`Mark thread as settled: ${title}`}
            title="Mark as settled"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <CheckIcon size={12} />
          </button>
        ) : null}
        {tierInfo.tier === 'snoozed' || tierInfo.tier === 'settled' ? (
          <button
            type="button"
            onClick={onClearTier}
            aria-label={tierInfo.tier === 'snoozed' ? `Wake thread: ${title}` : `Move thread back to Needs attention: ${title}`}
            title={tierInfo.tier === 'snoozed' ? 'Wake now' : 'Move back to Needs attention'}
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <RotateIcon size={12} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSnooze}
            aria-label={`Snooze thread until tomorrow: ${title}`}
            title="Snooze until tomorrow 9:00 AM"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ClockIcon size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onRename}
          aria-label={`Rename thread: ${title}`}
          title="Rename thread"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <PencilIcon size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete thread: ${threadTitle(thread.root)}`}
          title="Delete thread"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TrashIcon size={12} />
        </button>
      </span>
    </li>
  );
}

function ProjectGroup({ project, active, tasks, focusedKey, pendingTaskIds, pendingQuestionTaskIds, query = '', onNavigate }: {
  project: Workspace;
  active: boolean;
  tasks: Task[];
  focusedKey: string | null;
  pendingTaskIds: ReadonlySet<string>;
  pendingQuestionTaskIds: ReadonlySet<string>;
  query?: string;
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const collapsed = useUiStore((s) => s.collapsedProjects[project.id] === true) && query === '';
  const toggle = useUiStore((s) => s.toggleProject);
  const tierPrefs = useThreadTierStore((s) => s.prefs);
  const { openThread, newThread } = useThreadNavigation();
  // Working starts open; Settled and Snoozed start hidden behind their
  // collapsible headers. Needs attention has no header toggle — it is first
  // and always shown. Searching or opening a thread forces its tier open.
  const [collapsedTiers, setCollapsedTiers] = useState<Partial<Record<ThreadTierId, boolean>>>({ settled: true, snoozed: true });
  const [now, setNow] = useState(() => Date.now());
  const [deleting, setDeleting] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [prCount, setPrCount] = useState(0);
  const [deletingThread, setDeletingThread] = useState<ThreadView | null>(null);
  const [renamingThread, setRenamingThread] = useState<ThreadView | null>(null);
  // Locally recorded PR count for the header badge; the dialog syncs the
  // repository's full list from GitHub when opened.
  useEffect(() => {
    let active = true;
    void window.conductor.github.listPrs(project.id)
      .then((list) => { if (active) setPrCount(list.filter((pr) => pr.state === 'open').length); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [project.id]);
  // Re-evaluate tiers once a minute so an expiring snooze wakes up on its
  // own instead of waiting for the next task event.
  useEffect(() => {
    const timer = window.setInterval(() => { setNow(Date.now()); }, 60_000);
    return () => { window.clearInterval(timer); };
  }, []);
  const allThreads = useMemo(() => groupThreads(tasks), [tasks]);
  const threads = query === '' ? allThreads : allThreads.filter((t) => threadTitle(t.root).toLowerCase().includes(query));
  const signalsFor = (thread: ThreadView): ThreadTierSignals => ({
    hasPendingApproval: thread.tasks.some((task) => pendingTaskIds.has(task.id)),
    hasPendingQuestion: thread.tasks.some((task) => pendingQuestionTaskIds.has(task.id)),
  });
  const tierGroups = useMemo(
    () => groupThreadsByTier(threads, tierPrefs, signalsFor, now),
    // signalsFor is derived from the two id sets below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [threads, tierPrefs, pendingTaskIds, pendingQuestionTaskIds, now],
  );
  if (query !== '' && threads.length === 0) return <></>;
  const working = tierGroups.find((group) => group.id === 'working')?.threads.length ?? 0;
  const needsAttention = tierGroups.find((group) => group.id === 'needs-attention')?.threads.length ?? 0;

  return (
    <li className="flex flex-col">
      <div className={cn('group flex h-8 items-center rounded-md pr-1 transition-colors hover:bg-sidebar-row-hover')}>
        <button
          type="button"
          onClick={() => { toggle(project.id); }}
          aria-expanded={!collapsed}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pl-1.5 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          title={project.rootPath}
        >
          <ChevronRightIcon size={12} className={cn('shrink-0 text-sidebar-muted-foreground transition-transform duration-150', !collapsed && 'rotate-90')} />
          <span aria-hidden="true" className={cn('flex size-5 shrink-0 items-center justify-center rounded-md text-3xs font-bold tracking-wide', active ? 'bg-primary/20 text-primary' : 'bg-sidebar-row-active text-sidebar-muted-foreground')}>{project.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'P'}</span>
          <span className={cn('min-w-0 flex-1 truncate font-medium', active ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85')}>{project.name}</span>
          {needsAttention > 0 ? <span title={`${needsAttention} need${needsAttention === 1 ? 's' : ''} attention`} className="shrink-0 rounded-full bg-amber-500/15 px-1.5 text-3xs font-medium text-amber-600 tabular-nums dark:text-amber-300">{needsAttention}</span> : null}
          {working > 0 ? <span title={`${working} working`} className="shrink-0 rounded-full bg-sky-500/12 px-1.5 text-3xs font-medium text-sky-600 tabular-nums dark:text-sky-300">{working}</span> : null}
        </button>
        <button
          type="button"
          onClick={() => { setPrsOpen(true); }}
          aria-label={`Pull requests for ${project.name}`}
          title={`Pull requests for ${project.name}`}
          className="flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <PullRequestIcon size={13} />
          {prCount > 0 ? <span className="text-3xs font-medium tabular-nums">{prCount}</span> : null}
        </button>
        <button
          type="button"
          onClick={() => { void newThread(project.id); }}
          aria-label={`New thread in ${project.name}`}
          title="New thread"
          className="ml-1 flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SquarePenIcon size={13} />
        </button>
        <button
          type="button"
          onClick={() => { setDeleting(true); }}
          aria-label={`Delete ${project.name}`}
          title="Delete project"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TrashIcon size={13} />
        </button>
      </div>
      <DeleteProjectDialog project={project} open={deleting} onClose={() => { setDeleting(false); }} />
      {prsOpen ? <ProjectPullRequestsDialog project={project} open onClose={() => { setPrsOpen(false); void window.conductor.github.listPrs(project.id).then((list) => { setPrCount(list.filter((pr) => pr.state === 'open').length); }).catch(() => undefined); }} /> : null}
      {deletingThread !== null ? <DeleteThreadDialog thread={deletingThread} open onClose={() => { setDeletingThread(null); }} /> : null}
      {renamingThread !== null ? <RenameThreadDialog key={renamingThread.key} threadId={renamingThread.key} currentTitle={threadTitle(renamingThread.root)} open onClose={() => { setRenamingThread(null); }} /> : null}
      {!collapsed ? (
        threads.length === 0 ? (
          <p className="py-1 pl-7 text-2xs text-sidebar-muted-foreground/70">No threads yet</p>
        ) : (
          <div className="flex flex-col pb-1">
            {tierGroups.map((group) => {
              const isAttention = group.id === 'needs-attention';
              const containsFocused = focusedKey !== null && group.threads.some((thread) => thread.key === focusedKey);
              const tierCollapsed = !isAttention && query === '' && !containsFocused && collapsedTiers[group.id] === true;
              return (
                <section key={group.id} aria-label={`${group.label} threads in ${project.name}`} className="flex flex-col">
                  {isAttention ? (
                    <h3 className="flex h-6 items-center gap-1.5 pr-1 pl-7 text-2xs font-medium tracking-wide text-amber-600 uppercase dark:text-amber-300/90">
                      <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90" />
                      <span className="flex-1">{group.label}</span>
                      <span className="tabular-nums">{group.threads.length}</span>
                    </h3>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setCollapsedTiers((current) => ({ ...current, [group.id]: !(current[group.id] ?? group.id !== 'working') })); }}
                      aria-expanded={!tierCollapsed}
                      aria-label={`${group.label} threads in ${project.name}`}
                      className="flex h-6 w-full cursor-pointer items-center gap-1.5 rounded-md pr-1 pl-6 text-left text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
                    >
                      <ChevronRightIcon size={11} className={cn('shrink-0 transition-transform duration-150', !tierCollapsed && 'rotate-90')} />
                      <span className="flex-1">{group.label}</span>
                      <span className="tabular-nums">{group.threads.length}</span>
                    </button>
                  )}
                  {!tierCollapsed ? (
                    <ul className="flex flex-col gap-px pl-6">
                      {group.threads.map((thread) => {
                        const tierInfo = classifyThreadTier(thread, tierPrefs[thread.key], signalsFor(thread), now);
                        const pref = tierPrefs[thread.key];
                        return (
                          <ThreadRow
                            key={thread.key}
                            thread={thread}
                            selected={focusedKey === thread.key}
                            pendingApproval={pendingTaskIds.has(thread.latest.id) || thread.tasks.some((task) => pendingTaskIds.has(task.id))}
                            tierInfo={tierInfo}
                            snoozedUntil={pref?.mode === 'snoozed' ? pref.snoozedUntil : undefined}
                            onOpen={() => {
                              // Opening a woken snooze acknowledges it; it then
                              // falls back to the tier its state dictates.
                              if (tierInfo.attentionReason === 'snooze-woke') useThreadTierStore.getState().clear(thread.key);
                              void openThread(thread.latest);
                              onNavigate?.();
                            }}
                            onRename={() => { setRenamingThread(thread); }}
                            onDelete={() => { setDeletingThread(thread); }}
                            onMarkSettled={() => { useThreadTierStore.getState().markSettled(thread.key, thread.latest.updatedAt); }}
                            onSnooze={() => { useThreadTierStore.getState().snooze(thread.key, thread.latest.updatedAt, defaultSnoozeUntil()); }}
                            onClearTier={() => { useThreadTierStore.getState().clear(thread.key); }}
                          />
                        );
                      })}
                    </ul>
                  ) : null}
                </section>
              );
            })}
          </div>
        )
      ) : null}
    </li>
  );
}

function ChatHistory({ query = '', onNavigate }: { query?: string; onNavigate?: (() => void) | undefined }): React.JSX.Element {
  const allThreads = useChatStore((state) => state.threads);
  const threads = query === '' ? allThreads : allThreads.filter((t) => t.title.toLowerCase().includes(query));
  const selectedId = useChatStore((state) => state.selectedId);
  const [error, setError] = useState<string | null>(null);
  const [deletingThread, setDeletingThread] = useState<ChatThread | null>(null);
  const [renamingThread, setRenamingThread] = useState<ChatThread | null>(null);
  const load = (): void => {
    setError(null);
    void window.conductor.chat.list().then((list) => { useChatStore.getState().setThreads(list); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not load chats'); });
  };
  useEffect(load, []);
  // The dialog closes both after a successful delete and after a cancel. Reload
  // only when the store no longer holds the thread, so a cancel stays untouched.
  const closeDelete = (): void => {
    const thread = deletingThread;
    setDeletingThread(null);
    if (thread !== null && !useChatStore.getState().threads.some((item) => item.id === thread.id)) load();
  };
  return <>
    <h2 className="px-1.5 py-2 text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase">Chats</h2>
    {error ? <p role="alert" className="px-2 text-xs text-destructive-foreground">{error} <button type="button" className="underline" onClick={load}>Retry</button></p> : null}
    {threads.length === 0 ? <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">Your conversations will appear here.</p> : <ul className="flex flex-col gap-1">{threads.map((thread) => <li key={thread.id} className={cn('group/chat relative flex h-8 items-center rounded-md transition-colors focus-within:bg-sidebar-row-hover', selectedId === thread.id ? 'bg-sidebar-row-active' : 'hover:bg-sidebar-row-hover')}>
      <button type="button" title={thread.title} aria-current={selectedId === thread.id ? 'page' : undefined} onClick={() => { useChatStore.getState().select(thread.id); onNavigate?.(); }} className="flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-md px-2 text-left text-[13px] transition-[padding] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring group-hover/chat:pr-14 group-focus-within/chat:pr-14">
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      </button>
      <span className="pointer-events-none absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-0 transition-opacity group-hover/chat:pointer-events-auto group-hover/chat:opacity-100 group-focus-within/chat:pointer-events-auto group-focus-within/chat:opacity-100">
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); setRenamingThread(thread); }}
          aria-label={`Rename chat: ${thread.title}`}
          title="Rename chat"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <PencilIcon size={12} />
        </button>
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); setDeletingThread(thread); }}
          aria-label={`Delete chat: ${thread.title}`}
          title="Delete chat"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TrashIcon size={12} />
        </button>
      </span>
    </li>)}</ul>}
    {deletingThread !== null ? <DeleteChatDialog thread={deletingThread} open onClose={closeDelete} /> : null}
    {renamingThread !== null ? <RenameChatDialog key={renamingThread.id} thread={renamingThread} open onClose={() => { setRenamingThread(null); }} /> : null}
  </>;
}

export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const tasks = useTaskStore((s) => s.tasks);
  const focusedTaskId = useTaskStore((s) => s.focusedTaskId);
  const pending = useApprovalStore((s) => s.pending);
  const pendingQuestions = useQuestionStore((s) => s.pending);
  const draft = useUiStore((s) => s.draft);
  const setAddProjectOpen = useUiStore((s) => s.setAddProjectOpen);
  const { newThread } = useThreadNavigation();
  const location = useLocation();
  const onHome = location.pathname === '/home';

  // Every project's recent threads appear in the sidebar, not just the active
  // project's, so load each project's history once its id is known.
  const workspaceKey = workspaces.map((w) => w.id).join(',');
  useEffect(() => {
    let cancelled = false;
    for (const workspace of workspaces) {
      void window.conductor.task.list({ workspaceId: workspace.id, limit: 50 }).then((list) => {
        if (!cancelled) useTaskStore.getState().setTasks(list);
      }).catch(() => { /* surfaced by the main data pump */ });
    }
    return () => { cancelled = true; };
    // Keyed by the id list so renames don't refetch every project's history.
  }, [workspaceKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const byProject = useMemo(() => {
    const groups = new Map<string, Task[]>();
    for (const task of Object.values(tasks)) {
      const list = groups.get(task.workspaceId) ?? [];
      list.push(task);
      groups.set(task.workspaceId, list);
    }
    for (const list of groups.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    return groups;
  }, [tasks]);

  const pendingTaskIds = useMemo(() => new Set(pending.map((request) => request.taskId)), [pending]);
  const pendingQuestionTaskIds = useMemo(() => new Set(pendingQuestions.map((request) => request.taskId)), [pendingQuestions]);
  const activeCount = Object.values(tasks).filter((task) => !isTerminalTask(task)).length;
  // The focused thread is only highlighted while it is what the chat shows.
  const focusedTask = pickFocusedTask(tasks, focusedTaskId, activeWorkspaceId);
  const focusedKey = location.pathname === '/work' && !draft && focusedTask !== null ? threadKey(focusedTask) : null;
  const selectedChat = useChatStore((state) => state.selectedId);
  const [query, setQuery] = useState('');

  return (
    <nav aria-label="Primary" className="flex h-full w-[268px] shrink-0 flex-col bg-sidebar text-sidebar-foreground">
      {/* Title-bar strip: leaves room for the macOS traffic lights. */}
      <div className="app-drag flex h-(--topbar-height) shrink-0 items-center justify-between pr-2 pl-20">
        <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground/90">Conductor</span>
        <SuggestionsInbox />
      </div>

      <div className="px-3 pb-2">
        <label className="flex h-8 items-center gap-2 rounded-lg bg-white/4 px-2.5 text-sidebar-muted-foreground ring-1 ring-sidebar-border transition-colors focus-within:bg-white/6 focus-within:text-sidebar-foreground dark:bg-white/4">
          <span aria-hidden="true" className="text-[13px]">⌕</span>
          <span className="sr-only">Search threads</span>
          <input value={query} onChange={(event) => { setQuery(event.target.value.toLowerCase()); }} placeholder="Search" className="min-w-0 flex-1 bg-transparent text-[13px] text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground" />
          {query !== '' ? <button type="button" onClick={() => { setQuery(''); }} aria-label="Clear search" className="cursor-pointer text-xs hover:text-sidebar-foreground">✕</button> : null}
        </label>
      </div>

      <SurfaceTabs />

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => { if (onHome) useChatStore.getState().select(null); else void newThread(); onNavigate?.(); }}
          className={cn(
            'flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground/90 transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground',
            'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
            (onHome ? selectedChat === null : location.pathname === '/work' && draft) && 'bg-sidebar-row-active',
          )}
        >
          <SquarePenIcon size={14} className="text-sidebar-muted-foreground" />
          <span className="flex-1 text-left">{onHome ? 'New chat' : 'New thread'}</span>
          <Kbd>⌘N</Kbd>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {onHome ? <ChatHistory query={query} onNavigate={onNavigate} /> : <>
        <div className="flex h-7 items-center justify-between px-1.5">
          <span className="text-2xs font-medium tracking-wide text-sidebar-muted-foreground uppercase">Projects</span>
          <button
            type="button"
            onClick={() => { setAddProjectOpen(true); }}
            aria-label="Add project"
            title="Add project"
            className="flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
          >
            <PlusIcon size={14} />
          </button>
        </div>
        {workspaces.length === 0 ? (
          <button type="button" onClick={() => { setAddProjectOpen(true); }} className="mt-1 flex w-full cursor-pointer flex-col items-start gap-1 rounded-lg border border-dashed border-sidebar-border px-3 py-3 text-left hover:bg-sidebar-row-hover">
            <span className="text-xs font-medium text-sidebar-foreground">Add your first project</span>
            <span className="text-2xs text-sidebar-muted-foreground">Pick a folder for agents to work in.</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {workspaces.map((project) => (
              <ProjectGroup
                key={project.id}
                project={project}
                active={project.id === activeWorkspaceId}
                tasks={byProject.get(project.id) ?? []}
                focusedKey={focusedKey}
                pendingTaskIds={pendingTaskIds}
                pendingQuestionTaskIds={pendingQuestionTaskIds}
                query={query}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
        </>}
      </div>

      <p className="shrink-0 px-4 pt-2 text-2xs text-sidebar-muted-foreground/80">Settled · local-first</p>
      <ul className="flex shrink-0 flex-col gap-px p-2">
        {NAV_ENTRIES.filter((entry) => entry.id !== 'home' && (!onHome || entry.id === 'settings' || entry.id === 'connected-apps')).map((entry) => {
          const Icon = NAV_ICONS[entry.id];
          return (
            <li key={entry.id}>
              <NavLink
                to={entry.path}
                onClick={onNavigate}
                className={({ isActive }) => cn(
                  'flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                  isActive ? 'bg-sidebar-row-active text-sidebar-foreground' : 'text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground',
                )}
              >
                {Icon !== undefined ? <Icon size={14} /> : null}
                <span className="flex-1">{NAV_LABELS[entry.id] ?? entry.label}</span>
                {entry.id === 'active-tasks' && activeCount > 0 ? <span className="text-3xs text-sidebar-muted-foreground tabular-nums">{activeCount}</span> : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
