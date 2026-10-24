import { CliCatalog } from '../components/connected-apps';
import { FolderConnectors } from '../components/connected-apps/FolderConnectors';
import { McpServers } from '../components/connected-apps/McpServers';
import { RemoteHosts } from '../components/connected-apps/RemoteHosts';
import { ScreenScaffold } from './ScreenScaffold';

export function ConnectedAppsScreen(): React.JSX.Element {
  return (
    <ScreenScaffold
      title="Connections"
      description="Sources Conductor indexes for context, the agents it routes tasks to (local CLIs and remote hosts), and MCP tools."
    >
      <div className="flex flex-col gap-10">
        <FolderConnectors />
        <CliCatalog />
        <RemoteHosts />
        <McpServers />
      </div>
    </ScreenScaffold>
  );
}
