import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import type { SandboxRun, SandboxStatus } from '@shared/sandbox-agents';

// AIO Sandbox containers (github.com/agent-infra/sandbox), one per agent:
// an agent's 1:1 chat and its group chats share its sandbox.
//
// Each container runs the pinned image with a random API key, publishes its
// port on 127.0.0.1 only, and is labelled so leftovers from a crash are
// removed on the next launch. Files live on in two named volumes (below),
// which that cleanup never touches. There is no fixed limit on how many run: before
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

// Storage that outlives the container. Containers are thrown away when a
// sandbox idles out or the app quits, so anything an agent wants to keep goes
// in one of two Docker named volumes: its own, and one every agent shares.
/** Where an agent's own volume is mounted: kept across restarts, private to it. */
export const SANDBOX_WORKSPACE_DIR = '/home/gem/workspace';
/** Where the volume shared by every agent is mounted. */
export const SANDBOX_SHARED_DIR = '/home/gem/shared';
/** The notebook every agent keeps in the shared folder, so work carries over a restart or a change of model. */
export const SANDBOX_MEMORY_FILE = `${SANDBOX_SHARED_DIR}/memory.md`;
export const SHARED_VOLUME = 'conductor-sandbox-shared';

/** Sandbox keys of group chats start with this; a group's sandbox works in the shared volume. */
export const GROUP_KEY_PREFIX = 'group-';

/** The volume mounted as an agent's workspace: its own, or the shared one for a group's sandbox. */
export function workspaceVolume(key: string): string {
  return key.startsWith(GROUP_KEY_PREFIX) ? SHARED_VOLUME : agentVolume(key);
}

/** The Docker volume holding one agent's files. */
export function agentVolume(agentId: string): string {
  const safe = agentId.replace(/[^a-zA-Z0-9_.-]/g, '');
  return `conductor-sandbox-agent-${safe === '' ? 'default' : safe}`;
}

/** Where the sandbox's Chromium keeps its profile (cookies, logins). Fixed by the image's start-browser.sh. */
export const SANDBOX_BROWSER_DIR = '/home/gem/.config/browser';

/**
 * The volume holding one sandbox's browser profile, so a login made once
 * survives the container being thrown away. It is per sandbox key (an agent,
 * a group chat, or a flow), never shared, so an agent only gets the logins
 * made in its own sandbox.
 */
export function browserVolume(key: string): string {
  const safe = key.replace(/[^a-zA-Z0-9_.-]/g, '');
  return `conductor-sandbox-browser-${safe === '' ? 'default' : safe}`;
}

/** A file here is read by Chromium as managed policy, which overrides the image's own preferences. */
export const BROWSER_POLICY_FILE = '/etc/browser/policies/managed/conductor.json';
/** Allow cookies to be kept after the browser closes (the image defaults to session-only, which forgets every login on exit). */
const BROWSER_POLICY = '{"DefaultCookiesSetting":1}\n';
/** Run inside the sandbox: ask Chromium to quit cleanly so it writes its cookies out. */
const CLOSE_BROWSER = `fetch('http://127.0.0.1:9222/json/version').then(r=>r.json()).then(v=>{const w=new WebSocket(v.webSocketDebuggerUrl);w.onopen=()=>w.send('{"id":1,"method":"Browser.close"}');setTimeout(()=>process.exit(0),2500)}).catch(()=>process.exit(0))`;

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

/**
 * Where a docker CLI lives when the app is launched from a desktop shell with a
 * minimal PATH: Docker Desktop, Homebrew, OrbStack, Rancher Desktop, Colima,
 * plus the usual Linux and Windows install locations. Missing dirs are harmless.
 */
export function dockerSearchDirs(home: string = homedir(), env: NodeJS.ProcessEnv = process.env): string[] {
  const programFiles = env['ProgramFiles'] ?? 'C:\\Program Files';
  return [
    '/usr/local/bin', '/opt/homebrew/bin', '/Applications/Docker.app/Contents/Resources/bin', join(home, '.docker/bin'),
    join(home, '.orbstack/bin'), '/Applications/OrbStack.app/Contents/MacOS/xbin',
    join(home, '.rd/bin'), join(home, '.colima/bin'), '/snap/bin', '/usr/bin', '/bin',
    join(programFiles, 'Docker', 'Docker', 'resources', 'bin'), join(programFiles, 'Rancher Desktop', 'resources', 'resources', 'win32', 'bin'),
  ];
}

function searchPath(): string {
  const extra = dockerSearchDirs();
  return [...new Set([...(process.env['PATH'] ?? '').split(delimiter), ...extra])].filter(Boolean).join(delimiter);
}

function dockerBinary(): string | undefined {
  const names = process.platform === 'win32' ? ['docker.exe', 'docker.cmd', 'docker'] : ['docker'];
  for (const dir of searchPath().split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function execDocker(docker: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(docker, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, PATH: searchPath() } }, (error, stdout, stderr) => {
      if (error !== null) {
        const detail = `${stderr}`.split('\n').map((line) => line.trim()).find((line) => line !== '') ?? error.message;
        reject(new Error(detail.slice(0, 400)));
        return;
      }
      resolve(`${stdout}`);
    });
  });
}

/** The docker context that answered last; undefined means the CLI's own active one. */
let workingContext: string | undefined;

/**
 * The CLI's active context may point at a runtime that is not running (say
 * Docker Desktop, while OrbStack, Colima or Rancher Desktop is). If it does not
 * answer, use whichever other context does. DOCKER_HOST / DOCKER_CONTEXT win.
 */
async function pickContext(docker: string): Promise<string | undefined> {
  if (process.env['DOCKER_HOST'] || process.env['DOCKER_CONTEXT']) return undefined;
  if (workingContext !== undefined) return workingContext;
  try { await execDocker(docker, ['info', '--format', '{{.ServerVersion}}'], 10_000); return undefined; } catch { /* try the others */ }
  let names: string[] = [];
  try { names = (await execDocker(docker, ['context', 'ls', '--format', '{{.Name}}'], 10_000)).split('\n').map((n) => n.trim()).filter(Boolean); } catch { return undefined; }
  for (const name of names) {
    try { await execDocker(docker, ['--context', name, 'info', '--format', '{{.ServerVersion}}'], 10_000); workingContext = name; return name; } catch { /* next */ }
  }
  return undefined;
}

const defaultDocker: DockerRunner = async (args, options = {}) => {
  const docker = dockerBinary();
  if (docker === undefined) throw new Error('Docker is not installed');
  const context = await pickContext(docker);
  try {
    return await execDocker(docker, context === undefined ? args : ['--context', context, ...args], options.timeoutMs ?? 60_000);
  } catch (error) {
    workingContext = undefined; // re-probe next time, in case the runtime changed
    throw error;
  }
};

export interface SandboxManagerOptions {
  docker?: DockerRunner;
  /** Probe a started sandbox; resolves once its API answers. Injectable for tests. */
  waitReady?: (endpoint: SandboxEndpoint, signal: AbortSignal) => Promise<void>;
  idleStopMs?: number;
  onChange?: () => void;
  /** Where to keep the browser policy file mounted into each sandbox. Without it, cookies stay session-only. */
  browserPolicyFile?: string;
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
    this.browserPolicyFile = options.browserPolicyFile;
  }

  private readonly browserPolicyFile: string | undefined;

  /** `-v` arguments that mount the browser policy file, writing it first. */
  private policyMount(): string[] {
    if (this.browserPolicyFile === undefined) return [];
    try {
      mkdirSync(dirname(this.browserPolicyFile), { recursive: true });
      writeFileSync(this.browserPolicyFile, BROWSER_POLICY, { mode: 0o644 });
    } catch { return []; }
    return ['-v', `${this.browserPolicyFile}:${BROWSER_POLICY_FILE}:ro`];
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
      // Before the browser starts: clear Chromium's lock files in the profile (a
      // container that was killed leaves ones naming itself, and the new browser
      // would refuse the profile as "in use by another computer"), and hand the
      // profile to the sandbox user (a new volume is owned by root).
      await this.docker([
        'run', '--rm', '-v', `${browserVolume(input.agentId)}:/b`, '--entrypoint', 'sh', SANDBOX_IMAGE, '-c',
        'rm -f /b/SingletonLock /b/SingletonCookie /b/SingletonSocket; chown 1000:1000 /b',
      ], { timeoutMs: 60_000 }).catch(() => {});
      const policy = this.policyMount();
      await this.docker([
        'run', '-d', '--name', container,
        '--label', `${LABEL}=1`, '--label', `${LABEL}.agent=${input.agentId}`,
        '--security-opt', 'seccomp=unconfined',
        '--memory', String(SANDBOX_MEMORY_BYTES), '--shm-size', '1g',
        '-e', `SANDBOX_API_KEY=${apiKey}`, '-e', 'TZ=UTC',
        '-p', `127.0.0.1::${CONTAINER_PORT}`,
        // Docker creates a named volume the first time it is mounted.
        '-v', `${workspaceVolume(input.agentId)}:${SANDBOX_WORKSPACE_DIR}`,
        '-v', `${SHARED_VOLUME}:${SANDBOX_SHARED_DIR}`,
        // Docker would create ~/.config as root to hold the browser volume, and
        // other tools could not write there; a small owned tmpfs under it fixes that.
        '--tmpfs', '/home/gem/.config:uid=1000,gid=1000,mode=0775,size=64m',
        '-v', `${browserVolume(input.agentId)}:${SANDBOX_BROWSER_DIR}`,
        ...policy,
        SANDBOX_IMAGE,
      ], { timeoutMs: 120_000 });
      // A fresh volume is owned by root; hand both mounts to the sandbox user.
      // Best-effort: if the image has no such user, leave them world-writable.
      await this.docker([
        'exec', '-u', '0', container, 'sh', '-c',
        `chown gem:gem ${SANDBOX_WORKSPACE_DIR} ${SANDBOX_SHARED_DIR} 2>/dev/null || chmod 0777 ${SANDBOX_WORKSPACE_DIR} ${SANDBOX_SHARED_DIR}`,
      ], { timeoutMs: 30_000 }).catch(() => {});
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
  /** Docker volumes holding sandbox data: the shared one, each agent's workspace, and the legacy one. */
  async dataVolumes(): Promise<string[]> {
    const out = await this.docker(['volume', 'ls', '-q', '--filter', 'name=conductor-sandbox'], { timeoutMs: 15_000 });
    return out.split('\n').map((name) => name.trim()).filter((name) => name === SHARED_VOLUME || name === 'conductor-sandbox-workspace' || name.startsWith('conductor-sandbox-agent-'));
  }

  /**
   * The text files in a volume (small, not hidden, not dependency folders),
   * read through a throw-away container so no sandbox needs to be running.
   * Paths are relative to the volume's root.
   */
  async readVolumeFiles(volume: string): Promise<Array<{ path: string; content: string }>> {
    const script = 'cd /d && find . -type f -size -200k -not -path "*/.*" -not -path "*/node_modules/*" -not -path "*/.git/*" | head -400 | while IFS= read -r f; do '
      + 'if [ -s "$f" ] && grep -Iq . "$f" 2>/dev/null; then printf "\\n@@FILE %s\\n" "$f"; cat "$f"; fi; done';
    const out = await this.docker(['run', '--rm', '-v', `${volume}:/d:ro`, '--entrypoint', 'sh', SANDBOX_IMAGE, '-c', script], { timeoutMs: 120_000 });
    const files: Array<{ path: string; content: string }> = [];
    for (const part of out.split('\n@@FILE ').slice(1)) {
      const end = part.indexOf('\n');
      if (end < 0) continue;
      files.push({ path: part.slice(0, end).replace(/^\.\//, ''), content: part.slice(end + 1) });
    }
    return files;
  }

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
    // Close the browser cleanly first so it writes its cookies to the profile volume.
    if (run.endpoint !== undefined) {
      try { await this.docker(['exec', run.container, 'node', '-e', CLOSE_BROWSER], { timeoutMs: 10_000 }); } catch { /* not running, or no browser */ }
    }
    try { await this.docker(['rm', '-f', run.container], { timeoutMs: 60_000 }); } catch { /* already gone */ }
    this.running.delete(agentId);
    this.onChange();
  }

  /** Forget the logins saved in a sandbox's browser: stop the sandbox, delete its profile volume. */
  async clearBrowser(agentId: string): Promise<void> {
    await this.stop(agentId);
    try { await this.docker(['volume', 'rm', '-f', browserVolume(agentId)], { timeoutMs: 30_000 }); } catch { /* Docker absent, or never created */ }
  }

  /** The agent was deleted: stop its sandbox and delete its own volumes. The shared volume stays. */
  async forget(agentId: string): Promise<void> {
    await this.clearBrowser(agentId);
    if (agentId.startsWith(GROUP_KEY_PREFIX)) return; // a group's workspace is the shared volume: never delete it
    try { await this.docker(['volume', 'rm', '-f', agentVolume(agentId)], { timeoutMs: 30_000 }); } catch { /* Docker absent, or never created */ }
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
