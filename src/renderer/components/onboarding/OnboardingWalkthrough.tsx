import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentOption } from '@shared/integrations-contract';
import type { DataControlSettings, PermissionProfile } from '@shared/domain';
import type { Mem0Health } from '@shared/chat-contract';
import { useUiStore, useWorkspaceStore } from '../../stores';
import { isOnboardingCompleted, markOnboardingCompleted } from '../../lib/onboarding';
import { cn } from '../../lib/cn';
import { Button, Dialog, Switch, inputClassName } from '../ui/primitives';

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
  memory: 'Set up memory (optional)',
  done: 'You’re all set',
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

  const footer = (
    <>
      {step !== 'done' ? <Button size="md" variant="ghost" onClick={finish}>Skip setup</Button> : null}
      <span className="flex-1" />
      {index > 0 && step !== 'done' ? <Button size="md" variant="ghost" onClick={back}>Back</Button> : null}
      {step === 'done'
        ? <Button size="md" variant="primary" onClick={() => { finish(); navigate('/home'); }}>Start using Conductor</Button>
        : <Button size="md" variant="primary" onClick={next}>{step === 'welcome' ? 'Get started' : 'Continue'}</Button>}
    </>
  );

  return (
    <Dialog open onClose={finish} title={TITLES[step]} width="max-w-lg" footer={footer}
      description={<span className="text-2xs">Step {index + 1} of {STEPS.length}</span>}>
      <div className="flex flex-col gap-3 text-sm">
        <div className="flex gap-1" aria-hidden="true">
          {STEPS.map((s, i) => <span key={s} className={cn('h-1 flex-1 rounded-full', i <= index ? 'bg-primary' : 'bg-muted')} />)}
        </div>

        {step === 'welcome' ? (
          <>
            <p className="text-muted-foreground">Conductor runs coding agents on your projects and keeps you in control. Setup takes about a minute:</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              <li>Connect an agent CLI (Codex, Claude Code, …)</li>
              <li>Decide how agents may work and what they may send</li>
              <li>Add a project folder</li>
              <li>Optionally connect Mem0 for long-term memory</li>
            </ol>
          </>
        ) : null}

        {step === 'agents' ? (
          <>
            <p className="text-muted-foreground">Conductor drives agent CLIs installed on this Mac.</p>
            {agents === null ? <p className="text-xs text-muted-foreground">Looking for agents…</p> : (
              <ul className="flex flex-col gap-1.5">
                {agents.map((agent) => (
                  <li key={agent.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px]">
                    <Check ok={agent.available} />
                    <span className="min-w-0 flex-1 truncate">{agent.name}</span>
                    <span className="text-2xs text-muted-foreground">{agent.available ? 'Ready' : 'Not installed'}</span>
                  </li>
                ))}
              </ul>
            )}
            {agents !== null && !hasAgent ? (
              <p className="rounded-lg bg-warning/10 px-3 py-2 text-xs text-foreground">No agent found. Install one (for example Codex or Claude Code), then recheck — or open Connections for install help.</p>
            ) : null}
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => { void load(); }}>Recheck</Button>
              <Button size="sm" variant="ghost" onClick={() => { useUiStore.getState().setOnboardingOpen(false); navigate('/connected-apps'); }}>Open Connections</Button>
            </div>
            <SettingsLinks links={[{ label: 'Connected apps (install & MCP)', path: '/connected-apps' }, { label: 'Agent models', path: '/settings' }]} />
          </>
        ) : null}

        {step === 'permissions' ? (
          <>
            <p className="text-muted-foreground">Choose what agents may do. You can change any of this later in Settings.</p>
            <div role="radiogroup" aria-label="Permission profile" className="flex flex-col gap-1.5">
              {PROFILES.map((option) => (
                <button key={option.id} type="button" role="radio" aria-checked={profile === option.id} disabled={busy}
                  onClick={() => { void perform(() => window.conductor.permissions.setProfile(option.id)); }}
                  className={cn('flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2 text-left disabled:opacity-60', profile === option.id ? 'border-ring bg-accent' : 'border-border hover:bg-accent/50')}>
                  <Check ok={profile === option.id} />
                  <span className="min-w-0 flex-1"><span className="block text-[13px] font-medium">{option.label}</span><span className="block text-2xs text-muted-foreground">{option.hint}</span></span>
                </button>
              ))}
            </div>
            <div className="flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2">
              <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">Auto-approve everything</p><p className="text-2xs text-muted-foreground">Skips every approval prompt. Leave off unless you fully trust your agents.</p></div>
              <Switch label="Auto-approve everything" checked={autoApprove} disabled={busy}
                onChange={(next) => { void perform(() => window.conductor.settings.set({ key: 'execution.autoApprove', value: next, scope: 'global' })); }} />
            </div>
            <div>
              <p className="mb-1 text-xs font-medium">Allow sending tasks and context to</p>
              {local.length === 0 ? <p className="text-2xs text-muted-foreground">Connect an agent first (previous step).</p> : (
                <ul className="flex flex-col gap-1">
                  {local.map((agent) => {
                    const allowed = consented.has(agent.id);
                    return (
                      <li key={agent.id} className="flex items-center gap-2 text-[13px]">
                        <input id={`consent-${agent.id}`} type="checkbox" checked={allowed} disabled={busy}
                          onChange={() => { void perform(() => allowed ? window.conductor.dataControl.revokeConsent(agent.id) : window.conductor.dataControl.grantConsent(agent.id)); }} />
                        <label htmlFor={`consent-${agent.id}`}>{agent.name}</label>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            {hasAgent && !permissionsReady ? <div><Button size="sm" variant="primary" disabled={busy} onClick={() => { void recommended(); }}>{busy ? 'Saving…' : 'Use recommended (assisted + allow all)'}</Button></div> : null}
            <SettingsLinks links={[{ label: 'Execution & data', path: '/settings' }]} />
          </>
        ) : null}

        {step === 'project' ? (
          <>
            <p className="text-muted-foreground">A project is a folder agents work in. Threads, files and history are grouped under it.</p>
            {workspaces.length > 0 ? (
              <ul className="flex flex-col gap-1.5">
                {workspaces.slice(0, 4).map((w) => <li key={w.id} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px]"><Check ok /><span className="min-w-0 flex-1 truncate">{w.name}</span></li>)}
              </ul>
            ) : <p className="text-xs text-muted-foreground">No projects yet.</p>}
            <div><Button size="sm" variant={workspaces.length > 0 ? 'outline' : 'primary'} onClick={() => { useUiStore.getState().setAddProjectOpen(true); }}>Add a project folder</Button></div>
            <SettingsLinks links={[{ label: 'Projects', path: '/settings' }, { label: 'GitHub', path: '/settings' }]} />
          </>
        ) : null}

        {step === 'memory' ? (
          <>
            <p className="text-muted-foreground">Mem0 gives Conductor long-term memory so replies can use details you’ve shared before. It’s optional — Conductor works without it.</p>
            <p className="flex items-center gap-2 text-[13px]">
              <Check ok={mem0?.reachable === true} />
              {mem0 === null ? 'Checking the memory service…' : mem0.reachable ? 'Memory service connected' : (mem0.detail ?? 'Memory service not reachable')}
              <Button size="xs" variant="ghost" onClick={() => { void checkMem0(); }}>Recheck</Button>
            </p>
            {mem0?.reachable !== true ? (
              <>
                <div className="flex flex-col gap-2">
                  <p className="text-xs text-muted-foreground">Run the bundled local service (needs Docker Desktop) from the Conductor repo folder, then press Recheck:</p>
                  {MEM0_COMMANDS.map((c) => <CopyCommand key={c.command} label={c.label} command={c.command} />)}
                  <p className="text-xs text-muted-foreground">Or connect to a Mem0 service you already run:</p>
                </div>
                <label className="flex flex-col gap-1 text-xs font-medium">Service URL
                  <input className={inputClassName} value={mem0Url} onChange={(e) => { setMem0Url(e.target.value); }} spellCheck={false} />
                </label>
                <label className="flex flex-col gap-1 text-xs font-medium">API key
                  <input className={inputClassName} type="password" autoComplete="off" value={mem0Key} onChange={(e) => { setMem0Key(e.target.value); }} placeholder="Paste the Mem0 API key" />
                </label>
                <div><Button size="sm" variant="primary" disabled={mem0Busy || mem0Url.trim() === '' || mem0Key.trim() === ''} onClick={() => { void connectMem0(); }}>{mem0Busy ? 'Checking…' : 'Test and save'}</Button></div>
                <p className="text-2xs text-muted-foreground">The key is stored only on this Mac, in Conductor’s private app data, and is never shown again.</p>
              </>
            ) : (
              <div className="flex items-start gap-3 rounded-lg bg-muted/50 px-3 py-2">
                <div className="min-w-0 flex-1"><p className="text-[13px] font-medium">Use saved context for new tasks</p><p className="text-2xs text-muted-foreground">Lets tasks recall relevant memories.</p></div>
                <Switch label="Use saved context for new tasks" checked={dataSettings?.indexingEnabled === true} disabled={busy || dataSettings === null}
                  onChange={(next) => { if (dataSettings !== null) void perform(() => window.conductor.dataControl.setSettings({ ...dataSettings, indexingEnabled: next })); }} />
              </div>
            )}
            <SettingsLinks links={[{ label: 'Memory', path: '/memory' }, { label: 'Data preferences', path: '/settings' }]} />
          </>
        ) : null}

        {step === 'done' ? (
          <>
            <p className="text-muted-foreground">Conductor is ready. A few things worth knowing:</p>
            <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
              <li>Press <kbd className="rounded border border-border px-1 text-2xs">⌘N</kbd> to start a new thread.</li>
              <li>The sparkles button at the top of the sidebar lists threads that need your attention — approvals, questions, failures — plus suggestions.</li>
              <li>Manage agents, MCP servers and credentials under Connected apps.</li>
            </ul>
            <ul className="mt-1 flex flex-col gap-1 text-[13px]">
              <li className="flex items-center gap-2"><Check ok={hasAgent} />Agent {hasAgent ? 'connected' : 'not connected yet'}</li>
              <li className="flex items-center gap-2"><Check ok={permissionsReady} />Permissions {permissionsReady ? 'set' : 'not set yet'}</li>
              <li className="flex items-center gap-2"><Check ok={workspaces.length > 0} />Project {workspaces.length > 0 ? 'added' : 'not added yet'}</li>
              <li className="flex items-center gap-2"><Check ok={mem0?.reachable === true} />Memory {mem0?.reachable === true ? 'connected' : 'not set up (optional)'}</li>
            </ul>
            <SettingsLinks links={[{ label: 'Settings', path: '/settings' }, { label: 'Connected apps', path: '/connected-apps' }, { label: 'Memory', path: '/memory' }]} />
          </>
        ) : null}

        {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
      </div>
    </Dialog>
  );
}
