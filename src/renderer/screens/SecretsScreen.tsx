import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SecretInfo } from '@shared/integrations-contract';
import { AGENT_SECRET_ALL, agentSecretOwner, isAgentSecretOwner, type SandboxAgent } from '@shared/sandbox-agents';
import { cn } from '../lib/cn';
import { relativeTime } from '../lib/time';
import { Alert, Button, Dialog, EmptyState, inputClassName } from '../components/ui/primitives';
import { MenuSelect } from '../components/ui/MenuSelect';
import { KeyIcon, PlusIcon, Spinner } from '../components/ui/icons';
import { SettingsSection } from '../components/settings/SettingsLayout';

// Every secret Conductor keeps in the macOS Keychain, in one place. Values are
// never read back into the UI: a secret can be renamed, given a new value
// (same id, so whatever uses it keeps working) or deleted. Secrets made here
// can be handed to agents, which type them into web forms by name without
// ever seeing them.

const errorText = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));

/** Who uses a secret, in words. */
function usedBy(owner: string | undefined, agents: readonly SandboxAgent[]): string {
  if (owner === undefined) return 'Not used yet';
  if (owner === AGENT_SECRET_ALL) return 'All agents';
  if (owner.startsWith('agents:')) return agents.find((agent) => agentSecretOwner(agent.id) === owner)?.name ?? 'A deleted agent';
  if (owner.startsWith('mcp:')) return 'MCP server';
  if (owner.startsWith('github:')) return 'GitHub';
  return owner.split(':')[0] ?? owner;
}

type Editing = { mode: 'new' } | { mode: 'edit'; secret: SecretInfo };

function SecretDialog({ editing, agents, onClose, onSaved }: { editing: Editing; agents: readonly SandboxAgent[]; onClose: () => void; onSaved: () => void }): React.JSX.Element {
  const existing = editing.mode === 'edit' ? editing.secret : undefined;
  const integration = existing?.owner !== undefined && !isAgentSecretOwner(existing.owner);
  const [label, setLabel] = useState(existing?.label ?? '');
  const [value, setValue] = useState('');
  const [owner, setOwner] = useState<string>(existing?.owner ?? (editing.mode === 'new' ? AGENT_SECRET_ALL : 'none'));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSave = label.trim() !== '' && (existing !== undefined || value !== '');

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (existing === undefined) {
        await window.conductor.secrets.create({ label: label.trim(), value, ...(owner !== 'none' ? { owner } : {}) });
      } else {
        await window.conductor.secrets.update({
          id: existing.id,
          ...(label.trim() !== existing.label ? { label: label.trim() } : {}),
          ...(value !== '' ? { value } : {}),
          ...(!integration && owner !== (existing.owner ?? 'none') ? { owner: owner === 'none' ? null : owner } : {}),
        });
      }
      onSaved();
    } catch (err) { setError(errorText(err)); } finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} title={existing === undefined ? 'New secret' : `Edit ${existing.label}`}
      footer={(
        <div className="flex w-full items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="primary" disabled={busy || !canSave} onClick={() => { void save(); }}>{busy ? <Spinner size={12} /> : null}Save</Button>
        </div>
      )}>
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); if (canSave) void save(); }}>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">Name</span>
          <input className={inputClassName} value={label} maxLength={255} autoFocus={existing === undefined} placeholder="LinkedIn password" onChange={(e) => { setLabel(e.target.value); }} />
          {!integration ? <span className="text-3xs text-muted-foreground">Agents refer to the secret by this name, so make it say what it is for.</span> : null}
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-2xs font-medium text-muted-foreground">{existing === undefined ? 'Value' : 'New value'} {existing !== undefined ? <span className="font-normal">(leave empty to keep the current one)</span> : null}</span>
          <input type="password" className={cn(inputClassName, 'font-mono text-xs')} value={value} autoComplete="new-password" spellCheck={false} onChange={(e) => { setValue(e.target.value); }} />
        </label>
        {integration ? (
          <p className="text-2xs text-muted-foreground">Used by {usedBy(existing?.owner, agents)}. A new value takes effect the next time it connects.</p>
        ) : (
          <div className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">Agents that can use it</span>
            <MenuSelect variant="box" label="Agents that can use it" value={owner} onChange={setOwner}
              options={[
                { value: AGENT_SECRET_ALL, label: 'All agents' },
                ...agents.map((agent) => ({ value: agentSecretOwner(agent.id), label: agent.name })),
                { value: 'none', label: 'No agent (just keep it)' },
              ]} />
            <span className="text-3xs text-muted-foreground">They can type it into a web form in Chrome, by name. They never see the value, and it is blanked out of anything they read back from the page.</span>
          </div>
        )}
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}

function SecretRow({ secret, agents, onEdit, onDeleted }: { secret: SecretInfo; agents: readonly SandboxAgent[]; onEdit: () => void; onDeleted: () => void }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const remove = async (): Promise<void> => {
    try { await window.conductor.secrets.delete(secret.id); onDeleted(); } catch (err) { setError(errorText(err)); }
  };
  return (
    <li className="flex flex-col gap-1 px-4 py-3 text-xs">
      <div className="flex items-center gap-3">
        <KeyIcon size={13} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground">{secret.label}</span>
          <span className="block text-xs text-muted-foreground">{usedBy(secret.owner, agents)} · added {relativeTime(secret.createdAt)}</span>
        </span>
        <span className="font-mono text-3xs tracking-widest text-muted-foreground" aria-hidden>••••••••</span>
        {confirming ? (
          <>
            <span className="text-2xs text-muted-foreground">Delete from the Keychain?</span>
            <Button size="xs" variant="ghost" onClick={() => { setConfirming(false); }}>Keep</Button>
            <Button size="xs" variant="destructive-outline" onClick={() => { void remove(); }}>Delete</Button>
          </>
        ) : (
          <>
            <Button size="xs" variant="outline" onClick={onEdit}>Edit</Button>
            <Button size="xs" variant="ghost" className="hover:text-destructive-foreground" onClick={() => { setConfirming(true); }}>Delete</Button>
          </>
        )}
      </div>
      {error !== null ? <p role="alert" className="pl-6 text-2xs text-destructive-foreground">{error}</p> : null}
    </li>
  );
}

function Section({ title, hint, secrets, agents, onEdit, refresh }: { title: string; hint: string; secrets: SecretInfo[]; agents: readonly SandboxAgent[]; onEdit: (secret: SecretInfo) => void; refresh: () => void }): React.JSX.Element | null {
  if (secrets.length === 0) return null;
  return (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="px-3 sm:px-4">
        <h3 className="text-sm font-medium text-foreground">{title}</h3>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <ul className="flex flex-col rounded-xl border border-border/60 bg-card/40 shadow-xs/5 *:not-first:border-t *:not-first:border-border/50">
        {secrets.map((secret) => <SecretRow key={secret.id} secret={secret} agents={agents} onEdit={() => { onEdit(secret); }} onDeleted={refresh} />)}
      </ul>
    </section>
  );
}

/** Settings > Secrets. */
export function SecretsPanel(): React.JSX.Element {
  const [secrets, setSecrets] = useState<SecretInfo[] | null>(null);
  const [agents, setAgents] = useState<SandboxAgent[]>([]);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    window.conductor.secrets.list().then((list) => { setSecrets(list); setError(null); }).catch((err: unknown) => { setError(errorText(err)); });
  }, []);
  useEffect(() => {
    refresh();
    window.conductor.sandboxAgents.list().then(setAgents).catch(() => undefined);
  }, [refresh]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (secrets ?? []).filter((secret) => q === '' || secret.label.toLowerCase().includes(q) || usedBy(secret.owner, agents).toLowerCase().includes(q));
  }, [secrets, query, agents]);
  const mine = shown.filter((secret) => secret.owner === undefined || isAgentSecretOwner(secret.owner));
  const integrations = shown.filter((secret) => secret.owner !== undefined && !isAgentSecretOwner(secret.owner));

  return (
    <SettingsSection title="Secrets" action={<Button size="xs" variant="outline" onClick={() => { setEditing({ mode: 'new' }); }}><PlusIcon />New secret</Button>}>
      <p className="px-3 text-xs text-muted-foreground sm:px-4">
        Stored in your Mac’s Keychain. Values are never shown again, here or to agents. Give a secret a new value to rotate it; everything that uses it keeps working.
      </p>
      {error !== null ? <Alert>{error}</Alert> : null}
      {secrets === null ? <p className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner size={12} />Loading…</p>
        : secrets.length === 0 ? (
          <EmptyState icon={<KeyIcon size={18} />} title="No secrets yet"
            description="Save a password or API key, and let agents sign in to sites with it without ever seeing it." />
        ) : (
          <>
            <input className={cn(inputClassName, 'max-w-sm')} type="search" placeholder="Search secrets" aria-label="Search secrets" value={query} onChange={(e) => { setQuery(e.target.value); }} />
            {shown.length === 0 ? <p className="text-xs text-muted-foreground">No secret matches “{query}”.</p> : null}
            <Section title="Your secrets" hint="Saved here. Agents can type the ones given to them into web forms." secrets={mine} agents={agents} onEdit={(secret) => { setEditing({ mode: 'edit', secret }); }} refresh={refresh} />
            <Section title="Integration credentials" hint="Created when you connected an MCP server or GitHub. Each is only ever used by that integration." secrets={integrations} agents={agents} onEdit={(secret) => { setEditing({ mode: 'edit', secret }); }} refresh={refresh} />
          </>
        )}
      {editing !== null ? <SecretDialog key={editing.mode === 'edit' ? editing.secret.id : 'new'} editing={editing} agents={agents} onClose={() => { setEditing(null); }} onSaved={() => { setEditing(null); refresh(); }} /> : null}
    </SettingsSection>
  );
}
