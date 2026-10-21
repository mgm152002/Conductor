import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  RemoteConnection, RemoteExecEvent, RemoteExecHandle, RemoteExecOutcome, RemoteExecSpec, RemoteTransport,
} from './remote-execution-adapter';

// RemoteTransport over the system OpenSSH client (/usr/bin/ssh). It relies on
// the user's existing SSH setup (keys, agent, ~/.ssh/config host aliases) and
// never prompts: BatchMode is always on, so a host that needs a password or an
// unknown host key fails fast instead of hanging.

export type SpawnFn = (command: string, args: string[]) => ChildProcessWithoutNullStreams;

const defaultSpawn: SpawnFn = (command, args) => spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });

/** `user@host`, `host`, or an ~/.ssh/config alias; never an option. */
const HOST = /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function assertSshHost(host: string): string {
  const trimmed = host.trim();
  if (!HOST.test(trimmed)) throw new Error('Enter an SSH host like user@server or an ~/.ssh/config alias');
  return trimmed;
}

/** Quote one argument for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

interface Running {
  child: ChildProcessWithoutNullStreams;
  exit: Promise<RemoteExecOutcome>;
  events: AsyncIterable<RemoteExecEvent>;
  done: boolean;
  cancelled: boolean;
}

function eventQueue(child: ChildProcessWithoutNullStreams): AsyncIterable<RemoteExecEvent> {
  const queue: RemoteExecEvent[] = [];
  let wake: (() => void) | undefined;
  let open = 2;
  const push = (event: RemoteExecEvent): void => { queue.push(event); wake?.(); };
  for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']] as const) {
    const lines = createInterface({ input: stream });
    lines.on('line', (line) => { push({ kind, data: line, at: new Date().toISOString() }); });
    lines.on('close', () => { open -= 1; wake?.(); });
  }
  return {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) yield queue.shift()!;
        if (open === 0) return;
        await new Promise<void>((resolve) => { wake = resolve; });
        wake = undefined;
      }
    },
  };
}

export class SshRemoteTransport implements RemoteTransport {
  private readonly sessions = new Map<string, Running>();
  private counter = 0;

  constructor(
    private readonly options: {
      /** Agent binary on the remote host. */
      agentCommand?: string;
      /** Remote shell command that installs the agent, when permitted. */
      installCommand?: string;
      spawn?: SpawnFn;
      sshPath?: string;
    } = {},
  ) {}

  private get ssh(): string { return this.options.sshPath ?? '/usr/bin/ssh'; }
  private get agent(): string { return this.options.agentCommand ?? 'codex'; }

  private baseArgs(timeoutSeconds: number): string[] {
    return ['-o', 'BatchMode=yes', '-o', `ConnectTimeout=${Math.max(1, Math.round(timeoutSeconds))}`, '-o', 'ServerAliveInterval=30', '-T'];
  }

  /** Run a short remote command and resolve with its exit code and output. */
  private run(host: string, remote: string, timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = (this.options.spawn ?? defaultSpawn)(this.ssh, [...this.baseArgs(timeoutMs / 1000), '--', assertSshHost(host), remote]);
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`ssh to ${host} timed out after ${timeoutMs}ms`)); }, timeoutMs + 2_000);
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.stdin.end();
    });
  }

  async connect(host: string, timeoutMs: number): Promise<RemoteConnection> {
    const result = await this.run(host, 'true', timeoutMs);
    if (result.code !== 0) throw new Error(result.stderr.trim().split('\n').pop() || `ssh exited with ${String(result.code)}`);
    return { host };
  }

  async isHarnessPresent(connection: RemoteConnection): Promise<boolean> {
    const result = await this.run(connection.host, `command -v ${shellQuote(this.agent)} >/dev/null 2>&1 || test -x "$HOME/.local/bin/${this.agent}"`, 30_000);
    return result.code === 0;
  }

  async provisionAndInstall(connection: RemoteConnection): Promise<void> {
    if (this.options.installCommand === undefined) {
      throw new Error(`${this.agent} is not installed on ${connection.host}. Install it there, or enable “install if missing”.`);
    }
    const result = await this.run(connection.host, this.options.installCommand, 600_000);
    if (result.code !== 0) throw new Error(result.stderr.trim().slice(-500) || 'Install command failed');
  }

  async exec(connection: RemoteConnection, spec: RemoteExecSpec): Promise<RemoteExecHandle> {
    const argv = [this.agent, ...(spec.args ?? [])].map(shellQuote).join(' ');
    // Login-shell PATH so user-level installs (npm -g, ~/.local/bin) resolve.
    const remote = `PATH="$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/opt/homebrew/bin:$PATH"; exec ${argv}`;
    const child = (this.options.spawn ?? defaultSpawn)(this.ssh, [...this.baseArgs(30), '--', assertSshHost(connection.host), remote]);
    const ref = `ssh-${process.pid}-${(this.counter += 1)}`;
    const running: Running = {
      child,
      events: eventQueue(child),
      done: false,
      cancelled: false,
      exit: new Promise<RemoteExecOutcome>((resolve) => {
        child.on('error', () => { running.done = true; resolve({}); });
        child.on('close', (code, signal) => {
          running.done = true;
          resolve({ ...(code !== null ? { exitCode: code } : {}), ...(running.cancelled || signal !== null ? { cancelled: true } : {}) });
        });
      }),
    };
    this.sessions.set(ref, running);
    child.stdin.on('error', () => {});
    child.stdin.end(spec.stdin ?? '');
    return { remoteRef: ref };
  }

  stream(handle: RemoteExecHandle): AsyncIterable<RemoteExecEvent> {
    const running = this.sessions.get(handle.remoteRef);
    return running?.events ?? { async *[Symbol.asyncIterator]() { /* unknown session */ } };
  }

  async wait(handle: RemoteExecHandle): Promise<RemoteExecOutcome> {
    const running = this.sessions.get(handle.remoteRef);
    if (running === undefined) throw new Error('Unknown remote session');
    const outcome = await running.exit;
    this.sessions.delete(handle.remoteRef);
    return outcome;
  }

  async cancel(handle: RemoteExecHandle, graceMs: number): Promise<void> {
    const running = this.sessions.get(handle.remoteRef);
    if (running === undefined || running.done) return;
    running.cancelled = true;
    // Closing the ssh client hangs up the remote session (SIGHUP to the agent).
    running.child.kill('SIGTERM');
    const timer = setTimeout(() => { if (!running.done) running.child.kill('SIGKILL'); }, graceMs);
    await running.exit;
    clearTimeout(timer);
  }

  async isSessionLive(_host: string, remoteRef: string): Promise<boolean> {
    const running = this.sessions.get(remoteRef);
    return running !== undefined && !running.done;
  }

  /** Connection + agent check for the UI. */
  async test(host: string): Promise<{ connected: boolean; agentInstalled: boolean; error?: string }> {
    try {
      const connection = await this.connect(host, 15_000);
      return { connected: true, agentInstalled: await this.isHarnessPresent(connection) };
    } catch (error) {
      return { connected: false, agentInstalled: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
