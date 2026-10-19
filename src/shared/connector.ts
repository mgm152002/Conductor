// The connector framework contract and the data-model shapes that surround it
// (Requirement 14). A Connector is the pluggability seam for ingesting an
// external source (email, messaging, local Mac context, ...). Every connector
// implements one common lifecycle — authorize, retrieve, incremental sync,
// change detection, health reporting, revocation — so the Ingestion Worker can
// drive any source uniformly, exactly the way the AgentAdapter contract keeps
// the orchestrator agent-agnostic.
//
// These are the durable contracts shared across main, preload, and renderer.
// The runtime Zod validation for IPC payloads referencing these lives in
// `ipc-contract.ts` (added when the connector IPC surface lands); these are the
// TypeScript shapes the schemas produce and the UI consumes.
//
// INVARIANT: everything a connector *retrieves* is untrusted data. The
// Ingestion Worker wraps every ingested payload on the data channel
// (Requirement 11) before it is persisted or handed to anything else — ingested
// content is never concatenated into the trusted-instruction channel.

import type { UntrustedSource } from './domain';

/** The category of an external source a connector ingests. */
export type ConnectorKind =
  | 'email'
  | 'messaging'
  | 'calendar'
  | 'files'
  | 'local_mac_context';

/**
 * A connector's authorization state. `revoked` is terminal for syncing: once a
 * user revokes authorization the framework stops further sync but retains
 * already-ingested items unless deletion is also requested (Requirement 14.5).
 */
export type ConnectorAuthState = 'unauthorized' | 'authorized' | 'revoked';

/**
 * Health as reported by the lifecycle. `unknown` before the first sync;
 * `healthy` after a successful sync; `unhealthy` once a sync exhausts its
 * retries (Requirement 14.4).
 */
export type ConnectorHealth = 'unknown' | 'healthy' | 'unhealthy';

/** How a synchronization was triggered (Requirement 14.2). */
export type SyncTrigger = 'event' | 'scheduled';

/** A registered connector instance and its durable lifecycle state. */
export interface Connector {
  id: string;
  kind: ConnectorKind;
  /** Human-readable label, e.g. "Work Gmail". */
  name: string;
  authState: ConnectorAuthState;
  health: ConnectorHealth;
  /** Opaque cursor the connector uses for incremental sync / change detection. */
  syncCursor?: string;
  /** Max sync retries before the connector is marked unhealthy (Req 14.4). */
  maxRetries: number;
  /** Count of consecutive failures since the last success. */
  consecutiveFailures: number;
  lastSyncedAt?: string;
  lastError?: string;
  /** Per-connector source configuration (e.g. the folder a files connector indexes). */
  config: ConnectorConfig;
  createdAt: string;
  updatedAt: string;
}

/**
 * Source configuration for one connector instance. Only the fields relevant to
 * the connector's kind are set. `workspaceId` binds ingested content to a
 * project so task context retrieval can draw on it.
 */
export interface ConnectorConfig {
  /** Absolute folder path a `files` connector indexes. */
  rootPath?: string;
  /** Project (workspace) whose tasks may retrieve this connector's content. */
  workspaceId?: string;
  /** IMAP mailbox (kind `email`). The password lives in the Keychain. */
  email?: { host: string; port: number; secure: boolean; user: string; mailbox: string; secretId: string };
  /** iCalendar feed (kind `calendar`). The feed URL is a secret in the Keychain. */
  calendar?: { label: string; secretId: string };
  /** Slack workspace (kind `messaging`). The token lives in the Keychain. */
  messaging?: { provider: 'slack'; secretId: string; team?: string; channels?: string[] };
}

/** A connector as surfaced to the renderer, with live runtime state. */
export interface ConnectorView extends Connector {
  /** Number of ingested items currently recorded for the connector. */
  itemCount: number;
  /** True while a sync is in flight. */
  syncing: boolean;
  /** False when no lifecycle implementation is registered for the kind. */
  supported: boolean;
}

/** Ingested-item metadata as surfaced to the renderer. */
export interface IngestedItemView {
  id: string;
  externalId?: string;
  origin?: string;
  sourceTimestamp: string;
  ingestedAt: string;
  memoryId?: string;
}

/**
 * A single item ingested from a source. The item's raw content is NEVER stored
 * inline here as trusted text: it is held on the data channel and persisted as
 * untrusted data. This record carries only the metadata the design requires per
 * item — source, timestamp, permissions, provenance (Requirement 14.3).
 */
export interface IngestedItem {
  id: string;
  connectorId: string;
  /** The untrusted-source category this content is carried under (Req 11.1). */
  source: UntrustedSource;
  /** Stable id assigned to the untrusted-data wrapper, for provenance linking. */
  dataId: string;
  /** External id in the source system (message id, file path, ...), if any. */
  externalId?: string;
  /** When the item was observed/created in the source. */
  sourceTimestamp: string;
  /** Content hash used for change detection and dedup. */
  contentHash: string;
  /** The permissions that governed access to this item, recorded as provenance. */
  permissions: string[];
  /** Where this came from: connector id + kind + optional origin label. */
  provenance: IngestedItemProvenance;
  ingestedAt: string;
  /** The searchable memory the content was persisted into, if any. */
  memoryId?: string;
}

export interface IngestedItemProvenance {
  connectorId: string;
  connectorKind: ConnectorKind;
  method: 'ingested';
  origin?: string;
}

/** The kind of automation the Ingestion Worker proposes for user review. */
export type AutomationProposalKind = 'auto_workflow' | 'scheduled_job';

/**
 * A candidate automation surfaced from relevant ingested context
 * (Requirement 14.6). It is inert: a proposal performs nothing on its own and
 * exists only for the user to review, accept, or dismiss.
 */
export type AutomationProposalStatus = 'proposed' | 'accepted' | 'dismissed';

export interface AutomationProposal {
  id: string;
  connectorId: string;
  kind: AutomationProposalKind;
  /** Human-readable title, e.g. "Summarize new invoices daily". */
  title: string;
  /** Why this was proposed — the triggering ingested context. */
  rationale: string;
  /** Ids of the ingested items that motivated the proposal. */
  sourceItemIds: string[];
  status: AutomationProposalStatus;
  createdAt: string;
}

/**
 * One item as a connector yields it from `retrieve`. The framework turns this
 * into an {@link IngestedItem} (assigning ids, wrapping the content as
 * untrusted data, computing the content hash) — the connector itself never
 * touches the data channel or the database.
 */
export interface RetrievedItem {
  /** External id in the source system, if the source provides one. */
  externalId?: string;
  /** Raw content as pulled from the source. Treated as untrusted data. */
  content: string;
  sourceTimestamp: string;
  permissions: string[];
  /** Optional free-form origin label (URL, filename, message id). */
  origin?: string;
}

/** The outcome of a connector's `retrieve`, including the next sync cursor. */
export interface RetrieveResult {
  items: RetrievedItem[];
  /** Cursor to persist for the next incremental sync (change detection). */
  nextCursor?: string;
}

/**
 * The common connector lifecycle every source implements (Requirement 14.1).
 * The Ingestion Worker is the only caller; a connector performs no persistence,
 * no data-channel wrapping, and no scheduling of its own.
 */
export interface ConnectorLifecycle {
  readonly kind: ConnectorKind;

  /**
   * Establish authorization with the source. Rejects if it cannot authorize.
   * `connector` carries the instance configuration (e.g. a folder path).
   */
  authorize(connector?: Connector): Promise<void>;

  /**
   * Retrieve items changed since `cursor` (incremental sync + change
   * detection). A connector returns only new/changed items and the next cursor.
   */
  retrieve(cursor: string | undefined, connector?: Connector): Promise<RetrieveResult>;

  /** Release source-side resources on revocation. Ingested items are retained. */
  revoke(connector?: Connector): Promise<void>;
}
