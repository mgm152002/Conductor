import { ExecutionSettings } from '../components/settings/ExecutionSettings';
import { IntegrationSettings } from '../components/settings/IntegrationSettings';
import { AgentModels } from '../components/settings/AgentModels';
import { UsageSettings } from '../components/settings/UsageSettings';
import { ScreenScaffold } from './ScreenScaffold';
import { WorkspaceManager } from '../components/settings/WorkspaceManager';
import { useThemeStore } from '../stores';

// Settings surfaces workspace management (create/list/select wired to the
// `window.conductor` bridge) and the current appearance. Appearance follows the
// macOS system setting automatically (Requirement 22.1, 22.2); it is shown here
// as read-only status so the user can confirm the app is tracking the OS.
export function SettingsScreen(): React.JSX.Element {
  const appearance = useThemeStore((s) => s.appearance);

  return (
    <ScreenScaffold
      title="Settings"
      description="Manage workspaces, permission profiles, appearance, connected accounts, and data control."
    >
      <div className="flex flex-col gap-8">
        <WorkspaceManager />
        <ExecutionSettings />
        <AgentModels />
        <UsageSettings />
        <IntegrationSettings />
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-foreground">
            Appearance
          </h2>
          <p className="text-sm text-muted-foreground">
            Following the macOS system setting — currently{' '}
            <span className="font-medium text-foreground">
              {appearance}
            </span>
            .
          </p>
        </section>
      </div>
    </ScreenScaffold>
  );
}
