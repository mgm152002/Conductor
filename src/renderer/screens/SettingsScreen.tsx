import type { ReactNode } from 'react';
import { ExecutionSettings } from '../components/settings/ExecutionSettings';
import { IntegrationSettings } from '../components/settings/IntegrationSettings';
import { AgentModels } from '../components/settings/AgentModels';
import { GitHubSettings } from '../components/settings/GitHubSettings';
import { ScreenScaffold } from './ScreenScaffold';
import { WorkspaceManager } from '../components/settings/WorkspaceManager';
import { useThemeStore } from '../stores';
import { ACCENTS } from '../stores/theme-store';
import { SettingsIcon } from '../components/ui/icons';
import { cn } from '../lib/cn';

// Settings as a console board: a label above each grouped card, rows
// divided by hairlines, controls on the right, paired two-up on wide
// windows. Each settings area keeps its own logic; this screen only gives
// them the shared grouped-card chrome.

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
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);

  return (
    <ScreenScaffold
      title="Settings"
      screen="settings"
      icon={<SettingsIcon size={14} />}
    >
      <div className="flex flex-col gap-6">
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
                <p className="mt-0.5 text-xs text-muted-foreground">Follows macOS automatically.</p>
              </div>
              <span className="seg-control">
                <span className="seg-item" data-active="true">{appearance === 'dark' ? 'Dark' : 'Light'}</span>
              </span>
            </div>
            <div className="group-row">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium text-foreground">Accent colour</p>
                <p className="mt-0.5 text-xs text-muted-foreground">Buttons, selection, and focus. Saved on this Mac.</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5" role="radiogroup" aria-label="Accent colour">
                {ACCENTS.map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="radio"
                    aria-checked={accent === option.id}
                    title={option.label}
                    aria-label={option.label}
                    onClick={() => { setAccent(option.id); }}
                    className={cn(
                      'size-6 cursor-pointer rounded-md transition-transform duration-150 hover:scale-110 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      accent === option.id && 'ring-2 ring-foreground ring-offset-2 ring-offset-card',
                    )}
                    style={{ backgroundColor: option.swatch }}
                  />
                ))}
              </div>
            </div>
          </div>
        </section>
      </div>
    </ScreenScaffold>
  );
}
