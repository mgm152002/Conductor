import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { AgentOption } from '@shared/integrations-contract';
import type { DataControlSettings, PermissionProfile } from '@shared/domain';
import type { Mem0Health } from '@shared/chat-contract';
import { useUiStore, useWorkspaceStore } from '../../stores';
import { isOnboardingCompleted, markOnboardingCompleted } from '../../lib/onboarding';
import { cn } from '../../lib/cn';
import { Button, Switch, inputClassName } from '../ui/primitives';
import { CheckIcon, FolderIcon } from '../ui/icons';
import { ProviderAvatar, agentBrand } from '../ui/BrandMarks';
import { SettingsGroup, SettingsRow } from '../settings/SettingsLayout';

// First-run setup: welcome → agents → permissions → project → done. Every
// change is an explicit click, each step can be skipped, and the walkthrough
// never reappears once finished or skipped (it can be reopened from the store).

const STEPS = ['welcome', 'agents', 'permissions', 'project', 'memory', 'done'] as const;
type Step = (typeof STEPS)[number];

const TITLES: Record<Step, string> = {
  welcome: 'Welcome to Conductor',
  agents: 'Connect an agent',
  permissions: 'Choose how agents may work',
  project: 'Add your first project',
  memory: 'Set up memory',
  done: 'You’re all set',
};

const RAIL_LABELS: Record<Step, string> = {
  welcome: 'Welcome',
  agents: 'Agents',
  permissions: 'Permissions',
  project: 'Project',
  memory: 'Memory',
  done: 'Ready',
};

function Check({ ok }: { ok: boolean }): React.JSX.Element {
  return <span aria-hidden="true" className={cn('inline-block size-1.5 shrink-0 rounded-full', ok ? 'bg-success' : 'bg-muted-foreground/50')} />;
}

const PROFILES: { id: PermissionProfile; label: string; hint: string }[] = [
  { id: 'read_only', label: 'Read-only', hint: 'Agents can read your project but cannot change anything.' },
  { id: 'assisted_execution', label: 'Assisted execution', hint: 'Agents can work, and you approve each command or file change. Recommended.' },
  { id: 'trusted_automation', label: 'Trusted automation', hint: 'Agents run within pre-approved grants with fewer prompts.' },
];

const MEM0_COMMANDS: { label: string; command: string }[] = [
  { label: '1. Create the local API key and connect Conductor', command: 'npm run mem0:configure' },
  { label: '2. Start Mem0 + Qdrant (Docker)', command: 'docker compose -f services/mem0/compose.yaml up -d --build' },
  { label: 'Check status', command: 'docker compose -f services/mem0/compose.yaml ps' },
  { label: 'Stop later', command: 'docker compose -f services/mem0/compose.yaml stop' },
];

function CopyCommand({ label, command }: { label: string; command: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <p className="mb-0.5 text-2xs text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2 rounded-lg bg-code px-2.5 py-1.5">
        <code className="min-w-0 flex-1 font-mono text-2xs break-all select-all">{command}</code>
        <Button size="xs" variant="ghost" onClick={() => {
          void navigator.clipboard.writeText(command).then(() => { setCopied(true); window.setTimeout(() => { setCopied(false); }, 1500); }).catch(() => undefined);
        }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}

/** A labelled shortcut to the full settings for the current step. */
function SettingsLinks({ links }: { links: { label: string; path: string }[] }): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5 text-2xs text-muted-foreground">
      <span>Related settings:</span>
      {links.map((link) => (
        <button key={link.path + link.label} type="button" className="cursor-pointer underline hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
          onClick={() => { useUiStore.getState().setOnboardingOpen(false); navigate(link.path); }}>{link.label}</button>
      ))}
    </div>
  );
}

export function OnboardingWalkthrough(): React.JSX.Element | null {
  const navigate = useNavigate();
  const open = useUiStore((s) => s.onboardingOpen);
  const addProjectOpen = useUiStore((s) => s.addProjectOpen);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const [step, setStep] = useState<Step>('welcome');
  const [onboardingStarted, setStarted] = useState(false);
  useEffect(() => { if (open) setStarted(true); }, [open]);
  const index0 = STEPS.indexOf(step);
  const [agents, setAgents] = useState<AgentOption[] | null>(null);
  const [profile, setProfile] = useState<PermissionProfile | null>(null);
  const [consented, setConsented] = useState<Set<string>>(new Set());
  const [mem0, setMem0] = useState<Mem0Health | null>(null);
  const [mem0Url, setMem0Url] = useState('http://127.0.0.1:8000');
  const [mem0Key, setMem0Key] = useState('');
  const [mem0Busy, setMem0Busy] = useState(false);
  const [dataSettings, setDataSettings] = useState<DataControlSettings | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Show on first launch only.
  useEffect(() => {
    if (!isOnboardingCompleted()) useUiStore.getState().setOnboardingOpen(true);
  }, []);

  const load = useCallback(async () => {
    try {
      const [list, currentProfile, consents, data, auto] = await Promise.all([
        window.conductor.agents.list(),
        window.conductor.permissions.getProfile(),
        window.conductor.dataControl.listConsents(),
        window.conductor.dataControl.getSettings(),
        window.conductor.settings.get('execution.autoApprove'),
      ]);
      setDataSettings(data);
      setAutoApprove(auto === true);
      setAgents(list);
      setProfile(currentProfile);
      setConsented(new Set(consents.filter((c) => c.revokedAt === undefined).map((c) => c.provider)));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  useEffect(() => { if (open) void load(); }, [open, load]);
  const checkMem0 = useCallback(async () => {
    try { setMem0(await window.conductor.chat.mem0Health()); } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { if (open && step === 'memory') void checkMem0(); }, [open, step, checkMem0]);

  async function connectMem0(): Promise<void> {
    setMem0Busy(true); setError(null);
    try {
      setMem0(await window.conductor.chat.mem0Configure({ url: mem0Url, apiKey: mem0Key }));
      setMem0Key('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setMem0Busy(false); }
  }

  const finish = useCallback((): void => {
    markOnboardingCompleted();
    useUiStore.getState().setOnboardingOpen(false);
    setStep('welcome');
  }, []);

  // Escape closes the setup to the "Resume setup" pill instead of ending it.
  useEffect(() => {
    if (!open || addProjectOpen) return;
    const onKey = (event: KeyboardEvent): void => { if (event.key === 'Escape') useUiStore.getState().setOnboardingOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); };
  }, [open, addProjectOpen]);

  // Hide while the Add-project dialog (shared with the sidebar) is on top.
  if (!open && !isOnboardingCompleted() && !addProjectOpen && onboardingStarted) {
    return (
      <button type="button" onClick={() => { useUiStore.getState().setOnboardingOpen(true); }}
        className="fixed bottom-4 left-4 z-40 cursor-pointer rounded-full border border-border bg-card px-3.5 py-2 text-xs font-medium text-foreground shadow-lg hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring">
        Resume setup · step {index0 + 1} of {STEPS.length}
      </button>
    );
  }
  if (!open || addProjectOpen) return null;

  const local = (agents ?? []).filter((a) => a.available && !a.remote);
  const remote = (agents ?? []).filter((a) => a.available && a.remote);
  const hasAgent = local.length + remote.length > 0;
  const needsConsent = local.filter((a) => !consented.has(a.id));
  const readOnly = profile === 'read_only';
  const permissionsReady = hasAgent && !readOnly && needsConsent.length === 0;
  const index = STEPS.indexOf(step);
  const next = (): void => { setError(null); setStep(STEPS[Math.min(index + 1, STEPS.length - 1)]!); };
  const back = (): void => { setError(null); setStep(STEPS[Math.max(index - 1, 0)]!); };

  async function perform(action: () => Promise<unknown>): Promise<void> {
    setBusy(true); setError(null);
    try { await action(); await load(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  }
  const recommended = (): Promise<unknown> => perform(async () => {
    if (readOnly) await window.conductor.permissions.setProfile('assisted_execution');
    for (const agent of needsConsent) await window.conductor.dataControl.grantConsent(agent.id);
  });

  const complete: Record<Step, boolean> = {
    welcome: index > 0, agents: hasAgent, permissions: permissionsReady, project: workspaces.length > 0, memory: mem0?.reachable === true, done: false,
  };
  const goTo = (target: Step): void => { setError(null); setStep(target); };
  const rowStatus = (ok: boolean, yes: string, no: string): React.JSX.Element => (
    <span className={cn('flex items-center gap-1.5 text-xs', ok ? 'text-success' : 'text-muted-foreground')}><Check ok={ok} />{ok ? yes : no}</span>
  );

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label="Set up Conductor" className="animate-pop-in fixed inset-0 z-50 flex bg-background text-foreground">
      <aside className="hidden w-72 shrink-0 flex-col border-r border-sidebar-border bg-sidebar px-5 py-6 md:flex">
        <div className="flex items-center gap-2.5 px-2">
          <svg width="26" height="26" viewBox="220 220 584 584" fill="none" strokeWidth="48" strokeLinecap="round" aria-hidden="true">
            <path d="M 706.7 336.7 A 262 262 0 1 0 706.7 687.3" stroke="#5b8cff" />
            <path d="M 631.6 369.5 A 186 186 0 1 0 631.6 654.5" stroke="#9b6bff" />
            <path d="M 563.6 414.9 A 110 110 0 1 0 563.6 609.1" stroke="#f0609e" />
            <circle cx="686" cy="512" r="38" fill="currentColor" stroke="none" />
          </svg>
          <span className="text-base font-semibold">Conductor</span>
        </div>
        <p className="mt-6 px-2 text-xs text-muted-foreground">Setup takes about a minute. Every step can be skipped.</p>
        <nav aria-label="Setup steps" className="mt-6 flex flex-col gap-0.5">
          {STEPS.map((s, i) => {
            const current = s === step;
            const done = i < index && complete[s];
            return (
              <button key={s} type="button" aria-current={current ? 'step' : undefined} onClick={() => { goTo(s); }}
                className={cn('flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 text-left text-sm focus-visible:outline-2 focus-visible:outline-ring',
                  current ? 'bg-sidebar-row-active font-medium text-sidebar-foreground' : 'text-sidebar-muted-foreground hover:bg-sidebar-row-hover')}>
                <span className={cn('flex size-5 shrink-0 items-center justify-center rounded-full border text-2xs',
                  done ? 'border-success bg-success text-background' : current ? 'border-primary text-primary' : 'border-border-strong')}>
                  {done ? <CheckIcon size={12} /> : i + 1}
                </span>
                {RAIL_LABELS[s]}
              </button>
            );
          })}
        </nav>
        <span className="flex-1" />
        {step !== 'done' ? <Button size="md" variant="ghost" className="justify-start" onClick={finish}>Skip setup</Button> : null}
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto [scrollbar-gutter:stable_both-edges]">
          <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 px-6 pt-14 pb-10">
            <header className="space-y-2">
              <p className="text-xs text-muted-foreground md:hidden">Step {index + 1} of {STEPS.length}</p>
              <h1 className="text-2xl font-semibold tracking-tight text-balance">{TITLES[step]}</h1>
            </header>

            {step === 'welcome' ? (
              <>
                <p className="max-w-xl text-pretty text-muted-foreground">Conductor runs coding agents on your projects and keeps you in control of what they do. Four short steps get you to your first thread.</p>
                <SettingsGroup>
                  <SettingsRow title="Connect an agent" description="Use a coding agent CLI installed on this Mac, such as Codex or Claude Code." />
                  <SettingsRow title="Decide how agents work" description="Choose what they may do on their own and what they may send." />
                  <SettingsRow title="Add a project" description="Pick a folder for agents to work in." />
                  <SettingsRow title="Add memory" description="Optional. Connect Mem0 so replies can use what you’ve shared before." />
                </SettingsGroup>
              </>
            ) : null}

            {step === 'agents' ? (
              <>
                <p className="max-w-xl text-pretty text-muted-foreground">Conductor drives agent CLIs installed on this Mac.</p>
                {agents === null ? <p className="text-sm text-muted-foreground">Looking for agents…</p> : (
                  <SettingsGroup>
                    {agents.map((agent) => (
                      <SettingsRow key={agent.id} title={<span className="flex items-center gap-2"><ProviderAvatar brand={agentBrand(agent.id)} label={agent.name} size={16} />{agent.name}</span>}
                        control={rowStatus(agent.available, 'Ready', 'Not installed')} />
                    ))}
                  </SettingsGroup>
                )}
                {agents !== null && !hasAgent ? (
                  <p className="rounded-xl bg-warning/10 px-4 py-3 text-sm">No agent found. Install one (for example Codex or Claude Code), then recheck, or open Connected apps for install help.</p>
                ) : null}
                <div className="flex gap-2">
                  <Button size="md" variant="outline" onClick={() => { void load(); }}>Recheck</Button>
                  <Button size="md" variant="ghost" onClick={() => { useUiStore.getState().setOnboardingOpen(false); navigate('/connected-apps'); }}>Open Connected apps</Button>
                </div>
                <SettingsLinks links={[{ label: 'Connected apps (install & MCP)', path: '/connected-apps' }, { label: 'Agent models', path: '/settings' }]} />
              </>
            ) : null}

            {step === 'permissions' ? (
              <>
                <p className="max-w-xl text-pretty text-muted-foreground">Choose what agents may do. You can change any of this later in Settings.</p>
                <div role="radiogroup" aria-label="Permission profile" className="grid gap-2 sm:grid-cols-3">
                  {PROFILES.map((option) => (
                    <button key={option.id} type="button" role="radio" aria-checked={profile === option.id} disabled={busy}
                      onClick={() => { void perform(() => window.conductor.permissions.setProfile(option.id)); }}
                      className={cn('flex cursor-pointer flex-col gap-1.5 rounded-xl border p-3.5 text-left focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-60', profile === option.id ? 'border-ring bg-accent' : 'border-border/60 bg-card/40 hover:bg-accent/50')}>
                      <span className="flex items-center justify-between text-sm font-medium">{option.label}<Check ok={profile === option.id} /></span>
                      <span className="text-xs text-muted-foreground">{option.hint}</span>
                    </button>
                  ))}
                </div>
                <SettingsGroup>
                  <SettingsRow title="Auto-approve everything" description="Skips every approval prompt. Leave off unless you fully trust your agents."
                    control={<Switch label="Auto-approve everything" checked={autoApprove} disabled={busy}
                      onChange={(next) => { void perform(() => window.conductor.settings.set({ key: 'execution.autoApprove', value: next, scope: 'global' })); }} />} />
                  {local.length === 0 ? <SettingsRow title="Allow sending tasks and context" description="Connect an agent first (previous step)." /> : local.map((agent) => {
                    const allowed = consented.has(agent.id);
                    return (
                      <SettingsRow key={agent.id} title={`Allow sending tasks and context to ${agent.name}`}
                        control={<Switch label={`Allow ${agent.name}`} checked={allowed} disabled={busy}
                          onChange={() => { void perform(() => allowed ? window.conductor.dataControl.revokeConsent(agent.id) : window.conductor.dataControl.grantConsent(agent.id)); }} />} />
                    );
                  })}
                </SettingsGroup>
                {hasAgent && !permissionsReady ? <div><Button size="md" variant="primary" disabled={busy} onClick={() => { void recommended(); }}>{busy ? 'Saving…' : 'Use recommended (assisted + allow all)'}</Button></div> : null}
                <SettingsLinks links={[{ label: 'Execution & data', path: '/settings' }]} />
              </>
            ) : null}

            {step === 'project' ? (
              <>
                <p className="max-w-xl text-pretty text-muted-foreground">A project is a folder agents work in. Threads, files and history are grouped under it.</p>
                {workspaces.length > 0 ? (
                  <SettingsGroup>
                    {workspaces.slice(0, 4).map((w) => <SettingsRow key={w.id} title={<span className="flex items-center gap-2"><FolderIcon size={14} />{w.name}</span>} control={rowStatus(true, 'Added', '')} />)}
                  </SettingsGroup>
                ) : <p className="text-sm text-muted-foreground">No projects yet.</p>}
                <div><Button size="md" variant={workspaces.length > 0 ? 'outline' : 'primary'} onClick={() => { useUiStore.getState().setAddProjectOpen(true); }}>Add a project folder</Button></div>
                <SettingsLinks links={[{ label: 'Projects', path: '/settings' }, { label: 'GitHub', path: '/settings' }]} />
              </>
            ) : null}

            {step === 'memory' ? (
              <>
                <p className="max-w-xl text-pretty text-muted-foreground">Mem0 gives Conductor long-term memory so replies can use details you’ve shared before. It’s optional, and Conductor works without it.</p>
                <SettingsGroup>
                  <SettingsRow title="Memory service"
                    description={mem0 === null ? 'Checking the memory service…' : mem0.reachable ? 'Connected' : (mem0.detail ?? 'Not reachable')}
                    control={<Button size="sm" variant="outline" onClick={() => { void checkMem0(); }}>Recheck</Button>} />
                  {mem0?.reachable === true ? (
                    <SettingsRow title="Use saved context for new tasks" description="Lets tasks recall relevant memories."
                      control={<Switch label="Use saved context for new tasks" checked={dataSettings?.indexingEnabled === true} disabled={busy || dataSettings === null}
                        onChange={(next) => { if (dataSettings !== null) void perform(() => window.conductor.dataControl.setSettings({ ...dataSettings, indexingEnabled: next })); }} />} />
                  ) : null}
                </SettingsGroup>
                {mem0?.reachable !== true ? (
                  <>
                    <div className="flex flex-col gap-2">
                      <p className="text-sm text-muted-foreground">Run the bundled local service (needs Docker Desktop) from the Conductor repo folder, then press Recheck:</p>
                      {MEM0_COMMANDS.map((c) => <CopyCommand key={c.command} label={c.label} command={c.command} />)}
                      <p className="text-sm text-muted-foreground">Or connect to a Mem0 service you already run:</p>
                    </div>
                    <label className="flex flex-col gap-1 text-xs font-medium">Service URL
                      <input className={inputClassName} value={mem0Url} onChange={(e) => { setMem0Url(e.target.value); }} spellCheck={false} />
                    </label>
                    <label className="flex flex-col gap-1 text-xs font-medium">API key
                      <input className={inputClassName} type="password" autoComplete="off" value={mem0Key} onChange={(e) => { setMem0Key(e.target.value); }} placeholder="Paste the Mem0 API key" />
                    </label>
                    <div><Button size="md" variant="primary" disabled={mem0Busy || mem0Url.trim() === '' || mem0Key.trim() === ''} onClick={() => { void connectMem0(); }}>{mem0Busy ? 'Checking…' : 'Test and save'}</Button></div>
                    <p className="text-xs text-muted-foreground">The key is stored only on this Mac, in Conductor’s private app data, and is never shown again.</p>
                  </>
                ) : null}
                <SettingsLinks links={[{ label: 'Memory', path: '/memory' }, { label: 'Data preferences', path: '/settings' }]} />
              </>
            ) : null}

            {step === 'done' ? (
              <>
                <p className="max-w-xl text-pretty text-muted-foreground">Conductor is ready. Here’s where everything stands:</p>
                <SettingsGroup>
                  <SettingsRow title="Agent" control={rowStatus(hasAgent, 'Connected', 'Not connected yet')} />
                  <SettingsRow title="Permissions" control={rowStatus(permissionsReady, 'Set', 'Not set yet')} />
                  <SettingsRow title="Project" control={rowStatus(workspaces.length > 0, 'Added', 'Not added yet')} />
                  <SettingsRow title="Memory" control={rowStatus(mem0?.reachable === true, 'Connected', 'Not set up (optional)')} />
                </SettingsGroup>
                <ul className="list-disc space-y-1 pl-5 text-sm text-muted-foreground">
                  <li>Press <kbd className="rounded border border-border px-1 text-2xs">⌘N</kbd> to start a new thread.</li>
                  <li>The sparkles button at the top of the sidebar lists threads that need your attention, plus suggestions.</li>
                  <li>Manage agents, MCP servers and credentials under Connected apps.</li>
                </ul>
                <SettingsLinks links={[{ label: 'Settings', path: '/settings' }, { label: 'Connected apps', path: '/connected-apps' }, { label: 'Memory', path: '/memory' }]} />
              </>
            ) : null}

            {error !== null ? <p role="alert" className="text-sm text-destructive-foreground">{error}</p> : null}
          </div>
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-6 py-3">
          <div className="mx-auto flex w-full max-w-2xl items-center gap-2">
            {step !== 'done' ? <Button size="md" variant="ghost" className="md:hidden" onClick={finish}>Skip setup</Button> : null}
            <span className="flex-1" />
            {index > 0 && step !== 'done' ? <Button size="md" variant="ghost" onClick={back}>Back</Button> : null}
            {step === 'done'
              ? <Button size="md" variant="primary" onClick={() => { finish(); navigate('/home'); }}>Start using Conductor</Button>
              : <Button size="md" variant="primary" onClick={next}>{step === 'welcome' ? 'Get started' : 'Continue'}</Button>}
          </div>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
