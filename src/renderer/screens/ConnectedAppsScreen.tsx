import { useState } from 'react';
import { CliCatalog } from '../components/connected-apps';
import { FolderConnectors } from '../components/connected-apps/FolderConnectors';
import { McpServers } from '../components/connected-apps/McpServers';
import { CliMcpServers } from '../components/connected-apps/CliMcpServers';
import { RemoteHosts } from '../components/connected-apps/RemoteHosts';
import { ScreenScaffold } from './ScreenScaffold';
import { LayersIcon, PlugIcon } from '../components/ui/icons';

type ConnectionsTab = 'connections' | 'mcp';

const TABS: { id: ConnectionsTab; label: string; Icon: typeof PlugIcon }[] = [
  { id: 'connections', label: 'Agents & sources', Icon: PlugIcon },
  { id: 'mcp', label: 'MCP servers', Icon: LayersIcon },
];

export function ConnectedAppsScreen(): React.JSX.Element {
  const [tab, setTab] = useState<ConnectionsTab>('connections');
  return (
    <ScreenScaffold
      title="Connections"
      screen="connected-apps"
      layout="wide"
      icon={<PlugIcon size={16} />}
      actions={<div className="seg-control" role="tablist" aria-label="Connections sections">
          {TABS.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              data-active={tab === id}
              onClick={() => { setTab(id); }}
              className="seg-item focus-visible:outline-2 focus-visible:outline-ring"
            >
              {label}
            </button>
          ))}
        </div>}
    >
      {tab === 'connections' ? (
        // Single stacked column: panels have very different heights, so a
        // two-column grid leaves a dead empty half under the shorter one.
        <div className="flex flex-col gap-10" role="tabpanel" aria-label="Agents and sources">
          <CliCatalog />
          <FolderConnectors />
          <RemoteHosts />
        </div>
      ) : (
        <div role="tabpanel" aria-label="MCP servers" className="flex flex-col gap-10">
          <CliMcpServers />
          <McpServers legacy />
        </div>
      )}
    </ScreenScaffold>
  );
}
