import { randomUUID } from 'node:crypto';
import type { AdapterSessionHandle } from '@shared/adapter';
import type { CapabilityDescriptor } from '@shared/domain';
import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { Registry } from '../registry/registry';
import { RemoteExecutionAdapter } from './remote-execution-adapter';
import { buildObjectiveLaunch, type ObjectiveInput } from './objective-cli-adapter';
import { assertSshHost, SshRemoteTransport } from './ssh-transport';

// Remote hosts run Codex over SSH. Each enabled host is registered as an agent
// (`remote:<id>`) that can fulfil task objectives in a directory on that host.
// Remote agents are marked high cost/latency so routing prefers local agents
// unless the user picks the remote host for a thread.

export interface RemoteHost {
  id: string;
  name: string;
  host: string;
  remoteDir: string;
  installIfMissing: boolean;
  enabled: boolean;
  createdAt: string;
}

export const CODEX_INSTALL_COMMAND = 'npm install -g @openai/codex';

interface Row { id: string; name: string; host: string; remote_dir: string; install_if_missing: number; enabled: number; created_at: string }

function toHost(row: Row): RemoteHost {
  return { id: row.id, name: row.name, host: row.host, remoteDir: row.remote_dir, installIfMissing: row.install_if_missing === 1, enabled: row.enabled === 1, createdAt: row.created_at };
}

function objectiveCapabilities(adapterId: string, name: string): CapabilityDescriptor[] {
  const base: Omit<CapabilityDescriptor, 'id' | 'title'> = {
    inputSchema: { type: 'object' }, outputSchema: { type: 'object' },
    streaming: true, cancellable: true, resumable: false,
    requiredPermissions: [{ kind: 'network_egress' }, { kind: 'command_exec' }, { kind: 'filesystem_read' }, { kind: 'filesystem_write' }],
    costHint: 'high', latencyHint: 'high',
  };
  return [
    { ...base, id: 'objective.fulfill', title: `Complete a task with Codex on ${name}` },
    { ...base, id: `objective.fulfill.${adapterId}`, title: `Continue a conversation on ${name}` },
  ];
}

/** Codex on a remote host, launched over SSH with the same protocol as local Codex. */
export class RemoteAgentAdapter extends RemoteExecutionAdapter {
  constructor(
    private readonly remote: RemoteHost,
    transport: SshRemoteTransport,
    private readonly beforeStart: (host: RemoteHost) => void,
  ) {
    const id = `remote:${remote.id}`;
    super({ id, name: `Codex on ${remote.name}`, version: '1.0.0', host: remote.host, capabilities: objectiveCapabilities(id, remote.name) }, transport);
  }

  override async start(input: unknown): Promise<AdapterSessionHandle> {
    if (typeof input !== 'object' || input === null) throw new Error('Objective input is required');
    const data = input as ObjectiveInput;
    if (!data.objective) throw new Error('Objective is required');
    this.beforeStart(this.remote);
    // The agent works in the configured remote directory, not the local path.
    const launch = buildObjectiveLaunch(this.record.id, { ...data, rootPath: this.remote.remoteDir });
    return super.start({ args: launch.args ?? [], stdin: launch.stdin ?? '' });
  }
}

export class RemoteHostService {
  private readonly transports = new Map<string, SshRemoteTransport>();

  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    private readonly registry: Registry,
    private readonly beforeStart: (host: RemoteHost) => void,
    private readonly grantConsent: (provider: string) => void,
    private readonly makeTransport: (host: RemoteHost) => SshRemoteTransport = (host) =>
      new SshRemoteTransport(host.installIfMissing ? { installCommand: CODEX_INSTALL_COMMAND } : {}),
  ) {}

  static provider(host: string): string {
    return `ssh:${host.toLowerCase()}`;
  }

  list(): RemoteHost[] {
    return (this.store.db.prepare('SELECT * FROM remote_hosts ORDER BY created_at ASC, rowid ASC').all() as Row[]).map(toHost);
  }

  get(id: string): RemoteHost | undefined {
    const row = this.store.db.prepare('SELECT * FROM remote_hosts WHERE id = ?').get(id) as Row | undefined;
    return row === undefined ? undefined : toHost(row);
  }

  /** Register adapters for every enabled host (at boot). */
  registerAll(): void {
    for (const host of this.list()) if (host.enabled) this.registerAdapter(host);
  }

  add(input: { name: string; host: string; remoteDir: string; installIfMissing: boolean }): RemoteHost {
    const host = assertSshHost(input.host);
    const name = input.name.trim() || host;
    const remoteDir = input.remoteDir.trim();
    if (remoteDir === '' || remoteDir.length > 1024 || /[\0\n]/.test(remoteDir)) throw new Error('Enter the remote working directory');
    const record: RemoteHost = { id: randomUUID(), name, host, remoteDir, installIfMissing: input.installIfMissing, enabled: true, createdAt: new Date().toISOString() };
    this.store.db.prepare('INSERT INTO remote_hosts (id, name, host, remote_dir, install_if_missing, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(record.id, record.name, record.host, record.remoteDir, record.installIfMissing ? 1 : 0, record.createdAt);
    // Adding a host is the user's consent to send tasks to it over SSH.
    this.grantConsent(RemoteHostService.provider(host));
    this.audit.append({ actor: 'user', action: 'remote_host.added', target: record.id, redactedPayload: { host, remoteDir } });
    this.registerAdapter(record);
    return record;
  }

  remove(id: string): void {
    if (this.get(id) === undefined) return;
    this.registry.deregister(`remote:${id}`);
    this.transports.delete(id);
    this.store.db.prepare('DELETE FROM remote_hosts WHERE id = ?').run(id);
    this.audit.append({ actor: 'user', action: 'remote_host.removed', target: id });
  }

  setEnabled(id: string, enabled: boolean): RemoteHost {
    const host = this.get(id);
    if (host === undefined) throw new Error('Remote host not found');
    this.store.db.prepare('UPDATE remote_hosts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    const next = { ...host, enabled };
    if (enabled) this.registerAdapter(next); else this.registry.deregister(`remote:${id}`);
    return next;
  }

  async test(id: string): Promise<{ connected: boolean; agentInstalled: boolean; error?: string }> {
    const host = this.get(id);
    if (host === undefined) throw new Error('Remote host not found');
    return this.transportFor(host).test(host.host);
  }

  /** Whether the remote adapter is registered and routable. */
  available(id: string): boolean {
    const adapterId = `remote:${id}`;
    return this.registry.has(adapterId) && this.registry.resolve(adapterId).record.available;
  }

  private transportFor(host: RemoteHost): SshRemoteTransport {
    let transport = this.transports.get(host.id);
    if (transport === undefined) {
      transport = this.makeTransport(host);
      this.transports.set(host.id, transport);
    }
    return transport;
  }

  private registerAdapter(host: RemoteHost): void {
    const adapterId = `remote:${host.id}`;
    if (this.registry.has(adapterId)) this.registry.deregister(adapterId);
    this.registry.register(new RemoteAgentAdapter(host, this.transportFor(host), this.beforeStart));
  }
}
