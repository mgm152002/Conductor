import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { MenuSelect } from '../ui/MenuSelect';
import { GITHUB_CLIENT_ID_PATTERN, GITHUB_OAUTH_CLIENT_ID_KEY } from '@shared/mcp';
import type { McpDiscoveryEntry, McpInvocationResult, McpOAuthChallenge, McpServer } from '@shared/mcp';
import type { McpMarketplaceEntry, McpMarketplaceIcon } from '@shared/mcp-marketplace';
import { relativeTime } from '../../lib/time';
import { Badge, Button, Dialog, EmptyState, inputClassName, textareaClassName } from '../ui/primitives';
import {
  BrainIcon, BugIcon, ChartIcon, DatabaseIcon, FolderIcon, GlobeIcon, ImageIcon, KeyIcon, LayersIcon,
  ListChecksIcon, NoteIcon, PlayIcon, PlusIcon, SearchIcon, ShapesIcon, SparklesIcon, TrashIcon, VideoIcon,
} from '../ui/icons';

/** Blue verified check, like a social verified badge — only for servers
 *  mcpservers.org itself marks "official". */
export function VerifiedBadge({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img" aria-label="Official MCP server" className="shrink-0">
      <circle cx="12" cy="12" r="10" fill="#1d9bf0" />
      <path d="m8.2 12.4 2.5 2.5 5.1-5.6" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const MARKETPLACE_GLYPHS: Record<McpMarketplaceIcon, (props: { size?: number }) => React.JSX.Element> = {
  video: VideoIcon, image: ImageIcon, github: GitHubIcon, folder: FolderIcon, brain: BrainIcon,
  thinking: SparklesIcon, browser: GlobeIcon, database: DatabaseIcon, bug: BugIcon,
  checklist: ListChecksIcon, note: NoteIcon, shapes: ShapesIcon, chart: ChartIcon, globe: GlobeIcon,
};

function GitHubIcon({ size = 16 }: { size?: number }): React.JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5A11.5 11.5 0 0 0 .5 12a11.5 11.5 0 0 0 7.86 10.93c.58.1.79-.25.79-.56v-2c-3.2.7-3.87-1.54-3.87-1.54a3 3 0 0 0-1.28-1.67c-1.05-.72.08-.7.08-.7a2.4 2.4 0 0 1 1.75 1.18 2.44 2.44 0 0 0 3.33 1 2.44 2.44 0 0 1 .73-1.52c-2.55-.29-5.23-1.28-5.23-5.68a4.44 4.44 0 0 1 1.19-3.09 4.14 4.14 0 0 1 .11-3.05s.97-.31 3.18 1.18a11 11 0 0 1 5.8 0c2.21-1.49 3.18-1.18 3.18-1.18a4.14 4.14 0 0 1 .11 3.05 4.44 4.44 0 0 1 1.19 3.09c0 4.41-2.69 5.38-5.25 1.28-1.55 2.4 1.28 1.3.15 2.76 0 1.99-.01 1.45-.01 1.01 0 .31.21.67.8.55A11.5 11.5 0 0 0 23.5 12 11.5 11.5 0 0 0 12 .5Z" /></svg>
  );
}

/** The server's real logo when the marketplace provided one, else a coloured glyph tile. */
export function MarketplaceIcon({ entry, size = 36 }: { entry: McpMarketplaceEntry; size?: number }): React.JSX.Element {
  const Glyph = MARKETPLACE_GLYPHS[entry.icon];
  if (entry.logoDataUrl !== undefined) {
    return (
      <span className="flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-white" style={{ width: size, height: size }} aria-hidden="true">
        <img src={entry.logoDataUrl} alt="" className="size-full object-contain p-1" />
      </span>
    );
  }
  return (
    <span className="flex shrink-0 items-center justify-center rounded-lg text-white" style={{ width: size, height: size, background: entry.color }} aria-hidden="true">
      <Glyph size={Math.round(size * 0.52)} />
    </span>
  );
}

// MCP servers: add (untrusted, not started), approve to enable and list tools,
// try a tool, disable or remove. Approved servers are also offered to Codex
// for agent runs when the permission profile allows execution.

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : String(err);
}

function ServerStatus({ server }: { server: McpServer }): React.JSX.Element {
  if (server.authentication?.status === 'sign_in_required') return <Badge tone="warning">Sign in required</Badge>;
  if (server.trustStatus !== 'trusted') return <Badge tone="warning">Needs approval</Badge>;
  if (server.enablement !== 'enabled') return <Badge>Disabled</Badge>;
  if (server.health === 'healthy') return <Badge tone="success">Running</Badge>;
  if (server.health === 'unhealthy') return <Badge tone="destructive">Unreachable</Badge>;
  return <Badge>Enabled</Badge>;
}

function ToolRunner({ server, onClose }: { server: McpServer | null; onClose: () => void }): React.JSX.Element {
  const [tool, setTool] = useState('');
  const [args, setArgs] = useState('{}');
  const [result, setResult] = useState<McpInvocationResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toolId = useId();
  const argsId = useId();
  useEffect(() => { setTool(server?.capabilities[0]?.id ?? ''); setArgs('{}'); setResult(null); setError(null); }, [server]);
  async function run(): Promise<void> {
    if (server === null) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(args) as Record<string, unknown>; } catch { setError('Arguments must be a JSON object'); return; }
    setBusy(true); setError(null);
    try { setResult(await window.conductor.mcp.invoke({ id: server.id, tool, args: parsed })); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  return (
    <Dialog open={server !== null} onClose={onClose} title={`Run a tool on ${server?.name ?? ''}`} description="Calls the tool directly from Conductor. The call is audited." width="max-w-xl">
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={toolId} className="text-xs font-medium">Tool</label>
          <MenuSelect variant="box" label="Tool" value={tool} onChange={setTool} options={(server?.capabilities ?? []).map((c) => ({ value: c.id, label: c.id, ...(c.title !== c.id ? { hint: c.title } : {}) }))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={argsId} className="text-xs font-medium">Arguments (JSON)</label>
          <textarea id={argsId} className={`${textareaClassName} font-mono text-xs`} rows={5} value={args} onChange={(e) => { setArgs(e.target.value); }} spellCheck={false} />
        </div>
        {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
        {result !== null ? (
          <pre className="max-h-72 overflow-auto rounded-lg border border-border bg-code p-2.5 font-mono text-2xs whitespace-pre-wrap break-words">
            {result.ok ? JSON.stringify(result.output, null, 2) : `${result.reason}: ${result.message}`}
          </pre>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button size="md" variant="ghost" onClick={onClose}>Close</Button>
          <Button size="md" variant="primary" disabled={busy || tool === ''} onClick={() => { void run(); }}><PlayIcon size={12} />{busy ? 'Running…' : 'Run'}</Button>
        </div>
      </div>
    </Dialog>
  );
}

export function Marketplace({ servers, busy, onInstall, isInstalled, installLabel }: {
  servers: McpServer[];
  busy: string | null;
  onInstall: (entry: McpMarketplaceEntry) => void;
  /** Overrides the installed check (e.g. against the CLIs' servers). */
  isInstalled?: ((entry: McpMarketplaceEntry) => boolean) | undefined;
  installLabel?: string | undefined;
}): React.JSX.Element {
  const [catalog, setCatalog] = useState<readonly McpMarketplaceEntry[]>([]);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('All');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(async (search: string) => {
    setLoading(true);
    setLoadError(null);
    try { setCatalog(await window.conductor.mcp.marketplace(search.trim() || undefined)); }
    catch (err) { setLoadError(message(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(''); }, [load]);
  const installedEndpoints = useMemo(() => new Set(servers.map((s) => s.endpoint)), [servers]);
  const categories = useMemo(() => ['All', ...new Set(catalog.map((e) => e.category))], [catalog]);
  const visible = catalog.filter((entry) => category === 'All' || entry.category === category);
  const queryId = useId();
  return (
    <div className="flex flex-col gap-3">
      <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void load(query); }}>
        <div className="min-w-44 flex-1">
          <label htmlFor={queryId} className="sr-only">Search mcpservers.org</label>
          <input id={queryId} className={inputClassName} value={query} onChange={(e) => { setQuery(e.target.value); }} placeholder="Search mcpservers.org… (e.g. higgsfield, video, github)" />
        </div>
        <Button size="sm" variant="outline" type="submit" disabled={loading}><SearchIcon size={13} />{loading ? 'Searching…' : 'Search'}</Button>
        <div className="flex flex-wrap gap-1" role="group" aria-label="Marketplace category">
          {categories.map((c) => (
            <Button key={c} size="xs" variant={category === c ? 'primary' : 'outline'} onClick={() => { setCategory(c); }}>{c}</Button>
          ))}
        </div>
      </form>
      <p className="text-3xs text-muted-foreground">Live catalog from mcpservers.org. <VerifiedBadge size={11} /> marks servers mcpservers.org lists as official. {isInstalled !== undefined ? 'Install opens the add form with its settings filled in.' : 'Installing never starts a server — Approve does.'}</p>
      {loadError !== null ? <p role="alert" className="text-xs text-destructive-foreground">Could not reach mcpservers.org: {loadError} <button type="button" className="underline" onClick={() => { void load(query); }}>Retry</button></p> : null}
      {loading && catalog.length === 0 ? <p role="status" className="text-2xs text-muted-foreground">Loading the registry catalog…</p> : null}
      {!loading && visible.length === 0 ? <p className="text-2xs text-muted-foreground">No registry servers match. Try another search.</p> : (
        <>
        <p className="text-3xs text-muted-foreground">{visible.length} server{visible.length === 1 ? '' : 's'}{category !== 'All' ? ` in ${category}` : ''} — scroll the catalog or search to narrow it down.</p>
        <ul className="grid max-h-[520px] gap-2 overflow-y-auto pr-1 sm:grid-cols-2 xl:grid-cols-3">
          {visible.map((entry) => {
            const installed = isInstalled !== undefined
              ? isInstalled(entry)
              : (entry.endpoint !== '' && installedEndpoints.has(entry.endpoint)) || servers.some((s) => s.name === entry.name);
            return (
              <li key={entry.id} className="flex gap-3 rounded-xl border border-border bg-card p-3.5">
                <MarketplaceIcon entry={entry} />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                    <span className="truncate">{entry.name}</span>
                    {entry.verified ? <VerifiedBadge /> : null}
                  </p>
                  <p className="truncate text-3xs text-muted-foreground" title={entry.id}>{entry.publisher} · {entry.category}{entry.verified ? ' · Official' : ''}{entry.stars !== undefined ? ` · ★ ${entry.stars}` : ''}</p>
                  <p className="mt-1 line-clamp-3 text-2xs leading-relaxed text-muted-foreground">{entry.description}</p>
                  <p className="mt-1 text-3xs text-muted-foreground">{entry.authNote}</p>
                  <div className="mt-2 flex items-center gap-2">
                    {installed
                      ? <Badge tone="success">Installed</Badge>
                      : <Button size="xs" variant="primary" disabled={busy !== null || !entry.installable} title={entry.installable ? `Install ${entry.name}` : entry.authNote} onClick={() => { onInstall(entry); }}>{busy === `install:${entry.id}` || busy === `draft:${entry.id}` ? 'Opening…' : entry.installable ? (installLabel ?? 'Install') : 'Needs manual setup'}</Button>}
                    <span className="truncate font-mono text-3xs text-muted-foreground" title={entry.websiteUrl}>{entry.id}</span>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
        </>
      )}
    </div>
  );
}

/**
 * Servers registered in Conductor itself (the older model, before servers were
 * installed into the CLIs). With `legacy`, it only lists existing ones so they
 * can still be managed or removed, and renders nothing when there are none.
 */
export function McpServers({ legacy = false }: { legacy?: boolean } = {}): React.JSX.Element | null {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [catalogEntries, setCatalogEntries] = useState<readonly McpMarketplaceEntry[]>([]);
  const [discovered, setDiscovered] = useState<McpDiscoveryEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<McpServer | null>(null);
  const [running, setRunning] = useState<McpServer | null>(null);
  const [secretFor, setSecretFor] = useState<{ server: McpServer; name: string } | null>(null);
  const [secretValue, setSecretValue] = useState('');
  const [approveKeys, setApproveKeys] = useState<Record<string, string>>({});
  const [oauth, setOauth] = useState<McpOAuthChallenge | null>(null);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [githubOpen, setGithubOpen] = useState(false);
  const [githubClientId, setGithubClientId] = useState('');
  const [githubSaved, setGithubSaved] = useState('');
  useEffect(() => {
    void window.conductor.settings.get(GITHUB_OAUTH_CLIENT_ID_KEY).then((value) => {
      if (typeof value === 'string') { setGithubSaved(value); setGithubClientId(value); }
    }).catch(() => undefined);
  }, []);
  const oauthRef = useRef<McpOAuthChallenge | null>(null);
  useEffect(() => { oauthRef.current = oauth; }, [oauth]);
  useEffect(() => () => {
    if (oauthRef.current !== null) void window.conductor.mcp.cancelOAuth(oauthRef.current.serverId);
  }, []);
  useEffect(() => { setApproveKeys({}); setSecretValue(''); }, [confirm?.id, secretFor?.name]);
  const nameId = useId();
  const endpointId = useId();

  const refresh = useCallback(async () => {
    try { setServers(await window.conductor.mcp.list()); } catch (err) { setError(message(err)); }
  }, []);
  useEffect(() => {
    void refresh();
    void window.conductor.mcp.marketplace().then(setCatalogEntries).catch(() => undefined);
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { window.clearInterval(timer); };
  }, [refresh]);

  async function act(key: string, run: () => Promise<unknown>): Promise<void> {
    setBusy(key); setError(null);
    try { await run(); await refresh(); } catch (err) { setError(message(err)); } finally { setBusy(null); }
  }

  async function finishOAuth(challenge: McpOAuthChallenge): Promise<void> {
    setOauth(challenge); setOauthError(null); setBusy(`oauth:${challenge.serverId}`);
    try {
      await window.conductor.mcp.completeOAuth(challenge.serverId);
      setOauth(null);
      await refresh();
    } catch (err) {
      setOauthError(message(err));
      await refresh();
    } finally { setBusy(null); }
  }

  async function install(entry: McpMarketplaceEntry): Promise<void> {
    setBusy(`install:${entry.id}`); setError(null);
    try {
      const result = await window.conductor.mcp.install(entry.id);
      await refresh();
      if (result.oauth !== undefined) void finishOAuth(result.oauth);
    } catch (err) { setError(message(err)); }
    finally { setBusy((current) => current === `install:${entry.id}` ? null : current); }
  }

  async function connect(server: McpServer): Promise<void> {
    setBusy(`oauth:${server.id}`); setError(null);
    try { void finishOAuth(await window.conductor.mcp.startOAuth(server.id)); }
    catch (err) { setError(message(err)); setBusy(null); }
  }

  const registered = new Set(servers.map((s) => s.endpoint));

  if (legacy && servers.length === 0) return null;

  return (
    <section aria-label={legacy ? 'Servers registered in Conductor' : 'MCP servers'} className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><LayersIcon size={15} className="text-muted-foreground" />{legacy ? 'Servers registered in Conductor' : 'MCP servers'}</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{legacy
            ? 'Added before servers were installed into the CLIs. Conductor still hands approved ones to agents for each run; add them above to put them in the CLIs themselves.'
            : 'Approved servers are exposed to every agent — Codex, Claude Code, OpenCode, Kiro and Antigravity — in Work and Chat.'}</p>
        </div>
        <div className={legacy ? 'hidden' : 'flex gap-1.5'}>
          <Button size="sm" variant="outline" onClick={() => { setGithubOpen(true); }} title={githubSaved === '' ? 'Add your GitHub OAuth App client ID' : 'GitHub sign-in is configured'}>GitHub sign-in{githubSaved === '' ? '' : ' ✓'}</Button>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void act('discover', async () => { setDiscovered(await window.conductor.mcp.discover()); }); }}><SearchIcon size={13} />Find installed</Button>
          <Button size="sm" variant="primary" onClick={() => { setName(''); setEndpoint(''); setAdding(true); }}><PlusIcon size={13} />Add server</Button>
        </div>
      </header>
      {error !== null ? (
        <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive-foreground">
          <span>{error}</span>
          {/OAuth App client ID/i.test(error) ? <Button size="xs" variant="outline" onClick={() => { setGithubOpen(true); }}>Set GitHub client ID</Button> : null}
        </p>
      ) : null}
      {legacy ? null : <Marketplace servers={servers} busy={busy} onInstall={(entry) => { void install(entry); }} />}
      {discovered !== null ? (
        <div className="rounded-xl border border-border p-3">
          <div className="mb-2 flex items-center justify-between"><p className="text-xs font-medium">Found in other apps’ MCP configs</p><Button size="xs" variant="ghost" onClick={() => { setDiscovered(null); }}>Hide</Button></div>
          {discovered.length === 0 ? <p className="text-2xs text-muted-foreground">No MCP servers found in Claude Desktop, Cursor, Kiro, VS Code or Codex configs. Servers with environment variables or headers are skipped because those usually hold credentials.</p> : (
            <ul className="flex flex-col gap-1">
              {discovered.map((entry) => (
                <li key={entry.id} className="flex items-center gap-2 text-2xs">
                  <span className="min-w-0 flex-1"><span className="font-medium text-foreground">{entry.name}</span> <span className="font-mono text-muted-foreground">{entry.endpoint}</span></span>
                  {registered.has(entry.endpoint) ? <Badge>Added</Badge> : <Button size="xs" variant="outline" disabled={busy !== null} onClick={() => { void act(`add:${entry.id}`, () => window.conductor.mcp.add({ name: entry.name, endpoint: entry.endpoint })); }}>Add</Button>}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
      {servers.length === 0 ? (
        <EmptyState icon={<LayersIcon size={20} />} title="No MCP servers" description="Add a server by command (stdio) or https:// URL. It stays stopped until you approve it." />
      ) : (
        <ul className="flex flex-col gap-2">
          {servers.map((server) => {
            const entry = catalogEntries.find((e) => e.endpoint !== '' && e.endpoint === server.endpoint) ?? catalogEntries.find((e) => e.name === server.name);
            return (
            <li key={server.id} className="rounded-xl border border-border bg-card p-3.5">
              <div className="flex items-start gap-3">
                {entry !== undefined ? <MarketplaceIcon entry={entry} size={32} /> : null}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><p className="flex items-center gap-1.5 text-sm font-medium text-foreground">{server.name}{entry?.verified ? <VerifiedBadge size={13} /> : null}</p><ServerStatus server={server} /></div>
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground" title={server.endpoint}>{server.endpoint}</p>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {server.capabilities.length > 0 ? `${server.capabilities.length} tool${server.capabilities.length === 1 ? '' : 's'}: ${server.capabilities.slice(0, 6).map((c) => c.id).join(', ')}${server.capabilities.length > 6 ? '…' : ''}` : 'Tools are listed after approval'}
                    {server.lastHealthCheckAt ? ` · checked ${relativeTime(server.lastHealthCheckAt)}` : ''}
                  </p>
                  {(server.secretSlots ?? []).map((slot) => (
                    <p key={slot.name} className="mt-1 flex items-center gap-2 text-2xs text-muted-foreground">
                      <KeyIcon size={11} className="shrink-0" />
                      <span className="font-mono">{slot.name}</span>
                      <span>{slot.set ? 'saved in Keychain' : 'not set — the server will fail without it'}</span>
                      <button type="button" className="cursor-pointer underline hover:text-foreground" onClick={() => { setSecretFor({ server, name: slot.name }); }}>{slot.set ? 'Change' : 'Set key'}</button>
                      {slot.set ? <button type="button" className="cursor-pointer underline hover:text-foreground" onClick={() => { void act(`clearsecret:${server.id}:${slot.name}`, () => window.conductor.mcp.clearSecret({ id: server.id, name: slot.name })); }}>Remove</button> : null}
                    </p>
                  ))}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {server.authentication?.status === 'sign_in_required' ? (
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { void connect(server); }}>{busy === `oauth:${server.id}` ? 'Waiting for sign-in…' : 'Sign in'}</Button>
                  ) : server.trustStatus === 'trusted' && server.enablement === 'enabled' ? (
                    <>
                      <Button size="sm" variant="outline" disabled={server.capabilities.length === 0} onClick={() => { setRunning(server); }}><PlayIcon size={11} />Try a tool</Button>
                      <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void act(`disable:${server.id}`, () => window.conductor.mcp.disable(server.id)); }}>Disable</Button>
                    </>
                  ) : (
                    <Button size="sm" variant="primary" disabled={busy !== null} onClick={() => { setConfirm(server); }}>{busy === `approve:${server.id}` ? 'Starting…' : server.trustStatus === 'trusted' ? 'Enable' : 'Approve'}</Button>
                  )}
                  <Button size="icon-sm" variant="ghost" aria-label={`Remove ${server.name}`} disabled={busy !== null} onClick={() => { void act(`remove:${server.id}`, () => window.conductor.mcp.remove(server.id)); }}><TrashIcon size={13} /></Button>
                </div>
              </div>
            </li>
            );
          })}
        </ul>
      )}
      <Dialog open={adding} onClose={() => { setAdding(false); }} title="Add MCP server" description="The server is saved as untrusted and is not started until you approve it.">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void act('add', async () => { await window.conductor.mcp.add({ name: name.trim(), endpoint: endpoint.trim() }); setAdding(false); }); }}>
          <div className="flex flex-col gap-1.5"><label htmlFor={nameId} className="text-xs font-medium">Name</label><input id={nameId} className={inputClassName} value={name} onChange={(e) => { setName(e.target.value); }} maxLength={255} /></div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={endpointId} className="text-xs font-medium">Command or URL</label>
            <input id={endpointId} className={`${inputClassName} font-mono text-xs`} value={endpoint} onChange={(e) => { setEndpoint(e.target.value); }} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/notes" spellCheck={false} />
            <p className="text-3xs text-muted-foreground">Command = local stdio. URL = Streamable HTTP. Leave credential placeholders like YOUR_API_KEY_HERE in place — Conductor detects them and asks for the value separately, storing it in your Keychain.</p>
          </div>
          <div className="mt-2 flex justify-end gap-2"><Button size="md" variant="ghost" onClick={() => { setAdding(false); }}>Cancel</Button><Button size="md" variant="primary" type="submit" disabled={busy !== null || !name.trim() || !endpoint.trim()}>Add</Button></div>
        </form>
      </Dialog>
      <Dialog
        open={githubOpen}
        onClose={() => { setGithubOpen(false); setGithubClientId(githubSaved); }}
        title="GitHub sign-in"
        description="Conductor signs in to GitHub with your own OAuth App, so tokens and rate limits belong to you. Nothing is shared with the Conductor authors."
        footer={<>
          {githubSaved !== '' ? <Button size="md" variant="ghost" onClick={() => {
            void act('github-clear', async () => { await window.conductor.settings.set({ key: GITHUB_OAUTH_CLIENT_ID_KEY, value: '', scope: 'global' }); setGithubSaved(''); setGithubClientId(''); setGithubOpen(false); });
          }}>Remove</Button> : null}
          <span className="flex-1" />
          <Button size="md" variant="ghost" onClick={() => { setGithubOpen(false); setGithubClientId(githubSaved); }}>Cancel</Button>
          <Button size="md" variant="primary" disabled={!GITHUB_CLIENT_ID_PATTERN.test(githubClientId.trim())} onClick={() => {
            const value = githubClientId.trim();
            void act('github-save', async () => { await window.conductor.settings.set({ key: GITHUB_OAUTH_CLIENT_ID_KEY, value, scope: 'global' }); setGithubSaved(value); setGithubOpen(false); });
          }}>Save</Button>
        </>}
      >
        <div className="flex flex-col gap-3 text-xs">
          <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>Open <a href="https://github.com/settings/applications/new" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">github.com/settings/applications/new</a> and register an OAuth App (any name; the homepage and callback URL can be <code className="font-mono">http://localhost</code>).</li>
            <li>On the app’s page, tick <strong className="font-medium text-foreground">Enable Device Flow</strong> and save.</li>
            <li>Paste its <strong className="font-medium text-foreground">Client ID</strong> below. The client ID is public; no client secret is needed.</li>
          </ol>
          <label className="flex flex-col gap-1 font-medium">Client ID
            <input className={inputClassName} value={githubClientId} onChange={(e) => { setGithubClientId(e.target.value); }} placeholder="Ov23li…" spellCheck={false} autoComplete="off" />
          </label>
          {githubClientId.trim() !== '' && !GITHUB_CLIENT_ID_PATTERN.test(githubClientId.trim()) ? <p role="alert" className="text-destructive-foreground">That doesn’t look like a GitHub client ID.</p> : null}
        </div>
      </Dialog>
      <Dialog
        open={oauth !== null}
        onClose={() => { if (oauth !== null) void window.conductor.mcp.cancelOAuth(oauth.serverId); setOauth(null); setOauthError(null); setBusy(null); }}
        title={`Sign in to ${oauth?.providerName ?? 'the service'}`}
        description={`${oauth?.providerName ?? 'The service'} opened in your browser. Enter this one-time code, approve Conductor, then return here. Conductor will finish automatically.`}
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { if (oauth !== null) void window.conductor.mcp.cancelOAuth(oauth.serverId); setOauth(null); setOauthError(null); setBusy(null); }}>Cancel</Button>
          {oauthError !== null && oauth !== null ? <Button size="md" variant="primary" onClick={() => {
            const server = servers.find((candidate) => candidate.id === oauth.serverId);
            void window.conductor.mcp.cancelOAuth(oauth.serverId);
            setOauth(null); setOauthError(null);
            if (server !== undefined) void connect(server);
          }}>Try again</Button> : null}
        </>}
      >
        <div className="flex flex-col items-center gap-3 py-2">
          <p className="rounded-lg border border-border bg-code px-5 py-3 font-mono text-xl font-semibold tracking-widest select-all">{oauth?.userCode}</p>
          {oauthError === null
            ? <p role="status" className="text-xs text-muted-foreground">Waiting for approval in {oauth?.providerName ?? 'your browser'}…</p>
            : <p role="alert" className="text-xs text-destructive-foreground">{oauthError}</p>}
          <p className="text-3xs text-muted-foreground">If the browser did not open, cancel and choose Sign in again.</p>
        </div>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onClose={() => { setConfirm(null); }}
        title={`Approve ${confirm?.name ?? ''}?`}
        description="Approving starts this server on your Mac (or connects to its URL) with your user permissions, lists its tools, and exposes them to Conductor and every agent CLI (Codex, Claude Code, OpenCode, Kiro, Antigravity). Only approve servers you trust."
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setConfirm(null); }}>Cancel</Button>
          <Button
            size="md" variant="primary"
            disabled={confirm !== null && (confirm.secretSlots ?? []).some((slot) => !slot.set && (approveKeys[slot.name] ?? '').trim() === '')}
            onClick={() => {
              const target = confirm;
              const keys = { ...approveKeys };
              setConfirm(null);
              if (target) void act(`approve:${target.id}`, async () => {
                for (const slot of target.secretSlots ?? []) {
                  const value = (keys[slot.name] ?? '').trim();
                  if (!slot.set && value !== '') await window.conductor.mcp.setSecret({ id: target.id, name: slot.name, value });
                }
                await window.conductor.mcp.approve(target.id);
              });
            }}
          >Approve and start</Button>
        </>}
      >
        <div className="flex flex-col gap-3">
          <p className="rounded-lg bg-code px-2.5 py-2 font-mono text-2xs break-all">{confirm?.endpoint}</p>
          {(confirm?.secretSlots ?? []).map((slot) => (
            <div key={slot.name} className="flex flex-col gap-1.5">
              <label htmlFor={`approve-key-${slot.name}`} className="flex items-center gap-1.5 text-xs font-medium"><KeyIcon size={12} />{slot.name}</label>
              {slot.set
                ? <p className="text-2xs text-muted-foreground">Saved in your macOS Keychain. It is substituted when the server starts — it never appears in this endpoint or in chat.</p>
                : <>
                  <input id={`approve-key-${slot.name}`} type="password" autoComplete="off" className={inputClassName} value={approveKeys[slot.name] ?? ''} onChange={(e) => { setApproveKeys((k) => ({ ...k, [slot.name]: e.target.value })); }} placeholder={`Paste the ${slot.name} value`} />
                  <p className="text-3xs text-muted-foreground">Stored in your macOS Keychain. Conductor substitutes it at start time for every agent; the placeholder in the endpoint above is never sent as-is.</p>
                </>}
            </div>
          ))}
        </div>
      </Dialog>
      <Dialog
        open={secretFor !== null}
        onClose={() => { setSecretFor(null); }}
        title={`${secretFor?.server.name ?? ''} — ${secretFor?.name ?? ''}`}
        description="Stored in your macOS Keychain. Conductor substitutes it when the server starts, for Conductor and every agent CLI. It is never shown again or written into the endpoint."
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setSecretFor(null); }}>Cancel</Button>
          <Button size="md" variant="primary" disabled={secretValue.trim() === ''} onClick={() => { const target = secretFor; setSecretFor(null); if (target) void act(`setsecret:${target.server.id}:${target.name}`, () => window.conductor.mcp.setSecret({ id: target.server.id, name: target.name, value: secretValue })); }}>Save to Keychain</Button>
        </>}
      >
        <label htmlFor="mcp-secret-value" className="sr-only">Credential value</label>
        <input id="mcp-secret-value" type="password" autoComplete="off" className={inputClassName} value={secretValue} onChange={(e) => { setSecretValue(e.target.value); }} placeholder="Paste the API key / token" />
      </Dialog>
      <ToolRunner server={running} onClose={() => { setRunning(null); }} />
    </section>
  );
}
