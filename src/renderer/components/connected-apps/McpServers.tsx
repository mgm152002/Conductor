import { useCallback, useEffect, useId, useState } from 'react';
import type { McpDiscoveryEntry, McpInvocationResult, McpServer } from '@shared/mcp';
import { relativeTime } from '../../lib/time';
import { Badge, Button, Dialog, EmptyState, inputClassName, textareaClassName } from '../ui/primitives';
import { LayersIcon, PlayIcon, PlusIcon, SearchIcon, TrashIcon } from '../ui/icons';

// MCP servers: add (untrusted, not started), approve to enable and list tools,
// try a tool, disable or remove. Approved servers are also offered to Codex
// for agent runs when the permission profile allows execution.

function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : String(err);
}

function ServerStatus({ server }: { server: McpServer }): React.JSX.Element {
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
          <select id={toolId} className={inputClassName} value={tool} onChange={(e) => { setTool(e.target.value); }}>
            {server?.capabilities.map((c) => <option key={c.id} value={c.id}>{c.id}{c.title !== c.id ? ` — ${c.title}` : ''}</option>)}
          </select>
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

export function McpServers(): React.JSX.Element {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [discovered, setDiscovered] = useState<McpDiscoveryEntry[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<McpServer | null>(null);
  const [running, setRunning] = useState<McpServer | null>(null);
  const nameId = useId();
  const endpointId = useId();

  const refresh = useCallback(async () => {
    try { setServers(await window.conductor.mcp.list()); } catch (err) { setError(message(err)); }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    return () => { window.clearInterval(timer); };
  }, [refresh]);

  async function act(key: string, run: () => Promise<unknown>): Promise<void> {
    setBusy(key); setError(null);
    try { await run(); await refresh(); } catch (err) { setError(message(err)); } finally { setBusy(null); }
  }

  const registered = new Set(servers.map((s) => s.endpoint));

  return (
    <section aria-label="MCP servers" className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><LayersIcon size={15} className="text-muted-foreground" />MCP servers</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Model Context Protocol tools. Approved servers can be called from here and are offered to Codex when the permission profile allows execution.</p>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void act('discover', async () => { setDiscovered(await window.conductor.mcp.discover()); }); }}><SearchIcon size={13} />Find installed</Button>
          <Button size="sm" variant="primary" onClick={() => { setName(''); setEndpoint(''); setAdding(true); }}><PlusIcon size={13} />Add server</Button>
        </div>
      </header>
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
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
          {servers.map((server) => (
            <li key={server.id} className="rounded-xl border border-border bg-card p-3.5">
              <div className="flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2"><p className="text-sm font-medium text-foreground">{server.name}</p><ServerStatus server={server} /></div>
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground" title={server.endpoint}>{server.endpoint}</p>
                  <p className="mt-1 text-2xs text-muted-foreground">
                    {server.capabilities.length > 0 ? `${server.capabilities.length} tool${server.capabilities.length === 1 ? '' : 's'}: ${server.capabilities.slice(0, 6).map((c) => c.id).join(', ')}${server.capabilities.length > 6 ? '…' : ''}` : 'Tools are listed after approval'}
                    {server.lastHealthCheckAt ? ` · checked ${relativeTime(server.lastHealthCheckAt)}` : ''}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {server.trustStatus === 'trusted' && server.enablement === 'enabled' ? (
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
          ))}
        </ul>
      )}
      <Dialog open={adding} onClose={() => { setAdding(false); }} title="Add MCP server" description="The server is saved as untrusted and is not started until you approve it.">
        <form className="flex flex-col gap-3" onSubmit={(e) => { e.preventDefault(); void act('add', async () => { await window.conductor.mcp.add({ name: name.trim(), endpoint: endpoint.trim() }); setAdding(false); }); }}>
          <div className="flex flex-col gap-1.5"><label htmlFor={nameId} className="text-xs font-medium">Name</label><input id={nameId} className={inputClassName} value={name} onChange={(e) => { setName(e.target.value); }} maxLength={255} /></div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={endpointId} className="text-xs font-medium">Command or URL</label>
            <input id={endpointId} className={`${inputClassName} font-mono text-xs`} value={endpoint} onChange={(e) => { setEndpoint(e.target.value); }} placeholder="npx -y @modelcontextprotocol/server-filesystem ~/notes" spellCheck={false} />
            <p className="text-3xs text-muted-foreground">A command runs the server locally over stdio. An https:// URL uses Streamable HTTP. Don’t put API keys here.</p>
          </div>
          <div className="mt-2 flex justify-end gap-2"><Button size="md" variant="ghost" onClick={() => { setAdding(false); }}>Cancel</Button><Button size="md" variant="primary" type="submit" disabled={busy !== null || !name.trim() || !endpoint.trim()}>Add</Button></div>
        </form>
      </Dialog>
      <Dialog
        open={confirm !== null}
        onClose={() => { setConfirm(null); }}
        title={`Approve ${confirm?.name ?? ''}?`}
        description="Approving starts this server on your Mac (or connects to its URL) with your user permissions, lists its tools, and lets Conductor and Codex call them. Only approve servers you trust."
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setConfirm(null); }}>Cancel</Button>
          <Button size="md" variant="primary" onClick={() => { const target = confirm; setConfirm(null); if (target) void act(`approve:${target.id}`, () => window.conductor.mcp.approve(target.id)); }}>Approve and start</Button>
        </>}
      >
        <p className="rounded-lg bg-code px-2.5 py-2 font-mono text-2xs break-all">{confirm?.endpoint}</p>
      </Dialog>
      <ToolRunner server={running} onClose={() => { setRunning(null); }} />
    </section>
  );
}
