import { useCallback, useEffect, useId, useState } from 'react';
import type { RemoteHostView, RemoteTestResult } from '@shared/integrations-contract';
import { Badge, Button, Dialog, EmptyState, Switch, inputClassName } from '../ui/primitives';
import { PlusIcon, ServerIcon, TrashIcon } from '../ui/icons';

// Remote hosts run Codex over SSH using your existing keys and ~/.ssh/config.
// Pick a host in the composer's agent menu to run a thread there.

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : String(err);
}

export function RemoteHosts(): React.JSX.Element {
  const [hosts, setHosts] = useState<RemoteHostView[]>([]);
  const [tests, setTests] = useState<Record<string, RemoteTestResult | 'testing'>>({});
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', host: '', remoteDir: '~/', installIfMissing: false });
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), host: useId(), dir: useId(), install: useId() };

  const refresh = useCallback(async () => {
    try { setHosts(await window.conductor.remote.list()); } catch (err) { setError(message(err)); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);

  async function test(id: string): Promise<void> {
    setTests((t) => ({ ...t, [id]: 'testing' }));
    try {
      const result = await window.conductor.remote.test(id);
      setTests((t) => ({ ...t, [id]: result }));
    } catch (err) {
      setTests((t) => ({ ...t, [id]: { connected: false, agentInstalled: false, error: message(err) } }));
    }
  }

  async function add(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    try {
      const created = await window.conductor.remote.add(form);
      setAdding(false);
      await refresh();
      void test(created.id);
    } catch (err) { setError(message(err)); }
  }

  return (
    <section aria-label="Remote hosts" className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><ServerIcon size={15} className="text-muted-foreground" />Remote hosts</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Run Codex on another machine over SSH (key-based, non-interactive). Choose the host in the composer’s agent menu.</p>
        </div>
        <Button size="sm" variant="primary" onClick={() => { setForm({ name: '', host: '', remoteDir: '~/', installIfMissing: false }); setError(null); setAdding(true); }}><PlusIcon size={13} />Add host</Button>
      </header>
      {error !== null && !adding ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
      {hosts.length === 0 ? (
        <EmptyState icon={<ServerIcon size={20} />} title="No remote hosts" description="Add a server you can reach with `ssh user@host` without a password prompt." />
      ) : (
        <ul className="flex flex-col gap-2">
          {hosts.map((host) => {
            const result = tests[host.id];
            return (
              <li key={host.id} className="rounded-xl border border-border bg-card p-3.5">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-medium text-foreground">{host.name}</p>
                      {!host.enabled ? <Badge>Disabled</Badge> : host.available ? <Badge tone="success">Ready</Badge> : <Badge tone="destructive">Unavailable</Badge>}
                    </div>
                    <p className="mt-0.5 font-mono text-2xs text-muted-foreground">{host.host} · {host.remoteDir}</p>
                    {result === 'testing' ? <p className="mt-1 text-2xs text-muted-foreground">Testing connection…</p> : null}
                    {result !== undefined && result !== 'testing' ? (
                      <p className={`mt-1 text-2xs ${result.connected && result.agentInstalled ? 'text-success' : 'text-destructive-foreground'}`}>
                        {result.connected ? (result.agentInstalled ? 'Connected · Codex is installed' : `Connected · Codex not found${host.installIfMissing ? ' (will be installed on first run)' : ''}`) : `Connection failed: ${result.error ?? 'unknown error'}`}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <Button size="sm" variant="outline" disabled={result === 'testing'} onClick={() => { void test(host.id); }}>Test</Button>
                    <Switch label={`Enable ${host.name}`} checked={host.enabled} onChange={(enabled) => { void window.conductor.remote.setEnabled({ id: host.id, enabled }).then(refresh).catch((err: unknown) => { setError(message(err)); }); }} />
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${host.name}`} onClick={() => { void window.conductor.remote.remove(host.id).then(refresh); }}><TrashIcon size={13} /></Button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Dialog open={adding} onClose={() => { setAdding(false); }} title="Add remote host" description="Conductor connects with your SSH keys in BatchMode (never prompts). Adding the host records your consent to send tasks to it, and Codex on that host sends them on to OpenAI.">
        <form className="flex flex-col gap-3" onSubmit={(event) => { void add(event); }}>
          <div className="flex flex-col gap-1.5"><label htmlFor={ids.name} className="text-xs font-medium">Name</label><input id={ids.name} className={inputClassName} value={form.name} onChange={(e) => { setForm({ ...form, name: e.target.value }); }} placeholder="Build server" /></div>
          <div className="flex flex-col gap-1.5"><label htmlFor={ids.host} className="text-xs font-medium">SSH host</label><input id={ids.host} className={`${inputClassName} font-mono text-xs`} value={form.host} onChange={(e) => { setForm({ ...form, host: e.target.value }); }} placeholder="user@server.example.com or an ~/.ssh/config alias" spellCheck={false} /></div>
          <div className="flex flex-col gap-1.5"><label htmlFor={ids.dir} className="text-xs font-medium">Remote working directory</label><input id={ids.dir} className={`${inputClassName} font-mono text-xs`} value={form.remoteDir} onChange={(e) => { setForm({ ...form, remoteDir: e.target.value }); }} spellCheck={false} /></div>
          <label htmlFor={ids.install} className="flex items-start gap-2 text-xs">
            <input id={ids.install} type="checkbox" className="mt-0.5" checked={form.installIfMissing} onChange={(e) => { setForm({ ...form, installIfMissing: e.target.checked }); }} />
            <span>Install Codex on the host if it is missing (<code className="font-mono">npm install -g @openai/codex</code>). Codex must still be signed in on that host.</span>
          </label>
          {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
          <div className="mt-2 flex justify-end gap-2"><Button size="md" variant="ghost" onClick={() => { setAdding(false); }}>Cancel</Button><Button size="md" variant="primary" type="submit" disabled={!form.host.trim() || !form.remoteDir.trim()}>Add host</Button></div>
        </form>
      </Dialog>
    </section>
  );
}
