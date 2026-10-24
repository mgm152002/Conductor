import { ScreenScaffold } from './ScreenScaffold';
import { WorkspaceManager } from '../components/settings/WorkspaceManager';

export function ProjectsScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Projects"
      description="Organize work into projects, each with its own context, memory, and connected sources."
    >
      <WorkspaceManager />
    </ScreenScaffold>
  );
}
