import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import {
  MCP_CLI_NAMES,
  type CliMcpCliView, type CliMcpOverview, type CliMcpPresence, type CliMcpServerView,
  type CliMcpSyncReport, type McpCliId,
} from '@shared/cli-mcp';
import { cn } from '../../lib/cn';
import { AgentMark } from '../chat/AgentMark';
import { Alert, Button, Dialog, EmptyState, Switch, inputClassName, textareaClassName } from '../ui/primitives';
import { CheckIcon, GlobeIcon, KeyIcon, LayersIcon, PlusIcon, RotateIcon, Spinner, TerminalIcon, TrashIcon, XIcon } from '../ui/icons';

// MCP servers as the agent CLIs themselves have them. Each server is one row
// with a chip per installed CLI: installed, missing (click to install there),
// or removed on purpose. Adding a server installs it into the one CLI you
// choose, through that CLI's own `mcp add`; ticking "also install in the
// other CLIs" copies it everywhere. Auto-sync is an optional switch that
// keeps every CLI's servers in step. Credential values are sent once, on add,
// and never shown again.

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

/** "KEY=value" lines → record; header lines also accept "Name: value". */
function parsePairs(text: string, separator: RegExp): { pairs: Record<string, string>; error?: string } {
  const pairs: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const match = separator.exec(line);
    if (match === null || match.index === 0) return { pairs, error: `Can’t read “${line.slice(0, 40)}”. Use NAME=value, one per line.` };
    pairs[line.slice(0, match.index).trim()] = line.slice(match.index + match[0].length).trim();
  }
  return { pairs };
}

function syncSummary(report: CliMcpSyncReport): string | null {
  if (report.installed.length === 0 && report.failed.length === 0) return null;
  const copied = report.installed.length > 0
    ? `Copied ${report.installed.map((item) => `${item.name} to ${MCP_CLI_NAMES[item.cli]}`).join(', ')}.`
    : '';
  const failed = report.failed.length > 0
    ? ` Could not copy ${report.failed.map((item) => `${item.name} to ${MCP_CLI_NAMES[item.cli]} (${item.error})`).join(', ')}.`
    : '';
  return `${copied}${failed}`.trim();
}

function PresenceChip({ cli, presence, busy, onInstall, onRemove }: {
  cli: McpCliId;
  presence: CliMcpPresence;
  busy: boolean;
  onInstall: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const name = MCP_CLI_NAMES[cli];
  const base = 'group/chip flex h-7 shrink-0 items-center gap-1.5 rounded-full border pr-2 pl-1 text-2xs font-medium transition-colors';
  if (presence.state === 'installed') {
    return (
      <span className={cn(base, 'border-success/30 bg-success/8 text-foreground')} title={`${name}: installed${presence.entry.disabled ? ' (disabled in its config)' : ''}`}>
        <AgentMark agentId={cli} name={name} size={18} />
        {name}
        {busy ? <Spinner size={11} /> : (
          <>
            <CheckIcon size={11} className="text-success group-focus-within/chip:hidden group-hover/chip:hidden" />
            <button
              type="button"
              onClick={onRemove}
              aria-label={`Remove from ${name}`}
              title={`Remove from ${name} (sync won’t add it back)`}
              className="hidden size-4 cursor-pointer items-center justify-center rounded-full text-muted-foreground group-focus-within/chip:flex group-hover/chip:flex hover:bg-destructive/15 hover:text-destructive-foreground focus-visible:flex focus-visible:outline-2 focus-visible:outline-ring"
            >
              <XIcon size={10} />
            </button>
          </>
        )}
      </span>
    );
  }
  if (presence.state === 'unsupported') {
    return (
      <span className={cn(base, 'border-dashed border-border text-muted-foreground opacity-70')} title={presence.reason}>
        <AgentMark agentId={cli} name={name} size={18} />{name}<span className="text-3xs">n/a</span>
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={onInstall}
      disabled={busy}
      title={presence.state === 'excluded' ? `You removed it from ${name}. Install it there again` : `Install into ${name}`}
      className={cn(base, 'cursor-pointer border-dashed border-border-strong text-muted-foreground hover:border-primary/50 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default')}
    >
      <span className="opacity-60"><AgentMark agentId={cli} name={name} size={18} /></span>
      {name}
      {busy ? <Spinner size={11} /> : <PlusIcon size={11} />}
      {presence.state === 'excluded' ? <span className="text-3xs">removed</span> : null}
    </button>
  );
}

function ServerRow({ server, clis, busy, onAct, onRemoveEverywhere }: {
  server: CliMcpServerView;
  clis: CliMcpCliView[];
  busy: string | null;
  onAct: (key: string, run: () => Promise<CliMcpOverview>) => void;
  onRemoveEverywhere: () => void;
}): React.JSX.Element {
  const installedIn = clis.filter((cli) => server.presence[cli.id]?.state === 'installed').length;
  const available = clis.filter((cli) => cli.installed).length;
  return (
    <li className="group-card flex flex-col gap-3 p-4">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/12 text-primary">
          {server.transport === 'http' ? <GlobeIcon size={16} /> : <TerminalIcon size={16} />}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-foreground">
            {server.name}
            <span className="rounded-full bg-accent px-1.5 py-px text-3xs font-medium text-muted-foreground">{server.transport === 'http' ? 'Remote' : 'Local command'}</span>
            <span className={cn('text-2xs font-medium', installedIn === available ? 'text-success' : 'text-muted-foreground')}>
              In {installedIn} of {available} CLI{available === 1 ? '' : 's'}
            </span>
          </p>
          <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground" title={server.endpoint}>{server.endpoint}</p>
          {server.envNames.length > 0 || server.headerNames.length > 0 ? (
            <p className="mt-1 flex flex-wrap items-center gap-1.5 text-3xs text-muted-foreground">
              <KeyIcon size={10} />
              {[...server.envNames, ...server.headerNames].map((key) => <span key={key} className="rounded bg-accent px-1 font-mono">{key}</span>)}
              <span>copied with the server</span>
            </p>
          ) : null}
          {!server.portable && server.note !== undefined ? <p className="mt-1 text-2xs text-muted-foreground">{server.note} It stays in that CLI only.</p> : null}
        </div>
        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${server.name} from every CLI`} title="Remove from every CLI" onClick={onRemoveEverywhere} className="hover:text-destructive-foreground">
          <TrashIcon size={13} />
        </Button>
      </div>
      <div className="flex flex-wrap gap-1.5" role="group" aria-label={`${server.name} in each CLI`}>
        {clis.filter((cli) => cli.installed).map((cli) => {
          const presence = server.presence[cli.id] ?? { state: 'missing' as const };
          const key = `${server.key}:${cli.id}`;
          return (
            <PresenceChip
              key={cli.id}
              cli={cli.id}
              presence={!server.portable && presence.state !== 'installed' ? { state: 'unsupported', reason: server.note ?? 'Only works in the CLI that has it.' } : presence}
              busy={busy === key}
              onInstall={() => { onAct(key, () => window.conductor.mcp.cli.install({ key: server.key, cli: cli.id })); }}
              onRemove={() => { onAct(key, () => window.conductor.mcp.cli.remove({ key: server.key, cli: cli.id })); }}
            />
          );
        })}
      </div>
    </li>
  );
}

interface FormState {
  name: string;
  endpoint: string;
  env: string;
  headers: string;
  /** The CLI to install into. */
  cli: McpCliId | null;
  /** Also install into every other installed CLI. */
  everywhere: boolean;
}

function AddServerDialog({ open, clis, initial, onClose, onAdded }: {
  open: boolean;
  clis: CliMcpCliView[];
  initial: FormState;
  onClose: () => void;
  onAdded: (overview: CliMcpOverview) => void;
}): React.JSX.Element {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setForm(initial); setError(null); }, [initial]);
  const ids = { name: useId(), endpoint: useId(), env: useId(), headers: useId() };
  const http = /^https?:\/\//i.test(form.endpoint.trim());
  const installed = clis.filter((cli) => cli.installed);

  async function submit(): Promise<void> {
    setError(null);
    const endpoint = form.endpoint.trim();
    const env = parsePairs(form.env, /=/);
    const headers = parsePairs(form.headers, /[:=]/);
    if (env.error !== undefined) { setError(env.error); return; }
    if (headers.error !== undefined) { setError(headers.error); return; }
    if (form.cli === null) { setError('Choose the CLI to install it into.'); return; }
    const targets = form.everywhere ? [form.cli, ...installed.map((cli) => cli.id).filter((id) => id !== form.cli)] : [form.cli];
    setBusy(true);
    try {
      onAdded(await window.conductor.mcp.cli.add({
        name: form.name.trim(), endpoint,
        ...(!http && Object.keys(env.pairs).length > 0 ? { env: env.pairs } : {}),
        ...(http && Object.keys(headers.pairs).length > 0 ? { headers: headers.pairs } : {}),
        clis: targets,
      }));
      onClose();
    } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Add an MCP server"
      description="Pick the CLI to install it into. Conductor runs that CLI’s own mcp add command."
      width="max-w-lg"
      footer={<>
        <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="md" variant="primary" disabled={busy || form.name.trim() === '' || form.endpoint.trim() === ''} onClick={() => { void submit(); }}>
          {busy ? <><Spinner size={13} />Installing…</> : form.cli === null ? 'Install' : form.everywhere ? `Install into ${installed.length} CLIs` : `Install into ${MCP_CLI_NAMES[form.cli]}`}
        </Button>
      </>}
    >
      <form className="flex flex-col gap-3" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.name} className="text-2xs font-medium text-muted-foreground">Name</label>
          <input id={ids.name} className={inputClassName} value={form.name} maxLength={64} placeholder="github" onChange={(e) => { setForm({ ...form, name: e.target.value }); }} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.endpoint} className="text-2xs font-medium text-muted-foreground">Command or URL</label>
          <input id={ids.endpoint} className={cn(inputClassName, 'font-mono')} value={form.endpoint} placeholder="npx -y @modelcontextprotocol/server-github  or  https://mcp.example.com/mcp" onChange={(e) => { setForm({ ...form, endpoint: e.target.value }); }} />
        </div>
        {http ? (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.headers} className="text-2xs font-medium text-muted-foreground">Headers <span className="font-normal">(optional, one per line: Name: value)</span></label>
            <textarea id={ids.headers} rows={2} className={cn(textareaClassName, 'font-mono text-xs')} value={form.headers} placeholder="Authorization: Bearer …" onChange={(e) => { setForm({ ...form, headers: e.target.value }); }} />
            <p className="text-3xs text-muted-foreground">Codex and Kiro can’t take headers from the command line, so a server with headers skips them. Servers that use sign-in ask for it the first time an agent connects.</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1">
            <label htmlFor={ids.env} className="text-2xs font-medium text-muted-foreground">Environment <span className="font-normal">(optional, one per line: NAME=value)</span></label>
            <textarea id={ids.env} rows={2} className={cn(textareaClassName, 'font-mono text-xs')} value={form.env} placeholder="GITHUB_TOKEN=…" onChange={(e) => { setForm({ ...form, env: e.target.value }); }} />
          </div>
        )}
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-2xs font-medium text-muted-foreground">Install into</legend>
          <div role="radiogroup" aria-label="CLI to install into" className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {installed.map((cli) => {
              const on = form.cli === cli.id;
              return (
                <button
                  key={cli.id}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => { setForm({ ...form, cli: cli.id }); }}
                  className={cn('flex h-10 cursor-pointer items-center gap-2 rounded-xl border px-2 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                    on ? 'border-primary/60 bg-primary/10 text-foreground' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground')}
                >
                  <AgentMark agentId={cli.id} name={cli.name} size={22} />
                  <span className="min-w-0 flex-1 truncate text-left">{cli.name}</span>
                  <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', on ? 'border-primary bg-primary text-primary-foreground' : 'border-border-strong')}>
                    {on ? <CheckIcon size={10} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
          {installed.length === 0 ? <p className="text-2xs text-muted-foreground">No supported agent CLI is installed.</p> : null}
        </fieldset>
        {installed.length > 1 ? (
          <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-border px-3 py-2.5">
            <Switch label="Also install in the other CLIs" checked={form.everywhere} onChange={(everywhere) => { setForm({ ...form, everywhere }); }} />
            <span className="min-w-0">
              <span className="block text-xs font-medium text-foreground">Also install in the other CLIs</span>
              <span className="block text-2xs text-muted-foreground">
                {form.cli === null ? 'Copies it into every other installed CLI too.' : `Copies it into ${installed.filter((cli) => cli.id !== form.cli).map((cli) => cli.name).join(', ')} too.`} You can also add it to one CLI at a time later.
              </span>
            </span>
          </label>
        ) : null}
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}

export function CliMcpServers(): React.JSX.Element {
  const [overview, setOverview] = useState<CliMcpOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState<FormState | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<CliMcpServerView | null>(null);

  const apply = useCallback((next: CliMcpOverview) => {
    setOverview(next);
    if (next.sync !== undefined) setNotice(syncSummary(next.sync));
  }, []);

  const load = useCallback(async (sync: boolean) => {
    setError(null);
    try { apply(await window.conductor.mcp.cli.overview({ sync })); }
    catch (err) { setError(message(err)); }
    finally { setLoading(false); }
  }, [apply]);
  // Opening the tab syncs only when the user turned auto-sync on.
  useEffect(() => { void load(true); }, [load]);

  function act(key: string, run: () => Promise<CliMcpOverview>): void {
    setBusy(key); setError(null);
    void run().then(apply).catch((err: unknown) => { setError(message(err)); }).finally(() => { setBusy(null); });
  }

  const clis = useMemo(() => overview?.clis ?? [], [overview]);
  const installedClis = clis.filter((cli) => cli.installed).map((cli) => cli.id);
  const emptyForm = useMemo<FormState>(() => ({ name: '', endpoint: '', env: '', headers: '', cli: installedClis[0] ?? null, everywhere: false }), [installedClis.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  const shared = (overview?.servers ?? []).filter((server) => server.portable);
  const cliOnly = (overview?.servers ?? []).filter((server) => !server.portable);
  return (
    <section aria-label="MCP servers in your agent CLIs" className="flex flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-[62ch]">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><LayersIcon size={15} className="text-muted-foreground" />MCP servers in your agent CLIs</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Installed straight into a CLI’s own configuration, so it works in that CLI on its own too.
            Add one to the CLI you choose, then copy it to others with the + on its card, or turn on auto-sync to keep every CLI in step.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            Auto-sync
            <Switch
              label="Auto-sync MCP servers across CLIs"
              checked={overview?.autoSync ?? false}
              disabled={overview === null || busy !== null}
              onChange={(enabled) => { act('autosync', () => window.conductor.mcp.cli.setAutoSync(enabled)); }}
            />
          </label>
          <Button size="sm" variant="outline" disabled={busy !== null || overview === null} title="Copy every server into every CLI that lacks it, once" onClick={() => {
            setBusy('sync'); setError(null);
            void window.conductor.mcp.cli.sync()
              .then(async (report) => { setNotice(syncSummary(report) ?? 'Every CLI already has every server.'); apply(await window.conductor.mcp.cli.overview()); })
              .catch((err: unknown) => { setError(message(err)); })
              .finally(() => { setBusy(null); });
          }}>
            {busy === 'sync' ? <Spinner size={12} /> : <RotateIcon size={12} />}Sync now
          </Button>
          <Button size="sm" variant="primary" disabled={overview === null} onClick={() => { setForm(emptyForm); }}><PlusIcon size={13} />Add server</Button>
        </div>
      </header>

      {clis.length > 0 ? (
        <ul aria-label="Agent CLIs" className="flex flex-wrap gap-2">
          {clis.map((cli) => (
            <li key={cli.id} title={cli.installed ? `${cli.name} config: ${cli.configPath}` : `${cli.name} is not installed`} className={cn('flex h-8 items-center gap-2 rounded-lg border px-2 text-xs', cli.installed ? 'border-border bg-card text-foreground' : 'border-dashed border-border text-muted-foreground opacity-60')}>
              <AgentMark agentId={cli.id} name={cli.name} size={18} />
              <span className="font-medium">{cli.name}</span>
              <span className="text-3xs text-muted-foreground">
                {!cli.installed ? 'not installed' : cli.error !== undefined ? 'config unreadable' : ((count: number) => `${count} server${count === 1 ? '' : 's'}`)((overview?.servers ?? []).filter((server) => server.presence[cli.id]?.state === 'installed').length)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {error !== null ? <Alert action={<Button size="xs" variant="ghost" onClick={() => { setError(null); }}>Dismiss</Button>}>{error}</Alert> : null}
      {notice !== null ? <Alert tone="info" action={<Button size="xs" variant="ghost" onClick={() => { setNotice(null); }}>Dismiss</Button>}>{notice}</Alert> : null}
      {clis.filter((cli) => cli.error !== undefined).map((cli) => <Alert key={cli.id} tone="warning">{cli.name}: {cli.error}</Alert>)}

      {loading ? (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner size={12} />Reading each CLI’s MCP configuration{overview === null ? ' and syncing' : ''}…</p>
      ) : (overview?.servers.length ?? 0) === 0 ? (
        <div className="group-card"><EmptyState icon={<LayersIcon size={20} />} title="No MCP servers yet" description="Add one and pick the CLI it goes into." /></div>
      ) : (
        <>
          {shared.length > 0 ? (
            <ul className="flex flex-col gap-2">
              {shared.map((server) => (
                <ServerRow key={server.key} server={server} clis={clis} busy={busy} onAct={act} onRemoveEverywhere={() => { setConfirmRemove(server); }} />
              ))}
            </ul>
          ) : (
            <div className="group-card"><EmptyState icon={<LayersIcon size={20} />} title="No shared MCP servers yet" description="Add one and pick the CLI it goes into." /></div>
          )}
          {cliOnly.length > 0 ? (
            <details className="group-card px-4 py-3">
              <summary className="cursor-pointer text-xs font-medium text-muted-foreground select-none hover:text-foreground">
                {cliOnly.length === 1 ? '1 server works' : `${cliOnly.length} servers work`} inside one CLI only (not synced)
              </summary>
              <ul className="mt-3 flex flex-col divide-y divide-border">
                {cliOnly.map((server) => {
                  const owner = clis.find((cli) => server.presence[cli.id]?.state === 'installed');
                  return (
                    <li key={server.key} className="flex items-center gap-2.5 py-2">
                      {owner !== undefined ? <AgentMark agentId={owner.id} name={owner.name} size={18} /> : null}
                      <span className="min-w-0 flex-1">
                        <span className="text-[13px] font-medium text-foreground">{server.name}</span>
                        <span className="ml-2 text-2xs text-muted-foreground">{owner?.name}{server.note !== undefined ? `. ${server.note}` : ''}</span>
                      </span>
                    </li>
                  );
                })}
              </ul>
            </details>
          ) : null}
        </>
      )}

      {form !== null ? <AddServerDialog open clis={clis} initial={form} onClose={() => { setForm(null); }} onAdded={apply} /> : null}
      <Dialog
        open={confirmRemove !== null}
        onClose={() => { setConfirmRemove(null); }}
        title={`Remove ${confirmRemove?.name ?? 'server'} everywhere?`}
        description="It is removed from every agent CLI’s configuration. You can add it again later."
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setConfirmRemove(null); }}>Keep it</Button>
          <Button size="md" variant="destructive" disabled={busy !== null} onClick={() => {
            const target = confirmRemove;
            setConfirmRemove(null);
            if (target !== null) act(`remove:${target.key}`, () => window.conductor.mcp.cli.removeEverywhere(target.key));
          }}>Remove everywhere</Button>
        </>}
      />
    </section>
  );
}
