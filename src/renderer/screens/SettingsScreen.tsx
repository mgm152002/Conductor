import type { ReactNode } from 'react';
import { ExecutionSettings } from '../components/settings/ExecutionSettings';
import { IntegrationSettings } from '../components/settings/IntegrationSettings';
import { AgentModels } from '../components/settings/AgentModels';
import { GitHubSettings } from '../components/settings/GitHubSettings';
import { ScreenScaffold } from './ScreenScaffold';
import { WorkspaceManager } from '../components/settings/WorkspaceManager';
import { useThemeStore } from '../stores';

// Settings in the T3 shape: a label above each grouped card, rows divided by
// hairlines, controls on the right. Each settings area keeps its own logic;
// this screen only gives them the shared grouped-card chrome.

function SettingGroup({ label, children }: { label: string; children: ReactNode }): React.JSX.Element {
  return (
    <section>
      <h2 className="group-label">{label}</h2>
      <div className="group-card px-4 py-4">{children}</div>
    </section>
  );
}

export function SettingsScreen(): React.JSX.Element {
  const appearance = useThemeStore((s) => s.appearance);

  return (
    <ScreenScaffold
      title="Settings"
      description="Manage workspaces, permission profiles, appearance, connected accounts, and data control."
    >
      <div className="flex flex-col gap-8">
        <SettingGroup label="Projects">
          <WorkspaceManager />
        </SettingGroup>
        <SettingGroup label="Execution & data">
          <ExecutionSettings />
        </SettingGroup>
        <SettingGroup label="Agent models">
          <AgentModels />
        </SettingGroup>
        <SettingGroup label="GitHub">
          <GitHubSettings />
        </SettingGroup>
        <SettingGroup label="Integrations">
          <IntegrationSettings />
        </SettingGroup>
        <section>
          <h2 className="group-label">Appearance</h2>
          <div className="group-card">
            <div className="group-row">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">System appearance</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Conductor follows the macOS setting automatically.</p>
              </div>
              <span className="seg-control">
                <span className="seg-item" data-active="true">{appearance === 'dark' ? 'Dark' : 'Light'}</span>
              </span>
            </div>
          </div>
        </section>
      </div>
    </ScreenScaffold>
  );
}
