import type {
  McpDiscoveryEntry,
  McpHealthProbeResult,
  McpServer,
  McpTransport,
} from '@shared/mcp';

// A scripted MCP transport for McpRegistry tests. It is the only seam that
// stands in for a real external MCP server, so discovery payloads, health
// probe outcomes, and invocation behavior (resolve, reject, hang, or honor an
// abort signal) are all driven deterministically without any real server or
// network. Nothing here touches the DB, the audit log, or the clock — the
// registry owns all of that.

export interface FakeMcpTransportOptions {
  /** Entries returned by discover(). Defaults to none. */
  discovered?: McpDiscoveryEntry[];
  /** When set, discover() never resolves (exercises the discovery timeout). */
  hangDiscovery?: boolean;
  /** When set, discover() rejects with this message. */
  failDiscovery?: string;
  /** Per-server health probe outcome, keyed by server id. Default healthy. */
  health?: Record<string, McpHealthProbeResult>;
  /** Server ids whose probeHealth() throws (recorded as unhealthy). */
  throwHealthFor?: string[];
}

export class FakeMcpTransport implements McpTransport {
  private readonly options: FakeMcpTransportOptions;

  discoverCalls = 0;
  probeCalls: string[] = [];
  invokeCalls: Array<{ serverId: string; capabilityId: string; args: unknown }> = [];

  /**
   * Controls how the NEXT invoke() behaves. `resolve` returns `output`;
   * `reject` throws `message`; `hang` never settles until its abort signal
   * fires (then it rejects), exercising the registry timeout/cancellation.
   */
  invokeBehavior:
    | { mode: 'resolve'; output: unknown }
    | { mode: 'reject'; message: string }
    | { mode: 'hang' } = { mode: 'resolve', output: null };

  constructor(options: FakeMcpTransportOptions = {}) {
    this.options = options;
  }

  async discover(): Promise<McpDiscoveryEntry[]> {
    this.discoverCalls += 1;
    if (this.options.hangDiscovery === true) {
      return new Promise<McpDiscoveryEntry[]>(() => {
        /* never resolves */
      });
    }
    if (this.options.failDiscovery !== undefined) {
      throw new Error(this.options.failDiscovery);
    }
    return this.options.discovered ?? [];
  }

  async probeHealth(server: McpServer): Promise<McpHealthProbeResult> {
    this.probeCalls.push(server.id);
    if (this.options.throwHealthFor?.includes(server.id) === true) {
      throw new Error(`probe failed for ${server.id}`);
    }
    return this.options.health?.[server.id] ?? { healthy: true };
  }

  async invoke(
    server: McpServer,
    capabilityId: string,
    args: unknown,
    signal: AbortSignal,
  ): Promise<unknown> {
    this.invokeCalls.push({ serverId: server.id, capabilityId, args });
    const behavior = this.invokeBehavior;
    if (behavior.mode === 'resolve') {
      return behavior.output;
    }
    if (behavior.mode === 'reject') {
      throw new Error(behavior.message);
    }
    // hang — settle only when the registry aborts the signal.
    return new Promise<unknown>((_resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        { once: true },
      );
    });
  }
}
