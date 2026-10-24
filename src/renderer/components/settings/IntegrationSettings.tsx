import { useCallback, useEffect, useState } from 'react';
import type { ExternalFlowConsent } from '@shared/domain';
import type { SecretInfo } from '@shared/integrations-contract';
import { relativeTime } from '../../lib/time';
import { Button, EmptyState } from '../ui/primitives';
import { KeyIcon } from '../ui/icons';

// Stored credentials (Keychain items Conductor created; values are never
// shown) and consents for providers other than the agent CLIs.

const AGENT_PROVIDERS = new Set(['codex', 'claude-code', 'opencode', 'antigravity', 'kiro']);

export function IntegrationSettings(): React.JSX.Element {
  const [secrets, setSecrets] = useState<SecretInfo[]>([]);
  const [consents, setConsents] = useState<ExternalFlowConsent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([window.conductor.secrets.list(), window.conductor.dataControl.listConsents()]);
      setSecrets(s);
      setConsents(c.filter((consent) => consent.revokedAt === undefined && !AGENT_PROVIDERS.has(consent.provider)));
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Stored credentials" className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Stored credentials</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Passwords, tokens and feed URLs you gave Conductor. Values live in the macOS Keychain (service “Conductor”) and are only inserted into requests made by the integration that owns them.</p>
        </div>
        {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
        {secrets.length === 0 ? <EmptyState icon={<KeyIcon size={18} />} title="No stored credentials" description="Connecting an email account, calendar feed or Slack workspace stores its credential here." /> : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {secrets.map((secret) => (
              <li key={secret.id} className="flex items-center gap-3 px-3.5 py-2.5 text-xs">
                <KeyIcon size={13} className="shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-foreground">{secret.label}</span>
                  <span className="block text-3xs text-muted-foreground">{secret.owner ?? 'Unassigned'} · added {relativeTime(secret.createdAt)}</span>
                </span>
                <Button size="xs" variant="destructive-outline" onClick={() => { void window.conductor.secrets.delete(secret.id).then(refresh); }}>Delete</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section aria-label="Integration consents" className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Integration consents</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Services Conductor may contact for your sources and remote hosts. Revoking stops syncing and remote runs for that provider until you allow it again.</p>
        </div>
        {consents.length === 0 ? <p className="text-xs text-muted-foreground">No integration consents.</p> : (
          <ul className="flex flex-col divide-y divide-border rounded-xl border border-border">
            {consents.map((consent) => (
              <li key={consent.id} className="flex items-center gap-3 px-3.5 py-2.5 text-xs">
                <span className="min-w-0 flex-1 font-mono text-foreground">{consent.provider}</span>
                <span className="text-3xs text-muted-foreground">since {relativeTime(consent.grantedAt)}</span>
                <Button size="xs" variant="outline" onClick={() => { void window.conductor.dataControl.revokeConsent(consent.provider).then(refresh); }}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
