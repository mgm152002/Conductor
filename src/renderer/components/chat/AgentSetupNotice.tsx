import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AgentOption } from '@shared/integrations-contract';
import type { PermissionProfile } from '@shared/domain';
import { Button } from '../ui/primitives';
import { AlertTriangleIcon } from '../ui/icons';

// Checks the things that stop a task before any agent runs, and offers a
// one-click fix for each:
//  * no agent CLI installed → go to Connections;
//  * the Read-only profile → allow agents with per-run approval;
//  * no consent to send tasks to the installed agent's provider → allow it.
// Each fix is an explicit click; nothing changes on its own.

interface Readiness {
  agents: AgentOption[];
  profile: PermissionProfile;
  consented: Set<string>;
}

export function AgentSetupNotice({ onFixed }: { onFixed?: () => void }): React.JSX.Element | null {
  const navigate = useNavigate();
  const [state, setState] = useState<Readiness | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [agents, profile, consents] = await Promise.all([
        window.conductor.agents.list(),
        window.conductor.permissions.getProfile(),
        window.conductor.dataControl.listConsents(),
      ]);
      setState({ agents, profile, consented: new Set(consents.filter((c) => c.revokedAt === undefined).map((c) => c.provider)) });
    } catch { /* surfaced elsewhere */ }
  }, []);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => { void load(); }, 10_000);
    return () => { window.clearInterval(timer); };
  }, [load]);

  if (state === null) return null;
  const local = state.agents.filter((a) => a.available && !a.remote);
  const remote = state.agents.filter((a) => a.available && a.remote);
  const noAgent = local.length === 0 && remote.length === 0;
  const readOnly = state.profile === 'read_only';
  const needsConsent = local.filter((a) => !state.consented.has(a.id));
  const ready = !noAgent && !readOnly && (remote.length > 0 || needsConsent.length < local.length);
  if (ready) return null;

  async function fix(): Promise<void> {
    setBusy(true); setError(null);
    try {
      if (readOnly) await window.conductor.permissions.setProfile('assisted_execution');
      for (const agent of needsConsent) await window.conductor.dataControl.grantConsent(agent.id);
      await load();
      onFixed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally { setBusy(false); }
  }

  const steps: string[] = [];
  if (readOnly) steps.push('let agents work, asking you before each command or file change (Assisted execution)');
  if (needsConsent.length > 0) steps.push(`allow sending tasks and context to ${needsConsent.map((a) => a.name).join(', ')}`);

  return (
    <div role="status" className="mx-auto mb-2 flex w-full max-w-(--chat-max) items-start gap-2.5 rounded-2xl border border-warning/30 bg-warning/6 px-3.5 py-3 text-xs">
      <AlertTriangleIcon size={15} className="mt-px shrink-0 text-warning" />
      <div className="min-w-0 flex-1">
        {noAgent ? (
          <>
            <p className="font-medium text-foreground">No agent is installed yet</p>
            <p className="mt-0.5 text-muted-foreground">Tasks need an agent CLI such as Codex or Claude Code.</p>
          </>
        ) : (
          <>
            <p className="font-medium text-foreground">Agents can’t run tasks yet</p>
            <p className="mt-0.5 text-muted-foreground">To start tasks, {steps.join(' and ')}. You can change this later in Settings.</p>
          </>
        )}
        {error !== null ? <p role="alert" className="mt-1 text-destructive-foreground">{error}</p> : null}
      </div>
      {noAgent
        ? <Button size="sm" variant="primary" onClick={() => { navigate('/connected-apps'); }}>Open Connections</Button>
        : <Button size="sm" variant="primary" disabled={busy} onClick={() => { void fix(); }}>{busy ? 'Saving…' : 'Allow'}</Button>}
    </div>
  );
}
