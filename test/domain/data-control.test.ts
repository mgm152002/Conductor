import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { SettingsService } from '@main/domain/settings-service';
import { WorkspaceService } from '@main/domain/workspace-service';
import {
  ConsentRequiredError,
  DataControlService,
} from '@main/domain/data-control-service';
import { RecordingExternalFlowEmitter } from '@main/orchestrator/external-flow-emitter';
import {
  DATA_CONTROL_KEYS,
  DEFAULT_DATA_CONTROL_SETTINGS,
} from '@shared/domain';

// Unit tests for Requirement 21 (external-flow transparency & data control):
//   21.1 — an allowed external flow fires an indicator naming the provider
//   21.2 — retention / indexing / sync are user-configurable, persisted settings
//   21.3 — stored-data deletion removes the data and returns a confirmation
//   21.4 — a flow without explicit consent is blocked with a consent-required msg
//   21.5 — local-first defaults: sync OFF, external flows only when consented

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;
let settings: SettingsService;
let workspaces: WorkspaceService;
let emitter: RecordingExternalFlowEmitter;

let clockMs: number;
const now = () => clockMs;

function newService(): DataControlService {
  return new DataControlService(store, settings, audit, emitter, now);
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-datactrl-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  workspaces = new WorkspaceService(store);
  settings = new SettingsService(store, workspaces);
  emitter = new RecordingExternalFlowEmitter();
  clockMs = Date.parse('2024-01-01T00:00:00.000Z');
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('DataControlService settings (Requirement 21.2, 21.5)', () => {
  it('returns local-first defaults when nothing is configured', () => {
    const svc = newService();
    const s = svc.getSettings();
    expect(s).toEqual(DEFAULT_DATA_CONTROL_SETTINGS);
    // Local-first: external synchronization is OFF by default.
    expect(s.syncEnabled).toBe(false);
    expect(s.indexingEnabled).toBe(true);
    expect(s.retentionDays).toBeGreaterThan(0);
  });

  it('persists updated settings and resolves them on a fresh service', () => {
    const svc = newService();
    const updated = svc.updateSettings({
      retentionDays: 30,
      indexingEnabled: false,
      syncEnabled: true,
    });
    expect(updated).toEqual({
      retentionDays: 30,
      indexingEnabled: false,
      syncEnabled: true,
    });
    // A fresh service reads the same persisted values (global preferences).
    expect(newService().getSettings()).toEqual(updated);
  });

  it('updates only the provided fields and leaves the rest unchanged', () => {
    const svc = newService();
    svc.updateSettings({ syncEnabled: true });
    const s = svc.getSettings();
    expect(s.syncEnabled).toBe(true);
    expect(s.retentionDays).toBe(DEFAULT_DATA_CONTROL_SETTINGS.retentionDays);
    expect(s.indexingEnabled).toBe(
      DEFAULT_DATA_CONTROL_SETTINGS.indexingEnabled,
    );
  });

  it('stores settings under the data.* global preference namespace', () => {
    const svc = newService();
    svc.updateSettings({ retentionDays: 7 });
    expect(settings.resolve(DATA_CONTROL_KEYS.retentionDays)).toBe(7);
  });

  it('rejects a negative or non-integer retention', () => {
    const svc = newService();
    expect(() => svc.updateSettings({ retentionDays: -1 })).toThrow();
    expect(() => svc.updateSettings({ retentionDays: 1.5 })).toThrow();
  });
});

describe('DataControlService external-flow consent (Requirement 21.4, 21.5)', () => {
  it('blocks an external flow without consent and surfaces a consent-required message', () => {
    const svc = newService();
    const decision = svc.beginExternalFlow({
      provider: 'openai',
      target: 'api.openai.com',
    });
    expect(decision.status).toBe('blocked');
    if (decision.status === 'blocked') {
      expect(decision.reason).toBe('consent_required');
      expect(decision.message.toLowerCase()).toContain('consent');
    }
    // No indicator fires for a blocked flow.
    expect(emitter.emitted).toHaveLength(0);
    // The block is audited.
    const blocked = audit
      .list()
      .find((e) => e.action === 'data_control.external_flow_blocked');
    expect(blocked).toBeDefined();
  });

  it('throws ConsentRequiredError from guardExternalFlow without running the transport', async () => {
    const svc = newService();
    let ran = false;
    await expect(
      svc.guardExternalFlow(
        { provider: 'openai', target: 'api.openai.com' },
        async () => {
          ran = true;
          return 'sent';
        },
      ),
    ).rejects.toBeInstanceOf(ConsentRequiredError);
    expect(ran).toBe(false);
  });

  it('allows a flow once consent is granted and runs the transport', async () => {
    const svc = newService();
    svc.grantConsent('openai');
    const result = await svc.guardExternalFlow(
      { provider: 'openai', target: 'api.openai.com' },
      async () => 'sent',
    );
    expect(result).toBe('sent');
  });

  it('is idempotent on repeated grants and reports active consents', () => {
    const svc = newService();
    const a = svc.grantConsent('openai');
    const b = svc.grantConsent('openai');
    expect(b.id).toBe(a.id);
    expect(svc.listConsents().map((c) => c.provider)).toEqual(['openai']);
  });

  it('blocks again after consent is revoked', () => {
    const svc = newService();
    svc.grantConsent('openai');
    expect(svc.hasConsent('openai')).toBe(true);
    svc.revokeConsent('openai');
    expect(svc.hasConsent('openai')).toBe(false);
    expect(svc.listConsents()).toHaveLength(0);
    expect(
      svc.beginExternalFlow({ provider: 'openai', target: 'api.openai.com' })
        .status,
    ).toBe('blocked');
  });
});

describe('DataControlService external-flow indicator (Requirement 21.1)', () => {
  it('fires an indicator naming the provider and target when a flow is allowed', () => {
    const svc = newService();
    svc.grantConsent('anthropic');
    const decision = svc.beginExternalFlow({
      provider: 'anthropic',
      target: 'api.anthropic.com',
    });
    expect(decision.status).toBe('allowed');
    expect(emitter.emitted).toHaveLength(1);
    const indicator = emitter.emitted[0]!;
    expect(indicator.provider).toBe('anthropic');
    expect(indicator.target).toBe('api.anthropic.com');
    expect(indicator.leavingMachine).toBe(true);
    expect(indicator.initiatedAt).toBe(new Date(clockMs).toISOString());
    if (decision.status === 'allowed') {
      expect(decision.indicator).toEqual(indicator);
    }
  });

  it('audits an allowed external flow without carrying transmitted content', () => {
    const svc = newService();
    svc.grantConsent('anthropic');
    svc.beginExternalFlow({ provider: 'anthropic', target: 'api.anthropic.com' });
    const flow = audit
      .list()
      .find((e) => e.action === 'data_control.external_flow');
    expect(flow).toBeDefined();
    expect(JSON.stringify(flow!.redactedPayload)).not.toContain('secret');
  });
});

describe('DataControlService stored-data deletion (Requirement 21.3)', () => {
  function seedTasks(count: number): void {
    const ws = workspaces.create({ name: 'ws', rootPath: workDir });
    const insert = store.db.prepare(
      `INSERT INTO tasks (id, workspace_id, objective, state, created_at, updated_at)
       VALUES (?, ?, ?, 'CREATED', ?, ?)`,
    );
    const ts = new Date(clockMs).toISOString();
    for (let i = 0; i < count; i += 1) {
      insert.run(randomUUID(), ws.id, `task ${i}`, ts, ts);
    }
  }

  it('deletes the targeted category and returns a completion confirmation', () => {
    const svc = newService();
    seedTasks(3);
    expect(
      (store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
        .n,
    ).toBe(3);

    const result = svc.deleteStoredData('tasks');
    expect(result.target).toBe('tasks');
    expect(result.removedCount).toBe(3);
    expect(result.confirmation.toLowerCase()).toContain('deleted');
    expect(
      (store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
        .n,
    ).toBe(0);
  });

  it('deletes everything for the all target and audits the deletion', () => {
    const svc = newService();
    seedTasks(2);
    const result = svc.deleteStoredData('all');
    expect(result.target).toBe('all');
    expect(result.removedCount).toBeGreaterThanOrEqual(2);
    const deleted = audit
      .list()
      .find((e) => e.action === 'data_control.data_deleted');
    expect(deleted).toBeDefined();
    expect(
      (store.db.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number })
        .n,
    ).toBe(0);
  });
});
