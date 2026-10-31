import { CliCatalog } from '../components/connected-apps';
import { FolderConnectors } from '../components/connected-apps/FolderConnectors';
import { McpServers } from '../components/connected-apps/McpServers';
import { RemoteHosts } from '../components/connected-apps/RemoteHosts';
import { ScreenScaffold } from './ScreenScaffold';
import { PlugIcon } from '../components/ui/icons';

export function ConnectedAppsScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Connections"
      screen="connected-apps"
      layout="wide"
      icon={<PlugIcon size={14} />}
    >
      {/* Integrations hub: four independent panels in a 2x2, sources first. */}
      <div className="grid items-start gap-6 lg:grid-cols-2">
        <FolderConnectors />
        <CliCatalog />
        <RemoteHosts />
        <McpServers />
      </div>
    </ScreenScaffold>
  );
}
