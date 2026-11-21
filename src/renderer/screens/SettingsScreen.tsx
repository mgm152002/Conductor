import { useMemo, useState, type ComponentType } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';
import {
  BotIcon, CodeXmlIcon, GitBranchIcon, GlobeIcon, KeyRoundIcon, PaletteIcon, PlugIcon, SearchIcon, ShieldIcon, XIcon,
  type LucideIcon,
} from 'lucide-react';
import { AgentModels } from '../components/settings/AgentModels';
import { AppearanceSettings } from '../components/settings/AppearanceSettings';
import { BrowserSettings } from '../components/settings/BrowserSettings';
import { ExecutionSettings } from '../components/settings/ExecutionSettings';
import { GitHubSettings } from '../components/settings/GitHubSettings';
import { IntegrationSettings } from '../components/settings/IntegrationSettings';
import { SettingsGroup, SettingsPage, SettingsSection } from '../components/settings/SettingsLayout';
import { WorkspaceManager } from '../components/settings/WorkspaceManager';
import { AppRouteModal, AppRouteModalClose } from '../components/ui/AppRouteModal';
import { Kbd } from '../components/ui/primitives';
import { cn } from '../lib/cn';
import { SecretsPanel } from './SecretsScreen';

// Settings, laid out as a settings modal: a
// grouped navigation with search at the left, a "Settings / Section" header,
// and one page per section in the readable column.

interface SettingsPageDef {
  id: string;
  label: string;
  Icon: LucideIcon;
  /** Words the search also matches. */
  keywords: string;
  Component: ComponentType;
}

const wrapped = (title: string, Body: ComponentType, card = true): ComponentType => function Section() {
  return <SettingsSection title={title}>{card ? <SettingsGroup><Body /></SettingsGroup> : <Body />}</SettingsSection>;
};

const GROUPS: Array<{ heading?: string; pages: SettingsPageDef[] }> = [
  {
    pages: [
      { id: 'appearance', label: 'Appearance', Icon: PaletteIcon, keywords: 'theme dark light color scheme', Component: AppearanceSettings },
      { id: 'execution', label: 'Execution & data', Icon: ShieldIcon, keywords: 'permissions consent data delete privacy', Component: ExecutionSettings },
    ],
  },
  {
    heading: 'Agents',
    pages: [
      { id: 'models', label: 'Agent models', Icon: BotIcon, keywords: 'model fallback default codex claude', Component: wrapped('Agent models', AgentModels, false) },
      { id: 'browser', label: 'Browser', Icon: GlobeIcon, keywords: 'chrome cloud sandbox selenium profile', Component: wrapped('Browser', BrowserSettings) },
      { id: 'secrets', label: 'Secrets', Icon: KeyRoundIcon, keywords: 'password keychain api key token credential', Component: SecretsPanel },
    ],
  },
  {
    heading: 'Code',
    pages: [
      { id: 'projects', label: 'Projects', Icon: CodeXmlIcon, keywords: 'workspace folder repository', Component: wrapped('Projects', WorkspaceManager, false) },
      { id: 'github', label: 'Source control', Icon: GitBranchIcon, keywords: 'github token pull request commit', Component: GitHubSettings },
    ],
  },
  {
    heading: 'Connections',
    pages: [
      { id: 'integrations', label: 'Integrations', Icon: PlugIcon, keywords: 'consent provider credentials', Component: wrapped('Integrations', IntegrationSettings, false) },
    ],
  },
];

const PAGES = GROUPS.flatMap((group) => group.pages);
/** The settings pages, in nav order (Usage is its own modal, not a settings page). */
export const SETTINGS_PAGE_IDS: readonly string[] = PAGES.map((page) => page.id);

const ROW = 'flex h-8 w-full cursor-pointer items-center gap-2 overflow-hidden rounded-[var(--control-radius)] px-2.5 py-1.5 text-left text-sm font-medium text-sidebar-muted-foreground/80 outline-hidden transition-colors hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-[var(--sidebar-icon-color)] hover:[&>svg]:text-sidebar-foreground';
const ACTIVE = 'bg-sidebar-row-active font-medium text-sidebar-foreground [&>svg]:text-sidebar-foreground';

function SettingsNav({ current, onPick }: { current: string; onPick: (id: string) => void }): React.JSX.Element {
  const [query, setQuery] = useState('');
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === '' ? [] : PAGES.filter((page) => `${page.label} ${page.keywords}`.toLowerCase().includes(q));
  }, [query]);
  return (
    <nav aria-label="Settings sections" className="flex w-60 shrink-0 flex-col border-e border-border bg-sidebar text-sidebar-foreground max-md:w-14">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
        <label className="flex h-8 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground max-md:hidden">
          <SearchIcon className="size-4 shrink-0 text-sidebar-muted-foreground/80" />
          <input value={query} onChange={(event) => { setQuery(event.target.value); }} placeholder="Search" aria-label="Search settings"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && results[0] !== undefined) { onPick(results[0].id); setQuery(''); }
              if (event.key === 'Escape' && query !== '') { event.preventDefault(); event.stopPropagation(); setQuery(''); }
            }}
            className="min-w-0 flex-1 bg-transparent text-sm text-sidebar-foreground outline-none placeholder:text-sidebar-muted-foreground" />
          {query !== '' ? (
            <button type="button" aria-label="Clear search" className="shrink-0 cursor-pointer" onClick={() => { setQuery(''); }}><XIcon className="size-3" /></button>
          ) : <Kbd>/</Kbd>}
        </label>
        {query.trim() !== '' ? (
          results.length === 0 ? <p className="px-2 py-6 text-center text-xs text-sidebar-muted-foreground">No settings match.</p> : (
            <ul className="flex flex-col gap-0.5">
              {results.map((page) => (
                <li key={page.id}>
                  <button type="button" className={cn(ROW, 'h-auto min-h-10 items-start')} onClick={() => { onPick(page.id); setQuery(''); }}>
                    <page.Icon />
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium text-sidebar-foreground">{page.label}</span></span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : (
          <div className="flex flex-col gap-4">
            {GROUPS.map((group, index) => (
              <div key={group.heading ?? index} className="flex flex-col gap-1">
                {group.heading !== undefined ? <h3 className="px-2 text-xs font-medium text-sidebar-muted-foreground/80 max-md:sr-only">{group.heading}</h3> : null}
                <ul className="flex flex-col gap-0.5">
                  {group.pages.map((page) => (
                    <li key={page.id}>
                      <button type="button" aria-current={current === page.id ? 'page' : undefined} onClick={() => { onPick(page.id); }} className={cn(ROW, current === page.id && ACTIVE)}>
                        <page.Icon />
                        <span className="truncate max-md:sr-only">{page.label}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        )}
      </div>
    </nav>
  );
}

export function SettingsScreen({ onClose }: { onClose?: () => void }): React.JSX.Element {
  const { section } = useParams();
  const navigate = useNavigate();
  const page = PAGES.find((item) => item.id === section);
  if (page === undefined) return <Navigate to="/settings/appearance" replace />;
  const close = onClose ?? ((): void => { void navigate(-1); });
  return (
    <AppRouteModal label="Settings" onClose={close}>
      <div className="relative flex min-h-0 flex-1">
        <SettingsNav current={page.id} onPick={(id) => { void navigate(`/settings/${id}`, { replace: true }); }} />
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border ps-5 pe-2">
            <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-2 text-sm">
              <span className="text-muted-foreground">Settings</span>
              <span aria-hidden className="text-muted-foreground/60">/</span>
              <span className="truncate font-medium text-foreground">{page.label}</span>
            </nav>
            <div className="ms-auto flex shrink-0 items-center gap-1"><AppRouteModalClose onClose={close} /></div>
          </header>
          <SettingsPage key={page.id}><page.Component /></SettingsPage>
        </div>
      </div>
    </AppRouteModal>
  );
}
