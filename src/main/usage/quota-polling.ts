import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import {
  defaultCliEnvironment,
  discoverOnPath,
  type CliEnvironment,
} from '../adapters/local-cli-adapter';
import { quotaSampleFromCodexRateLimits, type QuotaRecorder } from './quota';

type Json = Record<string, unknown>;

const DEFAULT_INTERVAL_MS = 5 * 60_000;
const DEFAULT_TIMEOUT_MS = 3_000;

const obj = (value: unknown): Json | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Json
    : null
);

export interface QuotaPollingServiceOptions {
  quota: Pick<QuotaRecorder, 'record'>;
  env?: CliEnvironment;
  intervalMs?: number;
  timeoutMs?: number;
}

/** Refreshes provider quota snapshots without starting an agent task. */
export class QuotaPollingService {
  private readonly quota: Pick<QuotaRecorder, 'record'>;
  private readonly env: CliEnvironment;
  private readonly intervalMs: number;
  private readonly timeoutMs: number;
  private activeChild: ChildProcessWithoutNullStreams | undefined;
  private interval: ReturnType<typeof setInterval> | undefined;
  private inFlight: Promise<void> | undefined;

  constructor(options: QuotaPollingServiceOptions) {
    this.quota = options.quota;
    this.env = options.env ?? defaultCliEnvironment();
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  start(): void {
    if (this.interval !== undefined) return;
    this.poll();
    this.interval = setInterval(() => { this.poll(); }, this.intervalMs);
    // The app's own event loop keeps the process alive; this timer alone must
    // not, matching the other background services.
    this.interval.unref?.();
  }

  refresh(): Promise<void> {
    if (this.inFlight !== undefined) return this.inFlight;
    const refresh = this.probeCodex().finally(() => {
      if (this.inFlight === refresh) this.inFlight = undefined;
    });
    this.inFlight = refresh;
    return refresh;
  }

  stop(): void {
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    this.terminateActiveChild();
  }

  /** A scheduled tick must never surface as an unhandled rejection. */
  private poll(): void {
    void this.refresh().catch((error: unknown) => {
      console.warn('Quota refresh failed:', error instanceof Error ? error.message : 'unavailable');
    });
  }

  private async probeCodex(): Promise<void> {
    const executable = discoverOnPath('codex', this.env);
    if (executable === undefined) return;

    const child = this.env.spawn(executable, ['app-server']);
    this.activeChild = child;
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
      const workflow = async (): Promise<void> => {
        await request('initialize', { clientInfo: { name: 'conductor', version: '0.1.0' }, capabilities: null });
        send({ method: 'initialized' });
        const result = await request('account/rateLimits/read', {});
        const sample = quotaSampleFromCodexRateLimits(result, { source: 'codex' });
        // `stop()` may have terminated the probe while this response was in
        // flight; never write quota after shutdown began.
        if (sample !== undefined && this.activeChild === child) {
          this.quota.record({ adapterId: 'codex', sample });
        }
      };
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, this.timeoutMs);
      });
      await Promise.race([workflow(), timeout]);
    } catch {
      // Absence, old app-server builds, auth errors, and malformed replies must
      // not turn a last-known valid snapshot into a dashboard failure.
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      lines.close();
      stderrLines.close();
      rejectPending(new Error('Quota probe finished'));
      if (this.activeChild === child) this.terminateActiveChild();
    }
  }

  private terminateActiveChild(): void {
    const child = this.activeChild;
    this.activeChild = undefined;
    if (child === undefined) return;
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
}
