import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import type { ChatSpace, ChatThread } from '@shared/chat-contract';
import { GENERAL_WORKSPACE_ID, type Task, type Workspace } from '@shared/domain';
import { useApprovalStore, useQuestionStore, useTaskStore, useThreadTierStore, useUiStore, useWorkspaceStore } from '../stores';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { pickFocusedTask } from './workspace/useFocusedTask';
import { threadStatus, threadTitle } from '../lib/thread-status';
import { groupThreads, threadKey, type ThreadView } from '../lib/threads';
import {
  classifyThreadTier, formatSnoozeCountdown, groupThreadsByTier, nextSnoozeWakeAt,
  tierMembership, tiersWithNewArrivals,
  type ThreadTierId, type ThreadTierInfo, type ThreadTierSignals,
} from '../lib/thread-tiers';
import { prNumberFromUrl, prPath } from '../lib/pull-request';
import { cn } from '../lib/cn';
import {
  BrainIcon, CheckIcon, ChevronDownIcon, ChevronRightIcon, ClockIcon, FolderIcon, FolderPlusIcon, GradCapIcon, ImageIcon, ListChecksIcon,
  ArrowLeftIcon, ArrowRightIcon, MessageIcon, PanelLeftIcon, PencilIcon, PhoneIcon, PlugIcon, PlusIcon, PullRequestIcon, IssueIcon, RotateIcon, SearchIcon,
  SettingsIcon, SparklesIcon, SquarePenIcon, TerminalIcon, TrashIcon, UsageIcon, XIcon,
} from './ui/icons';
import { isTerminalTask } from '../stores/task-store';
import { SIDEBAR_ICON, SIDEBAR_ROW } from './ui/sidebar-styles';
import { SuggestionsInbox } from './suggestions/SuggestionsInbox';
import { PhoneControlDialog } from './phone/PhoneControlDialog';
import { EntityIcon } from './ui/EntityIcon';
import { MenuSelect } from './ui/MenuSelect';
import { IconPickerDialog } from './icons/IconPickerDialog';
import { SnoozePickerDialog } from './threads/SnoozePickerDialog';
import { DeleteProjectDialog } from './projects/DeleteProjectDialog';
import { ProjectPullRequestsDialog } from './projects/ProjectPullRequestsDialog';
import { DeleteChatDialog } from './threads/DeleteChatDialog';
import { DeleteThreadDialog } from './threads/DeleteThreadDialog';
import { RenameChatDialog } from './threads/RenameChatDialog';
import { DeleteSpaceDialog, SpaceNameDialog } from './threads/SpaceDialogs';
import { RenameThreadDialog } from './threads/RenameThreadDialog';
import { useChatStore } from '../stores/chat-store';

// The app sidebar. In Work it lists every project's threads in one list sorted
// into tiers, each row led by its project badge; in Chat it lists spaces and personal chats. Each
// thread row leads with a status dot, so a column can be scanned by colour.

const ATTENTION_PILL_CLASSES: Record<string, { text: string; dot: string }> = {
  question: { text: 'text-amber-600 dark:text-amber-300/90', dot: 'bg-amber-500 dark:bg-amber-300/90' },
  approval: { text: 'text-amber-600 dark:text-amber-300/90', dot: 'bg-amber-500 dark:bg-amber-300/90' },
  completed: { text: 'text-emerald-600 dark:text-emerald-300/90', dot: 'bg-emerald-500 dark:bg-emerald-300/90' },
  failed: { text: 'text-red-600 dark:text-red-300/90', dot: 'bg-red-500 dark:bg-red-300/90' },
  blocked: { text: 'text-orange-600 dark:text-orange-300/90', dot: 'bg-orange-500 dark:bg-orange-300/90' },
  interrupted: { text: 'text-violet-600 dark:text-violet-300/90', dot: 'bg-violet-500 dark:bg-violet-300/90' },
  'snooze-woke': { text: 'text-violet-600 dark:text-violet-300/90', dot: 'bg-violet-500 dark:bg-violet-300/90' },
};

/** Short age: now, 5m, 4h, 18d, 3mo. */
function compactAge(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  if (minutes < 60 * 24 * 60) return `${Math.round(minutes / 1440)}d`;
  return `${Math.round(minutes / 43_200)}mo`;
}

function ThreadRow({ thread, project, selected, pendingApproval, tierInfo, snoozedUntil, onOpen, onRename, onDelete, onMarkSettled, onSnooze, onClearTier }: {
  thread: ThreadView;
  /** In the all-projects list, the project badge leading the row. */
  project?: Workspace | undefined;
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
  const navigate = useNavigate();
  const prNumber = thread.root.prNumber ?? prNumberFromUrl(thread.root.prUrl);
  const snoozeCountdown = snoozedUntil !== undefined ? formatSnoozeCountdown(snoozedUntil) : null;
  const status = threadStatus(task, pendingApproval);
  const title = threadTitle(thread.root);
  const attentionPill = tierInfo.tier === 'needs-attention' && tierInfo.attentionReason !== undefined
    ? ATTENTION_PILL_CLASSES[tierInfo.attentionReason]
    : undefined;
  const showPill = attentionPill !== undefined || tierInfo.tier === 'snoozed' || status.active || task.state === 'FAILED';
  const statusLabel = tierInfo.tier === 'needs-attention' ? tierInfo.attentionLabel : tierInfo.tier === 'snoozed' ? 'Snoozed' : status.label;
  return (
    <li
      className={cn(
        'group/thread relative flex items-center rounded-[var(--control-radius)] transition-colors',
        'focus-within:bg-sidebar-row-hover',
        selected ? 'bg-sidebar-row-active text-sidebar-foreground' : 'text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
        title={thread.root.objective}
        className="flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-[var(--control-radius)] ps-2.5 pe-2 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        {project !== undefined ? (
          <span className="relative shrink-0" title={project.name}>
            <EntityIcon icon={project.icon ?? null} name={project.name} kind="project" size={16} />
            {showPill ? (
              <span
                aria-hidden="true"
                className={cn(
                  'absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2 ring-sidebar',
                  attentionPill?.dot ?? status.dotClass,
                  status.pulse && tierInfo.tier !== 'snoozed' && 'animate-status-pulse',
                )}
              />
            ) : null}
          </span>
        ) : (
          <span
            aria-hidden="true"
            className={cn(
              'size-2 shrink-0 rounded-full',
              showPill ? (attentionPill?.dot ?? status.dotClass) : 'border border-sidebar-muted-foreground/45',
              showPill && status.pulse && tierInfo.tier !== 'snoozed' && 'animate-status-pulse',
            )}
          />
        )}
        {/* Thread row: one line, the title and its age (or status) at the right. */}
        <span className={cn('min-w-0 flex-1 truncate text-sm', selected && 'font-medium')}>{title}</span>
        <span className={cn('flex shrink-0 items-center gap-1.5 text-xs text-sidebar-muted-foreground tabular-nums transition-opacity group-hover/thread:opacity-0 group-focus-within/thread:opacity-0', thread.root.prUrl !== undefined && 'pe-5')}
          title={`${thread.tasks.length > 1 ? `${thread.tasks.length} messages · ` : ''}${tierInfo.tier === 'snoozed' && snoozedUntil !== undefined ? `wakes ${new Date(snoozedUntil).toLocaleString()}` : new Date(task.updatedAt).toLocaleString()}`}>
          {showPill ? <span className={cn('font-medium', attentionPill?.text ?? status.colorClass)}>{tierInfo.tier === 'snoozed' ? `wakes${snoozeCountdown !== null ? ` ${snoozeCountdown}` : ''}` : statusLabel}</span> : <span>{compactAge(task.updatedAt)}</span>}
        </span>
      </button>
      {thread.root.prUrl !== undefined ? (
        <button
          type="button"
          onClick={() => { if (prNumber !== null) navigate(prPath(thread.root.workspaceId, prNumber)); }}
          aria-label={`Open pull request ${prNumber !== null ? `#${prNumber} ` : ''}for thread: ${threadTitle(thread.root)}`}
          title={`Pull request${prNumber !== null ? ` #${prNumber}` : ''}${thread.root.prState !== undefined ? ` · ${thread.root.prState}` : ''} — open in the PR reader`}
          className={cn(
            'absolute top-1.5 right-1.5 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md hover:bg-sidebar-row-hover focus-visible:outline-2 focus-visible:outline-ring',
            thread.root.prState === 'merged' ? 'text-violet-500' : thread.root.prState === 'closed' ? 'text-destructive' : 'text-success',
          )}
        >
          <PullRequestIcon size={13} />
        </button>
      ) : null}
      {/* Hover actions take the place of the meta line, so the title never
          shifts or truncates further when they appear. */}
      {/* Centred in the one-line row, over the age, on the row's own hover colour. */}
      <span className={cn('pointer-events-none absolute inset-y-0 right-1 my-auto flex h-6 items-center gap-0.5 rounded-md ps-1 opacity-0 transition-opacity group-hover/thread:pointer-events-auto group-hover/thread:opacity-100 group-focus-within/thread:pointer-events-auto group-focus-within/thread:opacity-100', selected ? 'bg-sidebar-row-active' : 'bg-sidebar-row-hover')}>
        {tierInfo.tier !== 'settled' ? (
          <button
            type="button"
            onClick={onMarkSettled}
            aria-label={`Mark thread as settled: ${title}`}
            title="Mark as settled"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
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
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <RotateIcon size={12} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSnooze}
            aria-label={`Snooze thread: ${title}`}
            title="Snooze — choose when it wakes up"
            className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
          >
            <ClockIcon size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={onRename}
          aria-label={`Rename thread: ${title}`}
          title="Rename thread"
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <PencilIcon size={12} />
        </button>
        <button
          type="button"
          onClick={onDelete}
          aria-label={`Delete thread: ${threadTitle(thread.root)}`}
          title="Delete thread"
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TrashIcon size={12} />
        </button>
      </span>
    </li>
  );
}

/**
 * Work's thread list: one flat list across every project,
 * sorted into tier sections, each row led by its project's badge. Filtered
 * to one project (`project`), a header row carries that project's actions.
 */
function WorkThreads({ project, projects, active, tasks, focusedKey, pendingTaskIds, pendingQuestionTaskIds, query = '', onNavigate, onClearProject }: {
  project: Workspace | null;
  projects: ReadonlyMap<string, Workspace>;
  active: boolean;
  onClearProject: () => void;
  tasks: Task[];
  focusedKey: string | null;
  pendingTaskIds: ReadonlySet<string>;
  pendingQuestionTaskIds: ReadonlySet<string>;
  query?: string;
  onNavigate?: (() => void) | undefined;
}): React.JSX.Element {
  const tierPrefs = useThreadTierStore((s) => s.prefs);
  const { openThread, newThread } = useThreadNavigation();
  // Every tier — Needs attention included — is a collapsible section.
  // Working and Needs attention start open; Settled and Snoozed start
  // hidden. After that, a section auto-collapses whenever a thread lands
  // in it (see the arrival effect below), so arrivals never pop a section
  // open. Searching or opening a thread forces its tier open regardless.
  const [collapsedTiers, setCollapsedTiers] = useState<Record<ThreadTierId, boolean>>({
    'needs-attention': false, working: false, settled: true, snoozed: true,
  });
  // Explicit header clicks, keyed by tier. The tier holding the open thread
  // starts revealed (see `tierCollapsed` below), so without this record a
  // click on its header had nothing to toggle and the section never
  // collapsed. An override is dropped when focus moves or a thread lands in
  // the tier, after which the base rules apply again.
  const [tierOverrides, setTierOverrides] = useState<Partial<Record<ThreadTierId, boolean>>>({});
  const previousTierByThread = useRef<Map<string, ThreadTierId> | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [deleting, setDeleting] = useState(false);
  const [iconOpen, setIconOpen] = useState(false);
  const [prsOpen, setPrsOpen] = useState(false);
  const [githubTab, setGithubTab] = useState<'pulls' | 'issues'>('pulls');
  const [prCount, setPrCount] = useState(0);
  const [deletingThread, setDeletingThread] = useState<ThreadView | null>(null);
  const [renamingThread, setRenamingThread] = useState<ThreadView | null>(null);
  const [snoozingThread, setSnoozingThread] = useState<ThreadView | null>(null);
  // Locally recorded PR count for the header badge; the dialog syncs the
  // repository's full list from GitHub when opened.
  const projectId = project?.id ?? null;
  useEffect(() => {
    if (projectId === null) return undefined;
    let active = true;
    void window.conductor.github.listPrs(projectId)
      .then((list) => { if (active) setPrCount(list.filter((pr) => pr.state === 'open').length); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [projectId]);
  // Keep the snooze countdowns fresh once a minute; the exact wake itself
  // is driven by the dedicated snooze timer below, not by this poll.
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
  // Snooze timer: arm a timeout for the earliest pending wake in this
  // project. When it fires, `now` passes `snoozedUntil`, so the thread
  // leaves Snoozed and lands in Needs attention ("Snooze ended") on time
  // instead of up to a minute late on the poll above. Capped so a far-
  // future wake cannot overflow the browser timer; firing re-arms it.
  const nextWakeAt = useMemo(
    () => nextSnoozeWakeAt(allThreads.map((thread) => tierPrefs[thread.key]), now),
    [allThreads, tierPrefs, now],
  );
  useEffect(() => {
    if (nextWakeAt === null) return;
    const delay = Math.min(Math.max(nextWakeAt - Date.now(), 0), 2_147_483_647);
    const timer = window.setTimeout(() => { setNow(Date.now()); }, delay);
    return () => { window.clearTimeout(timer); };
  }, [nextWakeAt]);
  // Auto-collapse: whenever a thread lands in a tier — newly created,
  // finished, settled, snoozed, or woken by its snooze timer — collapse
  // that tier's section. The first render only records the baseline, so
  // sections keep their initial open/collapsed defaults on load. While
  // searching the baseline is left untouched, so clearing the search does
  // not collapse sections for threads that were merely filtered out.
  useEffect(() => {
    if (query !== '') return;
    const previous = previousTierByThread.current;
    previousTierByThread.current = tierMembership(tierGroups);
    if (previous === null) return;
    const arrivals = tiersWithNewArrivals(previous, tierGroups);
    if (arrivals.length === 0) return;
    setCollapsedTiers((current) => {
      if (arrivals.every((tier) => current[tier])) return current;
      const next = { ...current };
      for (const tier of arrivals) next[tier] = true;
      return next;
    });
    // A fresh arrival re-applies the base (auto-collapsed) state, discarding
    // any manual override for the tiers it landed in.
    setTierOverrides((current) => {
      if (arrivals.every((tier) => current[tier] === undefined)) return current;
      const next = { ...current };
      for (const tier of arrivals) delete next[tier];
      return next;
    });
  }, [tierGroups, query]);
  // Moving focus to another thread reveals its tier again, discarding a
  // manual collapse the user applied to it earlier.
  const previousFocusedKey = useRef<string | null>(null);
  useEffect(() => {
    if (focusedKey === null || focusedKey === previousFocusedKey.current) return;
    previousFocusedKey.current = focusedKey;
    const group = tierGroups.find((g) => g.threads.some((thread) => thread.key === focusedKey));
    if (group !== undefined) {
      setTierOverrides((current) => {
        if (current[group.id] === undefined) return current;
        const next = { ...current };
        delete next[group.id];
        return next;
      });
    }
  }, [focusedKey, tierGroups]);
  const scope = project !== null ? ` in ${project.name}` : '';

  return (
    <div className="flex flex-col">
      {project !== null ? (
      <div className={cn('group mb-1 flex h-8 items-center rounded-lg pr-1 transition-colors hover:bg-sidebar-row-hover')}>
        <span className="flex h-full min-w-0 flex-1 items-center gap-2 pl-2 text-sm" title={project.rootPath}>
          <EntityIcon icon={project.icon ?? null} name={project.name} kind="project" size={16} active={active} />
          <span className="min-w-0 flex-1 truncate font-medium text-sidebar-foreground">{project.name}</span>
        </span>
        <button
          type="button"
          onClick={() => { setGithubTab('pulls'); setPrsOpen(true); }}
          aria-label={`Pull requests for ${project.name}`}
          title={`Pull requests for ${project.name}`}
          className={cn('h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:flex focus-visible:outline-2 focus-visible:outline-ring', prCount > 0 ? 'flex' : 'hidden group-focus-within:flex group-hover:flex')}
        >
          <PullRequestIcon size={13} />
          {prCount > 0 ? <span className="text-xs font-medium tabular-nums">{prCount}</span> : null}
        </button>
        <button
          type="button"
          onClick={() => { setGithubTab('issues'); setPrsOpen(true); }}
          aria-label={`Issues for ${project.name}`}
          title={`Issues for ${project.name} — start threads from them`}
          className="hidden h-6 shrink-0 cursor-pointer items-center rounded-md px-1 text-sidebar-muted-foreground group-focus-within:flex group-hover:flex hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:flex focus-visible:outline-2 focus-visible:outline-ring"
        >
          <IssueIcon size={13} />
        </button>
        <button
          type="button"
          onClick={() => { void newThread(project.id); }}
          aria-label={`New thread in ${project.name}`}
          title="New thread"
          className="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground group-focus-within:flex group-hover:flex hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <SquarePenIcon size={13} />
        </button>
        <button
          type="button"
          onClick={() => { setIconOpen(true); }}
          aria-label={`Icon for ${project.name}`}
          title="Change icon"
          className="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground group-focus-within:flex group-hover:flex hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <ImageIcon size={13} />
        </button>
        <button
          type="button"
          onClick={() => { setDeleting(true); }}
          aria-label={`Delete ${project.name}`}
          title="Delete project"
          className="hidden size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground group-focus-within:flex group-hover:flex hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <TrashIcon size={13} />
        </button>
        <button
          type="button"
          onClick={onClearProject}
          aria-label="Show threads from every project"
          title="Show every project"
          className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring"
        >
          <XIcon size={13} />
        </button>
      </div>
      ) : null}
      {project !== null ? <DeleteProjectDialog project={project} open={deleting} onClose={() => { setDeleting(false); onClearProject(); }} /> : null}
      {project !== null && iconOpen ? <IconPickerDialog target={{ kind: 'project', id: project.id, name: project.name, icon: project.icon ?? null }} open onClose={() => { setIconOpen(false); }} /> : null}
      {project !== null && prsOpen ? <ProjectPullRequestsDialog project={project} open initialTab={githubTab} onClose={() => { setPrsOpen(false); void window.conductor.github.listPrs(project.id).then((list) => { setPrCount(list.filter((pr) => pr.state === 'open').length); }).catch(() => undefined); }} /> : null}
      {deletingThread !== null ? <DeleteThreadDialog thread={deletingThread} open onClose={() => { setDeletingThread(null); }} /> : null}
      {renamingThread !== null ? <RenameThreadDialog key={renamingThread.key} threadId={renamingThread.key} currentTitle={threadTitle(renamingThread.root)} open onClose={() => { setRenamingThread(null); }} /> : null}
      {snoozingThread !== null ? (
        <SnoozePickerDialog
          open
          onClose={() => { setSnoozingThread(null); }}
          onSnooze={(until) => { useThreadTierStore.getState().snooze(snoozingThread.key, snoozingThread.latest.updatedAt, until); }}
        />
      ) : null}
      {threads.length === 0 ? (
          <p className="px-2.5 py-1 text-xs text-sidebar-muted-foreground">{query !== '' ? 'No matching threads' : 'No threads yet'}</p>
        ) : (
          <div className="flex flex-col gap-1 pb-1">
            {tierGroups.map((group) => {
              const isAttention = group.id === 'needs-attention';
              const containsFocused = focusedKey !== null && group.threads.some((thread) => thread.key === focusedKey);
              // Base state: the tier holding the open thread is revealed so it
              // stays visible. A manual header click overrides that either
              // way, so every section — focused or not — collapses and expands
              // when clicked. Search forces sections open so matches show.
              const tierCollapsed = query === '' && (tierOverrides[group.id] ?? (!containsFocused && collapsedTiers[group.id] === true));
              return (
                <section key={group.id} aria-label={`${group.label} threads${scope}`} className="flex flex-col">
                  <button
                    type="button"
                    onClick={() => { setTierOverrides((current) => ({ ...current, [group.id]: !tierCollapsed })); }}
                    aria-expanded={!tierCollapsed}
                    aria-label={`${group.label} threads${scope}`}
                    className={cn(
                      // Section heading: "Settled   9 ⌄".
                      'flex h-8 w-full cursor-pointer items-center gap-1.5 rounded-md px-2.5 text-left text-sm focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      isAttention ? 'text-amber-600 hover:text-amber-500 dark:text-amber-300/90' : 'text-sidebar-muted-foreground hover:text-sidebar-foreground',
                    )}
                  >
                    {isAttention ? <span aria-hidden="true" className="size-1.5 shrink-0 rounded-full bg-amber-500 dark:bg-amber-300/90" /> : null}
                    <span className="flex-1">{group.label}</span>
                    <span className="text-xs tabular-nums">{group.threads.length}</span>
                    <ChevronDownIcon size={13} className={cn('shrink-0 transition-transform duration-150', tierCollapsed && '-rotate-90')} />
                  </button>
                  {!tierCollapsed ? (
                    <ul className="flex flex-col gap-px pb-1">
                      {group.threads.map((thread) => {
                        const tierInfo = classifyThreadTier(thread, tierPrefs[thread.key], signalsFor(thread), now);
                        const pref = tierPrefs[thread.key];
                        return (
                          <ThreadRow
                            key={thread.key}
                            thread={thread}
                            project={project === null ? projects.get(thread.root.workspaceId) : undefined}
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
                            onSnooze={() => { setSnoozingThread(thread); }}
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
        )}
    </div>
  );
}

const CHAT_THREAD_DRAG_TYPE = 'application/x-conductor-chat-thread';
const UNGROUPED_DROP_TARGET = '__ungrouped__';

function ChatHistory({ query = '', onNavigate }: { query?: string; onNavigate?: (() => void) | undefined }): React.JSX.Element {
  const allThreads = useChatStore((state) => state.threads);
  const spaces = useChatStore((state) => state.spaces);
  const threads = query === '' ? allThreads : allThreads.filter((t) => t.title.toLowerCase().includes(query));
  const selectedId = useChatStore((state) => state.selectedId);
  const [error, setError] = useState<string | null>(null);
  const [deletingThread, setDeletingThread] = useState<ChatThread | null>(null);
  const [renamingThread, setRenamingThread] = useState<ChatThread | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [renamingSpace, setRenamingSpace] = useState<ChatSpace | null>(null);
  const [deletingSpace, setDeletingSpace] = useState<ChatSpace | null>(null);
  const collapsedSpaces = useUiStore((state) => state.collapsedSpaces);
  const toggleSpace = useUiStore((state) => state.toggleSpace);
  const [iconSpace, setIconSpace] = useState<ChatSpace | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [movingId, setMovingId] = useState<string | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const load = (): void => {
    setError(null);
    void window.conductor.chat.list().then((list) => { useChatStore.getState().setThreads(list); })
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not load chats'); });
    void window.conductor.chat.listSpaces().then((list) => { useChatStore.getState().setSpaces(list); })
      .catch(() => { /* Spaces are additive; chat loading errors surface above. */ });
  };
  useEffect(load, []);
  // The dialog closes both after a successful delete and after a cancel. Reload
  // only when the store no longer holds the thread, so a cancel stays untouched.
  const closeDelete = (): void => {
    const thread = deletingThread;
    setDeletingThread(null);
    if (thread !== null && !useChatStore.getState().threads.some((item) => item.id === thread.id)) load();
  };
  // Dragging a chat into a space shares its context with that space's chats;
  // dragging it out to the ungrouped Chats list (setThreadSpace null) ends the
  // sharing — spaceContext only ever reads current members, in both directions.
  const draggedThread = draggedId === null ? undefined : allThreads.find((thread) => thread.id === draggedId);
  const acceptsSpace = (spaceId: string): boolean => draggedThread !== undefined && (draggedThread.spaceId ?? null) !== spaceId;
  const acceptsUngrouped = draggedThread?.spaceId != null;
  async function moveThread(threadId: string, spaceId: string | null): Promise<void> {
    const thread = allThreads.find((item) => item.id === threadId);
    if (thread === undefined || (thread.spaceId ?? null) === spaceId || movingId !== null) return;
    setMovingId(threadId);
    setMoveError(null);
    try {
      const updated = await window.conductor.chat.setThreadSpace(threadId, spaceId);
      useChatStore.getState().setThreadSpace(updated);
    } catch (err) {
      setMoveError(err instanceof Error ? err.message : 'Could not move the chat');
    } finally {
      setMovingId(null);
      setDraggedId(null);
      setDropTarget(null);
    }
  }
  function onDragOverTarget(event: React.DragEvent, target: string, accepts: boolean): void {
    if (!accepts) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDropTarget((current) => (current === target ? current : target));
  }
  function onDragLeaveTarget(event: React.DragEvent, target: string): void {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDropTarget((current) => (current === target ? null : current));
  }
  function onDropTarget(event: React.DragEvent, spaceId: string | null): void {
    event.preventDefault();
    const threadId = event.dataTransfer.getData(CHAT_THREAD_DRAG_TYPE) || draggedId;
    setDropTarget(null);
    if (threadId !== null) void moveThread(threadId, spaceId);
  }
  const renderThread = (thread: ChatThread): React.JSX.Element => (
    <li
      key={thread.id}
      data-chat-thread-id={thread.id}
      draggable={movingId === null}
      title="Drag to a space, or to Chats to remove"
      onDragStart={(event) => {
        setDraggedId(thread.id);
        setMoveError(null);
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(CHAT_THREAD_DRAG_TYPE, thread.id);
        event.dataTransfer.setData('text/plain', thread.id);
      }}
      onDragEnd={() => { setDraggedId(null); setDropTarget(null); }}
      className={cn('group/chat relative flex h-8 cursor-grab items-center rounded-lg transition-colors focus-within:bg-sidebar-row-hover active:cursor-grabbing', selectedId === thread.id ? 'bg-sidebar-row-active font-medium' : 'text-sidebar-foreground/85 hover:bg-sidebar-row-hover hover:text-sidebar-foreground', draggedId === thread.id && 'opacity-50')}
    >
      <button type="button" title={thread.title} aria-current={selectedId === thread.id ? 'page' : undefined} onClick={() => { useChatStore.getState().select(thread.id); onNavigate?.(); }} className="flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-lg px-2.5 text-left text-sm transition-[padding] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring group-hover/chat:pr-14 group-focus-within/chat:pr-14">
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
    </li>
  );
  const spaceIds = new Set(spaces.map((space) => space.id));
  const ungrouped = threads.filter((thread) => !thread.spaceId || !spaceIds.has(thread.spaceId));
  return <>
    <div className="flex h-7 items-center justify-between px-1.5">
      <h2 className="text-2xs font-semibold text-sidebar-muted-foreground">Spaces</h2>
      <button type="button" onClick={() => { setCreatingSpace(true); }} aria-label="New space" title="New space — group chats that share context" className="flex size-6 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring">
        <PlusIcon size={14} />
      </button>
    </div>
    {moveError ? <p role="alert" className="px-2 pb-2 text-xs text-destructive-foreground">{moveError}</p> : null}
    {spaces.length === 0
      ? <p className="px-2 pb-2 text-xs text-sidebar-muted-foreground">Chats in a space share context.</p>
      : spaces.map((space) => {
        const members = threads.filter((thread) => thread.spaceId === space.id);
        if (query !== '' && members.length === 0) return null;
        // Spaces collapse like project groups; searching always reveals matches.
        const spaceCollapsed = query === '' && collapsedSpaces[space.id] === true;
        return (
          <section
            key={space.id}
            aria-label={`Space: ${space.name}`}
            data-chat-space-id={space.id}
            onDragOver={(event) => { if (spaceCollapsed && acceptsSpace(space.id)) toggleSpace(space.id); onDragOverTarget(event, space.id, acceptsSpace(space.id)); }}
            onDragLeave={(event) => { onDragLeaveTarget(event, space.id); }}
            onDrop={(event) => { if (acceptsSpace(space.id)) onDropTarget(event, space.id); }}
            className={cn('rounded-md pb-1 transition-colors', dropTarget === space.id && 'bg-sidebar-row-hover ring-1 ring-ring/60 ring-inset')}
          >
            <div className="group/space flex h-7 items-center gap-1 px-1.5">
              <button type="button" onClick={() => { toggleSpace(space.id); }} aria-expanded={!spaceCollapsed} aria-label={`${spaceCollapsed ? 'Expand' : 'Collapse'} space: ${space.name}`} title={spaceCollapsed ? 'Expand space' : 'Collapse space'} className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring">
                <ChevronRightIcon size={11} className={cn('transition-transform duration-150', !spaceCollapsed && 'rotate-90')} />
              </button>
              <EntityIcon icon={space.icon ?? null} name={space.name} kind="space" />
              <span className="min-w-0 flex-1 truncate text-sm font-semibold" title={space.name}>{space.name}</span>
              <span className="shrink-0 text-2xs text-sidebar-muted-foreground">{members.length}</span>
              <button type="button" onClick={() => { setIconSpace(space); }} aria-label={`Icon for space: ${space.name}`} title="Change icon" className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover/space:opacity-100">
                <ImageIcon size={12} />
              </button>
              <button type="button" onClick={() => { setRenamingSpace(space); }} aria-label={`Rename space: ${space.name}`} title="Rename space" className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover/space:opacity-100">
                <PencilIcon size={12} />
              </button>
              <button type="button" onClick={() => { setDeletingSpace(space); }} aria-label={`Delete space: ${space.name}`} title="Delete space (chats are kept)" className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring group-hover/space:opacity-100">
                <TrashIcon size={12} />
              </button>
            </div>
            {spaceCollapsed ? null : (<>
            {dropTarget === space.id ? <p className="px-2 pb-1 pl-7 text-2xs text-sidebar-muted-foreground">Drop to add this chat to the space</p> : null}
            {members.length === 0
              ? <p className="px-2 pb-1 pl-7 text-2xs text-sidebar-muted-foreground">Drop chats here to share context.</p>
              : <ul className="ml-[13px] flex flex-col gap-px border-l border-sidebar-border pl-1.5">{members.map(renderThread)}</ul>}
            </>)}
          </section>
        );
      })}
    <div
      data-chat-ungrouped-drop-target=""
      onDragOver={(event) => { onDragOverTarget(event, UNGROUPED_DROP_TARGET, acceptsUngrouped); }}
      onDragLeave={(event) => { onDragLeaveTarget(event, UNGROUPED_DROP_TARGET); }}
      onDrop={(event) => { if (acceptsUngrouped) onDropTarget(event, null); }}
      className={cn('rounded-md transition-colors', dropTarget === UNGROUPED_DROP_TARGET && 'bg-sidebar-row-hover ring-1 ring-ring/60 ring-inset')}
    >
      <h2 className="flex h-7 items-center px-1.5 pt-1 text-2xs font-semibold text-sidebar-muted-foreground">Chats</h2>
      {acceptsUngrouped ? <p className="px-2 pb-1 text-2xs text-sidebar-muted-foreground">{dropTarget === UNGROUPED_DROP_TARGET ? 'Drop to remove from its space — its context will no longer be shared' : 'Drag a chat here to remove it from its space'}</p> : null}
      {error ? <p role="alert" className="px-2 text-xs text-destructive-foreground">{error} <button type="button" className="underline" onClick={load}>Retry</button></p> : null}
      {threads.length === 0 ? <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">No chats yet.</p> : ungrouped.length === 0 && spaces.length > 0 ? <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">All chats are in spaces.</p> : <ul className="flex flex-col gap-px">{ungrouped.map(renderThread)}</ul>}
    </div>
    {deletingThread !== null ? <DeleteChatDialog thread={deletingThread} open onClose={closeDelete} /> : null}
    {renamingThread !== null ? <RenameChatDialog key={renamingThread.id} thread={renamingThread} open onClose={() => { setRenamingThread(null); }} /> : null}
    {creatingSpace ? <SpaceNameDialog space={null} open onClose={() => { setCreatingSpace(false); }} /> : null}
    {renamingSpace !== null ? <SpaceNameDialog key={renamingSpace.id} space={renamingSpace} open onClose={() => { setRenamingSpace(null); }} /> : null}
    {deletingSpace !== null ? <DeleteSpaceDialog space={deletingSpace} open onClose={() => { setDeletingSpace(null); }} /> : null}
    {iconSpace !== null ? <IconPickerDialog key={iconSpace.id} target={{ kind: 'space', id: iconSpace.id, name: iconSpace.name, icon: iconSpace.icon ?? null }} open onClose={() => { setIconSpace(null); }} /> : null}
  </>;
}

const MORE = [
  { to: '/projects', label: 'Projects', Icon: FolderIcon },
  { to: '/active-tasks', label: 'Tasks', Icon: ListChecksIcon },
  { to: '/memory', label: 'Memory', Icon: BrainIcon },
  { to: '/connected-apps', label: 'Connections', Icon: PlugIcon },
  { to: '/usage', label: 'Usage', Icon: UsageIcon },
  { to: '/learning', label: 'Learning', Icon: GradCapIcon },
] as const;

/**
 * The app sidebar, where to go at the top, the list for the
 * surface you are on in the middle (threads by project in Work, chats and
 * spaces in Chat, agents and flows in Agents), the other destinations and
 * Settings at the bottom. ⌘B hides it.
 */
export function Sidebar({ onNavigate }: { onNavigate?: () => void } = {}): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const tasks = useTaskStore((s) => s.tasks);
  const focusedTaskId = useTaskStore((s) => s.focusedTaskId);
  const pending = useApprovalStore((s) => s.pending);
  const pendingQuestions = useQuestionStore((s) => s.pending);
  const draft = useUiStore((s) => s.draft);
  const setAddProjectOpen = useUiStore((s) => s.setAddProjectOpen);
  const setPanelCollapsed = useUiStore((s) => s.setPanelCollapsed);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const setSidebarSlot = useUiStore((s) => s.setSidebarSlot);
  const { newThread } = useThreadNavigation();
  const location = useLocation();
  const navigate = useNavigate();
  const [phoneOpen, setPhoneOpen] = useState(false);
  const path = location.pathname;
  const onHome = path === '/home';
  const onAgents = path === '/agents';
  const onWork = path === '/work' || path.startsWith('/pr/');

  const workProjectId = useUiStore((s) => s.workProject);
  const setWorkProject = useUiStore((s) => s.setWorkProject);
  const projectsById = useMemo(() => new Map(workspaces.map((project) => [project.id, project])), [workspaces]);
  const workProject = workProjectId !== null ? projectsById.get(workProjectId) ?? null : null;
  // Every project's threads in one list, newest first; a project filter narrows it.
  const workTasks = useMemo(() => Object.values(tasks)
    .filter((task) => (projectsById.has(task.workspaceId) || task.workspaceId === GENERAL_WORKSPACE_ID) && (workProject === null || task.workspaceId === workProject.id))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)), [tasks, projectsById, workProject]);
  const running = useMemo(() => Object.values(tasks).filter((task) => !isTerminalTask(task)).length, [tasks]);

  const pendingTaskIds = useMemo(() => new Set(pending.map((request) => request.taskId)), [pending]);
  const pendingQuestionTaskIds = useMemo(() => new Set(pendingQuestions.map((request) => request.taskId)), [pendingQuestions]);
  const attention = pending.length + pendingQuestions.length;
  // The focused thread is only highlighted while it is what the chat shows.
  const focusedTask = pickFocusedTask(tasks, focusedTaskId, activeWorkspaceId);
  const focusedKey = path === '/work' && !draft && focusedTask !== null ? threadKey(focusedTask) : null;

  const openChat = (): void => { useChatStore.getState().select(null); navigate('/home'); onNavigate?.(); };
  const openWork = (): void => { void newThread(); onNavigate?.(); };

  return (
    <nav aria-label="Primary" className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Sidebar header: the toggle, the app name and history arrows, clear of the traffic lights. */}
      <div className="app-drag flex h-[52px] shrink-0 items-center gap-1 pr-1.5 pl-[78px]">
        <button type="button" onClick={() => { setPanelCollapsed(true); }} aria-label="Hide sidebar" title="Hide sidebar (⌘B)" className={cn(SIDEBAR_ICON, 'size-7')}><PanelLeftIcon /></button>
        <button type="button" onClick={openChat} className="ml-0.5 flex h-7 min-w-max shrink-0 items-center rounded-md px-1 text-sm font-medium tracking-tight text-foreground outline-hidden focus-visible:ring-2 focus-visible:ring-ring">Conductor</button>
        <button type="button" onClick={() => { navigate(-1); }} aria-label="Back" title="Back (⌘[)" className={cn(SIDEBAR_ICON, 'size-7 [&>svg]:size-3.5')}><ArrowLeftIcon /></button>
        <button type="button" onClick={() => { navigate(1); }} aria-label="Forward" title="Forward (⌘])" className={cn(SIDEBAR_ICON, 'size-7 [&>svg]:size-3.5')}><ArrowRightIcon /></button>
      </div>

      <div className="flex shrink-0 flex-col gap-0.5 px-2 pb-2">
        <div className="flex items-center gap-0.5">
          <button type="button" onClick={() => { setPaletteOpen(true); }} title="Search (⌘K)" className={cn(SIDEBAR_ROW, 'min-w-0 flex-1')}><SearchIcon /><span>Search</span></button>
          <SuggestionsInbox />
          {onWork ? <button type="button" onClick={() => { setAddProjectOpen(true); }} aria-label="Add project" title="Add project" className={SIDEBAR_ICON}><FolderPlusIcon /></button> : null}
          <button type="button" onClick={onHome ? openChat : openWork} aria-label={onHome ? 'New chat' : 'New thread'} title={`${onHome ? 'New chat' : 'New thread'} (⌘N)`} className={SIDEBAR_ICON}><SquarePenIcon /></button>
        </div>
        <button type="button" onClick={openChat} aria-current={onHome ? 'page' : undefined} className={SIDEBAR_ROW}><MessageIcon /><span>Chat</span></button>
        <button type="button" onClick={openWork} aria-current={onWork ? 'page' : undefined} className={SIDEBAR_ROW}>
          <TerminalIcon /><span className="flex-1">Work</span>
          {attention > 0 ? <span title={`${attention} waiting on you`} className="rounded-sm bg-warning/8 px-1 text-xs font-medium text-warning tabular-nums dark:bg-warning/16">{attention}</span> : null}
        </button>
        <button type="button" onClick={() => { navigate('/agents'); onNavigate?.(); }} aria-current={onAgents ? 'page' : undefined} className={SIDEBAR_ROW}><SparklesIcon /><span>Agents</span></button>
      </div>

      {onAgents ? (
        <div ref={setSidebarSlot} className="flex min-h-0 flex-1 flex-col border-t border-sidebar-border" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col border-t border-sidebar-border">
          <div className="side-label mt-1.5 px-2">
            <span className="flex-1 pl-2">{onHome ? 'Chats' : 'Threads'}</span>
            {!onHome && workspaces.length > 1 ? (
              <MenuSelect
                label="Show threads from"
                title="Show threads from"
                value={workProject?.id ?? ''}
                onChange={(value) => { setWorkProject(value === '' ? null : value); }}
                options={[{ value: '', label: 'All projects' }, ...workspaces.map((project) => ({ value: project.id, label: project.name, mark: <EntityIcon icon={project.icon ?? null} name={project.name} kind="project" size={16} /> }))]}
                className="max-w-32"
              />
            ) : null}
            {!onHome ? <button type="button" onClick={() => { setAddProjectOpen(true); }} aria-label="Add project" title="Add project" className="side-icon"><FolderPlusIcon size={14} /></button> : null}
            <button type="button" onClick={onHome ? openChat : openWork} aria-label={onHome ? 'New chat' : 'New thread'} title={`${onHome ? 'New chat' : 'New thread'} (⌘N)`} className="side-icon mr-1"><SquarePenIcon size={14} /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {onHome ? <ChatHistory onNavigate={onNavigate} /> : (
              <WorkThreads
                key={workProject?.id ?? 'all'}
                project={workProject}
                projects={projectsById}
                active={workProject !== null && workProject.id === activeWorkspaceId}
                tasks={workTasks}
                focusedKey={focusedKey}
                pendingTaskIds={pendingTaskIds}
                pendingQuestionTaskIds={pendingQuestionTaskIds}
                onNavigate={onNavigate}
                onClearProject={() => { setWorkProject(null); }}
              />
            )}
          </div>
        </div>
      )}

      {/* Utility bar: the other destinations as icons along the bottom. */}
      <div className="flex shrink-0 items-center gap-px p-2">
        <NavLink to="/settings" onClick={onNavigate} aria-label="Settings" title="Settings" className={cn(SIDEBAR_ICON, 'size-7')}><SettingsIcon /></NavLink>
        {MORE.map(({ to, label, Icon }) => (
          <NavLink key={to} to={to} onClick={onNavigate} aria-label={label} title={label} aria-current={path === to ? 'page' : undefined} className={cn(SIDEBAR_ICON, 'relative size-7')}>
            <Icon />
            {to === '/active-tasks' && running > 0 ? <span className="absolute top-1 right-1 size-1.5 rounded-full bg-primary" aria-label={`${running} running`} /> : null}
          </NavLink>
        ))}
        <span className="flex-1" />
        <button type="button" aria-label="Control on phone" title="Control on phone" onClick={() => { setPhoneOpen(true); }} className={cn(SIDEBAR_ICON, 'size-7')}><PhoneIcon /></button>
      </div>
      {phoneOpen ? <PhoneControlDialog onClose={() => { setPhoneOpen(false); }} /> : null}
    </nav>
  );
}
