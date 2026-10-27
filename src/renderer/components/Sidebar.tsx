import { useEffect, useMemo, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import type { ChatThread } from '@shared/chat-contract';
import type { Task, Workspace } from '@shared/domain';
import { NAV_ENTRIES, type NavEntryId } from '../navigation';
import { useApprovalStore, useTaskStore, useUiStore, useWorkspaceStore } from '../stores';
import { isTerminalTask } from '../stores/task-store';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { pickFocusedTask } from './workspace/useFocusedTask';
import { isWorkingState, threadStatus, threadTitle } from '../lib/thread-status';
import { relativeTime } from '../lib/time';
import { groupThreads, threadKey, type ThreadView } from '../lib/threads';
import { cn } from '../lib/cn';
import { Kbd } from './ui/primitives';
import { SuggestionsInbox } from './suggestions/SuggestionsInbox';
import {
  ActivityIcon, BrainIcon, ChevronRightIcon, FolderIcon, LayersIcon, ListChecksIcon, PlugIcon,
  PlusIcon, SettingsIcon, SparklesIcon, SquarePenIcon, TrashIcon, UsageIcon, WorkflowIcon,
} from './ui/icons';
import { DeleteProjectDialog } from './projects/DeleteProjectDialog';
import { DeleteChatDialog } from './threads/DeleteChatDialog';
import { DeleteThreadDialog } from './threads/DeleteThreadDialog';
import { SurfaceTabs } from './SurfaceTabs';
import { useChatStore } from '../stores/chat-store';

// The left sidebar, laid out like T3 Code: a draggable title-bar strip, a
// "New thread" action, projects as collapsible groups with their threads
// (tasks) and live status pills, and the secondary destinations at the bottom.

const THREADS_PER_PROJECT = 8;

const NAV_ICONS: Partial<Record<NavEntryId, (p: { size?: number }) => React.JSX.Element>> = {
  projects: LayersIcon,
  'active-tasks': ListChecksIcon,
  'recent-activity': ActivityIcon,
  workflows: WorkflowIcon,
  skills: SparklesIcon,
  'connected-apps': PlugIcon,
  memory: BrainIcon,
  usage: UsageIcon,
  settings: SettingsIcon,
};

const NAV_LABELS: Partial<Record<NavEntryId, string>> = {
  'connected-apps': 'Connections',
  'recent-activity': 'Activity',
};

function ThreadRow({ thread, selected, pendingApproval, onOpen, onDelete }: { thread: ThreadView; selected: boolean; pendingApproval: boolean; onOpen: () => void; onDelete: () => void }): React.JSX.Element {
  const task = thread.latest;
  const status = threadStatus(task, pendingApproval);
  const showPill = status.active || task.state === 'FAILED';
  return (
    <li
      className={cn(
        'group/thread flex h-7 items-center rounded-md pr-1 transition-colors',
        'focus-within:bg-sidebar-row-hover',
        selected ? 'bg-sidebar-row-active text-sidebar-foreground shadow-xs dark:shadow-none' : 'text-sidebar-foreground/80 hover:bg-sidebar-row-hover hover:text-sidebar-foreground',
      )}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'page' : undefined}
        title={thread.root.objective}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md pl-7 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="min-w-0 flex-1 truncate">{threadTitle(thread.root)}</span>
        {thread.tasks.length > 1 ? <span className="shrink-0 text-3xs text-sidebar-muted-foreground/70 tabular-nums" title={`${thread.tasks.length} messages`}>{thread.tasks.length}</span> : null}
        {showPill ? (
          <span className={cn('flex shrink-0 items-center gap-1 text-3xs font-medium', status.colorClass)}>
            <span className={cn('size-1.5 rounded-full', status.dotClass, status.pulse && 'animate-status-pulse')} />
            {status.label}
          </span>
        ) : (
          <span className="shrink-0 text-3xs text-sidebar-muted-foreground/70 tabular-nums">{relativeTime(task.updatedAt)}</span>
        )}
      </button>
      <button
        type="button"
        onClick={onDelete}
        aria-label={`Delete thread: ${threadTitle(thread.root)}`}
        title="Delete thread"
        className="ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity group-hover/thread:opacity-100 group-focus-within/thread:opacity-100 hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <TrashIcon size={12} />
      </button>
    </li>
  );
}

function ProjectGroup({ project, active, tasks, focusedKey, pendingTaskIds }: {
  project: Workspace;
  active: boolean;
  tasks: Task[];
  focusedKey: string | null;
  pendingTaskIds: ReadonlySet<string>;
}): React.JSX.Element {
  const collapsed = useUiStore((s) => s.collapsedProjects[project.id] === true);
  const toggle = useUiStore((s) => s.toggleProject);
  const { openThread, newThread } = useThreadNavigation();
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deletingThread, setDeletingThread] = useState<ThreadView | null>(null);
  const threads = useMemo(() => groupThreads(tasks), [tasks]);
  const visible = expanded ? threads : threads.slice(0, THREADS_PER_PROJECT);
  const working = threads.filter((thread) => isWorkingState(thread.latest.state)).length;

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
          <FolderIcon size={14} className={cn('shrink-0', active ? 'text-primary' : 'text-sidebar-muted-foreground')} />
          <span className={cn('min-w-0 flex-1 truncate font-medium', active ? 'text-sidebar-foreground' : 'text-sidebar-foreground/85')}>{project.name}</span>
          {working > 0 ? <span className="shrink-0 rounded-full bg-sky-500/12 px-1.5 text-3xs font-medium text-sky-600 tabular-nums dark:text-sky-300">{working}</span> : null}
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
      {deletingThread !== null ? <DeleteThreadDialog thread={deletingThread} open onClose={() => { setDeletingThread(null); }} /> : null}
      {!collapsed ? (
        threads.length === 0 ? (
          <p className="py-1 pl-7 text-2xs text-sidebar-muted-foreground/70">No threads yet</p>
        ) : (
          <ul className="flex flex-col gap-px pb-1">
            {visible.map((thread) => (
              <ThreadRow
                key={thread.key}
                thread={thread}
                selected={focusedKey === thread.key}
                pendingApproval={thread.tasks.some((task) => pendingTaskIds.has(task.id))}
                onOpen={() => { void openThread(thread.latest); }}
                onDelete={() => { setDeletingThread(thread); }}
              />
            ))}
            {threads.length > THREADS_PER_PROJECT ? (
              <li>
                <button type="button" onClick={() => { setExpanded((v) => !v); }} className="h-6 w-full cursor-pointer rounded-md pl-7 text-left text-2xs text-sidebar-muted-foreground hover:text-sidebar-foreground">
                  {expanded ? 'Show less' : `Show ${threads.length - THREADS_PER_PROJECT} more`}
                </button>
              </li>
            ) : null}
          </ul>
        )
      ) : null}
    </li>
  );
}

function ChatHistory(): React.JSX.Element {
  const threads = useChatStore((state) => state.threads);
  const selectedId = useChatStore((state) => state.selectedId);
  const [error, setError] = useState<string | null>(null);
  const [deletingThread, setDeletingThread] = useState<ChatThread | null>(null);
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
    {threads.length === 0 ? <p className="px-2 py-2 text-xs text-sidebar-muted-foreground">Your conversations will appear here.</p> : <ul className="flex flex-col gap-1">{threads.map((thread) => <li key={thread.id} className={cn('group/chat flex h-8 items-center rounded-md pr-1 transition-colors focus-within:bg-sidebar-row-hover', selectedId === thread.id ? 'bg-sidebar-row-active' : 'hover:bg-sidebar-row-hover')}>
      <button type="button" title={thread.title} aria-current={selectedId === thread.id ? 'page' : undefined} onClick={() => { useChatStore.getState().select(thread.id); }} className="flex h-full min-w-0 flex-1 cursor-pointer items-center rounded-md px-2 text-left text-[13px] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span className="min-w-0 flex-1 truncate">{thread.title}</span>
      </button>
      <button
        type="button"
        onClick={(event) => { event.stopPropagation(); setDeletingThread(thread); }}
        aria-label={`Delete chat: ${thread.title}`}
        title="Delete chat"
        className="ml-1 flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-sidebar-muted-foreground opacity-0 transition-opacity group-hover/chat:opacity-100 group-focus-within/chat:opacity-100 hover:bg-sidebar-row-hover hover:text-destructive-foreground focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring"
      >
        <TrashIcon size={12} />
      </button>
    </li>)}</ul>}
    {deletingThread !== null ? <DeleteChatDialog thread={deletingThread} open onClose={closeDelete} /> : null}
  </>;
}

export function Sidebar(): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const tasks = useTaskStore((s) => s.tasks);
  const focusedTaskId = useTaskStore((s) => s.focusedTaskId);
  const pending = useApprovalStore((s) => s.pending);
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
  const activeCount = Object.values(tasks).filter((task) => !isTerminalTask(task)).length;
  // The focused thread is only highlighted while it is what the chat shows.
  const focusedTask = pickFocusedTask(tasks, focusedTaskId, activeWorkspaceId);
  const focusedKey = location.pathname === '/work' && !draft && focusedTask !== null ? threadKey(focusedTask) : null;
  const selectedChat = useChatStore((state) => state.selectedId);

  return (
    <nav aria-label="Primary" className="flex h-full w-64 shrink-0 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground">
      {/* Title-bar strip: leaves room for the macOS traffic lights. */}
      <div className="app-drag flex h-(--topbar-height) shrink-0 items-center justify-between pr-2 pl-20">
        <span className="text-[13px] font-semibold tracking-tight text-sidebar-foreground/90">Conductor</span>
        <SuggestionsInbox />
      </div>

      <SurfaceTabs />

      <div className="px-2 pb-2">
        <button
          type="button"
          onClick={() => { if (onHome) useChatStore.getState().select(null); else void newThread(); }}
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
        {onHome ? <ChatHistory /> : <>
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
              />
            ))}
          </ul>
        )}
        </>}
      </div>

      <ul className="flex shrink-0 flex-col gap-px border-t border-sidebar-border p-2">
        {NAV_ENTRIES.filter((entry) => entry.id !== 'home' && (!onHome || entry.id === 'settings' || entry.id === 'connected-apps')).map((entry) => {
          const Icon = NAV_ICONS[entry.id];
          return (
            <li key={entry.id}>
              <NavLink
                to={entry.path}
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
