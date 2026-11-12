import { NavLink, useLocation } from 'react-router-dom';
import { NAV_ENTRIES, type NavEntryId } from '../navigation';
import { useApprovalStore, useQuestionStore, useTaskStore, useUiStore } from '../stores';
import { isTerminalTask } from '../stores/task-store';
import { SuggestionsInbox } from './suggestions/SuggestionsInbox';
import { SurfaceTabs } from './SurfaceTabs';
import { useState } from 'react';
import { PhoneIcon, SearchIcon, SettingsIcon } from './ui/icons';
import { PhoneControlDialog } from './phone/PhoneControlDialog';

// The top bar: the whole app's navigation in one line across the window.
// The two working surfaces (Work, Chat) lead as the primary tabs, the other
// destinations follow as quieter tabs, and search, the inbox and Settings
// sit at the right. Nothing lives in a left sidebar: Work and Chat open on
// their own boards, and the thread list is a drawer you call when you want it.

type BarEntryId = Exclude<NavEntryId, 'home' | 'workflows' | 'skills' | 'settings'>;

// Workflows and Skills stay out of the bar for now; their routes remain
// mounted in NAV_ENTRIES so they can return as-is.
const LABELS: Record<BarEntryId, string> = {
  projects: 'Projects',
  'active-tasks': 'Tasks',
  learning: 'Learning',
  'connected-apps': 'Connections',
  memory: 'Memory',
  usage: 'Usage',
};

function isBarEntry(id: NavEntryId): id is BarEntryId {
  return id in LABELS;
}

export function TopBar(): React.JSX.Element {
  const [phoneOpen, setPhoneOpen] = useState(false);
  const tasks = useTaskStore((s) => s.tasks);
  const approvals = useApprovalStore((s) => s.pending.length);
  const questions = useQuestionStore((s) => s.pending.length);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const { pathname } = useLocation();
  const running = Object.values(tasks).filter((task) => !isTerminalTask(task)).length;

  return (
    <nav aria-label="Destinations" className="app-drag flex h-(--bar-height) shrink-0 items-center gap-1 border-b border-sidebar-border bg-rail pr-2.5 pl-[84px] text-sidebar-foreground">
      <SurfaceTabs attention={approvals + questions} />
      <span aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-border-strong" />
      <ul className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none]">
        <li className="shrink-0">
          <NavLink to="/agents" data-active={pathname === '/agents'} className="bar-tab">Agents</NavLink>
        </li>
        {NAV_ENTRIES.map((entry) => {
          if (!isBarEntry(entry.id)) return null;
          const live = entry.id === 'active-tasks' && running > 0;
          return (
            <li key={entry.id} className="shrink-0">
              <NavLink
                to={entry.path}
                data-active={pathname === entry.path}
                aria-label={live ? `${entry.label}, ${running} running` : entry.label}
                title={live ? `${running} running` : undefined}
                className="bar-tab"
              >
                {LABELS[entry.id]}
                {live ? (
                  <span className="flex h-4 items-center gap-1 rounded-full bg-primary px-1.5 text-[9px] font-semibold text-primary-foreground tabular-nums">
                    <span aria-hidden="true" className="eq-bars"><span /><span /><span /></span>
                    {running}
                  </span>
                ) : null}
              </NavLink>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        onClick={() => { setPaletteOpen(true); }}
        aria-label="Search and commands"
        title="Search threads, chats, screens and actions"
        className="flex h-7 w-52 shrink cursor-pointer items-center gap-2 rounded-lg bg-sidebar-row-hover px-2.5 text-xs text-sidebar-muted-foreground transition-colors hover:text-sidebar-foreground focus-visible:outline-2 focus-visible:outline-ring max-[1100px]:w-auto"
      >
        <SearchIcon size={13} />
        <span className="flex-1 text-left max-[1100px]:hidden">Search or jump to…</span>
        <kbd className="font-sans text-2xs">⌘K</kbd>
      </button>
      <SuggestionsInbox variant="bar" />
      <button type="button" aria-label="Control on phone" title="Control on phone" onClick={() => { setPhoneOpen(true); }} className="bar-icon cursor-pointer">
        <PhoneIcon size={15} />
      </button>
      {phoneOpen ? <PhoneControlDialog onClose={() => { setPhoneOpen(false); }} /> : null}
      <NavLink to="/settings" aria-label="Settings" title="Settings (⌘,)" data-active={pathname === '/settings'} className="bar-icon">
        <SettingsIcon size={15} />
      </NavLink>
    </nav>
  );
}
