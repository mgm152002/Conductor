import { useEffect, useRef, useState, type ReactNode } from 'react';
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

// Settings as an indexed page: a sticky list of sections at the left that
// jumps to (and tracks) each group, and the groups themselves in one column
// at the right. Each settings area keeps its own logic; this screen only
// gives them the shared grouped-card chrome.

const SECTIONS = [
  { id: 'appearance', label: 'Appearance' },
  { id: 'execution', label: 'Execution & data' },
  { id: 'agent-models', label: 'Agent models' },
  { id: 'projects', label: 'Projects' },
  { id: 'github', label: 'GitHub' },
  { id: 'integrations', label: 'Integrations' },
] as const;

type SectionId = (typeof SECTIONS)[number]['id'];

function SettingGroup({ id, children, padded = true }: { id: SectionId; children: ReactNode; padded?: boolean }): React.JSX.Element {
  const label = SECTIONS.find((section) => section.id === id)!.label;
  return (
    <section id={`settings-${id}`} data-settings-section={id} aria-label={label} className="scroll-mt-6">
      <h2 className="group-label">{label}</h2>
      <div className={cn('group-card', padded && 'px-4 py-4')}>{children}</div>
    </section>
  );
}

export function SettingsScreen(): React.JSX.Element {
  const appearance = useThemeStore((s) => s.appearance);
  const accent = useThemeStore((s) => s.accent);
  const setAccent = useThemeStore((s) => s.setAccent);

  const [current, setCurrent] = useState<SectionId>('appearance');
  const content = useRef<HTMLDivElement>(null);
  // Track the section nearest the top of the viewport so the index follows scrolling.
  useEffect(() => {
    const root = content.current;
    if (root === null || typeof IntersectionObserver === 'undefined') return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.settingsSection!;
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      const first = SECTIONS.find((section) => visible.has(section.id));
      if (first !== undefined) setCurrent(first.id);
    }, { rootMargin: '-10% 0px -55% 0px' });
    for (const element of root.querySelectorAll('[data-settings-section]')) observer.observe(element);
    return () => { observer.disconnect(); };
  }, []);

  return (
    <ScreenScaffold
      title="Settings"
      screen="settings"
      layout="wide"
      icon={<SettingsIcon size={16} />}
    >
      <div className="grid gap-8 md:grid-cols-[11rem_minmax(0,1fr)]">
        <nav aria-label="Settings sections" className="hidden md:block">
          <ul className="sticky top-6 flex flex-col gap-0.5">
            {SECTIONS.map((section) => (
              <li key={section.id}>
                <button
                  type="button"
                  aria-current={current === section.id ? 'true' : undefined}
                  onClick={() => {
                    setCurrent(section.id);
                    document.getElementById(`settings-${section.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }}
                  className={cn(
                    'flex h-8 w-full cursor-pointer items-center rounded-lg px-2.5 text-left text-[13px] transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    current === section.id ? 'bg-accent font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {section.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div ref={content} className="flex min-w-0 max-w-3xl flex-col gap-8">
          <SettingGroup id="appearance" padded={false}>
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
              <div className="flex shrink-0 items-center gap-2" role="radiogroup" aria-label="Accent colour">
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
                      'size-6 cursor-pointer rounded-full transition-transform duration-150 hover:scale-110 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
                      accent === option.id && 'ring-2 ring-foreground ring-offset-2 ring-offset-card',
                    )}
                    style={{ backgroundColor: option.swatch }}
                  />
                ))}
              </div>
            </div>
          </SettingGroup>
          <SettingGroup id="execution">
            <ExecutionSettings />
          </SettingGroup>
          <SettingGroup id="agent-models">
            <AgentModels />
          </SettingGroup>
          <SettingGroup id="projects">
            <WorkspaceManager />
          </SettingGroup>
          <SettingGroup id="github">
            <GitHubSettings />
          </SettingGroup>
          <SettingGroup id="integrations">
            <IntegrationSettings />
          </SettingGroup>
        </div>
      </div>
    </ScreenScaffold>
  );
}
