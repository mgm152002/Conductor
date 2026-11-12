import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { NAV_ENTRIES } from '../navigation';
import { useTaskStore, useUiStore, useWorkspaceStore } from '../stores';
import { useChatStore } from '../stores/chat-store';
import { useThreadNavigation } from '../hooks/useThreadNavigation';
import { groupThreads } from '../lib/threads';
import { threadTitle } from '../lib/thread-status';
import { relativeTime } from '../lib/time';
import { cn } from '../lib/cn';
import {
  FolderIcon, FolderPlusIcon, MessageIcon, PanelLeftIcon, ReturnIcon, SearchIcon, SquarePenIcon, TerminalIcon,
} from './ui/icons';

// ⌘K: one field that reaches everything — any screen, any project thread,
// any chat, and the handful of actions that start something new. Results
// are grouped, the first match is preselected, and it is fully keyboard
// driven (arrows, Enter, Escape).

interface Command {
  id: string;
  group: 'Actions' | 'Go to' | 'Threads' | 'Chats';
  label: string;
  /** Secondary text at the right (project, time, shortcut). */
  hint?: string;
  /** Extra text matched by the filter but not shown. */
  keywords?: string;
  icon: React.ReactNode;
  run: () => void;
}

const GROUP_ORDER: Command['group'][] = ['Actions', 'Go to', 'Threads', 'Chats'];
/** With no query, long lists are trimmed to their most recent entries. */
const IDLE_LIMIT: Partial<Record<Command['group'], number>> = { Threads: 6, Chats: 5 };

function matches(command: Command, terms: string[]): boolean {
  const haystack = `${command.label} ${command.hint ?? ''} ${command.keywords ?? ''} ${command.group}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function PaletteBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  const navigate = useNavigate();
  const { openThread, newThread } = useThreadNavigation();
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const tasks = useTaskStore((s) => s.tasks);
  const chats = useChatStore((s) => s.threads);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const list = useRef<HTMLDivElement>(null);

  const commands = useMemo<Command[]>(() => {
    const projectName = new Map(workspaces.map((workspace) => [workspace.id, workspace.name]));
    const ui = useUiStore.getState();
    const result: Command[] = [
      { id: 'new-thread', group: 'Actions', label: 'New thread', hint: '⌘N', keywords: 'work task start', icon: <SquarePenIcon size={15} />, run: () => { void newThread(); } },
      { id: 'new-chat', group: 'Actions', label: 'New chat', keywords: 'conversation ask', icon: <MessageIcon size={15} />, run: () => { useChatStore.getState().select(null); navigate('/home'); } },
      { id: 'add-project', group: 'Actions', label: 'Add project', keywords: 'folder workspace', icon: <FolderPlusIcon size={15} />, run: () => { ui.setAddProjectOpen(true); } },
      { id: 'toggle-panel', group: 'Actions', label: ui.panelCollapsed ? 'Show thread list' : 'Hide thread list', hint: '⌘B', keywords: 'sidebar panel', icon: <PanelLeftIcon size={15} />, run: () => { ui.setPanelCollapsed(!ui.panelCollapsed); } },
      ...workspaces.map((workspace): Command => ({
        id: `new-in:${workspace.id}`, group: 'Actions', label: `New thread in ${workspace.name}`, keywords: `project ${workspace.rootPath}`,
        icon: <FolderIcon size={15} />, run: () => { void newThread(workspace.id); },
      })),
      { id: 'go:work', group: 'Go to', label: 'Work', keywords: 'threads projects', icon: <TerminalIcon size={15} />, run: () => { navigate('/work'); } },
      { id: 'go:agents', group: 'Go to', label: 'Agents', keywords: 'sandbox bots browser', icon: <span className="size-[15px]" />, run: () => { navigate('/agents'); } },
      { id: 'go:home', group: 'Go to', label: 'Chat', keywords: 'home conversations', icon: <MessageIcon size={15} />, run: () => { navigate('/home'); } },
      ...NAV_ENTRIES.filter((entry) => entry.id !== 'home').map((entry): Command => ({
        id: `go:${entry.id}`, group: 'Go to', label: entry.id === 'connected-apps' ? 'Connections' : entry.label,
        ...(entry.id === 'settings' ? { hint: '⌘,' } : {}),
        keywords: entry.id === 'connected-apps' ? 'connected apps mcp agents cli' : entry.id === 'usage' ? 'cost tokens limits' : '',
        icon: <span className="size-[15px]" />, run: () => { navigate(entry.path); },
      })),
      ...groupThreads(Object.values(tasks)).map((thread): Command => ({
        id: `thread:${thread.key}`, group: 'Threads', label: threadTitle(thread.root),
        hint: [projectName.get(thread.root.workspaceId), relativeTime(thread.latest.updatedAt)].filter(Boolean).join('  '),
        icon: <TerminalIcon size={15} />, run: () => { void openThread(thread.latest); },
      })),
      ...chats.map((chat): Command => ({
        id: `chat:${chat.id}`, group: 'Chats', label: chat.title, hint: relativeTime(chat.updatedAt),
        icon: <MessageIcon size={15} />, run: () => { useChatStore.getState().select(chat.id); navigate('/home'); },
      })),
    ];
    return result;
  }, [workspaces, tasks, chats, navigate, newThread, openThread]);

  const groups = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const filtered = terms.length === 0 ? commands : commands.filter((command) => matches(command, terms));
    return GROUP_ORDER.map((group) => {
      const items = filtered.filter((command) => command.group === group);
      const limit = terms.length === 0 ? IDLE_LIMIT[group] : undefined;
      return { group, items: limit !== undefined ? items.slice(0, limit) : items.slice(0, 30) };
    }).filter((entry) => entry.items.length > 0);
  }, [commands, query]);
  const flat = useMemo(() => groups.flatMap((entry) => entry.items), [groups]);
  const active = flat[Math.min(index, flat.length - 1)];

  useEffect(() => { setIndex(0); }, [query]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>('[data-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [active?.id]);

  const run = (command: Command | undefined): void => {
    if (command === undefined) return;
    onClose();
    command.run();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[14vh]">
      <div className="absolute inset-0 bg-black/35 backdrop-blur-[2px]" onClick={onClose} aria-hidden="true" />
      <div role="dialog" aria-modal="true" aria-label="Search and commands" className="animate-pop-in relative z-10 flex max-h-[min(30rem,70vh)] w-full max-w-[36rem] flex-col overflow-hidden rounded-2xl border border-border bg-surface-raised text-foreground shadow-pop">
        <label className="flex h-12 shrink-0 items-center gap-3 border-b border-border px-4 text-muted-foreground">
          <SearchIcon size={16} />
          <span className="sr-only">Search threads, chats, screens and actions</span>
          <input
            autoFocus
            value={query}
            onChange={(event) => { setQuery(event.target.value); }}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setIndex((i) => (flat.length === 0 ? 0 : (Math.min(i, flat.length - 1) + 1) % flat.length)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setIndex((i) => (flat.length === 0 ? 0 : (Math.min(i, flat.length - 1) - 1 + flat.length) % flat.length)); }
              else if (event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); run(active); }
              else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            }}
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-results"
            aria-activedescendant={active !== undefined ? `command-${active.id}` : undefined}
            placeholder="Search threads, chats, screens and actions"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-foreground outline-none placeholder:text-muted-foreground/70"
          />
          <kbd className="rounded border border-border px-1.5 py-0.5 font-sans text-3xs text-muted-foreground">esc</kbd>
        </label>
        <div ref={list} id="command-palette-results" role="listbox" aria-label="Results" className="min-h-0 flex-1 overflow-y-auto p-1.5">
          {flat.length === 0 ? (
            <p className="px-3 py-8 text-center text-[13px] text-muted-foreground">Nothing matches “{query}”.</p>
          ) : groups.map((entry) => (
            <div key={entry.group} role="group" aria-label={entry.group} className="pb-1">
              <p aria-hidden="true" className="px-2.5 pt-2 pb-1 text-2xs font-semibold text-muted-foreground">{entry.group}</p>
              {entry.items.map((command) => {
                const selected = command.id === active?.id;
                return (
                  <div
                    key={command.id}
                    id={`command-${command.id}`}
                    role="option"
                    aria-selected={selected}
                    data-selected={selected}
                    onMouseMove={() => { const at = flat.indexOf(command); if (at !== index) setIndex(at); }}
                    onClick={() => { run(command); }}
                    className={cn('flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-[13px]', selected ? 'bg-accent text-foreground' : 'text-foreground/85')}
                  >
                    <span className={cn('flex shrink-0 items-center', selected ? 'text-primary' : 'text-muted-foreground')}>{command.icon}</span>
                    <span className="min-w-0 flex-1 truncate">{command.label}</span>
                    {command.hint !== undefined ? <span className="max-w-[45%] shrink-0 truncate text-2xs text-muted-foreground tabular-nums">{command.hint}</span> : null}
                    {selected ? <ReturnIcon size={13} className="shrink-0 text-muted-foreground" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function CommandPalette(): React.JSX.Element | null {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  // Restore focus to whatever had it (usually the composer) on close.
  const previous = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (open) { previous.current = document.activeElement as HTMLElement | null; return; }
    previous.current?.focus?.();
    previous.current = null;
  }, [open]);
  if (!open || typeof document === 'undefined') return null;
  return createPortal(<PaletteBody onClose={() => { setOpen(false); }} />, document.body);
}
