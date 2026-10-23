import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import {
  SkillBindingNotFoundError,
  SkillBindingValidationError,
  SkillNotFoundError,
  SkillsService,
  SkillUsageNotFoundError,
  SkillValidationError,
  type SaveSkillBindingInput,
  type UpsertSkillInput,
} from '@main/domain/skills-service';
import type {
  AgentInstructionTarget,
  InvoiceExtractionTemplate,
  SkillProvenance,
  SkillVersionBody,
} from '@shared/domain';

// Unit tests for Requirement 16 (Skills & procedural knowledge):
//   16.1/16.2 — represent every required field; reject incomplete skills
//   16.3      — global/project/workflow scopes
//   16.4/16.5 — export to a compatible instruction format; report incompatible
//   16.6      — diff + confirmation before overwrite; new version + rollback
//   16.7      — declining an update leaves the existing skill unchanged

let workDir: string;
let store: SqliteStore;
let audit: AuditLog;

let clockMs: number;
const now = () => clockMs;

const USER_PROV: SkillProvenance = { method: 'user_authored', source: 'u1' };

function completeBody(overrides: Partial<SkillVersionBody> = {}): SkillVersionBody {
  return {
    purpose: 'Summarize a long document into bullet points.',
    applicability: 'When a document exceeds 2000 words.',
    requiredContext: ['the source document'],
    inputContract: [
      { name: 'document', description: 'raw text', required: true },
    ],
    outputContract: [
      { name: 'summary', description: 'bullet list', required: true },
    ],
    steps: [
      { instruction: 'Read the document fully.', constraints: ['do not skim'] },
      { instruction: 'Extract key points.', constraints: [] },
    ],
    toolRequirements: ['text.summarize'],
    failureHandling: 'Return a partial summary and flag low confidence.',
    verificationCriteria: ['every section is represented'],
    examples: [
      { title: 'short doc', input: 'hello world', expectedOutput: '- hello world' },
    ],
    ...overrides,
  };
}

function newService(): SkillsService {
  return new SkillsService(store, audit, now);
}

function create(
  service: SkillsService,
  overrides: Partial<UpsertSkillInput> = {},
): ReturnType<SkillsService['upsert']> {
  return service.upsert({
    name: 'Summarize',
    scope: 'global',
    body: completeBody(),
    provenance: USER_PROV,
    ...overrides,
  });
}

beforeEach(async () => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-skills-'));
  store = new SqliteStore(join(workDir, 'app.db'));
  await store.migrate();
  audit = new AuditLog(store);
  clockMs = Date.parse('2024-01-01T00:00:00.000Z');
});

afterEach(() => {
  store.close();
  rmSync(workDir, { recursive: true, force: true });
});

describe('SkillsService — required fields (16.1/16.2)', () => {
  it('creates a skill with all required fields at version 1', () => {
    const service = newService();
    const result = create(service);
    expect(result.status).toBe('created');
    expect(result.version).toBe(1);

    const skill = service.get(result.skillId);
    expect(skill).toBeDefined();
    expect(skill!.body.purpose).toContain('Summarize');
    expect(skill!.body.steps).toHaveLength(2);
    expect(skill!.body.provenance).toEqual(USER_PROV);
  });

  it('rejects a skill missing purpose and identifies the field', () => {
    const service = newService();
    try {
      create(service, { body: completeBody({ purpose: '   ' }) });
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SkillValidationError);
      expect((err as SkillValidationError).missingFields).toContain('purpose');
    }
    expect(service.list()).toHaveLength(0);
  });

  it('reports every missing field at once', () => {
    const service = newService();
    try {
      create(service, {
        body: completeBody({
          purpose: '',
          steps: [],
          verificationCriteria: [],
          examples: [],
        }),
      });
      expect.unreachable();
    } catch (err) {
      const missing = (err as SkillValidationError).missingFields;
      expect(missing).toEqual(
        expect.arrayContaining([
          'purpose',
          'steps',
          'verificationCriteria',
          'examples',
        ]),
      );
    }
  });

  it('rejects malformed input-contract entries', () => {
    const service = newService();
    expect(() =>
      create(service, {
        // @ts-expect-error intentionally malformed field
        body: completeBody({ inputContract: [{ name: '', description: 1 }] }),
      }),
    ).toThrow(SkillValidationError);
  });
});

describe('SkillsService — scopes (16.3)', () => {
  it('supports global, project, and workflow scopes', () => {
    const service = newService();
    create(service, { name: 'G', scope: 'global' });
    create(service, { name: 'P', scope: 'project', scopeRef: 'proj-1' });
    create(service, { name: 'W', scope: 'workflow', scopeRef: 'wf-1' });

    expect(service.list('global')).toHaveLength(1);
    expect(service.list('project', 'proj-1')).toHaveLength(1);
    expect(service.list('workflow', 'wf-1')).toHaveLength(1);
    expect(service.list()).toHaveLength(3);
  });

  it('requires a scopeRef for project/workflow scope', () => {
    const service = newService();
    expect(() => create(service, { name: 'P', scope: 'project' })).toThrow(
      SkillValidationError,
    );
  });

  it('lets the same name coexist across distinct scope targets', () => {
    const service = newService();
    const a = create(service, { name: 'Same', scope: 'project', scopeRef: 'p1' });
    const b = create(service, { name: 'Same', scope: 'project', scopeRef: 'p2' });
    expect(a.skillId).not.toBe(b.skillId);
  });
});

describe('SkillsService — overwrite, diff, versions, rollback (16.6/16.7)', () => {
  it('returns unchanged when the submitted body equals head', () => {
    const service = newService();
    const created = create(service);
    const again = create(service);
    expect(again.status).toBe('unchanged');
    expect(again.version).toBe(1);
    expect(again.skillId).toBe(created.skillId);
    expect(service.versions(created.skillId)).toEqual([1]);
  });

  it('requires confirmation with a diff before overwriting, and changes nothing', () => {
    const service = newService();
    const created = create(service);

    const result = create(service, {
      body: completeBody({ failureHandling: 'Abort and alert the user.' }),
    });

    expect(result.status).toBe('confirmation_required');
    expect(result.diff).toBeDefined();
    expect(result.diff!.fromVersion).toBe(1);
    expect(result.diff!.entries.map((e) => e.field)).toContain('failureHandling');
    // Unchanged: still a single version, head body is the original.
    expect(service.versions(created.skillId)).toEqual([1]);
    expect(service.get(created.skillId)!.body.failureHandling).toContain(
      'partial summary',
    );
  });

  it('stores a new version on confirmed overwrite and retains the prior one', () => {
    const service = newService();
    const created = create(service);

    const updated = create(service, {
      confirmed: true,
      body: completeBody({ failureHandling: 'Abort and alert the user.' }),
    });

    expect(updated.status).toBe('updated');
    expect(updated.version).toBe(2);
    expect(service.versions(created.skillId)).toEqual([1, 2]);
    expect(service.get(created.skillId)!.body.failureHandling).toBe(
      'Abort and alert the user.',
    );
    // Prior version body is retained intact for rollback.
    const v1 = service.getVersion(created.skillId, 1);
    expect(v1!.failureHandling).toContain('partial summary');
  });

  it('rolls back the head to a prior version without mutating version bodies', () => {
    const service = newService();
    const created = create(service);
    create(service, {
      confirmed: true,
      body: completeBody({ failureHandling: 'v2 handling' }),
    });
    expect(service.get(created.skillId)!.currentVersion).toBe(2);

    const rolled = service.rollback(created.skillId, 1);
    expect(rolled.currentVersion).toBe(1);
    expect(rolled.body.failureHandling).toContain('partial summary');
    // Both versions still exist — rollback only repoints the head.
    expect(service.versions(created.skillId)).toEqual([1, 2]);
  });

  it('rejects rollback to an unknown version', () => {
    const service = newService();
    const created = create(service);
    expect(() => service.rollback(created.skillId, 5)).toThrow(
      SkillNotFoundError,
    );
  });
});

describe('SkillsService — export (16.4/16.5)', () => {
  it('exports to a compatible markdown format', () => {
    const service = newService();
    const created = create(service);
    const target: AgentInstructionTarget = {
      agentId: 'claude-code',
      format: 'markdown',
    };
    const result = service.exportTo(created.skillId, target);
    expect(result.status).toBe('exported');
    if (result.status === 'exported') {
      expect(result.format).toBe('markdown');
      expect(result.content).toContain('# Summarize');
      expect(result.content).toContain('## Purpose');
    }
  });

  it('exports to a compatible json format', () => {
    const service = newService();
    const created = create(service);
    const result = service.exportTo(created.skillId, {
      agentId: 'codex',
      format: 'json',
    });
    expect(result.status).toBe('exported');
    if (result.status === 'exported') {
      const parsed = JSON.parse(result.content) as { name: string };
      expect(parsed.name).toBe('Summarize');
    }
  });

  it('reports incompatible when no compatible instruction format exists', () => {
    const service = newService();
    const created = create(service);
    const result = service.exportTo(created.skillId, {
      agentId: 'legacy-agent',
      // A format the engine cannot render.
      format: 'xml' as unknown as 'markdown',
    });
    expect(result.status).toBe('incompatible');
    if (result.status === 'incompatible') {
      expect(result.agentId).toBe('legacy-agent');
    }
  });

  it('rejects export of an unknown skill', () => {
    const service = newService();
    expect(() =>
      service.exportTo('missing', { agentId: 'a', format: 'markdown' }),
    ).toThrow(SkillNotFoundError);
  });
});

describe('SkillsService — audit trail', () => {
  it('appends audit events for create, update, rollback, and export', () => {
    const service = newService();
    const created = create(service);
    create(service, {
      confirmed: true,
      body: completeBody({ failureHandling: 'v2' }),
    });
    service.rollback(created.skillId, 1);
    service.exportTo(created.skillId, { agentId: 'a', format: 'markdown' });

    const actions = audit.list().map((e) => e.action);
    expect(actions).toContain('skill_created');
    expect(actions).toContain('skill_version_added');
    expect(actions).toContain('skill_rolled_back');
    expect(actions).toContain('skill_exported');
  });

  it('records a confirmation_required audit event without mutating the skill', () => {
    const service = newService();
    const created = create(service);
    create(service, { body: completeBody({ purpose: 'different purpose here' }) });
    const actions = audit.list().map((e) => e.action);
    expect(actions).toContain('skill_update_confirmation_required');
    expect(service.versions(created.skillId)).toEqual([1]);
  });
});

// ---- Learned vendor bindings and usage history (Requirements 1.1/1.2/2.3/2.4/5.1) ----

const TEMPLATE: InvoiceExtractionTemplate = {
  fields: [
    { name: 'total', labels: ['Total Due'], required: true, normalization: 'amount' },
    { name: 'taxId', labels: ['Tax ID'], required: false, normalization: 'identifier' },
  ],
  lineItems: {
    columns: [{ field: 'description', labels: ['Description'], required: true }],
  },
};

const VENDOR_TRIGGER = {
  kind: 'vendor' as const,
  key: 'Acme, Inc.',
  aliases: ['ACME Corp', 'Acme Holdings'],
};

const WORKSPACE_ID = '550e8400-e29b-41d4-a716-446655440010';

function bind(
  service: SkillsService,
  skillId: string,
  overrides: Partial<SaveSkillBindingInput> = {},
): ReturnType<SkillsService['saveBinding']> {
  return service.saveBinding({
    skillId,
    trigger: VENDOR_TRIGGER,
    extractionTemplate: TEMPLATE,
    ...overrides,
  });
}

function insertTask(taskId: string): void {
  store.db
    .prepare(
      'INSERT OR IGNORE INTO workspaces (id,name,root_path,created_at,updated_at) VALUES (?,?,?,?,?)',
    )
    .run(WORKSPACE_ID, 'Test', '/test', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
  store.db
    .prepare(
      'INSERT INTO tasks (id,workspace_id,objective,state,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    )
    .run(taskId, WORKSPACE_ID, 'Parse an invoice', 'COMPLETED', '2024-01-01T00:00:00.000Z', '2024-01-01T00:00:00.000Z');
}

describe('SkillsService — binding lifecycle (1.1/1.2/2.4)', () => {
  it('creates, normalizes, updates, disables, and removes a binding', () => {
    const service = newService();
    const created = create(service);

    const binding = bind(service, created.skillId);
    expect(binding.status).toBe('active');
    expect(binding.trigger).toEqual({
      kind: 'vendor',
      key: 'acme inc',
      aliases: ['acme corp', 'acme holdings'],
    });
    expect(binding.extractionTemplate.fields[0]!.name).toBe('total');
    expect(service.listBindings()).toHaveLength(1);
    expect(service.listBindings({ skillId: created.skillId })).toHaveLength(1);
    expect(service.listBindings({ status: 'active' })).toHaveLength(1);

    clockMs += 1_000;
    const updated = bind(service, created.skillId, {
      bindingId: binding.id,
      status: 'disabled',
      extractionTemplate: {
        fields: [
          { name: 'total', labels: ['Amount Due'], required: true, normalization: 'amount' },
        ],
      },
      actor: 'user',
      sourceTaskId: 'task-1',
    });
    expect(updated.id).toBe(binding.id);
    expect(updated.status).toBe('disabled');
    expect(updated.createdAt).toBe(binding.createdAt);
    expect(updated.updatedAt).not.toBe(binding.updatedAt);
    expect(updated.extractionTemplate.fields[0]!.labels).toEqual(['Amount Due']);
    expect(service.listBindings({ status: 'active' })).toHaveLength(0);

    clockMs += 1_000;
    const enabled = service.setBindingStatus({
      bindingId: binding.id,
      status: 'active',
      sourceTaskId: 'task-2',
    });
    expect(enabled.status).toBe('active');
    expect(service.listBindings({ status: 'active' })).toHaveLength(1);

    service.removeBinding({ bindingId: binding.id });
    expect(service.listBindings()).toHaveLength(0);

    const actions = audit.list().map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'skill_binding_created',
        'skill_binding_updated',
        'skill_binding_status_changed',
        'skill_binding_removed',
      ]),
    );
  });

  it('rejects malformed triggers, templates, unknown skills, and duplicate keys', () => {
    const service = newService();
    const first = create(service);
    const second = create(service, { name: 'Second' });

    expect(() => bind(service, first.skillId, { trigger: { kind: 'vendor', key: '   ' } })).toThrow(
      SkillBindingValidationError,
    );
    expect(() => bind(service, first.skillId, { trigger: { kind: 'vendor', key: '!!!' } })).toThrow(
      SkillBindingValidationError,
    );
    expect(() =>
      bind(service, first.skillId, {
        extractionTemplate: { fields: [] },
      }),
    ).toThrow(SkillBindingValidationError);
    expect(() => bind(service, 'missing-skill')).toThrow(SkillNotFoundError);

    bind(service, first.skillId);
    expect(() => bind(service, second.skillId)).toThrow(SkillBindingValidationError);
    expect(service.listBindings()).toHaveLength(1);
  });

  it('matches active bindings by key or alias, prefers the longest match, and ignores disabled bindings', () => {
    const service = newService();
    const created = create(service);
    const binding = bind(service, created.skillId);

    const byKey = service.matchBinding({ kind: 'vendor', key: 'ACME, INC.' });
    expect(byKey?.binding.id).toBe(binding.id);
    expect(byKey?.matchedKey).toBe('acme inc');
    expect(byKey?.skill.currentVersion).toBe(1);

    const byAlias = service.matchBinding({ kind: 'vendor', key: 'acme-corp' });
    expect(byAlias?.binding.id).toBe(binding.id);
    expect(byAlias?.matchedKey).toBe('acme corp');

    expect(service.matchBinding({ kind: 'vendor', key: 'Unknown Vendor' })).toBeUndefined();

    service.setBindingStatus({ bindingId: binding.id, status: 'disabled' });
    expect(service.matchBinding({ kind: 'vendor', key: 'ACME, INC.' })).toBeUndefined();
  });

  it('resolves the current head after a rollback while preserving pinned usage versions', () => {
    const service = newService();
    const created = create(service);
    const binding = bind(service, created.skillId);
    create(service, {
      confirmed: true,
      body: completeBody({ failureHandling: 'v2 handling' }),
    });

    expect(service.matchBinding({ kind: 'vendor', key: 'Acme, Inc.' })?.skill.currentVersion).toBe(2);
    const v2Usage = service.recordUsage({ bindingId: binding.id, triggerKey: 'Acme, Inc.' });
    expect(v2Usage.skillVersion).toBe(2);

    service.rollback(created.skillId, 1);
    expect(service.matchBinding({ kind: 'vendor', key: 'Acme, Inc.' })?.skill.currentVersion).toBe(1);
    const v1Usage = service.recordUsage({ bindingId: binding.id });
    expect(v1Usage.skillVersion).toBe(1);

    const versions = service
      .listUsages({ skillId: created.skillId })
      .map((usage) => usage.skillVersion)
      .sort();
    expect(versions).toEqual([1, 2]);
    expect(service.versions(created.skillId)).toEqual([1, 2]);
  });
});

describe('SkillsService — usage attribution (2.3/2.4/5.1)', () => {
  it('records a pending usage with task, skill, version, and trigger, then finalizes it', () => {
    const service = newService();
    const created = create(service);
    const binding = bind(service, created.skillId);
    const taskId = '550e8400-e29b-41d4-a716-446655440011';
    insertTask(taskId);

    const usage = service.recordUsage({ bindingId: binding.id, taskId });
    expect(usage).toMatchObject({
      bindingId: binding.id,
      taskId,
      skillId: created.skillId,
      skillVersion: 1,
      triggerKey: 'acme inc',
      outcome: 'pending',
      startedAt: '2024-01-01T00:00:00.000Z',
    });
    expect(usage.completedAt).toBeUndefined();
    expect(service.listBindings()[0]!.lastUsedAt).toBe(usage.startedAt);

    clockMs += 5_000;
    const finished = service.finishUsage(usage.id, 'completed', { detail: 'PO matched' });
    expect(finished.outcome).toBe('completed');
    expect(finished.completedAt).toBe('2024-01-01T00:00:05.000Z');
    expect(service.listBindings()[0]!.lastUsedAt).toBe(finished.completedAt);
    expect(service.listUsages({ taskId }).map((row) => row.id)).toEqual([usage.id]);

    const actions = audit.list().map((e) => e.action);
    expect(actions).toContain('skill_usage_recorded');
    expect(actions).toContain('skill_usage_finished');
    expect(() => service.finishUsage('missing', 'completed')).toThrow(SkillUsageNotFoundError);
  });

  it('preserves historical usage rows when a binding is removed', () => {
    const service = newService();
    const created = create(service);
    const binding = bind(service, created.skillId);
    const usage = service.recordUsage({ bindingId: binding.id });

    service.removeBinding({ bindingId: binding.id });

    const rows = service.listUsages({ skillId: created.skillId });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(usage.id);
    expect(rows[0]!.bindingId).toBeUndefined();
    expect(rows[0]!.skillVersion).toBe(1);
  });

  it('records usage without a binding and validates the skill version', () => {
    const service = newService();
    const created = create(service);

    const usage = service.recordUsage({
      skillId: created.skillId,
      triggerKey: 'Manual Run',
      outcome: 'skipped',
    });
    expect(usage.bindingId).toBeUndefined();
    expect(usage.triggerKey).toBe('manual run');
    expect(usage.outcome).toBe('skipped');
    expect(usage.completedAt).toBeDefined();

    expect(() =>
      service.recordUsage({
        skillId: created.skillId,
        triggerKey: 'x',
        skillVersion: 99,
      }),
    ).toThrow(SkillNotFoundError);
    expect(() => service.recordUsage({ triggerKey: 'x' })).toThrow(
      SkillBindingValidationError,
    );
    expect(() => service.finishUsage('missing', 'completed')).toThrow(
      SkillUsageNotFoundError,
    );
  });

  it('raises a not-found error when updating or removing an unknown binding', () => {
    const service = newService();
    expect(() => service.setBindingStatus({ bindingId: 'missing', status: 'disabled' })).toThrow(
      SkillBindingNotFoundError,
    );
    expect(() => service.removeBinding({ bindingId: 'missing' })).toThrow(
      SkillBindingNotFoundError,
    );
  });
});
