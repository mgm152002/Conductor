import { HashRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { DEFAULT_PATH, NAV_ENTRIES } from './navigation';
import type { NavEntryId } from './navigation';
import { WorkScreen } from './screens/WorkScreen';
import {
  ActiveTasksScreen,
  ConnectedAppsScreen,
  HomeScreen,
  MemoryScreen,
  ProjectsScreen,
  LearningScreen,
  SettingsScreen,
  SkillsScreen,
  UsageScreen,
  WorkflowsScreen,
} from './screens';

// Maps each navigation entry id to the screen it routes to. Keyed by
// `NavEntryId` so adding or removing an entry in `navigation.ts` forces a
// matching screen here at compile time. The routes are generated from
// `NAV_ENTRIES`, keeping the sidebar and the router driven by one list.
const SCREENS: Record<NavEntryId, () => React.JSX.Element> = {
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
          {NAV_ENTRIES.map((entry) => {
            const Screen = SCREENS[entry.id];
            // `path` leads with "/"; strip it for the relative child route.
            return (
              <Route
                key={entry.id}
                path={entry.path.replace(/^\//, '')}
                element={<Screen />}
              />
            );
          })}
          <Route path="*" element={<Navigate to={DEFAULT_PATH} replace />} />
        </Route>
      </Routes>
    </HashRouter>
  );
}
