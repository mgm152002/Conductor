import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  defaultCliEnvironment,
  discoverOnPath,
  type CliEnvironment,
} from '../adapters/local-cli-adapter';
import {
  quotaSampleFromAntigravityUsage,
  quotaSampleFromCodexRateLimits,
  quotaSampleFromOpenCodeGoUsage,
  type NormalizedQuotaSample,
  type QuotaRecorder,
} from './quota';

type Json = Record<string, unknown>;

const DEFAULT_INTERVAL_MS = 5 * 60_000;
// Antigravity's `/usage` round trip is slower than Codex's local app-server;
// this still bounds every probe when a CLI hangs.
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_OUTPUT_BYTES = 1_000_000;
const OPENCODE_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

const obj = (value: unknown): Json | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Json
    : null
);

/** The subset of a fetch response the quota probes need. */
export interface QuotaHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** HTTP transport used by the OpenCode Go probe; injectable for tests. */
export type QuotaFetch = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<QuotaHttpResponse>;

export interface QuotaPollingServiceOptions {
  quota: Pick<QuotaRecorder, 'record'>;
  env?: CliEnvironment;
  intervalMs?: number;
  timeoutMs?: number;
  /** HTTP transport for the OpenCode Go usage endpoint. */
  fetch?: QuotaFetch;
  /** Resolve the OpenCode Go API key; defaults to `opencode auth export`. */
  openCodeApiKey?: () => Promise<string | undefined>;
  now?: () => Date;
}

interface ProbeSample {
  adapterId: string;
  sample: NormalizedQuotaSample;
}

/** Read one credential from the array `opencode auth export` prints. */
function openCodeGoKey(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  for (const entry of value) {
    const credential = obj(entry);
    if (credential?.['integrationID'] !== 'opencode-go') continue;
    if (credential['active'] === false) continue;
    const secret = obj(credential['value']);
    if (secret?.['type'] !== 'key') continue;
    const key = secret['key'];
    if (typeof key === 'string' && key.length >= 8 && key.length <= 512 && !/\s/.test(key)) return key;
  }
  return undefined;
}

/** Refreshes provider quota snapshots without starting an agent task. */
export class QuotaPollingService {
  private readonly quota: Pick<QuotaRecorder, 'record'>;
  private readonly env: CliEnvironment;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private readonly fetch: QuotaFetch;
  private readonly openCodeApiKey: () => Promise<string | undefined>;
  private readonly now: () => Date;
  private readonly activeChildren = new Set<ChildProcessWithoutNullStreams>();
  private readonly activeRequests = new Set<AbortController>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;
  private stopped = false;

  constructor(options: QuotaPollingServiceOptions) {
    this.quota = options.quota;
    this.env = options.env ?? defaultCliEnvironment();
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetch = options.fetch ?? ((url, init) => fetch(url, init));
    this.openCodeApiKey = options.openCodeApiKey ?? (() => this.readOpenCodeApiKey());
    this.now = options.now ?? (() => new Date());
  }

  start(): void {
    if (this.interval !== undefined) return;
    this.stopped = false;
    this.poll();
    this.interval = setInterval(() => { this.poll(); }, this.intervalMs);
    // The app's own event loop keeps the process alive; this timer alone must
    // not, matching the other background services.
    this.interval.unref?.();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight !== undefined) return this.inFlight;
    const refresh = this.runProbes().finally(() => {
      if (this.inFlight === refresh) this.inFlight = undefined;
    });
    this.inFlight = refresh;
    return refresh;
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.stopped = true;
    for (const child of [...this.activeChildren]) this.terminateChild(child);
    for (const controller of this.activeRequests) controller.abort();
    this.activeRequests.clear();
  }

  /** A scheduled tick must never surface as an unhandled rejection. */
  private poll(): void {
    void this.refresh().catch((error: unknown) => {
      console.warn('Quota refresh failed:', error instanceof Error ? error.message : 'unavailable');
    });
  }

  /**
   * Run every provider concurrently. One provider being absent, signed out, or
   * broken must not stop the others from recording their last valid snapshot.
   */
  private async runProbes(): Promise<void> {
    const results = await Promise.allSettled([
      this.probeCodex(),
      this.probeAntigravity(),
      this.probeOpenCodeGo(),
    ]);
    if (this.stopped) return;
    for (const result of results) {
      if (result.status !== 'fulfilled' || result.value === undefined) continue;
      this.quota.record({ adapterId: result.value.adapterId, sample: result.value.sample });
    }
  }

  private async probeCodex(): Promise<ProbeSample | undefined> {
    const executable = discoverOnPath('codex', this.env);
    if (executable === undefined) return undefined;

    const child = this.env.spawn(executable, ['app-server']);
    this.activeChildren.add(child);
    let nextId = 1;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const lines = createInterface({ input: child.stdout });
    // Drain stderr so a chatty app-server cannot block on a full pipe. Only a
    // bounded tail is retained, and it is never persisted.
    const stderrLines = createInterface({ input: child.stderr });
    const stderrTail: string[] = [];
    stderrLines.on('line', (line) => {
      if (line.trim() === '') return;
      stderrTail.push(line);
      if (stderrTail.length > 20) stderrTail.shift();
    });

    const rejectPending = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };

    lines.on('line', (line) => {
      try {
        const message = obj(JSON.parse(line));
        const id = message?.['id'];
        if (typeof id !== 'number') return;
        const waiter = pending.get(id);
        if (waiter === undefined) return;
        pending.delete(id);
        const error = obj(message?.['error']);
        if (error !== null) waiter.reject(new Error(typeof error['message'] === 'string' ? error['message'] : 'Codex request failed'));
        else waiter.resolve(message?.['result']);
      } catch {
        // Ignore non-JSON output; the timeout still bounds the probe.
      }
    });
    child.once('error', (error) => { rejectPending(error); });
    child.once('close', () => { rejectPending(new Error('Codex app-server exited')); });

    const send = (message: Json): void => {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const request = (method: string, params: Json): Promise<unknown> => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        send({ id, method, params });
      });
    };

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const workflow = async (): Promise<ProbeSample | undefined> => {
        await request('initialize', { clientInfo: { name: 'conductor', version: '0.1.0' }, capabilities: null });
        send({ method: 'initialized' });
        const result = await request('account/rateLimits/read', {});
        const sample = quotaSampleFromCodexRateLimits(result, {
          source: 'codex',
          now: this.now(),
        });
        return sample === undefined ? undefined : { adapterId: 'codex', sample };
      };
      const timeout = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), this.timeoutMs);
      });
      return await Promise.race([workflow(), timeout]);
    } catch {
      // Absence, old app-server builds, auth errors, and malformed replies must
      // not turn a last-known valid snapshot into a dashboard failure.
      return undefined;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      lines.close();
      stderrLines.close();
      rejectPending(new Error('Quota probe finished'));
      this.terminateChild(child);
    }
  }

  private async probeAntigravity(): Promise<ProbeSample | undefined> {
    const executable = discoverOnPath('agy', this.env);
    if (executable === undefined) return undefined;

    const output = await this.capture(executable, ['-p', '/usage', '--output-format', 'json']);
    if (output === undefined) return undefined;

    let payload: unknown;
    try {
      payload = JSON.parse(output.trim());
    } catch {
      return undefined;
    }
    const sample = quotaSampleFromAntigravityUsage(payload, {
      source: 'antigravity',
      now: this.now(),
    });
    return sample === undefined ? undefined : { adapterId: 'antigravity', sample };
  }

  private async probeOpenCodeGo(): Promise<ProbeSample | undefined> {
    // `opencode auth export` is the CLI's documented way to read the credential
    // the user configured. The key stays in memory and is never logged.
    const key = await this.openCodeApiKey();
    if (key === undefined) return undefined;

    const controller = new AbortController();
    this.activeRequests.add(controller);
    const timer = setTimeout(() => { controller.abort(); }, this.timeoutMs);
    let payload: unknown;
    try {
      const response = await this.fetch(OPENCODE_USAGE_URL, {
        headers: {
          Authorization: `Bearer ${key}`,
          Accept: 'application/json',
          'User-Agent': 'conductor',
        },
        signal: controller.signal,
      });
      // A user without a Go subscription gets 401/403. That is an unsupported
      // source, not a reason to erase a snapshot from an earlier subscription.
      if (!response.ok) return undefined;
      payload = await response.json().catch(() => undefined);
    } finally {
      clearTimeout(timer);
      this.activeRequests.delete(controller);
    }

    const sample = quotaSampleFromOpenCodeGoUsage(payload, {
      source: 'opencode',
      now: this.now(),
    });
    return sample === undefined ? undefined : { adapterId: 'opencode', sample };
  }

  private async readOpenCodeApiKey(): Promise<string | undefined> {
    const executable = discoverOnPath('opencode', this.env);
    if (executable === undefined) return undefined;

    const output = await this.capture(executable, ['auth', 'export']);
    if (output === undefined) return undefined;
    try {
      return openCodeGoKey(JSON.parse(output));
    } catch {
      return undefined;
    }
  }

  /** Run a short-lived CLI command and capture bounded stdout. */
  private async capture(executable: string, args: string[]): Promise<string | undefined> {
    const child = this.env.spawn(executable, args);
    this.activeChildren.add(child);
    // Non-interactive probes never read stdin; closing it prevents a CLI from
    // waiting for an answer.
    child.stdin.end();

    return new Promise((resolve) => {
      let settled = false;
      let overflow = false;
      let bytes = 0;
      const chunks: string[] = [];
      // Held so `finish` can clear a timer declared after it without resorting
      // to a mutable local that lint reads as never reassigned.
      const deadline: { timer?: ReturnType<typeof setTimeout> } = {};

      const finish = (output: string | undefined): void => {
        if (settled) return;
        settled = true;
        if (deadline.timer !== undefined) clearTimeout(deadline.timer);
        child.stdout.removeListener('data', onData);
        child.stderr.removeListener('data', onStderr);
        if (output === undefined) this.terminateChild(child);
        else this.activeChildren.delete(child);
        resolve(output);
      };

      const onData = (chunk: string): void => {
        if (overflow) return;
        bytes += Buffer.byteLength(chunk);
        if (bytes > MAX_OUTPUT_BYTES) {
          overflow = true;
          return;
        }
        chunks.push(chunk);
      };
      const onStderr = (): void => { /* Drain only; never retain provider output. */ };

      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', onData);
      child.stderr.on('data', onStderr);
      // A late stream error after termination must not become uncaught.
      child.stdout.on('error', () => undefined);
      child.stderr.on('error', () => undefined);
      child.once('error', () => { finish(undefined); });
      child.once('close', (code) => {
        if (overflow || code !== 0) finish(undefined);
        else finish(chunks.join(''));
      });
      deadline.timer = setTimeout(() => { finish(undefined); }, this.timeoutMs);
    });
  }

  private terminateChild(child: ChildProcessWithoutNullStreams): void {
    if (!this.activeChildren.delete(child)) return;
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
