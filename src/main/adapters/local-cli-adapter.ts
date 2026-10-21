// A real local CLI AgentAdapter. It discovers a CLI agent on PATH, starts it
// as a child process, streams its stdout/stderr as ordered adapter events,
// supports cancellation (graceful SIGTERM then forced SIGKILL), and probes
// liveness of a persisted session by its recorded pid.
//
// invariant (Requirement 10.1): this adapter holds only `SecretPlaceholder`
// tokens — never a raw secret value. Placeholder tokens in the request are
// passed through to the subprocess argv/stdin unchanged; the main-process
// secrets proxy is the single choke point that substitutes real values at
// egress. The adapter asserts its launch input carries no raw secret before
// spawning.

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { childEnv, searchPathEntries } from '../catalog/search-path';
import { accessSync, constants as fsConstants } from 'node:fs';
import { join, isAbsolute } from 'node:path';

import type {
  AdapterRecord,
  AdapterResult,
  AdapterSessionHandle,
  AdapterStreamEvent,
  AdapterStreamEventKind,
  AgentSession,
  AgentAdapter,
  CapabilityDescriptor,
} from '@shared/adapter';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { assertNoRawSecret } from '../secrets/secrets-proxy';

/** How long (ms) a cancelled process is given to exit before SIGKILL. */
const DEFAULT_CANCEL_GRACE_MS = 30_000;

/** Raised when the configured CLI cannot be found on PATH. */
export class CliNotFoundError extends Error {
  constructor(
    readonly command: string,
    readonly searchedPath: string[],
  ) {
    super(
      `CLI "${command}" was not found on PATH (searched ${searchedPath.length} entr${searchedPath.length === 1 ? 'y' : 'ies'})`,
    );
    this.name = 'CliNotFoundError';
  }
}

export interface LocalCliAdapterConfig {
  /** Adapter id used in the registry and sessions. */
  id: string;
  /** Human-readable adapter name. */
  name: string;
  /** Adapter semantic version. */
  version: string;
  /** The executable name to discover on PATH, e.g. "claude". */
  command: string;
  /** Capabilities this CLI advertises to routing. */
  capabilities: CapabilityDescriptor[];
  /** Grace period before force-terminating on cancel. Defaults to 30s. */
  cancelGraceMs?: number;
}

/** How the adapter resolves the CLI executable and spawns it. Injectable for tests. */
export interface CliEnvironment {
  /** PATH entries to search, most-preferred first. */
  pathEntries: string[];
  /** Returns true if `candidate` is an executable file. */
  isExecutable(candidate: string): boolean;
  /** Spawn the resolved executable with args. */
  spawn(executable: string, args: string[], options?: {cwd?: string; env?: Record<string, string>}): ChildProcessWithoutNullStreams;
  /** Probe whether a process with `pid` is currently alive. */
  isPidAlive(pid: number): boolean;
  killProcessGroup?(pid: number, signal: NodeJS.Signals): void;
}

/** Build the default environment from the real process/OS. */
export function defaultCliEnvironment(): CliEnvironment {
  // The login-shell PATH, so CLIs installed via Homebrew, npm, nvm or
  // ~/.local/bin are found even when the app was opened from Finder.
  const pathEntries = searchPathEntries();
  return {
    pathEntries,
    isExecutable(candidate: string): boolean {
      try {
        accessSync(candidate, fsConstants.X_OK);
        return statSync(candidate).isFile();
      } catch {
        return false;
      }
    },
    spawn(executable: string, args: string[], options?: {cwd?:string; env?: Record<string, string>}): ChildProcessWithoutNullStreams {
      return spawn(executable, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        // npm-installed CLIs are `#!/usr/bin/env node` scripts; they need the
        // same PATH discovery used to find them.
        env: { ...childEnv(), ...(options?.env ?? {}) },
        detached: process.platform !== 'win32',
        ...(options?.cwd ? {cwd: options.cwd} : {}),
      }) as ChildProcessWithoutNullStreams;
    },
    killProcessGroup(pid, signal): void {
      try { process.kill(process.platform === 'win32' ? pid : -pid, signal); }
      catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err; }
    },
    isPidAlive(pid: number): boolean {
      try {
        // Signal 0 performs error checking without delivering a signal.
        process.kill(pid, 0);
        return true;
      } catch (err) {
        // ESRCH => no such process; EPERM => exists but not ours (still alive).
        return (err as NodeJS.ErrnoException).code === 'EPERM';
      }
    },
  };
}

/**
 * Discover an executable on PATH. Returns the first matching absolute path, or
 * `undefined` when no PATH entry contains an executable of that name.
 */
export function discoverOnPath(
  command: string,
  env: CliEnvironment,
): string | undefined {
  if (isAbsolute(command)) return env.isExecutable(command) ? command : undefined;
  for (const dir of env.pathEntries) {
    const candidate = join(dir, command);
    if (env.isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

export interface LocalCliStartInput {
  /** Arguments passed to the CLI. May contain placeholder tokens. */
  args?: string[];
  /** Text written to the CLI's stdin. May contain placeholder tokens. */
  stdin?: string;
  cwd?: string;
}

interface LiveSession {
  readonly handle: AdapterSessionHandle;
  readonly child: ChildProcessWithoutNullStreams;
  readonly cancelGraceMs: number;
  completion: Promise<{code:number|null;signal:NodeJS.Signals|null;error?:string}>;
  killTimer?: ReturnType<typeof setTimeout>;
}

export class LocalCliAdapter implements AgentAdapter {
  readonly record: AdapterRecord;

  private readonly config: LocalCliAdapterConfig;
  private readonly env: CliEnvironment;
  private readonly sessions = new Map<string, LiveSession>();
  private resolvedExecutable: string | undefined;
  private sessionCounter = 0;

  constructor(config: LocalCliAdapterConfig, env: CliEnvironment = defaultCliEnvironment()) {
    this.config = config;
    this.env = env;
    this.record = {
      id: config.id,
      class: 'local_cli_agent',
      name: config.name,
      version: config.version,
      capabilities: config.capabilities,
      // Availability reflects PATH discovery: the CLI is available only when it
      // is actually resolvable right now.
      available: discoverOnPath(config.command, env) !== undefined,
      config: { command: config.command },
    };
  }

  /** The absolute executable path, discovering (and caching) it on first need. */
  private resolveExecutable(): string {
    if (this.resolvedExecutable !== undefined) {
      return this.resolvedExecutable;
    }
    const found = discoverOnPath(this.config.command, this.env);
    if (found === undefined) {
      throw new CliNotFoundError(this.config.command, this.env.pathEntries);
    }
    this.resolvedExecutable = found;
    return found;
  }

  async probeLiveness(session: AgentSession): Promise<boolean> {
    // Prefer an in-memory live session when present.
    const live = this.sessions.get(session.id);
    if (live !== undefined) {
      return live.child.exitCode === null && live.child.signalCode === null;
    }
    // Otherwise reconcile against the persisted pid. A lost/unknown pid reports
    // false so the Resume Center reconciles rather than trusting a stale state.
    const ref = session.externalRef;
    if (ref === undefined) {
      return false;
    }
    const pid = Number.parseInt(ref, 10);
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    return this.env.isPidAlive(pid);
  }

  async start(input: unknown): Promise<AdapterSessionHandle> {
    // Enforce the confinement invariant before anything leaves this process:
    // the launch input may carry placeholder tokens but never a raw secret.
    assertNoRawSecret(input);

    const parsed = normalizeStartInput(input);
    const executable = this.resolveExecutable();
    const child = parsed.cwd ? this.env.spawn(executable, parsed.args, {cwd:parsed.cwd}) : this.env.spawn(executable, parsed.args);
    const completion = new Promise<{code:number|null;signal:NodeJS.Signals|null;error?:string}>((resolve) => {
      child.once('close', (code, signal) => resolve({code,signal}));
      child.once('error', (err) => resolve({code:null,signal:null,error:err.message}));
    });
    // Broken stdin (e.g. missing authentication) is reported through child completion.
    child.stdin.on('error', () => {});

    if (parsed.stdin !== undefined) {
      child.stdin.write(parsed.stdin);
      child.stdin.end();
    }

    this.sessionCounter += 1;
    const sessionId = `${this.config.id}-${randomUUID()}`;
    const handle: AdapterSessionHandle = {
      sessionId,
      adapterId: this.config.id,
      ...(typeof child.pid === 'number'
        ? { externalRef: String(child.pid) }
        : {}),
      resumable: false,
    };

    this.sessions.set(sessionId, {
      handle,
      child,
      completion,
      cancelGraceMs: this.config.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS,
    });

    return handle;
  }

  async *stream(
    handle: AdapterSessionHandle,
  ): AsyncIterable<AdapterStreamEvent> {
    const live = this.sessions.get(handle.sessionId);
    if (live === undefined) {
      return;
    }

    const queue: AdapterStreamEvent[] = [];
    let sequence = 0;
    let done = live.child.exitCode !== null || live.child.signalCode !== null;
    let notify: (() => void) | undefined;

    const push = (kind: AdapterStreamEventKind, data: unknown): void => {
      sequence += 1;
      queue.push({ kind, sequence, data, at: new Date().toISOString() });
      notify?.();
    };

    const stdout = createInterface({ input: live.child.stdout });
    const stderr = createInterface({ input: live.child.stderr });
    stdout.on('line', (line) => push('stdout', line));
    stderr.on('line', (line) => push('stderr', line));

    const finish = (): void => {
      done = true;
      notify?.();
    };
    live.child.on('close', finish);
    void live.completion.then(finish);
    live.child.on('error', (err) => {
      push('log', { error: err.message });
      finish();
    });

    try {
      while (!done || queue.length > 0) {
        const next = queue.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (done) {
          break;
        }
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
      }
    } finally {
      stdout.close();
      stderr.close();
    }
  }

  async await(handle: AdapterSessionHandle): Promise<AdapterResult> {
    const live = this.sessions.get(handle.sessionId);
    if (live === undefined) {
      return { status: 'failed', error: 'unknown session' };
    }

    const outcome = await live.completion;

    this.sessions.delete(handle.sessionId);
    if (live.killTimer !== undefined) {
      clearTimeout(live.killTimer);
    }

    // A cancellation signal yields a cancelled result. Exit code is reported
    // but — per the contract — is NOT by itself a success signal; verification
    // against acceptance criteria is the orchestrator's only completion gate.
    if (outcome.error) return {status:'failed',error:outcome.error};
    if (outcome.signal !== null) {
      return {
        status: 'cancelled',
        ...(outcome.code !== null ? { exitCode: outcome.code } : {}),
      };
    }
    return {
      status: outcome.code === 0 ? 'succeeded' : 'failed',
      ...(outcome.code !== null ? { exitCode: outcome.code } : {}),
    };
  }

  async cancel(handle: AdapterSessionHandle): Promise<void> {
    const live = this.sessions.get(handle.sessionId);
    if (live === undefined) {
      return;
    }
    const { child } = live;
    if (child.exitCode !== null || child.signalCode !== null) {
      return;
    }

    if (child.pid && this.env.killProcessGroup) this.env.killProcessGroup(child.pid,'SIGTERM');
    else child.kill('SIGTERM');
    // Escalate to SIGKILL if the process does not exit within the grace window.
    live.killTimer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        if (child.pid && this.env.killProcessGroup) this.env.killProcessGroup(child.pid,'SIGKILL');
        else child.kill('SIGKILL');
      }
    }, live.cancelGraceMs);
    // Do not keep the event loop alive solely for the kill timer.
    live.killTimer.unref?.();
  }
}

/** Normalize and validate the opaque `start` input into a typed launch spec. */
function normalizeStartInput(input: unknown): {
  args: string[];
  stdin?: string;
  cwd?: string;
} {
  if (input === null || typeof input !== 'object') {
    return { args: [] };
  }
  const obj = input as Record<string, unknown>;
  const rawArgs = obj['args'];
  const args =
    Array.isArray(rawArgs) && rawArgs.every((a) => typeof a === 'string')
      ? (rawArgs as string[])
      : [];
  const rawStdin = obj['stdin'];
  const stdin = typeof rawStdin === 'string' ? rawStdin : undefined;
  const cwd = typeof obj['cwd'] === 'string' ? obj['cwd'] : undefined;
  return {args, ...(stdin !== undefined ? {stdin} : {}), ...(cwd ? {cwd} : {})};
}

/**
 * Build a Claude Code CLI adapter discovered on PATH as `claude`. This is the
 * concrete "one real local CLI adapter" the registry integrates (Requirement
 * 6.8); other CLIs (Codex, etc.) are the same adapter with a different command
 * and capability set.
 */
export function createClaudeCodeAdapter(
  env?: CliEnvironment,
): LocalCliAdapter {
  const capability: CapabilityDescriptor = {
    id: 'code.agent.run',
    title: 'Run a Claude Code CLI agent session',
    inputSchema: {
      type: 'object',
      properties: {
        args: { type: 'array', items: { type: 'string' } },
        stdin: { type: 'string' },
      },
    },
    outputSchema: { type: 'object' },
    streaming: true,
    cancellable: true,
    resumable: false,
    requiredPermissions: [
      { kind: 'command_exec' },
      { kind: 'filesystem_read' },
      { kind: 'filesystem_write' },
    ],
    costHint: 'medium',
    latencyHint: 'medium',
  };

  return new LocalCliAdapter(
    {
      id: 'claude-code-cli',
      name: 'Claude Code CLI',
      version: '1.0.0',
      command: 'claude',
      capabilities: [capability],
    },
    env ?? defaultCliEnvironment(),
  );
}
