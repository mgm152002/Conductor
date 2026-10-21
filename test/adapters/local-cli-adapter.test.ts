import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  CliNotFoundError,
  LocalCliAdapter,
  createClaudeCodeAdapter,
  discoverOnPath,
  type CliEnvironment,
  type LocalCliAdapterConfig,
} from '@main/adapters/local-cli-adapter';
import { validateAdapterContract } from '@main/registry/registry';
import type { AgentSession, CapabilityDescriptor } from '@shared/adapter';

// A controllable fake child process: tests push stdout/stderr lines and then
// emit `close`. It records signals delivered via kill().
class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new PassThrough();
  pid: number | undefined = 4321;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];

  kill(signal?: NodeJS.Signals | number): boolean {
    this.signals.push(String(signal));
    return true;
  }

  finishWith(code: number | null, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    this.emit('close', code, signal);
  }
}

function fakeEnv(
  overrides: Partial<CliEnvironment> & { child?: FakeChild } = {},
): CliEnvironment & { lastChild?: FakeChild } {
  const env: CliEnvironment & { lastChild?: FakeChild } = {
    pathEntries: ['/usr/bin', '/usr/local/bin'],
    isExecutable: (candidate: string) => candidate === '/usr/local/bin/claude',
    spawn: () => {
      const child = overrides.child ?? new FakeChild();
      env.lastChild = child;
      return child as unknown as ChildProcessWithoutNullStreams;
    },
    isPidAlive: () => true,
    ...overrides,
  };
  return env;
}

const CAPABILITY: CapabilityDescriptor = {
  id: 'code.agent.run',
  title: 'Run',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  streaming: true,
  cancellable: true,
  resumable: false,
  requiredPermissions: [],
};

function config(overrides: Partial<LocalCliAdapterConfig> = {}): LocalCliAdapterConfig {
  return {
    id: 'claude-code-cli',
    name: 'Claude Code CLI',
    version: '1.0.0',
    command: 'claude',
    capabilities: [CAPABILITY],
    ...overrides,
  };
}

function session(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    id: 's1',
    taskId: 't1',
    adapterId: 'claude-code-cli',
    status: 'live',
    resumable: false,
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('discoverOnPath', () => {
  it('returns the first executable match on PATH', () => {
    const env = fakeEnv();
    expect(discoverOnPath('claude', env)).toBe('/usr/local/bin/claude');
  });

  it('accepts an absolute path returned by catalog discovery', () => {
    expect(discoverOnPath('/usr/local/bin/claude', fakeEnv())).toBe('/usr/local/bin/claude');
  });

  it('returns undefined when no PATH entry has the executable', () => {
    const env = fakeEnv({ isExecutable: () => false });
    expect(discoverOnPath('claude', env)).toBeUndefined();
  });
});

describe('LocalCliAdapter contract and availability', () => {
  it('satisfies the full AgentAdapter contract', () => {
    const adapter = new LocalCliAdapter(config(), fakeEnv());
    expect(validateAdapterContract(adapter)).toEqual([]);
  });

  it('reports available when the CLI is discoverable', () => {
    const adapter = new LocalCliAdapter(config(), fakeEnv());
    expect(adapter.record.available).toBe(true);
    expect(adapter.record.class).toBe('local_cli_agent');
  });

  it('reports unavailable when the CLI is not on PATH', () => {
    const adapter = new LocalCliAdapter(
      config(),
      fakeEnv({ isExecutable: () => false }),
    );
    expect(adapter.record.available).toBe(false);
  });

  it('throws CliNotFoundError on start when the CLI is missing', async () => {
    const adapter = new LocalCliAdapter(
      config(),
      fakeEnv({ isExecutable: () => false }),
    );
    await expect(adapter.start({ args: [] })).rejects.toBeInstanceOf(
      CliNotFoundError,
    );
  });
});

describe('LocalCliAdapter streaming and completion', () => {
  it('streams stdout and stderr lines as ordered events', async () => {
    const child = new FakeChild();
    const adapter = new LocalCliAdapter(config(), fakeEnv({ child }));
    const handle = await adapter.start({ args: ['--help'] });

    const collected: Array<{ kind: string; data: unknown }> = [];
    const pump = (async () => {
      for await (const event of adapter.stream(handle)) {
        collected.push({ kind: event.kind, data: event.data });
      }
    })();

    child.stdout.write('line-1\n');
    child.stderr.write('warn-1\n');
    child.stdout.write('line-2\n');
    await new Promise((r) => setTimeout(r, 10));
    child.finishWith(0);
    await pump;

    expect(collected).toContainEqual({ kind: 'stdout', data: 'line-1' });
    expect(collected).toContainEqual({ kind: 'stderr', data: 'warn-1' });
    expect(collected).toContainEqual({ kind: 'stdout', data: 'line-2' });
  });

  it('await resolves succeeded on exit 0 and failed on non-zero', async () => {
    const okChild = new FakeChild();
    const okAdapter = new LocalCliAdapter(config(), fakeEnv({ child: okChild }));
    const okHandle = await okAdapter.start({});
    okChild.finishWith(0);
    expect(await okAdapter.await(okHandle)).toEqual({
      status: 'succeeded',
      exitCode: 0,
    });

    const failChild = new FakeChild();
    const failAdapter = new LocalCliAdapter(
      config(),
      fakeEnv({ child: failChild }),
    );
    const failHandle = await failAdapter.start({});
    failChild.finishWith(3);
    expect(await failAdapter.await(failHandle)).toEqual({
      status: 'failed',
      exitCode: 3,
    });
  });

  it('writes stdin when provided', async () => {
    const child = new FakeChild();
    const writeSpy = vi.spyOn(child.stdin, 'write');
    const adapter = new LocalCliAdapter(config(), fakeEnv({ child }));
    await adapter.start({ stdin: 'prompt text' });
    expect(writeSpy).toHaveBeenCalledWith('prompt text');
  });
});

describe('LocalCliAdapter cancellation', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('sends SIGTERM then escalates to SIGKILL after the grace window', async () => {
    const child = new FakeChild();
    const adapter = new LocalCliAdapter(
      config({ cancelGraceMs: 1000 }),
      fakeEnv({ child }),
    );
    const handle = await adapter.start({});

    await adapter.cancel(handle);
    expect(child.signals).toContain('SIGTERM');
    expect(child.signals).not.toContain('SIGKILL');

    vi.advanceTimersByTime(1000);
    expect(child.signals).toContain('SIGKILL');
  });

  it('reports a cancelled result when the process exits on a signal', async () => {
    vi.useRealTimers();
    const child = new FakeChild();
    const adapter = new LocalCliAdapter(config(), fakeEnv({ child }));
    const handle = await adapter.start({});
    child.finishWith(null, 'SIGTERM');
    expect(await adapter.await(handle)).toEqual({ status: 'cancelled' });
  });
});

describe('LocalCliAdapter liveness probing', () => {
  it('probes a persisted pid via the environment', async () => {
    const aliveEnv = fakeEnv({ isPidAlive: () => true });
    const adapter = new LocalCliAdapter(config(), aliveEnv);
    expect(await adapter.probeLiveness(session({ externalRef: '777' }))).toBe(
      true,
    );

    const deadEnv = fakeEnv({ isPidAlive: () => false });
    const deadAdapter = new LocalCliAdapter(config(), deadEnv);
    expect(
      await deadAdapter.probeLiveness(session({ externalRef: '777' })),
    ).toBe(false);
  });

  it('reports not-live for a session with no external reference', async () => {
    const adapter = new LocalCliAdapter(config(), fakeEnv());
    expect(await adapter.probeLiveness(session())).toBe(false);
  });
});

describe('LocalCliAdapter secret confinement', () => {
  it('passes placeholder tokens through to argv unchanged', async () => {
    const child = new FakeChild();
    const env = fakeEnv({ child });
    const spawnSpy = vi.spyOn(env, 'spawn');
    const adapter = new LocalCliAdapter(config(), env);
    await adapter.start({ args: ['--token', '{{SECRET:api_key}}'] });
    expect(spawnSpy).toHaveBeenCalledWith('/usr/local/bin/claude', [
      '--token',
      '{{SECRET:api_key}}',
    ]);
  });

  it('rejects a malformed secret token before spawning', async () => {
    const env = fakeEnv();
    const spawnSpy = vi.spyOn(env, 'spawn');
    const adapter = new LocalCliAdapter(config(), env);
    await expect(
      adapter.start({ args: ['{{SECRET:dangling'] }),
    ).rejects.toThrow(/malformed secret token/);
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

describe('createClaudeCodeAdapter', () => {
  it('builds a local_cli_agent adapter discovered as "claude"', () => {
    const adapter = createClaudeCodeAdapter(fakeEnv());
    expect(adapter.record.id).toBe('claude-code-cli');
    expect(adapter.record.class).toBe('local_cli_agent');
    expect(adapter.record.capabilities[0]?.id).toBe('code.agent.run');
    expect(validateAdapterContract(adapter)).toEqual([]);
  });
});
