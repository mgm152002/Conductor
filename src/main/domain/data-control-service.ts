import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import {
  DATA_CONTROL_KEYS,
  DEFAULT_DATA_CONTROL_SETTINGS,
  type DataControlSettings,
  type DataDeletionResult,
  type DataDeletionTarget,
  type ExternalFlowConsent,
  type ExternalFlowIndicator,
} from '@shared/domain';
import { NO_VALUE, type SettingsService } from './settings-service';
import type { AuditLog } from './audit-log';
import {
  noopExternalFlowEmitter,
  type ExternalFlowEmitter,
} from '../orchestrator/external-flow-emitter';

// The external-flow transparency & data-control service (Requirement 21,
// cross-cutting). It owns four concerns:
//
//  1. External-flow transparency (21.1): `beginExternalFlow` is the choke point
//     every external transmission passes through. When a flow is permitted it
//     fires an `ExternalFlowIndicator` through the injected emitter immediately
//     (well within the 500 ms budget) so the UI can surface that data is
//     leaving the machine, naming the target provider.
//
//  2. Local-first consent gating (21.4/21.5): Conductor transmits externally
//     only to a provider the user has explicitly consented to. A flow to a
//     provider without a matching, non-revoked consent is BLOCKED before the
//     indicator fires and before any transport runs; the service returns a
//     consent-required outcome and appends an Audit_Event. Consent is granted
//     and revoked per-provider; revocation is a soft, timestamped operation so
//     the audit trail and the "block subsequent flows" check both survive.
//
//  3. User-configurable settings (21.2): retention duration, indexing
//     enablement, and synchronization enablement, persisted as global
//     preferences under the `data.*` namespace with local-first defaults
//     (finite retention, indexing on, sync OFF).
//
//  4. Stored-data deletion (21.3): `deleteStoredData` removes the targeted
//     category and returns a human-readable completion confirmation.
//
// Every privileged operation appends a redacted Audit_Event via AuditLog. The
// service never touches secret values and never carries transmitted content in
// the indicator or any audit payload.

/** Reasons an external flow can be blocked before egress. */
export type ExternalFlowBlockReason = 'consent_required';

/** The outcome of a {@link DataControlService.beginExternalFlow} decision. */
export type ExternalFlowDecision =
  | {
      readonly status: 'allowed';
      /** The indicator fired to the renderer for this transmission. */
      readonly indicator: ExternalFlowIndicator;
    }
  | {
      readonly status: 'blocked';
      readonly reason: ExternalFlowBlockReason;
      /** The consent-required message the UI displays (Requirement 21.4). */
      readonly message: string;
    };

/** Error thrown when a caller insists on egress but consent is missing. */
export class ConsentRequiredError extends Error {
  readonly provider: string;

  constructor(provider: string, message: string) {
    super(message);
    this.name = 'ConsentRequiredError';
    this.provider = provider;
  }
}

interface ConsentRow {
  id: string;
  provider: string;
  granted_at: string;
  revoked_at: string | null;
}

function consentRowToConsent(row: ConsentRow): ExternalFlowConsent {
  return {
    id: row.id,
    provider: row.provider,
    grantedAt: row.granted_at,
    ...(row.revoked_at !== null ? { revokedAt: row.revoked_at } : {}),
  };
}

/** The deletion targets `all` expands into, in dependency-safe order. */
const ALL_DELETION_TARGETS: readonly Exclude<DataDeletionTarget, 'all'>[] = [
  'tasks',
  'context_items',
  'ingested_items',
  'audit_events',
];

/** The table each concrete deletion target maps to. */
const DELETION_TABLES: Record<
  Exclude<DataDeletionTarget, 'all'>,
  string
> = {
  tasks: 'tasks',
  context_items: 'context_items',
  ingested_items: 'ingested_items',
  audit_events: 'audit_events',
};

export class DataControlService {
  constructor(
    private readonly store: Store,
    private readonly settings: SettingsService,
    private readonly audit: AuditLog,
    private readonly emitter: ExternalFlowEmitter = noopExternalFlowEmitter,
    /** Clock seam so tests can control timestamps. */
    private readonly now: () => number = () => Date.now(),
  ) {}

  // ---- User-configurable settings (Requirement 21.2, 21.5) ----

  /**
   * The current data-control settings, resolved from global preferences with
   * local-first defaults filled in for any key the user has not set
   * (Requirement 21.5).
   */
  getSettings(): DataControlSettings {
    return {
      retentionDays: this.readNumber(
        DATA_CONTROL_KEYS.retentionDays,
        DEFAULT_DATA_CONTROL_SETTINGS.retentionDays,
      ),
      indexingEnabled: this.readBoolean(
        DATA_CONTROL_KEYS.indexingEnabled,
        DEFAULT_DATA_CONTROL_SETTINGS.indexingEnabled,
      ),
      syncEnabled: this.readBoolean(
        DATA_CONTROL_KEYS.syncEnabled,
        DEFAULT_DATA_CONTROL_SETTINGS.syncEnabled,
      ),
    };
  }

  /**
   * Update one or more data-control settings. Only the provided fields are
   * changed; omitted fields keep their current value. Returns the resolved
   * settings after the update and appends an Audit_Event.
   *
   * @throws if `retentionDays` is negative or not an integer.
   */
  updateSettings(input: {
    retentionDays?: number | undefined;
    indexingEnabled?: boolean | undefined;
    syncEnabled?: boolean | undefined;
  }): DataControlSettings {
    if (input.retentionDays !== undefined) {
      if (
        !Number.isInteger(input.retentionDays) ||
        input.retentionDays < 0
      ) {
        throw new Error('retentionDays must be a non-negative integer');
      }
      this.settings.set({
        key: DATA_CONTROL_KEYS.retentionDays,
        value: input.retentionDays,
        scope: 'global',
      });
    }
    if (input.indexingEnabled !== undefined) {
      this.settings.set({
        key: DATA_CONTROL_KEYS.indexingEnabled,
        value: input.indexingEnabled,
        scope: 'global',
      });
    }
    if (input.syncEnabled !== undefined) {
      this.settings.set({
        key: DATA_CONTROL_KEYS.syncEnabled,
        value: input.syncEnabled,
        scope: 'global',
      });
    }

    const resolved = this.getSettings();
    this.audit.append({
      actor: 'user',
      action: 'data_control.settings_updated',
      redactedPayload: resolved,
    });
    return resolved;
  }

  // ---- External-flow consent (Requirement 21.4, 21.5) ----

  /** Non-revoked consents, newest first. */
  listConsents(): ExternalFlowConsent[] {
    const rows = this.store.db
      .prepare(
        `SELECT * FROM external_flow_consents
         WHERE revoked_at IS NULL
         ORDER BY granted_at DESC, rowid DESC`,
      )
      .all() as ConsentRow[];
    return rows.map(consentRowToConsent);
  }

  /** Whether the user currently consents to external flows to `provider`. */
  hasConsent(provider: string): boolean {
    const row = this.store.db
      .prepare(
        `SELECT 1 FROM external_flow_consents
         WHERE provider = ? AND revoked_at IS NULL
         LIMIT 1`,
      )
      .get(provider) as { 1: number } | undefined;
    return row !== undefined;
  }

  /**
   * Grant the user's explicit consent to external data flows to `provider`
   * (Requirement 21.4/21.5). Idempotent: re-granting an already-consented
   * provider returns the existing consent. Appends an Audit_Event.
   */
  grantConsent(provider: string): ExternalFlowConsent {
    const name = provider.trim();
    if (name === '') {
      throw new Error('provider is required');
    }

    const existing = this.store.db
      .prepare(
        `SELECT * FROM external_flow_consents
         WHERE provider = ? AND revoked_at IS NULL
         ORDER BY granted_at DESC, rowid DESC LIMIT 1`,
      )
      .get(name) as ConsentRow | undefined;
    if (existing !== undefined) {
      return consentRowToConsent(existing);
    }

    const consent: ExternalFlowConsent = {
      id: randomUUID(),
      provider: name,
      grantedAt: new Date(this.now()).toISOString(),
    };
    this.store.db
      .prepare(
        `INSERT INTO external_flow_consents (id, provider, granted_at, revoked_at)
         VALUES (?, ?, ?, NULL)`,
      )
      .run(consent.id, consent.provider, consent.grantedAt);

    this.audit.append({
      actor: 'user',
      action: 'data_control.consent_granted',
      target: name,
      redactedPayload: { provider: name },
    });
    return consent;
  }

  /**
   * Revoke the user's consent to external flows to `provider`. Soft, timestamped
   * so the audit trail survives; subsequent flows to the provider are blocked.
   * A no-op when no active consent exists. Appends an Audit_Event when a consent
   * was actually revoked.
   */
  revokeConsent(provider: string): void {
    const name = provider.trim();
    const revokedAt = new Date(this.now()).toISOString();
    const result = this.store.db
      .prepare(
        `UPDATE external_flow_consents
         SET revoked_at = ?
         WHERE provider = ? AND revoked_at IS NULL`,
      )
      .run(revokedAt, name);

    if (result.changes > 0) {
      this.audit.append({
        actor: 'user',
        action: 'data_control.consent_revoked',
        target: name,
        redactedPayload: { provider: name },
      });
    }
  }

  // ---- External-flow transparency & gating (Requirement 21.1, 21.4, 21.5) ----

  /**
   * The choke point every external transmission passes through. When the user
   * has consented to flows to `provider`, this fires an `ExternalFlowIndicator`
   * through the emitter immediately (Requirement 21.1 — within 500 ms of the
   * transmission being initiated) and returns an `allowed` decision carrying the
   * indicator. When no consent exists, it BLOCKS the flow before any indicator
   * fires and before any transport runs, appends an Audit_Event, and returns a
   * `blocked` decision with the consent-required message (Requirement 21.4).
   *
   * This method performs no transmission itself; the caller only proceeds to
   * egress on an `allowed` decision.
   */
  beginExternalFlow(input: {
    provider: string;
    target: string;
  }): ExternalFlowDecision {
    const { provider, target } = input;

    if (!this.hasConsent(provider)) {
      const message = `Consent is required before data can leave the machine for "${provider}". Grant consent in Settings to allow this external data flow.`;
      this.audit.append({
        actor: 'orchestrator',
        action: 'data_control.external_flow_blocked',
        target: provider,
        redactedPayload: { provider, target, reason: 'consent_required' },
      });
      return { status: 'blocked', reason: 'consent_required', message };
    }

    const indicator: ExternalFlowIndicator = {
      id: randomUUID(),
      provider,
      target,
      leavingMachine: true,
      initiatedAt: new Date(this.now()).toISOString(),
    };

    // Surface the indicator to the renderer first so the UI reflects the
    // outbound flow within the 500 ms budget; emit never throws back here.
    this.emitter.emit(indicator);

    this.audit.append({
      actor: 'orchestrator',
      action: 'data_control.external_flow',
      target: provider,
      redactedPayload: {
        id: indicator.id,
        provider,
        target,
        leavingMachine: true,
      },
    });

    return { status: 'allowed', indicator };
  }

  /**
   * Convenience wrapper that runs `transport` only when the external flow to
   * `provider` is permitted, firing the indicator first. Throws
   * {@link ConsentRequiredError} (without running the transport) when consent
   * is missing, so a caller that cannot tolerate a blocked flow fails loudly
   * instead of silently transmitting.
   */
  async guardExternalFlow<T>(
    input: { provider: string; target: string },
    transport: () => Promise<T>,
  ): Promise<T> {
    const decision = this.beginExternalFlow(input);
    if (decision.status === 'blocked') {
      throw new ConsentRequiredError(input.provider, decision.message);
    }
    return transport();
  }

  // ---- Stored-data deletion (Requirement 21.3) ----

  /**
   * Delete stored data for the given target and return a completion
   * confirmation (Requirement 21.3). `all` removes every category. Appends an
   * Audit_Event recording what was removed.
   */
  deleteStoredData(target: DataDeletionTarget): DataDeletionResult {
    const targets: readonly Exclude<DataDeletionTarget, 'all'>[] =
      target === 'all' ? ALL_DELETION_TARGETS : [target];

    let removedCount = 0;
    this.store.transaction(() => {
      if (target === 'all') removedCount += this.store.db.prepare('DELETE FROM memories').run().changes;
      for (const t of targets) {
        const table = DELETION_TABLES[t];
        if (t === 'ingested_items') {
          // Ingested content is persisted as memories linked to the items;
          // deleting the items must not leave a searchable copy behind.
          this.store.db.prepare(
            `DELETE FROM memories WHERE method = 'ingested' AND (
               id IN (SELECT memory_id FROM ingested_items WHERE memory_id IS NOT NULL)
               OR source_id IN (SELECT id FROM ingested_items)
             )`,
          ).run();
        }
        const result = this.store.db.prepare(`DELETE FROM ${table}`).run();
        removedCount += result.changes;
      }
    });

    const confirmation =
      target === 'all'
        ? `Deleted all stored data (${removedCount} record${removedCount === 1 ? '' : 's'} removed).`
        : `Deleted stored ${target.replace('_', ' ')} (${removedCount} record${removedCount === 1 ? '' : 's'} removed).`;

    this.audit.append({
      actor: 'user',
      action: 'data_control.data_deleted',
      target,
      redactedPayload: { target, removedCount },
    });

    return { target, removedCount, confirmation };
  }

  // ---- Internal preference readers ----

  private readNumber(key: string, fallback: number): number {
    const resolved = this.settings.resolve(key);
    if (resolved === NO_VALUE) {
      return fallback;
    }
    return typeof resolved === 'number' ? resolved : fallback;
  }

  private readBoolean(key: string, fallback: boolean): boolean {
    const resolved = this.settings.resolve(key);
    if (resolved === NO_VALUE) {
      return fallback;
    }
    return typeof resolved === 'boolean' ? resolved : fallback;
  }
}
