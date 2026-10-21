import { describe, expect, it, vi } from 'vitest';
import {
  MAX_CONNECTION_TIMEOUT_MS,
  RemoteConnectionError,
  RemoteExecutionAdapter,
  RemoteProvisioningError,
  createRemoteExecutionAdapter,
  type RemoteConnection,
  type RemoteExecEvent,
  type RemoteExecHandle,
  type RemoteExecOutcome,
  type RemoteExecSpec,
  type RemoteExecutionAdapterConfig,
  type RemoteTransport,
} from '@main/adapters/remote-execution-adapter';
import { validateAdapterContract } from '@main/registry/registry';
import type { AgentSession, CapabilityDescriptor } from '@shared/adapter';

// A controllable in-memory transport. Every seam is overridable so a test can
// script a connection timeout, a provisioning failure, a lost connection, or a
// normal run — all without opening a socket.
function fakeTransport(
  overrides: Partial<RemoteTransport> = {},
): RemoteTransport & {
  calls: {
    connected: Array<{ host: string; timeoutMs: number }>;
    provisioned: number;
    execSpecs: RemoteExecSpec[];
  };
} {
  const calls = {
    connected: [] as Array<{ host: string; timeoutMs: number }>,
    provisioned: 0,
    execSpecs: [] as RemoteExecSpec[],
  };
  const base: RemoteTransport = {
    async connect(host: string, timeoutMs: number): Promise<RemoteConnection> {
      calls.connected.push({ host, timeoutMs });
      return { host };
    },
    async isHarnessPresent(): Promise<boolean> {
      return true;
    },
    async provisionAndInstall(): Promise<void> {
      calls.provisioned += 1;
    },
    async exec(
      _connection: RemoteConnection,
      spec: RemoteExecSpec,
    ): Promise<RemoteExecHandle> {
      calls.execSpecs.push(spec);
      return { remoteRef: 'remote-ref-1' };
    },
    async *stream(): AsyncIterable<RemoteExecEvent> {
      // no events by default
    },
    async wait(): Promise<RemoteExecOutcome> {
      return { exitCode: 0 };
    },
    async cancel(): Promise<void> {
      // no-op by default
    },
    async isSessionLive(): Promise<boolean> {
      return true;
    },
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

const CAPABILITY: CapabilityDescriptor = {
  id: 'code.agent.run',
  title: 'Run remote',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  streaming: true,
  cancellable: true,
  resumable: false,
  requiredPermissions: [],
};

function config(
  overrides: Partial<RemoteExecutionAdapterConfig> = {},
): RemoteExecutionAdapterConfig {
  return {
    id: 'remote-exec',
    name: 'Remote Execution',
    version: '1.0.0',
    host: 'ec2-user@203.0.113.7',
    capabilities: [CAPABILITY],
    ...overrides,
  };
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    taskId: 't1',
    adapterId: 'remote-exec',
    status: 'live',
    resumable: false,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('RemoteExecutionAdapter contract and availability', () => {
  it('satisfies the full AgentAdapter contract', () => {
    const adapter = new RemoteExecutionAdapter(config(), fakeTransport());
    expect(validateAdapterContract(adapter)).toEqual([]);
  });

  it('advertises the remote_execution class and starts available', () => {
    const adapter = new RemoteExecutionAdapter(config(), fakeTransport());
    expect(adapter.record.class).toBe('remote_execution');
    expect(adapter.record.available).toBe(true);
  });

  it('clamps the connection timeout to the 60-second ceiling', async () => {
    const transport = fakeTransport();
    const adapter = new RemoteExecutionAdapter(
      config({ connectionTimeoutMs: 120_000 }),
      transport,
    );
    await adapter.start({});
    expect(transport.calls.connected[0]?.timeoutMs).toBe(
      MAX_CONNECTION_TIMEOUT_MS,
    );
  });
});

describe('RemoteExecutionAdapter connection handling', () => {
  it('aborts and marks the target unavailable on a connection timeout', async () => {
    const transport = fakeTransport({
      connect: async (_host: string, timeoutMs: number) => {
        throw new Error(`timed out after ${timeoutMs}ms`);
      },
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);

    await expect(adapter.start({})).rejects.toBeInstanceOf(
      RemoteConnectionError,
    );
    // The target is taken out of routing after the failure (Requirement 20.2).
    expect(adapter.record.available).toBe(false);
    expect(adapter.available).toBe(false);
  });
});

describe('RemoteExecutionAdapter provisioning', () => {
  it('provisions and installs the harness when it is absent', async () => {
    const transport = fakeTransport({
      isHarnessPresent: async () => false,
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);

    await adapter.start({});
    expect(transport.calls.provisioned).toBe(1);
  });

  it('does not provision when the harness is already present', async () => {
    const transport = fakeTransport({ isHarnessPresent: async () => true });
    const adapter = new RemoteExecutionAdapter(config(), transport);

    await adapter.start({});
    expect(transport.calls.provisioned).toBe(0);
  });

  it('aborts and does not route when provisioning/install fails', async () => {
    let execAttempts = 0;
    const transport = fakeTransport({
      isHarnessPresent: async () => false,
      provisionAndInstall: async () => {
        throw new Error('apt-get failed');
      },
      exec: async () => {
        execAttempts += 1;
        return { remoteRef: `ref-${execAttempts}` };
      },
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);

    await expect(adapter.start({})).rejects.toBeInstanceOf(
      RemoteProvisioningError,
    );
    // No step was routed to the host — exec never ran (Requirement 20.4).
    expect(execAttempts).toBe(0);
    expect(adapter.record.available).toBe(false);
  });

  it('refuses to connect again once the host is marked unavailable', async () => {
    const connect = vi.fn(async (host: string) => ({ host }));
    const transport = fakeTransport({
      isHarnessPresent: async () => false,
      provisionAndInstall: async () => {
        throw new Error('bootstrap failed');
      },
      connect,
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);

    await expect(adapter.start({})).rejects.toBeInstanceOf(
      RemoteProvisioningError,
    );
    const firstConnects = connect.mock.calls.length;

    // A second attempt aborts immediately without reconnecting.
    await expect(adapter.start({})).rejects.toBeInstanceOf(
      RemoteProvisioningError,
    );
    expect(connect.mock.calls.length).toBe(firstConnects);
  });
});

describe('RemoteExecutionAdapter streaming and completion', () => {
  it('drives the remote harness through the identical contract', async () => {
    const transport = fakeTransport({
      async *stream(): AsyncIterable<RemoteExecEvent> {
        yield { kind: 'stdout', data: 'remote line 1' };
        yield { kind: 'stderr', data: 'remote warn' };
      },
      wait: async () => ({ exitCode: 0 }),
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    const handle = await adapter.start({ args: ['--run'] });

    const collected: Array<{ kind: string; data: unknown; sequence: number }> =
      [];
    for await (const event of adapter.stream(handle)) {
      collected.push({
        kind: event.kind,
        data: event.data,
        sequence: event.sequence,
      });
    }

    expect(collected).toEqual([
      { kind: 'stdout', data: 'remote line 1', sequence: 1 },
      { kind: 'stderr', data: 'remote warn', sequence: 2 },
    ]);
    expect(await adapter.await(handle)).toEqual({
      status: 'succeeded',
      exitCode: 0,
    });
  });

  it('reports failed on a non-zero remote exit code', async () => {
    const transport = fakeTransport({ wait: async () => ({ exitCode: 7 }) });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    const handle = await adapter.start({});
    expect(await adapter.await(handle)).toEqual({
      status: 'failed',
      exitCode: 7,
    });
  });

  it('reports cancelled when the remote invocation was cancelled', async () => {
    const transport = fakeTransport({
      wait: async () => ({ cancelled: true }),
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    const handle = await adapter.start({});
    await adapter.cancel(handle);
    expect(await adapter.await(handle)).toEqual({ status: 'cancelled' });
  });
});

describe('RemoteExecutionAdapter lost-connection handling', () => {
  it('reports a live in-memory session as not-live when the probe throws', async () => {
    const transport = fakeTransport({
      isSessionLive: async () => {
        throw new Error('connection reset');
      },
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    const handle = await adapter.start({});

    // A lost connection must surface as not-live so the Resume Center
    // reconciles rather than treating the step as succeeded (Requirement 20.6).
    expect(await adapter.probeLiveness(session({ id: handle.sessionId }))).toBe(
      false,
    );
  });

  it('reports a persisted session as not-live when the probe throws', async () => {
    const transport = fakeTransport({
      isSessionLive: async () => {
        throw new Error('host unreachable');
      },
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    expect(
      await adapter.probeLiveness(session({ externalRef: 'remote-ref-9' })),
    ).toBe(false);
  });

  it('reports not-live for a session with no external reference', async () => {
    const adapter = new RemoteExecutionAdapter(config(), fakeTransport());
    expect(await adapter.probeLiveness(session())).toBe(false);
  });

  it('does not treat a lost connection while awaiting as success', async () => {
    const transport = fakeTransport({
      wait: async () => {
        throw new Error('connection lost');
      },
    });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    const handle = await adapter.start({});
    const result = await adapter.await(handle);
    expect(result.status).toBe('failed');
    expect(result.error).toMatch(/connection lost/);
  });
});

describe('RemoteExecutionAdapter secret confinement', () => {
  it('forwards placeholder tokens to the remote harness unchanged', async () => {
    const transport = fakeTransport();
    const adapter = new RemoteExecutionAdapter(config(), transport);
    await adapter.start({ args: ['--token', '{{SECRET:api_key}}'] });
    expect(transport.calls.execSpecs[0]).toEqual({
      args: ['--token', '{{SECRET:api_key}}'],
    });
  });

  it('rejects a malformed secret token before connecting', async () => {
    const connect = vi.fn(async (host: string) => ({ host }));
    const transport = fakeTransport({ connect });
    const adapter = new RemoteExecutionAdapter(config(), transport);
    await expect(
      adapter.start({ args: ['{{SECRET:dangling'] }),
    ).rejects.toThrow(/malformed secret token/);
    // Nothing left the process — no connection was ever opened.
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('createRemoteExecutionAdapter', () => {
  it('builds a remote_execution adapter driving a harness over the contract', () => {
    const adapter = createRemoteExecutionAdapter(
      {
        id: 'remote-claude',
        name: 'Remote Claude Code',
        version: '1.0.0',
        host: 'ec2-user@203.0.113.7',
      },
      fakeTransport(),
    );
    expect(adapter.record.id).toBe('remote-claude');
    expect(adapter.record.class).toBe('remote_execution');
    expect(adapter.record.capabilities[0]?.id).toBe('code.agent.run');
    expect(validateAdapterContract(adapter)).toEqual([]);
  });
});
