import { Suspense, lazy } from 'react';
import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { DEFAULT_PATH, NAV_ENTRIES } from './navigation';
import type { NavEntryId } from './navigation';
import { WorkScreen } from './screens/WorkScreen';
import { HomeScreen } from './screens/HomeScreen';
import { Spinner } from './components/ui/icons';

// Fast first paint: only the two surfaces a session can land on (Chat and
// Work) ship in the entry bundle. Every other destination is a separate
// chunk the renderer fetches on first navigation and caches afterwards, so
// startup never pays for Settings, Memory, the PR reader, and the rest.
const PullRequestScreen = lazy(() => import('./screens/PullRequestScreen').then((m) => ({ default: m.PullRequestScreen })));
const ProjectsScreen = lazy(() => import('./screens/ProjectsScreen').then((m) => ({ default: m.ProjectsScreen })));
const ActiveTasksScreen = lazy(() => import('./screens/ActiveTasksScreen').then((m) => ({ default: m.ActiveTasksScreen })));
const LearningScreen = lazy(() => import('./screens/LearningScreen').then((m) => ({ default: m.LearningScreen })));
const WorkflowsScreen = lazy(() => import('./screens/WorkflowsScreen').then((m) => ({ default: m.WorkflowsScreen })));
const SkillsScreen = lazy(() => import('./screens/SkillsScreen').then((m) => ({ default: m.SkillsScreen })));
const ConnectedAppsScreen = lazy(() => import('./screens/ConnectedAppsScreen').then((m) => ({ default: m.ConnectedAppsScreen })));
const MemoryScreen = lazy(() => import('./screens/MemoryScreen').then((m) => ({ default: m.MemoryScreen })));
const UsageScreen = lazy(() => import('./screens/UsageScreen').then((m) => ({ default: m.UsageScreen })));
const SettingsScreen = lazy(() => import('./screens/SettingsScreen').then((m) => ({ default: m.SettingsScreen })));

function ScreenFallback(): React.JSX.Element {
  return (
    <div className="animate-page-in flex h-full items-center justify-center gap-2 text-sm text-muted-foreground" role="status">
      <Spinner size={15} /> Loading…
    </div>
  );
}

// Maps each navigation entry id to the screen it routes to. Keyed by
// `NavEntryId` so adding or removing an entry in `navigation.ts` forces a
// matching screen here at compile time. The routes are generated from
// `NAV_ENTRIES`, keeping the sidebar and the router driven by one list.
const SCREENS: Record<NavEntryId, React.ElementType> = {
  home: HomeScreen,
  projects: ProjectsScreen,
  'active-tasks': ActiveTasksScreen,
  learning: LearningScreen,
  workflows: WorkflowsScreen,
  skills: SkillsScreen,
  'connected-apps': ConnectedAppsScreen,
  memory: MemoryScreen,
  usage: UsageScreen,
  settings: SettingsScreen,
};

// A HashRouter is used because the packaged renderer loads from a `file://`
// origin where path-based history has no server to resolve deep links.
export function App(): React.JSX.Element {
  return (
    <HashRouter>
      <Routes>
        <Route element={<AppLayout />}>
          <Route index element={<Navigate to={DEFAULT_PATH} replace />} />
          <Route path="work" element={<WorkScreen />} />
          <Route path="pr/:workspaceId/:number" element={<Suspense fallback={<ScreenFallback />}><PullRequestScreen /></Suspense>} />
          {NAV_ENTRIES.map((entry) => {
            const Screen = SCREENS[entry.id];
            // `path` leads with "/"; strip it for the relative child route.
            return (
              <Route
                key={entry.id}
                path={entry.path.replace(/^\//, '')}
                element={<Suspense fallback={<ScreenFallback />}><Screen /></Suspense>}
              />
            );
          })}
          <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
