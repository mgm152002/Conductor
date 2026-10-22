import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type {
  AutomationProposal,
  Connector,
  ConnectorConfig,
  ConnectorKind,
  IngestedItem,
  IngestedItemProvenance,
} from '@shared/connector';

// The ConnectorService owns the durable connector lifecycle state and the
// repositories for ingested items and automation proposals (Requirement 14).
// It is the persistence + state-transition authority; the IngestionWorker (in
// `ingestion-worker.ts`) drives a connector's lifecycle through it and wraps
// retrieved content on the data channel. Keeping persistence here, exactly like
// WorkspaceService / PermissionService, means every connector state change goes
// through one audited, transactional seam.
//
// A connector is never deleted on revocation: it stays in the table with
// authState='revoked' so already-ingested items are retained unless the user
// explicitly asks for their deletion (Requirement 14.5).

export class ConnectorValidationError extends Error {
  constructor(
    readonly field: 'name' | 'kind' | 'maxRetries',
    message: string,
  ) {
    super(message);
    this.name = 'ConnectorValidationError';
  }
}

export class ConnectorNotFoundError extends Error {
  constructor(readonly id: string) {
    super(`Connector ${id} not found`);
    this.name = 'ConnectorNotFoundError';
  }
}

interface ConnectorRow {
  id: string;
  kind: ConnectorKind;
  name: string;
  auth_state: Connector['authState'];
  health: Connector['health'];
  sync_cursor: string | null;
  max_retries: number;
  consecutive_failures: number;
  last_synced_at: string | null;
  last_error: string | null;
  config: string | null;
  created_at: string;
  updated_at: string;
}

function parseConfig(raw: string | null): ConnectorConfig {
  if (raw === null || raw === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    const nested = (key: string): Record<string, unknown> | undefined => {
      const child = value[key];
      return child !== null && typeof child === 'object' && !Array.isArray(child) ? child as Record<string, unknown> : undefined;
    };
    const email = nested('email');
    const calendar = nested('calendar');
    const messaging = nested('messaging');
    return {
      ...(typeof value['rootPath'] === 'string' ? { rootPath: value['rootPath'] } : {}),
      ...(typeof value['workspaceId'] === 'string' ? { workspaceId: value['workspaceId'] } : {}),
      ...(email && typeof email['host'] === 'string' && typeof email['user'] === 'string' && typeof email['secretId'] === 'string'
        ? { email: { host: email['host'], port: typeof email['port'] === 'number' ? email['port'] : 993, secure: email['secure'] !== false,
            user: email['user'], mailbox: typeof email['mailbox'] === 'string' ? email['mailbox'] : 'INBOX', secretId: email['secretId'] } }
        : {}),
      ...(calendar && typeof calendar['secretId'] === 'string'
        ? { calendar: { label: typeof calendar['label'] === 'string' ? calendar['label'] : 'Calendar', secretId: calendar['secretId'] } }
        : {}),
      ...(messaging && messaging['provider'] === 'slack' && typeof messaging['secretId'] === 'string'
        ? { messaging: { provider: 'slack' as const, secretId: messaging['secretId'],
            ...(typeof messaging['team'] === 'string' ? { team: messaging['team'] } : {}),
            ...(Array.isArray(messaging['channels']) ? { channels: messaging['channels'].filter((c): c is string => typeof c === 'string') } : {}) } }
        : {}),
    };
  } catch {
    return {};
  }
}

function rowToConnector(row: ConnectorRow): Connector {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    authState: row.auth_state,
    health: row.health,
    ...(row.sync_cursor !== null ? { syncCursor: row.sync_cursor } : {}),
    maxRetries: row.max_retries,
    consecutiveFailures: row.consecutive_failures,
    ...(row.last_synced_at !== null ? { lastSyncedAt: row.last_synced_at } : {}),
    ...(row.last_error !== null ? { lastError: row.last_error } : {}),
    config: parseConfig(row.config),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

interface IngestedItemRow {
  id: string;
  connector_id: string;
  source: IngestedItem['source'];
  data_id: string;
  external_id: string | null;
  source_timestamp: string;
  content_hash: string;
  permissions: string;
  provenance: string;
  ingested_at: string;
  memory_id?: string | null;
}

function rowToIngestedItem(row: IngestedItemRow): IngestedItem {
  return {
    id: row.id,
    connectorId: row.connector_id,
    source: row.source,
    dataId: row.data_id,
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    sourceTimestamp: row.source_timestamp,
    contentHash: row.content_hash,
    permissions: JSON.parse(row.permissions) as string[],
    provenance: JSON.parse(row.provenance) as IngestedItemProvenance,
    ingestedAt: row.ingested_at,
    ...(row.memory_id !== undefined && row.memory_id !== null ? { memoryId: row.memory_id } : {}),
  };
}

interface ProposalRow {
  id: string;
  connector_id: string;
  kind: AutomationProposal['kind'];
  title: string;
  rationale: string;
  source_item_ids: string;
  status: AutomationProposal['status'];
  created_at: string;
}

function rowToProposal(row: ProposalRow): AutomationProposal {
  return {
    id: row.id,
    connectorId: row.connector_id,
    kind: row.kind,
    title: row.title,
    rationale: row.rationale,
    sourceItemIds: JSON.parse(row.source_item_ids) as string[],
    status: row.status,
    createdAt: row.created_at,
  };
}

const VALID_KINDS: ReadonlySet<ConnectorKind> = new Set([
  'email',
  'messaging',
  'calendar',
  'files',
  'local_mac_context',
]);

export interface RegisterConnectorInput {
  kind: ConnectorKind;
  name: string;
  /** Max sync retries before the connector is marked unhealthy (default 3). */
  maxRetries?: number;
  /** Per-instance source configuration. */
  config?: ConnectorConfig;
}

/** The metadata the worker records per ingested item (Requirement 14.3). */
export interface RecordIngestedItemInput {
  connectorId: string;
  source: IngestedItem['source'];
  dataId: string;
  externalId?: string;
  sourceTimestamp: string;
  contentHash: string;
  permissions: string[];
  provenance: IngestedItemProvenance;
}

export class ConnectorService {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
  ) {}

  /**
   * Register a connector in the unauthorized/unknown state. Validates the name
   * (1–255 chars), the kind, and the retry count, persisting nothing on
   * failure.
   */
  register(input: RegisterConnectorInput): Connector {
    const name = input.name.trim();
    if (name.length < 1 || name.length > 255) {
      throw new ConnectorValidationError(
        'name',
        'Connector name must be between 1 and 255 characters',
      );
    }
    if (!VALID_KINDS.has(input.kind)) {
      throw new ConnectorValidationError(
        'kind',
        `Unknown connector kind: ${String(input.kind)}`,
      );
    }
    const maxRetries = input.maxRetries ?? 3;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new ConnectorValidationError(
        'maxRetries',
        'maxRetries must be a non-negative integer',
      );
    }

    const now = new Date().toISOString();
    const connector: Connector = {
      id: randomUUID(),
      kind: input.kind,
      name,
      authState: 'unauthorized',
      health: 'unknown',
      maxRetries,
      consecutiveFailures: 0,
      config: { ...(input.config ?? {}) },
      createdAt: now,
      updatedAt: now,
    };

    this.store.transaction((tx) => {
      tx.db
        .prepare(
          `INSERT INTO connectors
             (id, kind, name, auth_state, health, max_retries,
              consecutive_failures, config, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          connector.id,
          connector.kind,
          connector.name,
          connector.authState,
          connector.health,
          connector.maxRetries,
          connector.consecutiveFailures,
          JSON.stringify(connector.config),
          connector.createdAt,
          connector.updatedAt,
        );
    });

    this.audit.append({
      actor: 'user',
      action: 'connector.registered',
      target: connector.id,
      redactedPayload: { kind: connector.kind, name: connector.name },
    });

    return connector;
  }

  get(id: string): Connector | undefined {
    const row = this.store.db
      .prepare(`SELECT * FROM connectors WHERE id = ?`)
      .get(id) as ConnectorRow | undefined;
    return row === undefined ? undefined : rowToConnector(row);
  }

  getOrThrow(id: string): Connector {
    const connector = this.get(id);
    if (connector === undefined) {
      throw new ConnectorNotFoundError(id);
    }
    return connector;
  }

  /** All connectors ordered by creation ascending. */
  list(): Connector[] {
    const rows = this.store.db
      .prepare(`SELECT * FROM connectors ORDER BY created_at ASC, rowid ASC`)
      .all() as ConnectorRow[];
    return rows.map(rowToConnector);
  }

  /** Mark a connector authorized (Requirement 14.1 — authorize). */
  markAuthorized(id: string): Connector {
    this.getOrThrow(id);
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `UPDATE connectors SET auth_state = 'authorized', updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
    this.audit.append({
      actor: 'user',
      action: 'connector.authorized',
      target: id,
    });
    return this.getOrThrow(id);
  }

  /**
   * Record a successful sync: advance the cursor, mark healthy, reset the
   * consecutive-failure count, and stamp lastSyncedAt. Clears any prior error.
   */
  recordSyncSuccess(id: string, nextCursor: string | undefined): Connector {
    this.getOrThrow(id);
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `UPDATE connectors
         SET health = 'healthy',
             consecutive_failures = 0,
             sync_cursor = ?,
             last_synced_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(nextCursor ?? null, now, now, id);
    return this.getOrThrow(id);
  }

  /**
   * Record a failed sync attempt. Increments the consecutive-failure counter;
   * once it reaches maxRetries the connector is marked unhealthy and the
   * failure is audited (Requirement 14.4). Returns the updated connector so the
   * worker can decide whether retries remain.
   */
  recordSyncFailure(id: string, error: string): Connector {
    const current = this.getOrThrow(id);
    const failures = current.consecutiveFailures + 1;
    const exhausted = failures >= current.maxRetries;
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `UPDATE connectors
         SET consecutive_failures = ?,
             health = CASE WHEN ? THEN 'unhealthy' ELSE health END,
             last_error = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(failures, exhausted ? 1 : 0, error, now, id);

    if (exhausted) {
      this.audit.append({
        actor: 'orchestrator',
        action: 'connector.unhealthy',
        target: id,
        redactedPayload: { consecutiveFailures: failures, error },
      });
    }
    return this.getOrThrow(id);
  }

  /**
   * Revoke a connector's authorization. Stops further sync by moving to the
   * terminal 'revoked' auth state; already-ingested items are RETAINED
   * (Requirement 14.5). Deleting those items is a separate, explicit request.
   */
  revoke(id: string): Connector {
    this.getOrThrow(id);
    const now = new Date().toISOString();
    this.store.db
      .prepare(
        `UPDATE connectors SET auth_state = 'revoked', updated_at = ?
         WHERE id = ?`,
      )
      .run(now, id);
    this.audit.append({
      actor: 'user',
      action: 'connector.revoked',
      target: id,
      redactedPayload: { itemsRetained: true },
    });
    return this.getOrThrow(id);
  }

  /**
   * Delete all ingested items for a connector — only when the user explicitly
   * requests it in addition to revoking (Requirement 14.5). Returns the count
   * removed.
   */
  deleteIngestedItems(id: string): number {
    this.getOrThrow(id);
    // Content lives in memories linked to the items; remove both together so
    // a deletion request leaves no searchable copy behind.
    const removed = this.store.transaction((tx) => {
      tx.db
        .prepare(
          `DELETE FROM memories WHERE (scope_level='source' AND scope_ref_id=?) OR (method = 'ingested' AND (
             id IN (SELECT memory_id FROM ingested_items WHERE connector_id = ? AND memory_id IS NOT NULL)
             OR source_id IN (SELECT id FROM ingested_items WHERE connector_id = ?)
           ))`,
        )
        .run(id, id, id);
      return tx.db
        .prepare(`DELETE FROM ingested_items WHERE connector_id = ?`)
        .run(id).changes;
    });
    this.audit.append({
      actor: 'user',
      action: 'connector.items_deleted',
      target: id,
      redactedPayload: { removed },
    });
    return removed;
  }

  /**
   * Persist an ingested item's metadata. Idempotent on (connectorId,
   * contentHash): a re-ingested, unchanged item is a no-op and returns the
   * existing row, so change detection never produces duplicates
   * (Requirement 14.3). The raw content itself is NOT stored here — it lives on
   * the data channel keyed by `dataId`.
   */
  recordIngestedItem(input: RecordIngestedItemInput): {
    item: IngestedItem;
    inserted: boolean;
  } {
    const existing = this.store.db
      .prepare(
        `SELECT * FROM ingested_items
         WHERE connector_id = ? AND content_hash = ?`,
      )
      .get(input.connectorId, input.contentHash) as
      | IngestedItemRow
      | undefined;
    if (existing !== undefined) {
      return { item: rowToIngestedItem(existing), inserted: false };
    }

    const item: IngestedItem = {
      id: randomUUID(),
      connectorId: input.connectorId,
      source: input.source,
      dataId: input.dataId,
      ...(input.externalId !== undefined
        ? { externalId: input.externalId }
        : {}),
      sourceTimestamp: input.sourceTimestamp,
      contentHash: input.contentHash,
      permissions: input.permissions,
      provenance: input.provenance,
      ingestedAt: new Date().toISOString(),
    };

    this.store.db
      .prepare(
        `INSERT INTO ingested_items
           (id, connector_id, source, data_id, external_id, source_timestamp,
            content_hash, permissions, provenance, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        item.id,
        item.connectorId,
        item.source,
        item.dataId,
        item.externalId ?? null,
        item.sourceTimestamp,
        item.contentHash,
        JSON.stringify(item.permissions),
        JSON.stringify(item.provenance),
        item.ingestedAt,
      );

    return { item, inserted: true };
  }

  /** Ingested items for a connector, newest first. */
  listIngestedItems(connectorId: string): IngestedItem[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM ingested_items WHERE connector_id = ?
         ORDER BY ingested_at DESC, rowid DESC`,
      )
      .all(connectorId) as IngestedItemRow[];
    return rows.map(rowToIngestedItem);
  }

  /**
   * Record a candidate automation proposal for user review (Requirement 14.6).
   * The proposal is inert — recording it performs nothing on its own.
   */
  proposeAutomation(input: {
    connectorId: string;
    kind: AutomationProposal['kind'];
    title: string;
    rationale: string;
    sourceItemIds: string[];
  }): AutomationProposal {
    this.getOrThrow(input.connectorId);
    const proposal: AutomationProposal = {
      id: randomUUID(),
      connectorId: input.connectorId,
      kind: input.kind,
      title: input.title,
      rationale: input.rationale,
      sourceItemIds: input.sourceItemIds,
      status: 'proposed',
      createdAt: new Date().toISOString(),
    };
    this.store.db
      .prepare(
        `INSERT INTO automation_proposals
           (id, connector_id, kind, title, rationale, source_item_ids, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        proposal.id,
        proposal.connectorId,
        proposal.kind,
        proposal.title,
        proposal.rationale,
        JSON.stringify(proposal.sourceItemIds),
        proposal.status,
        proposal.createdAt,
      );
    this.audit.append({
      actor: 'orchestrator',
      action: 'connector.automation_proposed',
      target: proposal.id,
      redactedPayload: { connectorId: input.connectorId, kind: input.kind },
    });
    return proposal;
  }

  /** True when an item with this content hash was already ingested. */
  itemByContentHash(connectorId: string, contentHash: string): IngestedItem | undefined {
    const row = this.store.db.prepare('SELECT * FROM ingested_items WHERE connector_id=? AND content_hash=?').get(connectorId, contentHash) as IngestedItemRow | undefined;
    return row === undefined ? undefined : rowToIngestedItem(row);
  }

  hasContentHash(connectorId: string, contentHash: string): boolean {
    return (
      this.store.db
        .prepare(
          `SELECT 1 FROM ingested_items WHERE connector_id = ? AND content_hash = ?`,
        )
        .get(connectorId, contentHash) !== undefined
    );
  }

  /** The most recently ingested item for a source-side id, if any. */
  latestByExternalId(connectorId: string, externalId: string): IngestedItem | undefined {
    const row = this.store.db
      .prepare(
        `SELECT * FROM ingested_items WHERE connector_id = ? AND external_id = ?
         ORDER BY ingested_at DESC, rowid DESC LIMIT 1`,
      )
      .get(connectorId, externalId) as IngestedItemRow | undefined;
    return row === undefined ? undefined : rowToIngestedItem(row);
  }

  /** Link an ingested item to the memory holding its content. */
  attachMemory(itemId: string, memoryId: string): void {
    this.store.db
      .prepare(`UPDATE ingested_items SET memory_id = ? WHERE id = ?`)
      .run(memoryId, itemId);
  }

  /** Number of ingested items recorded for a connector. */
  itemCount(connectorId: string): number {
    const row = this.store.db
      .prepare(`SELECT COUNT(*) AS n FROM ingested_items WHERE connector_id = ?`)
      .get(connectorId) as { n: number };
    return row.n;
  }

  /**
   * Clear the incremental-sync cursor so the next sync re-reads the whole
   * source. Content-hash dedup keeps unchanged items from being re-ingested.
   */
  resetCursor(id: string): Connector {
    this.getOrThrow(id);
    this.store.db
      .prepare(`UPDATE connectors SET sync_cursor = NULL, updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
    return this.getOrThrow(id);
  }

  /**
   * Re-authorize a previously revoked connector (explicit user action). The
   * caller must have driven the lifecycle's authorize first.
   */
  reauthorize(id: string): Connector {
    return this.markAuthorized(id);
  }

  /** Merge new fields into a connector's configuration. */
  updateConfig(id: string, patch: Partial<ConnectorConfig>): Connector {
    const current = this.getOrThrow(id);
    this.store.db.prepare('UPDATE connectors SET config = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify({ ...current.config, ...patch }), new Date().toISOString(), id);
    return this.getOrThrow(id);
  }

  /**
   * Permanently remove a connector, its ingested items and the memories that
   * hold their content. Explicit user action; audited with the removed counts.
   */
  delete(id: string): { removedItems: number; removedMemories: number } {
    this.getOrThrow(id);
    const result = this.store.transaction((tx) => {
      const memories = tx.db
        .prepare(
          `DELETE FROM memories WHERE (scope_level='source' AND scope_ref_id=?) OR (method = 'ingested' AND (
             id IN (SELECT memory_id FROM ingested_items WHERE connector_id = ? AND memory_id IS NOT NULL)
             OR source_id IN (SELECT id FROM ingested_items WHERE connector_id = ?)
           ))`,
        )
        .run(id, id, id).changes;
      const items = tx.db
        .prepare(`DELETE FROM ingested_items WHERE connector_id = ?`)
        .run(id).changes;
      tx.db.prepare(`DELETE FROM connectors WHERE id = ?`).run(id);
      return { removedItems: items, removedMemories: memories };
    });
    this.audit.append({
      actor: 'user',
      action: 'connector.deleted',
      target: id,
      redactedPayload: result,
    });
    return result;
  }

  /** Record the user's decision on an inert automation proposal. */
  setProposalStatus(
    proposalId: string,
    status: Exclude<AutomationProposal['status'], 'proposed'>,
  ): void {
    const changes = this.store.db
      .prepare(`UPDATE automation_proposals SET status = ? WHERE id = ? AND status = 'proposed'`)
      .run(status, proposalId).changes;
    if (changes === 0) throw new Error(`Proposal ${proposalId} is not awaiting review`);
    this.audit.append({
      actor: 'user',
      action: `connector.automation_${status}`,
      target: proposalId,
    });
  }

  /** Proposals for a connector, newest first. */
  listProposals(connectorId: string): AutomationProposal[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM automation_proposals WHERE connector_id = ?
         ORDER BY created_at DESC, rowid DESC`,
      )
      .all(connectorId) as ProposalRow[];
    return rows.map(rowToProposal);
  }
}
