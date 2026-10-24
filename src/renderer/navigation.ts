// Single source of truth for the left-sidebar navigation. Requirement 22.3
// mandates EXACTLY these nine entries, in this order:
//   Home, Projects, Active tasks, Recent activity, Workflows, Skills,
//   Connected apps, Memory, Settings.
// The sidebar renders this list and the router builds its routes from it, so
// the set cannot drift between the two.

export interface NavEntry {
  /** Stable id, also used as the route path segment. */
  readonly id: string;
  /** Label shown in the sidebar. */
  readonly label: string;
  /** Route path mounted under the app layout. */
  readonly path: string;
}

export const NAV_ENTRIES = [
  { id: 'home', label: 'Home', path: '/home' },
  { id: 'projects', label: 'Projects', path: '/projects' },
  { id: 'active-tasks', label: 'Active tasks', path: '/active-tasks' },
  { id: 'recent-activity', label: 'Recent activity', path: '/recent-activity' },
  { id: 'workflows', label: 'Workflows', path: '/workflows' },
  { id: 'skills', label: 'Skills', path: '/skills' },
  { id: 'connected-apps', label: 'Connected apps', path: '/connected-apps' },
  { id: 'memory', label: 'Memory', path: '/memory' },
  { id: 'settings', label: 'Settings', path: '/settings' },
] as const satisfies readonly NavEntry[];

export type NavEntryId = (typeof NAV_ENTRIES)[number]['id'];

/** Path the app redirects to by default. */
export const DEFAULT_PATH = '/home';
