import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import type { SandboxRun, SandboxStatus } from '@shared/sandbox-agents';

// AIO Sandbox containers (github.com/agent-infra/sandbox), one per agent:
// an agent's 1:1 chat and its group chats share its sandbox.
//
// Each container runs the pinned image with a random API key, publishes its
// port on 127.0.0.1 only, and is labelled so leftovers from a crash are
// removed on the next launch. There is no fixed limit on how many run: before
// starting one, Docker's free memory is checked, and if another sandbox
// won't fit the start is refused with a warning saying how to make room. A
// sandbox stops after it sits idle. Nothing here talks to the sandbox's
// tools — the gateway does that.

export const SANDBOX_IMAGE = 'ghcr.io/agent-infra/sandbox:1.11.0';
const LABEL = 'dev.conductor.sandbox';
const CONTAINER_PORT = 8080;
/** Memory each sandbox is allowed; the image's own guidance is 2 GiB. */
const SANDBOX_MEMORY_BYTES = 2 * 1024 ** 3;
const READY_TIMEOUT_MS = 120_000;
/** Free Docker memory a new sandbox needs to start (its desktop and browser at rest). */
const START_HEADROOM_BYTES = 1.25 * 1024 ** 3;
const IDLE_STOP_MS = 15 * 60_000;

/** How the sandbox's API is reached from this process. */
export interface SandboxEndpoint {
  /** `http://127.0.0.1:<port>` */
  baseUrl: string;
  apiKey: string;
}

interface Running {
  agentId: string;
  agentName: string;
  container: string;
  startedAt: string;
  state: SandboxRun['state'];
  endpoint?: SandboxEndpoint;
  ready: Promise<SandboxEndpoint>;
  /** Tasks currently using it; it is only stopped when this is empty. */
  users: Set<string>;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** Raised when Docker has no room for another sandbox. */
export class SandboxCapacityError extends Error {}

/** "512MiB / 3.8GiB" → bytes of the first figure. */
export function parseMemUsage(text: string): number {
  const match = /([\d.]+)\s*([KMGT]?i?B)/i.exec(text);
  if (match === null) return 0;
  const unit = match[2]!.toUpperCase().replace('I', '');
  const scale = unit === 'GB' ? 1024 ** 3 : unit === 'MB' ? 1024 ** 2 : unit === 'KB' ? 1024 : unit === 'TB' ? 1024 ** 4 : 1;
  return Number(match[1]) * scale;
}

/** Runs a docker command; injectable for tests. */
export type DockerRunner = (args: string[], options?: { timeoutMs?: number }) => Promise<string>;

function searchPath(): string {
  const extra = ['/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin', join(homedir(), '.docker/bin'), '/usr/bin', '/bin'];
  return [...new Set([...(process.env['PATH'] ?? '').split(delimiter), ...extra])].filter(Boolean).join(delimiter);
}

function dockerBinary(): string | undefined {
  for (const dir of searchPath().split(delimiter)) {
    const candidate = join(dir, 'docker');
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

const defaultDocker: DockerRunner = (args, options = {}) => new Promise((resolve, reject) => {
  const docker = dockerBinary();
  if (docker === undefined) { reject(new Error('Docker is not installed')); return; }
  execFile(docker, args, { timeout: options.timeoutMs ?? 60_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: searchPath() } }, (error, stdout, stderr) => {
    if (error !== null) {
      const detail = `${stderr}`.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? error.message;
      reject(new Error(detail.slice(0, 400)));
      return;
    }
    resolve(`${stdout}`);
  });
});

export interface SandboxManagerOptions {
  docker?: DockerRunner;
  /** Probe a started sandbox; resolves once its API answers. Injectable for tests. */
  waitReady?: (endpoint: SandboxEndpoint, signal: AbortSignal) => Promise<void>;
  idleStopMs?: number;
  onChange?: () => void;
}

/** Poll the sandbox API until it answers (it boots a desktop, browser and services). */
async function defaultWaitReady(endpoint: SandboxEndpoint, signal: AbortSignal): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let last = 'no answer yet';
  while (Date.now() < deadline) {
    if (signal.aborted) throw new Error('Sandbox start was cancelled');
    try {
      const response = await fetch(`${endpoint.baseUrl}/v1/sandbox`, { headers: { 'X-AIO-API-Key': endpoint.apiKey }, signal: AbortSignal.timeout(4_000) });
      if (response.ok) return;
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : 'unreachable';
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`The sandbox did not become ready in ${READY_TIMEOUT_MS / 1000}s (${last}).`);
}

export class SandboxManager {
  private readonly docker: DockerRunner;
  private readonly waitReady: NonNullable<SandboxManagerOptions['waitReady']>;
  private readonly idleStopMs: number;
  private readonly onChange: () => void;
  private readonly running = new Map<string, Running>();
  private pulling: Promise<void> | undefined;
  private pullProgress: number | undefined;
  private pullError: string | undefined;

  constructor(options: SandboxManagerOptions = {}) {
    this.docker = options.docker ?? defaultDocker;
    this.waitReady = options.waitReady ?? defaultWaitReady;
    this.idleStopMs = options.idleStopMs ?? IDLE_STOP_MS;
    this.onChange = options.onChange ?? (() => {});
  }

  // ---- status & image -----------------------------------------------------

  async status(): Promise<SandboxStatus> {
    const base = {
      imageRef: SANDBOX_IMAGE,
      running: [...this.running.values()].map((run): SandboxRun => ({
        agentId: run.agentId, agentName: run.agentName, startedAt: run.startedAt, state: run.state,
      })),
    };
    if (dockerBinary() === undefined && this.docker === defaultDocker) {
      return { ...base, docker: 'not-installed', image: 'missing' };
    }
    try {
      await this.docker(['info', '--format', '{{.ServerVersion}}'], { timeoutMs: 10_000 });
    } catch (error) {
      return { ...base, docker: 'not-running', dockerDetail: error instanceof Error ? error.message : 'Docker did not answer', image: 'missing' };
    }
    const image = this.pulling !== undefined ? 'pulling' : await this.hasImage() ? 'present' : 'missing';
    return {
      ...base,
      docker: 'ready',
      image,
      ...(await this.memory().then((memory) => (memory !== undefined ? { memory } : {}))),
      ...(this.pulling !== undefined && this.pullProgress !== undefined ? { pullProgress: this.pullProgress } : {}),
      ...(this.pullError !== undefined ? { pullError: this.pullError } : {}),
    };
  }

  private async hasImage(): Promise<boolean> {
    try { await this.docker(['image', 'inspect', '--format', '{{.Id}}', SANDBOX_IMAGE], { timeoutMs: 15_000 }); return true; } catch { return false; }
  }

  /** Docker's total memory and what its running containers use right now. */
  private async memory(): Promise<{ total: number; used: number } | undefined> {
    try {
      const total = Number((await this.docker(['info', '--format', '{{.MemTotal}}'], { timeoutMs: 10_000 })).trim());
      if (!Number.isFinite(total) || total <= 0) return undefined;
      const stats = await this.docker(['stats', '--no-stream', '--format', '{{.MemUsage}}'], { timeoutMs: 20_000 }).catch(() => '');
      const used = stats.split('\n').filter((line) => line.trim() !== '').reduce((sum, line) => sum + parseMemUsage(line), 0);
      return { total, used };
    } catch {
      return undefined;
    }
  }

  /** Download the sandbox image (a few GB), reporting progress. Idempotent. */
  pullImage(): Promise<void> {
    if (this.pulling !== undefined) return this.pulling;
    this.pullError = undefined;
    this.pullProgress = 0;
    const docker = dockerBinary();
    if (docker === undefined) return Promise.reject(new Error('Docker is not installed'));
    this.pulling = new Promise<void>((resolve, reject) => {
      const child = spawn(docker, ['pull', SANDBOX_IMAGE], { env: { ...process.env, PATH: searchPath() } });
      const layers = new Map<string, number>();
      let lastEmit = 0;
      const onLine = (line: string): void => {
        // "<layer>: Downloading [==>   ]  12.3MB/45.6MB" / "Pull complete".
        const match = /^([0-9a-f]{12}): (.+)$/.exec(line.trim());
        if (match === null) return;
        const [, layer, text] = match as unknown as [string, string, string];
        if (/Pull complete|Already exists|Download complete/.test(text)) layers.set(layer, 1);
        else {
          const sizes = /([\d.]+)([kMG]?B)\/([\d.]+)([kMG]?B)/.exec(text);
          if (sizes !== null) {
            const unit = (u: string): number => (u === 'GB' ? 1e9 : u === 'MB' ? 1e6 : u === 'kB' ? 1e3 : 1);
            const done = Number(sizes[1]) * unit(sizes[2]!);
            const total = Number(sizes[3]) * unit(sizes[4]!);
            layers.set(layer, total > 0 ? Math.min(0.99, done / total) * (/Extracting/.test(text) ? 1 : 0.8) : 0);
          } else if (!layers.has(layer)) layers.set(layer, 0);
        }
        const values = [...layers.values()];
        this.pullProgress = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
        if (Date.now() - lastEmit > 500) { lastEmit = Date.now(); this.onChange(); }
      };
      let buffer = '';
      const read = (chunk: Buffer): void => {
        buffer += chunk.toString('utf8');
        const lines = buffer.split(/\r?\n|\r/);
        buffer = lines.pop() ?? '';
        lines.forEach(onLine);
      };
      let stderr = '';
      child.stdout.on('data', read);
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(stderr.trim().split('\n').pop() ?? `docker pull exited with ${code}`));
      });
    }).then(() => {
      this.pulling = undefined;
      this.pullProgress = undefined;
      this.onChange();
    }, (error: unknown) => {
      this.pulling = undefined;
      this.pullProgress = undefined;
      this.pullError = error instanceof Error ? error.message : 'Download failed';
      this.onChange();
      throw error;
    });
    this.onChange();
    return this.pulling;
  }

  // ---- lifecycle ------------------------------------------------------------

  /** Remove containers left behind by an earlier run of the app. */
  async cleanupOrphans(): Promise<void> {
    try {
      const ids = (await this.docker(['ps', '-aq', '--filter', `label=${LABEL}`], { timeoutMs: 15_000 })).split('\n').map((id) => id.trim()).filter(Boolean);
      if (ids.length > 0) await this.docker(['rm', '-f', ...ids], { timeoutMs: 60_000 });
    } catch { /* Docker absent or stopped: nothing to clean. */ }
  }

  /**
   * The agent's sandbox, started if needed. `taskId` marks it in use until
   * `release(agentId, taskId)`; while in use it is never stopped. Throws a
   * SandboxCapacityError when Docker has no memory left for a new one.
   */
  async acquire(input: { taskId: string; agentId: string; agentName: string; signal?: AbortSignal }): Promise<SandboxEndpoint> {
    const existing = this.running.get(input.agentId);
    if (existing !== undefined && existing.state !== 'stopping') {
      existing.users.add(input.taskId);
      if (existing.idleTimer !== undefined) { clearTimeout(existing.idleTimer); delete existing.idleTimer; }
      return existing.ready;
    }
    if (!(await this.hasImage())) throw new Error('The sandbox image is not downloaded yet. Open Agents and choose Download sandbox.');
    await this.ensureRoom();
    const container = `conductor-sbx-${input.agentId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 12)}-${randomBytes(3).toString('hex')}`;
    const apiKey = randomBytes(24).toString('hex');
    const controller = new AbortController();
    input.signal?.addEventListener('abort', () => { controller.abort(); }, { once: true });
    const run: Running = {
      agentId: input.agentId, agentName: input.agentName, container,
      startedAt: new Date().toISOString(), state: 'starting', users: new Set([input.taskId]),
      ready: Promise.resolve({ baseUrl: '', apiKey }),
    };
    run.ready = (async (): Promise<SandboxEndpoint> => {
      await this.docker([
        'run', '-d', '--name', container,
        '--label', `${LABEL}=1`, '--label', `${LABEL}.agent=${input.agentId}`,
        '--security-opt', 'seccomp=unconfined',
        '--memory', String(SANDBOX_MEMORY_BYTES), '--shm-size', '1g',
        '-e', `SANDBOX_API_KEY=${apiKey}`, '-e', 'TZ=UTC',
        '-p', `127.0.0.1::${CONTAINER_PORT}`,
        SANDBOX_IMAGE,
      ], { timeoutMs: 120_000 });
      const mapping = (await this.docker(['port', container, `${CONTAINER_PORT}/tcp`], { timeoutMs: 15_000 })).split('\n')[0]?.trim() ?? '';
      const port = /:(\d+)$/.exec(mapping)?.[1];
      if (port === undefined) throw new Error('Docker did not publish the sandbox port');
      const endpoint = { baseUrl: `http://127.0.0.1:${port}`, apiKey };
      await this.waitReady(endpoint, controller.signal);
      run.endpoint = endpoint;
      run.state = 'ready';
      this.onChange();
      return endpoint;
    })();
    this.running.set(input.agentId, run);
    this.onChange();
    try {
      return await run.ready;
    } catch (error) {
      await this.stop(input.agentId);
      throw error;
    }
  }

  /** The agent's sandbox endpoint, if it is running and ready. */
  endpoint(agentId: string): SandboxEndpoint | undefined {
    const run = this.running.get(agentId);
    return run?.state === 'ready' ? run.endpoint : undefined;
  }

  /** The task stopped using the sandbox; stop it once idle for a while. */
  release(agentId: string, taskId: string): void {
    const run = this.running.get(agentId);
    if (run === undefined) return;
    run.users.delete(taskId);
    if (run.users.size > 0 || run.idleTimer !== undefined) return;
    run.idleTimer = setTimeout(() => { void this.stop(agentId); }, this.idleStopMs);
    run.idleTimer.unref?.();
  }

  async stop(agentId: string): Promise<void> {
    const run = this.running.get(agentId);
    if (run === undefined) return;
    if (run.idleTimer !== undefined) clearTimeout(run.idleTimer);
    run.state = 'stopping';
    this.onChange();
    try { await this.docker(['rm', '-f', run.container], { timeoutMs: 60_000 }); } catch { /* already gone */ }
    this.running.delete(agentId);
    this.onChange();
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((agentId) => this.stop(agentId)));
  }

  /**
   * Refuse to start when Docker can't fit another sandbox. Idle sandboxes
   * (no task using them) are stopped first to make room.
   */
  private async ensureRoom(): Promise<void> {
    for (;;) {
      const memory = await this.memory();
      if (memory === undefined || memory.total - memory.used >= START_HEADROOM_BYTES) return;
      const idle = [...this.running.values()].find((run) => run.users.size === 0 && run.state === 'ready');
      if (idle !== undefined) { await this.stop(idle.agentId); continue; }
      const gib = (bytes: number): string => (bytes / 1024 ** 3).toFixed(1);
      const busy = [...this.running.values()].filter((run) => run.state !== 'stopping').map((run) => run.agentName);
      throw new SandboxCapacityError(
        `Can’t start another agent sandbox: Docker has ${gib(memory.total - memory.used)} GB of ${gib(memory.total)} GB free and a sandbox needs about ${gib(START_HEADROOM_BYTES)} GB.`
        + `${busy.length > 0 ? ` Running now: ${busy.join(', ')}.` : ''} Stop one in Agents, or give Docker more memory in Docker Desktop → Settings → Resources.`,
      );
    }
  }
}
