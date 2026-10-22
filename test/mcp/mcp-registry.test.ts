import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import {
  McpApprovalRequiredError,
  McpDuplicateError,
  McpRegistrationError,
  McpRegistry,
  type McpAccessControl,
  type McpTimerClock,
} from '@main/mcp/mcp-registry';
import {
  MCP_DISCOVERY_TIMEOUT_MS,
  MCP_MAX_REQUEST_TIMEOUT_MS,
  type McpDiscoveryEntry,
} from '@shared/mcp';
import { FakeMcpTransport } from '../fakes/fake-mcp-transport';

// Unit tests for task 19.2 — MCP & integration registry (Requirement 17):
//   17.1  — discovery returns id / trust status / registration state (≤10s)
//   17.2  — validated registration; prior state preserved on failure
//   17.3  — health checks record healthy / unhealthy / unknown
//   17.4  — request timeout (≤30s) cancels and errors, state preserved
//   17.5  — cancellation terminates the in-flight op and errors
//   17.6  — access-control denial
//   17.7  — lifecycle audit events
//   17.8  — only approved capabilities are exposed externally
//   17.9  — enabling an untrusted server is blocked pending approval
//   17.10 — untrusted server stays disabled and invocations are rejected

// A controllable timer so request/discovery timeouts fire on demand without
// real delay. `flush(ms)` fires every scheduled handler whose delay is ≤ ms.
class ManualTimer implements McpTimerClock {
  private seq = 0;
  private readonly handlers = new Map<number, { handler: () => void; ms: number }>();

  setTimeout(handler: () => void, ms: number): unknown {
    const id = this.seq++;
    this.handlers.set(id, { handler, ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.handlers.delete(handle as number);
  }

  /** Fire all pending handlers with delay ≤ ms (default: all). */
  flush(ms = Number.POSITIVE_INFINITY): void {
    for (const [id, entry] of [...this.handlers.entries()]) {
      if (entry.ms <= ms) {
        this.handlers.delete(id);
        entry.handler();
      }
    }
  }
}

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;

function newRegistry(opts: {
  transport?: FakeMcpTransport;
  accessControl?: McpAccessControl;
  timer?: McpTimerClock;
  now?: () => number;
} = {}): { registry: McpRegistry; transport: FakeMcpTransport; timer: ManualTimer } {
  const transport = opts.transport ?? new FakeMcpTransport();
  const timer = (opts.timer as ManualTimer) ?? new ManualTimer();
  const registry = new McpRegistry(store, audit, {
    transport,
    timer,
    ...(opts.accessControl !== undefined ? { accessControl: opts.accessControl } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return { registry, transport, timer };
}

function discoveryEntry(overrides: Partial<McpDiscoveryEntry> = {}): McpDiscoveryEntry {
  return {
    id: 'srv-1',
    name: 'Server One',
    endpoint: 'mcp://localhost/one',
    trustStatus: 'untrusted',
    registrationState: 'discovered',
    ...overrides,
  };
}

/** Register + approve + enable a server so it can be invoked. */
function enabledServer(
  registry: McpRegistry,
  id = 'srv-1',
  capabilityId = 'cap.read',
): void {
  registry.register({
    id,
    name: 'Server',
    endpoint: `mcp://localhost/${id}`,
    capabilities: [{ id: capabilityId, title: 'Read' }],
  });
  registry.approve(id, 'approver-1');
  registry.enable(id);
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-mcp-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('discovery (17.1)', () => {
  it('returns id, trust status, and registration state for each entry', async () => {
    const transport = new FakeMcpTransport({
      discovered: [
        discoveryEntry({ id: 'a', trustStatus: 'untrusted' }),
        discoveryEntry({ id: 'b', trustStatus: 'trusted' }),
      ],
    });
    const { registry } = newRegistry({ transport });

    const entries = await registry.discover();

    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      id: 'a',
      trustStatus: 'untrusted',
      registrationState: 'discovered',
    });
    expect(entries[1]).toMatchObject({ id: 'b', registrationState: 'discovered' });
  });

  it('reports a discovered server already in the registry as registered', async () => {
    const transport = new FakeMcpTransport({
      discovered: [discoveryEntry({ id: 'srv-1' })],
    });
    const { registry } = newRegistry({ transport });
    registry.register({ id: 'srv-1', name: 'Server One', endpoint: 'mcp://x' });

    const entries = await registry.discover();

    expect(entries[0]?.registrationState).toBe('registered');
  });

  it('aborts discovery with a timeout error when the transport hangs past 10s', async () => {
    const transport = new FakeMcpTransport({ hangDiscovery: true });
    const timer = new ManualTimer();
    const { registry } = newRegistry({ transport, timer });

    const promise = registry.discover();
    timer.flush(MCP_DISCOVERY_TIMEOUT_MS);

    await expect(promise).rejects.toThrow(/timeout/);
  });
});

describe('validated registration (17.2)', () => {
  it('registers a server as untrusted and disabled', () => {
    const { registry } = newRegistry();
    const server = registry.register({
      id: 'srv-1',
      name: 'Server One',
      endpoint: 'mcp://localhost/one',
    });
    expect(server.trustStatus).toBe('untrusted');
    expect(server.enablement).toBe('disabled');
    expect(server.health).toBe('unknown');
  });

  it('rejects a missing required field and preserves prior registry state', () => {
    const { registry } = newRegistry();
    registry.register({ id: 'srv-1', name: 'One', endpoint: 'mcp://x' });
    const before = registry.list();

    expect(() =>
      registry.register({ id: '', name: 'Bad', endpoint: 'mcp://y' }),
    ).toThrow(McpRegistrationError);
    expect(() =>
      registry.register({ id: 'srv-2', name: '', endpoint: 'mcp://y' }),
    ).toThrow(McpRegistrationError);
    expect(() =>
      registry.register({ id: 'srv-2', name: 'Two', endpoint: '' }),
    ).toThrow(McpRegistrationError);

    // Prior state unchanged: only the one valid server exists.
    expect(registry.list()).toEqual(before);
  });

  it('rejects malformed capabilities naming the field', () => {
    const { registry } = newRegistry();
    expect(() =>
      registry.register({
        id: 'srv-1',
        name: 'One',
        endpoint: 'mcp://x',
        capabilities: [{ id: '', title: '' }],
      }),
    ).toThrow(McpRegistrationError);
    expect(registry.list()).toEqual([]);
  });

  it('rejects a duplicate id without altering the existing server', () => {
    const { registry } = newRegistry();
    const first = registry.register({ id: 'srv-1', name: 'One', endpoint: 'mcp://x' });
    expect(() =>
      registry.register({ id: 'srv-1', name: 'Other', endpoint: 'mcp://z' }),
    ).toThrow(McpDuplicateError);
    expect(registry.get('srv-1')).toEqual(first);
  });
});

describe('health checks (17.3)', () => {
  it('records healthy and unhealthy per server', async () => {
    const transport = new FakeMcpTransport({
      health: { a: { healthy: true }, b: { healthy: false } },
    });
    const { registry } = newRegistry({ transport });
    registry.register({ id: 'a', name: 'A', endpoint: 'mcp://a' });
    registry.register({ id: 'b', name: 'B', endpoint: 'mcp://b' });

    const results = await registry.runHealthChecks();

    expect(results.find((s) => s.id === 'a')?.health).toBe('healthy');
    expect(results.find((s) => s.id === 'b')?.health).toBe('unhealthy');
    expect(registry.get('a')?.lastHealthCheckAt).toBeDefined();
  });

  it('records unhealthy when the probe throws rather than propagating', async () => {
    const transport = new FakeMcpTransport({ throwHealthFor: ['a'] });
    const { registry } = newRegistry({ transport });
    registry.register({ id: 'a', name: 'A', endpoint: 'mcp://a' });

    const [server] = await registry.runHealthChecks();
    expect(server?.health).toBe('unhealthy');
  });

  it('leaves health unknown until the first check', () => {
    const { registry } = newRegistry();
    registry.register({ id: 'a', name: 'A', endpoint: 'mcp://a' });
    expect(registry.get('a')?.health).toBe('unknown');
  });
});

describe('untrusted-server gating (17.9 / 17.10)', () => {
  it('blocks enabling an untrusted server and keeps it disabled', () => {
    const { registry } = newRegistry();
    registry.register({ id: 'srv-1', name: 'One', endpoint: 'mcp://x' });

    expect(() => registry.enable('srv-1')).toThrow(McpApprovalRequiredError);
    expect(registry.get('srv-1')?.enablement).toBe('disabled');
  });

  it('enables only after explicit approval', () => {
    const { registry } = newRegistry();
    registry.register({ id: 'srv-1', name: 'One', endpoint: 'mcp://x' });
    registry.approve('srv-1', 'approver-1');
    const server = registry.enable('srv-1');
    expect(server.trustStatus).toBe('trusted');
    expect(server.enablement).toBe('enabled');
    expect(server.approvedBy).toBe('approver-1');
  });

  it('rejects invocation of an untrusted/disabled server as not approved', async () => {
    const { registry } = newRegistry({ accessControl: () => true });
    registry.register({
      id: 'srv-1',
      name: 'One',
      endpoint: 'mcp://x',
      capabilities: [{ id: 'cap.read', title: 'Read' }],
    });

    const result = await registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'agent-1',
    });

    expect(result).toEqual({
      ok: false,
      reason: 'not_approved',
      message: expect.stringContaining('not approved'),
    });
  });
});

describe('access control (17.6)', () => {
  it('denies a caller without access and returns insufficient access', async () => {
    const accessControl: McpAccessControl = ({ caller }) => caller === 'allowed';
    const { registry } = newRegistry({ accessControl });
    enabledServer(registry, 'srv-1', 'cap.read');

    const denied = await registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'blocked',
    });
    expect(denied).toMatchObject({ ok: false, reason: 'access_denied' });

    const allowed = await registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'allowed',
    });
    expect(allowed).toMatchObject({ ok: true });
  });
});

describe('request timeout and cancellation (17.4 / 17.5)', () => {
  it('cancels a request that exceeds the timeout and preserves registry state', async () => {
    const transport = new FakeMcpTransport();
    transport.invokeBehavior = { mode: 'hang' };
    const timer = new ManualTimer();
    const { registry } = newRegistry({
      transport,
      timer,
      accessControl: () => true,
    });
    enabledServer(registry, 'srv-1', 'cap.read');
    const before = registry.get('srv-1');

    const promise = registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'agent-1',
      timeoutMs: 5_000,
    });
    timer.flush(5_000);

    expect(await promise).toMatchObject({ ok: false, reason: 'timeout' });
    expect(registry.get('srv-1')).toEqual(before);
  });

  it('clamps a too-large timeout to the 30s maximum', async () => {
    const transport = new FakeMcpTransport();
    transport.invokeBehavior = { mode: 'hang' };
    const timer = new ManualTimer();
    const { registry } = newRegistry({
      transport,
      timer,
      accessControl: () => true,
    });
    enabledServer(registry, 'srv-1', 'cap.read');

    const promise = registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'agent-1',
      timeoutMs: 10 * 60_000, // 10 minutes requested
    });
    // Firing at the 30s cap must settle the request.
    timer.flush(MCP_MAX_REQUEST_TIMEOUT_MS);

    expect(await promise).toMatchObject({ ok: false, reason: 'timeout' });
  });

  it('terminates an in-flight request when the caller cancels', async () => {
    const transport = new FakeMcpTransport();
    transport.invokeBehavior = { mode: 'hang' };
    const { registry } = newRegistry({ transport, accessControl: () => true });
    enabledServer(registry, 'srv-1', 'cap.read');

    const controller = new AbortController();
    const promise = registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'agent-1',
      signal: controller.signal,
    });
    controller.abort();

    expect(await promise).toMatchObject({ ok: false, reason: 'cancelled' });
  });

  it('returns a successful invocation output', async () => {
    const transport = new FakeMcpTransport();
    transport.invokeBehavior = { mode: 'resolve', output: { answer: 42 } };
    const { registry } = newRegistry({ transport, accessControl: () => true });
    enabledServer(registry, 'srv-1', 'cap.read');

    const result = await registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: { q: 'x' },
      caller: 'agent-1',
    });
    expect(result).toEqual({ ok: true, output: { answer: 42 } });
  });
});

describe('external capability exposure (17.8)', () => {
  it('exposes only approved capabilities', () => {
    const { registry } = newRegistry();
    registry.exposeCapability({ capabilityId: 'cap.summarize', title: 'Summarize' });

    expect(registry.isCapabilityExposed('cap.summarize')).toBe(true);
    expect(registry.isCapabilityExposed('cap.delete')).toBe(false);
    expect(registry.listExposedCapabilities()).toHaveLength(1);

    registry.unexposeCapability('cap.summarize');
    expect(registry.isCapabilityExposed('cap.summarize')).toBe(false);
    expect(registry.listExposedCapabilities()).toEqual([]);
  });
});

describe('lifecycle audit events (17.7)', () => {
  it('records an audit event for registration, enabling, denial, and invocation', async () => {
    const { registry } = newRegistry({ accessControl: () => false });
    enabledServer(registry, 'srv-1', 'cap.read');
    await registry.invoke({
      serverId: 'srv-1',
      capabilityId: 'cap.read',
      args: {},
      caller: 'agent-1',
    });

    const actions = audit.list().map((e) => e.action);
    expect(actions).toContain('mcp.registered');
    expect(actions).toContain('mcp.approved');
    expect(actions).toContain('mcp.enabled');
    expect(actions).toContain('mcp.invocation_access_denied');

    // The enable-blocked path audits a denial too.
    registry.register({ id: 'srv-2', name: 'Two', endpoint: 'mcp://y' });
    expect(() => registry.enable('srv-2')).toThrow();
    expect(audit.list().map((e) => e.action)).toContain('mcp.enable_blocked');

    // Every audit event carries actor, action, target, and timestamp (17.7).
    const invocationEvent = audit
      .list()
      .find((e) => e.action === 'mcp.invocation_access_denied');
    expect(invocationEvent).toMatchObject({
      actor: 'agent-1',
      target: 'srv-1',
    });
    expect(invocationEvent?.createdAt).toBeDefined();
  });
});
