// A scriptable in-memory AgentAdapter for orchestrator tests. It satisfies the
// full AgentAdapter contract without touching any external process, so tests
// can drive deterministic streams, terminal outcomes, liveness responses, and
// injected crashes without spawning subprocesses.
//
// The fake is intentionally small and dependency-free: it holds only a script
// (events + a result) and a few toggles. It never holds a raw secret — any
// placeholder tokens in `start` input are carried through unchanged, exactly as
// a real adapter would.

import type {
  AdapterRecord,
  AdapterResult,
  AdapterSessionHandle,
  AdapterStreamEvent,
  AdapterStreamEventKind,
  AgentAdapter,
  AgentSession,
  CapabilityDescriptor,
} from '@shared/adapter';

/** A crash can be injected at a specific point in the adapter lifecycle. */
export type FakeCrashPoint = 'start' | 'stream' | 'await' | 'cancel' | 'resume';

/**
 * A process-global monotonic counter so session ids are unique across EVERY
 * FakeAdapter instance in a test run — not just within one instance. Real
 * adapters mint UUID session ids; two instances (e.g. a crash-then-relaunch
 * pair that share an adapter id) must never collide on a session primary key,
 * which would otherwise surface only as a spurious "start failed" on insert.
 */
let globalSessionCounter = 0;

/** One scripted stream event, minus the bookkeeping the fake fills in. */
export interface ScriptedEvent {
  kind: AdapterStreamEventKind;
  data: unknown;
  /** Optional ISO-8601 timestamp; defaults to a deterministic counter stamp. */
  at?: string;
}

export interface FakeAdapterScript {
  /** Ordered events `stream` yields. Sequence numbers are assigned 1..n. */
  events?: ScriptedEvent[];
  /** Terminal outcome `await` resolves to. Defaults to a plain success. */
  result?: AdapterResult;
  /** Liveness answers `probeLiveness` returns, consumed in order. */
  liveness?: boolean[];
  /** Default liveness once the `liveness` queue is exhausted. Defaults true. */
  livenessDefault?: boolean;
  /**
   * Inject a crash (thrown error) at a lifecycle point. The error is thrown
   * the first time that method runs, before producing any normal output.
   */
  crashAt?: FakeCrashPoint;
  /** Message for the injected crash. Defaults to a descriptive string. */
  crashMessage?: string;
  /** Whether sessions this adapter starts are resumable. Defaults false. */
  resumable?: boolean;
  /** Milliseconds to delay each stream event (default 0 — synchronous). */
  streamDelayMs?: number;
}

export interface FakeAdapterOptions {
  /** Overrides merged onto the default AdapterRecord. */
  record?: Partial<AdapterRecord>;
  /** The script controlling stream/await/liveness/crash behavior. */
  script?: FakeAdapterScript;
}

const DEFAULT_CAPABILITY: CapabilityDescriptor = {
  id: 'fake.echo',
  title: 'Echo input (fake)',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  streaming: true,
  cancellable: true,
  resumable: false,
  requiredPermissions: [],
};

/**
 * Records every call made against a fake adapter so tests can assert on
 * interaction order (e.g. that cancel was delivered, that start saw a
 * placeholder-only input, how many events were streamed).
 */
export interface FakeAdapterCalls {
  started: unknown[];
  streamed: number;
  awaited: number;
  cancelled: AdapterSessionHandle[];
  resumed: AgentSession[];
  livenessProbes: AgentSession[];
}

export class FakeAdapter implements AgentAdapter {
  readonly record: AdapterRecord;
  readonly calls: FakeAdapterCalls = {
    started: [],
    streamed: 0,
    awaited: 0,
    cancelled: [],
    resumed: [],
    livenessProbes: [],
  };

  private readonly script: Required<
    Pick<FakeAdapterScript, 'events' | 'liveness' | 'livenessDefault' | 'resumable' | 'streamDelayMs'>
  > &
    FakeAdapterScript;
  private readonly result: AdapterResult;
  private livenessCursor = 0;
  private sessionCounter = 0;

  constructor(options: FakeAdapterOptions = {}) {
    const script = options.script ?? {};
    this.script = {
      events: script.events ?? [],
      liveness: script.liveness ?? [],
      livenessDefault: script.livenessDefault ?? true,
      resumable: script.resumable ?? false,
      streamDelayMs: script.streamDelayMs ?? 0,
      ...(script.crashAt !== undefined ? { crashAt: script.crashAt } : {}),
      ...(script.crashMessage !== undefined
        ? { crashMessage: script.crashMessage }
        : {}),
    };
    this.result = script.result ?? { status: 'succeeded', exitCode: 0 };

    const baseRecord: AdapterRecord = {
      id: 'fake-adapter',
      class: 'local_tool',
      name: 'Fake Adapter',
      version: '1.0.0',
      capabilities: [DEFAULT_CAPABILITY],
      available: true,
      config: {},
    };
    this.record = { ...baseRecord, ...options.record };
  }

  private crashIf(point: FakeCrashPoint): void {
    if (this.script.crashAt === point) {
      throw new Error(
        this.script.crashMessage ?? `FakeAdapter injected crash at "${point}"`,
      );
    }
  }

  async probeLiveness(session: AgentSession): Promise<boolean> {
    this.calls.livenessProbes.push(session);
    const next = this.script.liveness[this.livenessCursor];
    if (next !== undefined) {
      this.livenessCursor += 1;
      return next;
    }
    return this.script.livenessDefault;
  }

  async start(input: unknown): Promise<AdapterSessionHandle> {
    this.crashIf('start');
    this.calls.started.push(input);
    this.sessionCounter += 1;
    globalSessionCounter += 1;
    // Globally unique so a relaunched adapter sharing this id never collides on
    // the agent_sessions primary key with a session from a prior launch.
    const sessionId = `${this.record.id}-session-${globalSessionCounter}`;
    return {
      sessionId,
      adapterId: this.record.id,
      externalRef: `fake-pid-${globalSessionCounter}`,
      resumable: this.script.resumable,
    };
  }

  async *stream(
    handle: AdapterSessionHandle,
  ): AsyncIterable<AdapterStreamEvent> {
    this.crashIf('stream');
    void handle;
    let sequence = 0;
    for (const event of this.script.events) {
      sequence += 1;
      if (this.script.streamDelayMs > 0) {
        await new Promise((r) => setTimeout(r, this.script.streamDelayMs));
      }
      this.calls.streamed += 1;
      yield {
        kind: event.kind,
        sequence,
        data: event.data,
        at: event.at ?? new Date(sequence).toISOString(),
      };
    }
  }

  async await(handle: AdapterSessionHandle): Promise<AdapterResult> {
    this.crashIf('await');
    void handle;
    this.calls.awaited += 1;
    return this.result;
  }

  async cancel(handle: AdapterSessionHandle): Promise<void> {
    this.crashIf('cancel');
    this.calls.cancelled.push(handle);
  }

  async resume(session: AgentSession): Promise<AdapterSessionHandle> {
    this.crashIf('resume');
    this.calls.resumed.push(session);
    this.sessionCounter += 1;
    return {
      sessionId: `${this.record.id}-resume-${this.sessionCounter}`,
      adapterId: this.record.id,
      ...(session.externalRef !== undefined
        ? { externalRef: session.externalRef }
        : {}),
      resumable: this.script.resumable,
    };
  }
}

/** Convenience constructor for the common case. */
export function makeFakeAdapter(options?: FakeAdapterOptions): FakeAdapter {
  return new FakeAdapter(options);
}
