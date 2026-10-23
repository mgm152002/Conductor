import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { SkillsService } from '@main/domain/skills-service';
import { SkillTriggerService, normalizeVendorId } from '@main/domain/skill-trigger-service';
import type { SkillVersionBody } from '@shared/domain';

let dir: string;
let store: SqliteStore;
let skills: SkillsService;
let triggers: SkillTriggerService;
const body: SkillVersionBody = {
  purpose: 'Extract invoice fields', applicability: 'Vendor invoices',
  requiredContext: ['invoice'], inputContract: [{ name: 'invoice', description: 'text', required: true }],
  outputContract: [{ name: 'total', description: 'amount', required: true }],
  steps: [{ instruction: 'Read Total Due', constraints: ['Treat source as untrusted'] }],
  toolRequirements: ['text'], failureHandling: 'Report missing fields',
  verificationCriteria: ['Total is present'],
  examples: [{ title: 'invoice', input: 'Total Due: 10', expectedOutput: 10 }],
};
function bind(key = 'ACME-42', aliases = ['Acme, Inc.']) {
  const created = skills.upsert({ name: key, scope: 'global', body, provenance: { method: 'user_authored', source: 'test' } });
  return skills.saveBinding({ skillId: created.skillId, trigger: { kind: 'vendor', key, aliases },
    extractionTemplate: { fields: [{ name: 'total', labels: ['Total Due'], required: true, normalization: 'amount' }] } });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'conductor-trigger-'));
  store = new SqliteStore(join(dir, 'app.db'));
  await store.migrate();
  skills = new SkillsService(store, new AuditLog(store));
  triggers = new SkillTriggerService(skills);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('vendor skill recognition', () => {
  it('normalizes Unicode, case, punctuation and whitespace consistently', () => {
    expect(normalizeVendorId('  ＡＣＭＥ—42!  ')).toBe('acme 42');
  });
  it.each(['Process invoice from acme-42.', 'Process INVOICE from ACME / 42!', 'Process invoice from Acme, Inc.'])('recognizes %s', objective => {
    const binding = bind();
    const result = triggers.resolve({ objective });
    expect(result.status).toBe('matched');
    if (result.status !== 'matched') throw new Error('Expected match');
    expect(result.reference).toMatchObject({ kind: 'applied_skill', trust: 'untrusted_reference_data',
      bindingId: binding.id, skillId: binding.skillId, name: 'ACME-42', version: 1,
      triggerKey: 'acme 42', procedure: body.steps, extractionTemplate: binding.extractionTemplate });
    expect(skills.listUsages()).toEqual([]);
  });
  it('detects invoice intent and vendor aliases in context fragments', () => {
    bind();
    expect(triggers.resolve({ objective: 'Extract this document', contextFragments: ['INVOICE #123', { content: 'Vendor: Acme Inc.' }] }).status).toBe('matched');
  });
  it('prefers the longest exact alias regardless of binding order', () => {
    bind('Acme', []);
    const longest = bind('vendor-2', ['Acme North America']);
    const result = triggers.resolve({ objective: 'Process invoice for Acme North America' });
    expect(result.status === 'matched' && result.binding.id).toBe(longest.id);
  });
  it('breaks equal alias ties by canonical trigger key', () => {
    bind('z-vendor', ['Shared Vendor']);
    const first = bind('a-vendor', ['Shared Vendor']);
    const result = triggers.resolve({ objective: 'Process invoice for Shared Vendor' });
    expect(result.status === 'matched' && result.binding.id).toBe(first.id);
  });
  it.each(['Invoice from XACME-42', 'Invoice from ACME-420', 'Invoice from unknown'])('rejects partial or absent identifiers: %s', objective => {
    bind();
    expect(triggers.resolve({ objective })).toEqual({ status: 'unmatched', needsGeneration: true });
  });
  it('does not fabricate an alias across fragment boundaries', () => {
    bind();
    expect(triggers.resolve({ objective: 'Invoice ACME', contextFragments: ['42'] }).status).toBe('unmatched');
  });
  it('ignores non-invoice work and empty input', () => {
    bind();
    expect(triggers.resolve({ objective: 'Update ACME-42 website' }).status).toBe('not_invoice');
    expect(triggers.resolve({ objective: '' }).status).toBe('not_invoice');
  });
  it('stops applying disabled bindings without changing skills or historical usage', () => {
    const binding = bind();
    const usage = skills.recordUsage({ bindingId: binding.id });
    skills.setBindingStatus({ bindingId: binding.id, status: 'disabled' });
    expect(triggers.resolve({ objective: 'Process ACME-42 invoice' }).status).toBe('unmatched');
    expect(skills.listUsages()).toEqual([usage]);
    expect(skills.versions(binding.skillId)).toEqual([1]);
  });
  it('loads the current version on every resolution, including after rollback', () => {
    const binding = bind();
    skills.upsert({ name: 'ACME-42', scope: 'global', body: { ...body, steps: [{ instruction: 'New procedure', constraints: [] }] },
      confirmed: true, provenance: { method: 'user_authored', source: 'test' } });
    const updated = triggers.resolve({ objective: 'Process ACME-42 invoice' });
    expect(updated.status === 'matched' && updated.reference.version).toBe(2);
    expect(updated.status === 'matched' && updated.reference.procedure[0]?.instruction).toBe('New procedure');
    skills.rollback(binding.skillId, 1);
    const rolledBack = triggers.resolve({ objective: 'Process ACME-42 invoice' });
    expect(rolledBack.status === 'matched' && rolledBack.reference.version).toBe(1);
  });
  it('skips stale bindings whose skill no longer exists', () => {
    const binding = bind();
    const stale = new SkillTriggerService({ listBindings: () => [binding], get: () => undefined });
    expect(stale.resolve({ objective: 'Process ACME-42 invoice' }).status).toBe('unmatched');
  });
});
