import { ScreenScaffold } from './ScreenScaffold';
import { WorkspaceManager } from '../components/settings/WorkspaceManager';
import { FolderIcon } from '../components/ui/icons';

export function ProjectsScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Projects"
      screen="projects"
      layout="wide"
      icon={<FolderIcon size={14} />}
    >
      <WorkspaceManager />
    </ScreenScaffold>
  );
}
