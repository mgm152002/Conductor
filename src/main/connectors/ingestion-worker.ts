import { createHash } from 'node:crypto';
import type { AuditLog } from '../domain/audit-log';
import {
  ingestUntrusted,
  wrapUntrusted,
  type UntrustedData,
} from '../orchestrator/data-channel';
import type { ConnectorService } from './connector-service';
import type {
  Connector,
  ConnectorKind,
  ConnectorLifecycle,
  IngestedItem,
  RetrievedItem,
  SyncTrigger,
} from '@shared/connector';
import type { UntrustedSource } from '@shared/domain';

// The Ingestion Worker drives a registered connector through the common
// lifecycle and is the ONLY place a connector's retrieved content crosses into
// Conductor (Requirement 14). It:
//
//  * runs both event-driven and scheduled synchronization (Requirement 14.2);
//  * performs incremental sync + change detection via the connector's cursor
//    and a per-item content hash (Requirement 14.1);
//  * records per-item source/timestamp/permissions/provenance through the
//    ConnectorService (Requirement 14.3);
//  * wraps every retrieved payload as UNTRUSTED DATA on the data channel before
//    it is persisted or seen by anything else, scanning for injection attempts
//    and recording any as ignored — ingested content never reaches the
//    trusted-instruction channel (Requirement 11; Property 8);
//  * retries a failing sync up to the connector's configured maximum and marks
//    the connector unhealthy on exhaustion (Requirement 14.4); and
//  * proposes candidate auto-workflows / scheduled jobs from relevant ingested
//    context for user review, never auto-executing them (Requirement 14.6).
//
// A connector lifecycle is injected by kind, mirroring how the registry holds
// adapters: the worker stays source-agnostic and tests supply fakes.

/** Maps a connector kind to the untrusted-source label its content rides on. */
function sourceForKind(kind: ConnectorKind): UntrustedSource {
  switch (kind) {
    case 'email':
      return 'email';
    case 'files':
    case 'local_mac_context':
      return 'file';
    case 'messaging':
    case 'calendar':
      // No dedicated untrusted-source category; carried as generic tool output.
      return 'tool_output';
  }
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * A detector that turns a connector's freshly ingested items into candidate
 * automation proposals (Requirement 14.6). It is inert: it only describes
 * candidates; the worker records them as `proposed` for the user to review.
 * Injected so the heuristic (or a future learning signal) stays out of the
 * worker's core loop and is testable in isolation.
 */
export type AutomationProposer = (args: {
  connector: Connector;
  newItems: IngestedItem[];
}) => Array<{
  kind: 'auto_workflow' | 'scheduled_job';
  title: string;
  rationale: string;
  sourceItemIds: string[];
}>;

export interface SyncOutcome {
  connectorId: string;
  trigger: SyncTrigger;
  /** True if the sync (eventually) succeeded within the retry budget. */
  succeeded: boolean;
  /** Items newly ingested this sync (deduped against prior content hashes). */
  ingested: IngestedItem[];
  /** Untrusted-data wrappers for the newly ingested items, for the caller. */
  data: UntrustedData[];
  /** Attempts consumed (1 on first-try success). */
  attempts: number;
  /** Final connector state after the sync. */
  connector: Connector;
  error?: string;
}

/**
 * Durable destination for newly ingested content. The worker hands each NEW
 * item (after dedup and injection scanning) to the sink, which persists the
 * untrusted content somewhere searchable and returns the id of what it wrote
 * (e.g. a memory id) so the metadata row can link to it. `previous` is the
 * last item ingested for the same source-side id, letting the sink supersede
 * stale content rather than duplicate it.
 */
export type IngestionSink = (args: {
  connector: Connector;
  item: IngestedItem;
  data: UntrustedData;
  previous?: IngestedItem;
}) => string | undefined | Promise<string | undefined>;

export interface IngestionWorkerOptions {
  connectors: ConnectorService;
  audit: AuditLog;
  /** Lifecycle implementations keyed by connector kind. */
  lifecycles: Partial<Record<ConnectorKind, ConnectorLifecycle>>;
  /** Optional proposer for candidate automations (Req 14.6). */
  proposer?: AutomationProposer;
  /** Optional durable sink for ingested content (see {@link IngestionSink}). */
  sink?: IngestionSink;
  /** Base delay between failed retrieve attempts; doubles each retry. Default 0. */
  retryDelayMs?: number;
  /** Sleep seam for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class IngestionWorker {
  private readonly connectors: ConnectorService;
  private readonly audit: AuditLog;
  private readonly lifecycles: Partial<
    Record<ConnectorKind, ConnectorLifecycle>
  >;
  private readonly proposer?: AutomationProposer;
  private readonly sink?: IngestionSink;
  private readonly retryDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: IngestionWorkerOptions) {
    this.connectors = options.connectors;
    this.audit = options.audit;
    this.lifecycles = options.lifecycles;
    if (options.proposer !== undefined) {
      this.proposer = options.proposer;
    }
    if (options.sink !== undefined) {
      this.sink = options.sink;
    }
    this.retryDelayMs = Math.max(0, options.retryDelayMs ?? 0);
    this.sleep =
      options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** Whether a lifecycle implementation exists for a connector kind. */
  supports(kind: ConnectorKind): boolean {
    return this.lifecycles[kind] !== undefined;
  }

  /**
   * Authorize a connector through its lifecycle, then mark it authorized in the
   * store. Rejects if the lifecycle authorize fails, leaving the connector
   * unauthorized.
   */
  async authorize(connectorId: string): Promise<Connector> {
    const connector = this.connectors.getOrThrow(connectorId);
    const lifecycle = this.lifecycleFor(connector.kind);
    await lifecycle.authorize(connector);
    return this.connectors.markAuthorized(connectorId);
  }

  /**
   * Run one synchronization of a connector, event-driven or scheduled
   * (Requirement 14.2). Retries a failing retrieve up to the connector's
   * configured maximum, marking it unhealthy on exhaustion (Requirement 14.4).
   * Refuses to sync a connector that is not authorized or has been revoked
   * (Requirement 14.5).
   */
  async sync(connectorId: string, trigger: SyncTrigger): Promise<SyncOutcome> {
    let connector = this.connectors.getOrThrow(connectorId);

    if (connector.authState !== 'authorized') {
      // Revoked connectors stop syncing (items retained); unauthorized ones
      // cannot sync yet. Either way this is not a retriable failure.
      return {
        connectorId,
        trigger,
        succeeded: false,
        ingested: [],
        data: [],
        attempts: 0,
        connector,
        error: `Connector is not authorized (authState=${connector.authState})`,
      };
    }

    const lifecycle = this.lifecycleFor(connector.kind);
    // The retry budget is maxRetries attempts total (Requirement 14.4).
    const maxAttempts = Math.max(1, connector.maxRetries);
    let attempts = 0;
    let lastError = '';

    while (attempts < maxAttempts) {
      if (attempts > 0 && this.retryDelayMs > 0) {
        await this.sleep(this.retryDelayMs * 2 ** (attempts - 1));
        // The user may have revoked the connector while we waited.
        connector = this.connectors.getOrThrow(connectorId);
        if (connector.authState !== 'authorized') break;
      }
      attempts += 1;
      try {
        const result = await lifecycle.retrieve(connector.syncCursor, connector);
        const { ingested, data } = await this.persistRetrieved(
          connector,
          result.items,
        );
        connector = this.connectors.recordSyncSuccess(
          connectorId,
          result.nextCursor,
        );

        this.audit.append({
          actor: 'orchestrator',
          action: 'connector.sync.succeeded',
          target: connectorId,
          redactedPayload: {
            trigger,
            attempts,
            newItemCount: ingested.length,
          },
        });

        // Candidate automations are recorded as `proposed` for user review as
        // a side effect (Requirement 14.6); nothing is executed here.
        this.proposeAutomations(connector, ingested);

        return {
          connectorId,
          trigger,
          succeeded: true,
          ingested,
          data,
          attempts,
          connector,
        };
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        connector = this.connectors.recordSyncFailure(connectorId, lastError);
      }
    }

    // Retries exhausted — the connector is now marked unhealthy by the service.
    return {
      connectorId,
      trigger,
      succeeded: false,
      ingested: [],
      data: [],
      attempts,
      connector,
      error: lastError,
    };
  }

  /**
   * Revoke a connector: drive its lifecycle revoke, then stop further sync in
   * the store while retaining ingested items (Requirement 14.5).
   */
  async revoke(connectorId: string): Promise<Connector> {
    const connector = this.connectors.getOrThrow(connectorId);
    const lifecycle = this.lifecycleFor(connector.kind);
    await lifecycle.revoke(connector);
    return this.connectors.revoke(connectorId);
  }

  private lifecycleFor(kind: ConnectorKind): ConnectorLifecycle {
    const lifecycle = this.lifecycles[kind];
    if (lifecycle === undefined) {
      throw new Error(`No connector lifecycle registered for kind "${kind}"`);
    }
    return lifecycle;
  }

  /**
   * Wrap each retrieved item as untrusted data, scan it for injection attempts
   * (recorded as ignored), and persist its metadata. Deduped by content hash so
   * change detection never re-ingests an unchanged item (Requirement 14.1/3).
   */
  private async persistRetrieved(
    connector: Connector,
    items: RetrievedItem[],
  ): Promise<{ ingested: IngestedItem[]; data: UntrustedData[] }> {
    const source = sourceForKind(connector.kind);
    const ingested: IngestedItem[] = [];
    const data: UntrustedData[] = [];

    for (const raw of items) {
      const contentHash = hashContent(raw.content);
      // Unchanged content was already scanned and recorded; skip it before
      // scanning so re-syncs do not duplicate injection audit events.
      const existing = this.connectors.itemByContentHash(connector.id, contentHash);
      if (existing !== undefined && (this.sink === undefined || existing.memoryId !== undefined)) {
        continue;
      }
      const previous =
        raw.externalId !== undefined
          ? this.connectors.latestByExternalId(connector.id, raw.externalId)
          : undefined;

      // Everything a connector retrieves is untrusted data. Wrap it on the data
      // channel BEFORE it is persisted or handed anywhere, and scan+record any
      // injection attempt as ignored (Requirement 11; Property 8).
      const wrapped = wrapUntrusted(raw.content, source, raw.origin);
      ingestUntrusted(wrapped, this.audit, `connector:${connector.id}`);

      const { item, inserted } = this.connectors.recordIngestedItem({
        connectorId: connector.id,
        source,
        dataId: wrapped.id,
        ...(raw.externalId !== undefined ? { externalId: raw.externalId } : {}),
        sourceTimestamp: raw.sourceTimestamp,
        contentHash,
        permissions: raw.permissions,
        provenance: {
          connectorId: connector.id,
          connectorKind: connector.kind,
          method: 'ingested',
          ...(raw.origin !== undefined ? { origin: raw.origin } : {}),
        },
      });

      if (inserted || (this.sink !== undefined && item.memoryId === undefined)) {
        let stored = item;
        if (this.sink !== undefined) {
          const memoryId = await this.sink({
            connector,
            item,
            data: wrapped,
            ...(previous !== undefined ? { previous } : {}),
          });
          if (memoryId !== undefined) {
            this.connectors.attachMemory(item.id, memoryId);
            stored = { ...item, memoryId };
          }
        }
        ingested.push(stored);
        data.push(wrapped);
      }
    }

    return { ingested, data };
  }

  /**
   * Surface candidate auto-workflow / scheduled-job proposals from newly
   * ingested context (Requirement 14.6). Proposals are inert and recorded as
   * `proposed` for user review; nothing is executed here.
   */
  private proposeAutomations(
    connector: Connector,
    newItems: IngestedItem[],
  ): ReturnType<ConnectorService['proposeAutomation']>[] {
    if (this.proposer === undefined || newItems.length === 0) {
      return [];
    }
    const candidates = this.proposer({ connector, newItems });
    return candidates.map((candidate) =>
      this.connectors.proposeAutomation({
        connectorId: connector.id,
        kind: candidate.kind,
        title: candidate.title,
        rationale: candidate.rationale,
        sourceItemIds: candidate.sourceItemIds,
      }),
    );
  }
}
