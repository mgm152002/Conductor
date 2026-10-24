import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { Skill, SkillBinding, SkillUsage, SkillVersion, SkillVersionBody, SkillWithBody } from '../../src/shared/domain';
import { blankSkillForm, formFromSkill, type SkillsController } from '../../src/renderer/hooks/useSkills';
import { SkillsScreenView } from '../../src/renderer/screens/SkillsScreen';

const skill: Skill = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Parse Acme invoices',
  scope: 'global',
  currentVersion: 2,
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T00:00:00Z',
};

const body: SkillVersionBody = {
  purpose: 'Extract invoice totals',
  applicability: 'Use for Acme invoices',
  requiredContext: ['Invoice text'],
  inputContract: [{ name: 'invoiceText', description: 'Vendor invoice text', required: true }],
  outputContract: [{ name: 'totalDue', description: 'Invoice total', required: true }],
  steps: [{ instruction: 'Read the invoice', constraints: ['Do not guess totals'] }],
  toolRequirements: ['filesystem_read'],
  failureHandling: 'Report the missing field',
  verificationCriteria: ['Totals reconcile'],
  examples: [{ title: 'Standard invoice', input: { total: 42 }, expectedOutput: { totalDue: 42 } }],
};

const head: SkillVersion = {
  ...body,
  skillId: skill.id,
  version: 2,
  provenance: { method: 'user_authored', source: 'local-user' },
  createdAt: '2026-10-25T00:00:00Z',
};

const previous: SkillVersion = {
  ...head,
  version: 1,
  purpose: 'Extract some invoice values',
  createdAt: '2026-10-24T00:00:00Z',
};

const selected: SkillWithBody = { ...skill, body: head };

const binding: SkillBinding = {
  id: '22222222-2222-4222-8222-222222222222',
  skillId: skill.id,
  trigger: { kind: 'vendor', key: 'acme-001', aliases: ['acme corp'] },
  extractionTemplate: { fields: [] },
  status: 'active',
  lastUsedAt: '2026-10-25T02:00:00Z',
  createdAt: '2026-10-25T00:00:00Z',
  updatedAt: '2026-10-25T02:00:00Z',
};

const usage: SkillUsage = {
  id: '33333333-3333-4333-8333-333333333333',
  bindingId: binding.id,
  taskId: '44444444-4444-4444-8444-444444444444',
  skillId: skill.id,
  skillVersion: 2,
  triggerKey: 'acme-001',
  outcome: 'completed',
  startedAt: '2026-10-25T02:00:00Z',
  completedAt: '2026-10-25T02:01:00Z',
};

function controller(overrides: Partial<SkillsController> = {}): SkillsController {
  const base = {
    items: [],
    visible: [],
    selected: null,
    form: blankSkillForm(),
    activeTab: 'overview',
    screenTab: 'skills',
    query: '',
    scopeFilter: 'all',
    loading: false,
    busy: false,
    error: null,
    notice: null,
    versions: [],
    viewing: null,
    pending: null,
    adapters: [],
    projects: [],
    workflows: [],
    agentId: 'portable-file',
    format: 'markdown',
    exported: '',
    exportName: '',
    bindings: [],
    usages: [],
    automationLoading: false,
    automationError: null,
    automationBusyId: null,
    removalCandidate: null,
    setActiveTab: vi.fn(),
    setScreenTab: vi.fn(),
    setQuery: vi.fn(),
    setScopeFilter: vi.fn(),
    changeForm: vi.fn(),
    refresh: vi.fn(async () => undefined),
    createNew: vi.fn(),
    selectSkill: vi.fn(async () => undefined),
    save: vi.fn(async () => undefined),
    confirmSave: vi.fn(async () => undefined),
    declineSave: vi.fn(),
    viewVersion: vi.fn(async () => undefined),
    rollback: vi.fn(async () => undefined),
    setAgentId: vi.fn(),
    setFormat: vi.fn(),
    exportSkill: vi.fn(async () => undefined),
    download: vi.fn(),
    refreshAutomation: vi.fn(async () => undefined),
    setBindingStatus: vi.fn(async () => undefined),
    requestBindingRemoval: vi.fn(),
    cancelBindingRemoval: vi.fn(),
    confirmBindingRemoval: vi.fn(async () => undefined),
  };
  return { ...base, ...overrides } as unknown as SkillsController;
}

function render(state: Partial<SkillsController>): string {
  return renderToStaticMarkup(createElement(SkillsScreenView, { controller: controller(state) }));
}

describe('Skills screen states', () => {
  it('shows a distinct loading state while the list is fetched', () => {
    const html = render({ loading: true });
    expect(html).toContain('role="status"');
    expect(html).toContain('Loading skills…');
    expect(html).not.toContain('No skills yet');
  });

  it('offers a clear next action when there are no skills', () => {
    const html = render({ loading: false, items: [], visible: [] });
    expect(html).toContain('No skills yet');
    expect(html).toContain('Create skill');
    expect(html).not.toContain('No matching skills');
  });

  it('distinguishes an empty search result from an empty library', () => {
    const html = render({ items: [skill], visible: [], query: 'missing', scopeFilter: 'global' });
    expect(html).toContain('No matching skills');
    expect(html).toContain('Clear filters');
    expect(html).not.toContain('No skills yet');
  });

  it('shows an error with a retry action', () => {
    const html = render({ error: 'Could not load skills' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load skills');
    expect(html).toContain('Retry');
  });
});

describe('Skills screen controls', () => {
  it('labels the search, scope filter, and every detail tab', () => {
    const html = render({ items: [skill], visible: [skill], selected: null });
    expect(html).toContain('aria-label="Search skills"');
    expect(html).toContain('aria-label="Filter by scope"');
    expect(html).toContain('role="tablist"');
    for (const label of ['Overview', 'Procedure', 'Contracts', 'Examples', 'Versions', 'Export']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Skill name"');
    expect(html).toContain('aria-label="Purpose"');
    expect(html).toContain('aria-label="Applicability"');
  });

  it('shows automation bindings with the required labels and actions', () => {
    const html = render({
      screenTab: 'automation',
      items: [skill],
      bindings: [binding],
      usages: [usage],
    });
    expect(html).toContain('Automation bindings');
    for (const label of ['Vendor key', 'Skill', 'Status', 'Current version', 'Last use', 'Actions']) {
      expect(html).toContain(`>${label}<`);
    }
    expect(html).toContain('acme-001');
    expect(html).toContain('Parse Acme invoices');
    expect(html).toContain('>active<');
    expect(html).toContain('>v2<');
    expect(html).toContain('>Disable<');
    expect(html).toContain('>Remove<');
    expect(html).toContain('Usage history');
    expect(html).toContain('Task 44444444-4444-4444-8444-444444444444');
    expect(html).toContain('>completed<');
  });

  it('distinguishes empty automation bindings and usage history', () => {
    const html = render({ screenTab: 'automation', bindings: [], usages: [] });
    expect(html).toContain('No automation bindings yet');
    expect(html).toContain('View skills');
    expect(html).toContain('No automation usage yet');
  });

  it('confirms removal and disables automation controls during the mutation', () => {
    const html = render({
      screenTab: 'automation',
      items: [skill],
      bindings: [binding],
      removalCandidate: binding,
      automationBusyId: binding.id,
    });
    expect(html).toContain('Remove automation binding?');
    expect(html).toContain('Existing usage history will be preserved.');
    expect(html).toContain('Removing…');
    expect(html).toContain('disabled=""');
  });

  it('shows distinct automation loading and error states', () => {
    const loading = render({ screenTab: 'automation', automationLoading: true });
    expect(loading).toContain('Loading automation bindings and usage…');
    expect(loading).not.toContain('No automation bindings yet');

    const failed = render({ screenTab: 'automation', automationError: 'Bridge unavailable' });
    expect(failed).toContain('Automation could not be loaded: Bridge unavailable');
    expect(failed).toContain('Retry automation');
  });

  it('edits contracts as repeatable rows, never a raw JSON textarea', () => {
    const form = blankSkillForm({
      inputContract: [{ name: 'totalDue', description: 'Invoice total', required: true }],
      outputContract: [{ name: 'poNumber', description: 'Matched PO', required: false }],
    });
    const html = render({ activeTab: 'contracts', form });
    expect(html).toContain('aria-label="Input contract field 1 name"');
    expect(html).toContain('aria-label="Input contract field 1 required"');
    expect(html).toContain('aria-label="Remove input contract field 1"');
    expect(html).toContain('Add input contract field');
    expect(html).toContain('aria-label="Remove output contract field 1"');
    expect(html).not.toContain('Input contract (JSON)');
    expect(html).not.toContain('Output contract (JSON)');
  });

  it('edits procedure steps and constraints as structured rows', () => {
    const form = blankSkillForm({ steps: [{ instruction: 'Read the invoice', constraints: ['Do not guess totals'] }] });
    const html = render({ activeTab: 'procedure', form });
    expect(html).toContain('aria-label="Step 1 instruction"');
    expect(html).toContain('aria-label="Step 1 constraint 1"');
    expect(html).toContain('aria-label="Add constraint"');
    expect(html).toContain('aria-label="Remove step 1"');
    expect(html).toContain('aria-label="Add step"');
    expect(html).not.toContain('Ordered steps and constraints (JSON)');
  });

  it('edits examples and their values as structured rows', () => {
    const form = blankSkillForm({
      examples: [{ title: 'Standard invoice', input: [{ key: 'total', value: '42' }], expectedOutput: [{ key: 'totalDue', value: '42' }] }],
    });
    const html = render({ activeTab: 'examples', form });
    expect(html).toContain('aria-label="Example 1 title"');
    expect(html).toContain('aria-label="Example 1 input 1 key"');
    expect(html).toContain('aria-label="Example 1 input 1 value"');
    expect(html).toContain('aria-label="Example 1 expected output 1 key"');
    expect(html).toContain('aria-label="Remove example 1"');
    expect(html).toContain('aria-label="Add example"');
    expect(html).not.toContain('Examples and tests (JSON)');
  });

  it('uses a labeled tab panel for the selected detail tab', () => {
    const html = render({ activeTab: 'contracts' });
    expect(html).toContain('role="tabpanel"');
    expect(html).toContain('aria-labelledby="skill-tab-contracts"');
    expect(html).toContain('id="skill-panel-contracts"');
    expect(html).toContain('Create skill');
  });

  it('reviews versions with provenance, changes, and a restore action', () => {
    const html = render({
      selected,
      form: formFromSkill(selected),
      versions: [head, previous],
      viewing: previous,
      activeTab: 'versions',
    });
    expect(html).toContain('aria-label="Skill versions"');
    expect(html).toContain('Reviewing version 1');
    expect(html).toContain('Not current');
    expect(html).toContain('aria-label="Changed fields"');
    expect(html).toContain('Restore version 1 as current');
    expect(html).toContain('Review and save changes');
  });

  it('exports the current saved version from a labeled panel', () => {
    const html = render({ selected, form: formFromSkill(selected), versions: [head], viewing: head, activeTab: 'export' });
    expect(html).toContain('Export current saved version');
    expect(html).toContain('aria-label="Export target"');
    expect(html).toContain('aria-label="Instruction format"');
    expect(html).toContain('Generate export');
  });
});
