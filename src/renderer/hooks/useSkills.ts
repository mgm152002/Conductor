import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AdapterRecord,
  DagWorkflow,
  Skill,
  SkillBinding,
  SkillBindingStatus,
  SkillDiff,
  SkillExportFormat,
  SkillIoField,
  SkillScope,
  SkillStep,
  SkillVersion,
  SkillVersionBody,
  SkillWithBody,
  SkillUsage,
  Workspace,
} from '@shared/domain';
import { SkillSaveSchema, type SkillSaveInput } from '@shared/automation-contract';

/**
 * The Skills screen is split into a stateful hook and presentational
 * components. The hook owns everything that talks to the bridge; the screen and
 * panels only render the state and call the returned commands.
 */

export type SkillDetailTab = 'overview' | 'procedure' | 'contracts' | 'examples' | 'versions' | 'export';
export type SkillsScreenTab = 'skills' | 'automation';
export type ScopeFilter = 'all' | SkillScope;

export interface KeyValueDraft {
  key: string;
  value: string;
}

export interface ExampleDraft {
  title: string;
  input: KeyValueDraft[];
  expectedOutput: KeyValueDraft[];
}

/** A flat, fully structured editing model — no raw JSON strings. */
export interface SkillFormState {
  name: string;
  scope: SkillScope;
  scopeRef: string;
  purpose: string;
  applicability: string;
  requiredContext: string[];
  inputContract: SkillIoField[];
  outputContract: SkillIoField[];
  steps: SkillStep[];
  toolRequirements: string[];
  failureHandling: string;
  verificationCriteria: string[];
  examples: ExampleDraft[];
}

export interface PendingSkillUpdate {
  input: SkillSaveInput;
  diff: SkillDiff;
}

export interface SkillsController {
  items: Skill[];
  visible: Skill[];
  selected: SkillWithBody | null;
  form: SkillFormState;
  activeTab: SkillDetailTab;
  screenTab: SkillsScreenTab;
  query: string;
  scopeFilter: ScopeFilter;
  loading: boolean;
  busy: boolean;
  error: string | null;
  notice: string | null;
  versions: SkillVersion[];
  viewing: SkillVersion | null;
  pending: PendingSkillUpdate | null;
  adapters: AdapterRecord[];
  projects: Workspace[];
  workflows: DagWorkflow[];
  agentId: string;
  format: SkillExportFormat;
  exported: string;
  exportName: string;
  bindings: SkillBinding[];
  usages: SkillUsage[];
  automationLoading: boolean;
  automationError: string | null;
  automationBusyId: string | null;
  removalCandidate: SkillBinding | null;
  setActiveTab: (tab: SkillDetailTab) => void;
  setScreenTab: (tab: SkillsScreenTab) => void;
  setQuery: (query: string) => void;
  setScopeFilter: (scope: ScopeFilter) => void;
  changeForm: (patch: Partial<SkillFormState>) => void;
  refresh: () => Promise<void>;
  createNew: () => void;
  selectSkill: (id: string) => Promise<void>;
  save: () => Promise<void>;
  confirmSave: () => Promise<void>;
  declineSave: () => void;
  viewVersion: (version: number) => Promise<void>;
  rollback: () => Promise<void>;
  setAgentId: (id: string) => void;
  setFormat: (format: SkillExportFormat) => void;
  exportSkill: () => Promise<void>;
  download: () => void;
  refreshAutomation: () => Promise<void>;
  setBindingStatus: (bindingId: string, status: SkillBindingStatus) => Promise<void>;
  requestBindingRemoval: (binding: SkillBinding) => void;
  cancelBindingRemoval: () => void;
  confirmBindingRemoval: () => Promise<void>;
}

export function blankSkillForm(overrides: Partial<SkillFormState> = {}): SkillFormState {
  return {
    name: '',
    scope: 'global',
    scopeRef: '',
    purpose: '',
    applicability: '',
    requiredContext: [''],
    inputContract: [],
    outputContract: [],
    steps: [{ instruction: '', constraints: [] }],
    toolRequirements: [''],
    failureHandling: '',
    verificationCriteria: [''],
    examples: [{ title: '', input: [], expectedOutput: [] }],
    ...overrides,
  };
}

function cleanLines(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function isBlankRow(row: KeyValueDraft): boolean {
  return !row.key.trim() && !row.value.trim();
}

/** Render an unknown JSON value into editable key/value rows. */
export function valueToRows(value: unknown): KeyValueDraft[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return [{ key: 'value', value: JSON.stringify(value) }];
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>).map(([key, nested]) => ({
      key,
      value: typeof nested === 'string' ? nested : JSON.stringify(nested),
    }));
  }
  return [{ key: 'value', value: String(value) }];
}

function parseLoose(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return '';
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

/** Turn editable key/value rows back into a JSON-serializable object. */
export function rowsToValue(rows: KeyValueDraft[]): unknown {
  const entries = rows
    .map((row) => ({ key: row.key.trim(), value: row.value }))
    .filter((row) => row.key);
  if (entries.length === 0) return {};
  const first = entries[0]!;
  if (entries.length === 1 && first.key === 'value') return parseLoose(first.value);
  const result: Record<string, unknown> = {};
  for (const entry of entries) result[entry.key] = parseLoose(entry.value);
  return result;
}

function bodyFormFields(body: SkillVersionBody): Omit<SkillFormState, 'name' | 'scope' | 'scopeRef'> {
  return {
    purpose: body.purpose,
    applicability: body.applicability,
    requiredContext: body.requiredContext.length > 0 ? [...body.requiredContext] : [''],
    inputContract: body.inputContract.map((field) => ({ ...field })),
    outputContract: body.outputContract.map((field) => ({ ...field })),
    steps: body.steps.length > 0 ? body.steps.map((step) => ({ ...step, constraints: [...step.constraints] })) : [{ instruction: '', constraints: [] }],
    toolRequirements: body.toolRequirements.length > 0 ? [...body.toolRequirements] : [''],
    failureHandling: body.failureHandling,
    verificationCriteria: body.verificationCriteria.length > 0 ? [...body.verificationCriteria] : [''],
    examples: body.examples.length > 0
      ? body.examples.map((example) => ({
          title: example.title,
          input: valueToRows(example.input),
          expectedOutput: valueToRows(example.expectedOutput),
        }))
      : [{ title: '', input: [], expectedOutput: [] }],
  };
}

export function formFromSkill(skill: SkillWithBody): SkillFormState {
  return {
    name: skill.name,
    scope: skill.scope,
    scopeRef: skill.scopeRef ?? '',
    ...bodyFormFields(skill.body),
  };
}

function ioField(field: SkillIoField): SkillIoField {
  const next: SkillIoField = { name: field.name.trim(), description: field.description.trim(), required: field.required };
  if (field.schema !== undefined) next.schema = field.schema;
  return next;
}

const hasText = (row: KeyValueDraft): boolean => !isBlankRow(row);
const stepHasText = (step: SkillStep): boolean => !!step.instruction.trim() || step.constraints.some((constraint) => !!constraint.trim());
const exampleHasText = (example: ExampleDraft): boolean =>
  !!example.title.trim() || example.input.some(hasText) || example.expectedOutput.some(hasText);

/** Build the wire body from the structured form, dropping wholly blank rows. */
export function formToBody(form: SkillFormState): SkillVersionBody {
  return {
    purpose: form.purpose.trim(),
    applicability: form.applicability.trim(),
    requiredContext: cleanLines(form.requiredContext),
    inputContract: form.inputContract.filter((field) => field.name.trim() || field.description.trim()).map(ioField),
    outputContract: form.outputContract.filter((field) => field.name.trim() || field.description.trim()).map(ioField),
    steps: form.steps.filter(stepHasText).map((step) => ({ instruction: step.instruction.trim(), constraints: cleanLines(step.constraints) })),
    toolRequirements: cleanLines(form.toolRequirements),
    failureHandling: form.failureHandling.trim(),
    verificationCriteria: cleanLines(form.verificationCriteria),
    examples: form.examples.filter(exampleHasText).map((example) => ({
      title: example.title.trim(),
      input: rowsToValue(example.input),
      expectedOutput: rowsToValue(example.expectedOutput),
    })),
  };
}

/** Names of body fields whose draft value differs from a saved version. */
export function changedSkillFields(base: SkillVersionBody, draft: SkillVersionBody): Array<keyof SkillVersionBody> {
  return (Object.keys(draft) as Array<keyof SkillVersionBody>).filter(
    (field) => JSON.stringify(base[field]) !== JSON.stringify(draft[field]),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'The request failed. Try again.';
}

export function useSkills(): SkillsController {
  const [items, setItems] = useState<Skill[]>([]);
  const [selected, setSelected] = useState<SkillWithBody | null>(null);
  const [form, setForm] = useState<SkillFormState>(() => blankSkillForm());
  const [activeTab, setActiveTab] = useState<SkillDetailTab>('overview');
  const [screenTab, setScreenTab] = useState<SkillsScreenTab>('skills');
  const [query, setQuery] = useState('');
  const [scopeFilter, setScopeFilter] = useState<ScopeFilter>('all');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [viewing, setViewing] = useState<SkillVersion | null>(null);
  const [pending, setPending] = useState<PendingSkillUpdate | null>(null);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [projects, setProjects] = useState<Workspace[]>([]);
  const [workflows, setWorkflows] = useState<DagWorkflow[]>([]);
  const [agentId, setAgentId] = useState('portable-file');
  const [format, setFormat] = useState<SkillExportFormat>('markdown');
  const [exported, setExported] = useState('');
  const [exportName, setExportName] = useState('');
  const [bindings, setBindings] = useState<SkillBinding[]>([]);
  const [usages, setUsages] = useState<SkillUsage[]>([]);
  const [automationLoading, setAutomationLoading] = useState(true);
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [automationBusyId, setAutomationBusyId] = useState<string | null>(null);
  const [removalCandidate, setRemovalCandidate] = useState<SkillBinding | null>(null);
  const selection = useRef(0);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return items.filter((skill) => {
      if (scopeFilter !== 'all' && skill.scope !== scopeFilter) return false;
      if (!needle) return true;
      return `${skill.name} ${skill.scope} ${skill.scopeRef ?? ''}`.toLowerCase().includes(needle);
    });
  }, [items, query, scopeFilter]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    Promise.all([window.conductor.skills.list(), window.conductor.registry.listAdapters()])
      .then(async ([list, registered]) => {
        if (!live) return;
        setItems(list);
        setAdapters(registered);
        const first = list[0];
        if (first) await openSkill(first.id, true);
      })
      .catch((failure: unknown) => { if (live) setError(message(failure)); })
      .finally(() => { if (live) setLoading(false); });
    // The latest counter is intentionally invalidated on unmount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { live = false; selection.current++; };
    // Runs once: the bridge is stable for the life of the renderer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    let live = true;
    setAutomationLoading(true);
    Promise.all([
      window.conductor.skills.listBindings(),
      window.conductor.skills.listUsages({ limit: 100 }),
    ])
      .then(([nextBindings, nextUsages]) => {
        if (!live) return;
        setBindings(nextBindings);
        setUsages(nextUsages);
        setAutomationError(null);
      })
      .catch((failure: unknown) => { if (live) setAutomationError(message(failure)); })
      .finally(() => { if (live) setAutomationLoading(false); });
    return () => { live = false; };
  }, []);

  useEffect(() => {
    let live = true;
    Promise.allSettled([window.conductor.workspace.list(), window.conductor.workflows.list()]).then(([projectResult, workflowResult]) => {
      if (!live) return;
      if (projectResult.status === 'fulfilled') setProjects(projectResult.value);
      if (workflowResult.status === 'fulfilled') setWorkflows(workflowResult.value);
    });
    return () => { live = false; };
  }, []);

  function changeForm(patch: Partial<SkillFormState>): void {
    setForm((current) => ({ ...current, ...patch }));
    setNotice(null);
  }

  async function refresh(): Promise<void> {
    try {
      setItems(await window.conductor.skills.list());
      setError(null);
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function openSkill(id: string, resetTab: boolean): Promise<void> {
    const token = ++selection.current;
    setBusy(true);
    setError(null);
    try {
      const [skill, numbers] = await Promise.all([
        window.conductor.skills.get(id),
        window.conductor.skills.versions(id),
      ]);
      if (!skill) throw new Error('This skill no longer exists. Refresh the list.');
      const details = await Promise.all(numbers.map((version) => window.conductor.skills.version({ skillId: id, version })));
      if (token !== selection.current) return;
      const filled = details.filter((version): version is SkillVersion => version !== undefined).sort((a, b) => b.version - a.version);
      setSelected(skill);
      setForm(formFromSkill(skill));
      setViewing(skill.body);
      setVersions(filled);
      setPending(null);
      setExported('');
      setExportName('');
      if (resetTab) setActiveTab('overview');
      setNotice(null);
    } finally {
      if (token === selection.current) setBusy(false);
    }
  }

  async function selectSkill(id: string): Promise<void> {
    try {
      await openSkill(id, true);
    } catch (failure) {
      setError(message(failure));
    }
  }

  function createNew(): void {
    selection.current++;
    setSelected(null);
    setForm(blankSkillForm());
    setActiveTab('overview');
    setVersions([]);
    setViewing(null);
    setPending(null);
    setError(null);
    setNotice('New skill draft. Name it and add a purpose to get started.');
    setExported('');
    setExportName('');
  }

  function buildInput(): SkillSaveInput {
    const body = formToBody(form);
    const parsed = SkillSaveSchema.safeParse({
      name: form.name,
      scope: form.scope,
      ...(form.scope === 'global' ? {} : { scopeRef: form.scopeRef }),
      provenance: { method: 'user_authored', source: 'local-user' },
      body,
    });
    if (!parsed.success) {
      throw new Error(parsed.error.issues.map((issue) => `${issue.path.map(String).join('.') || 'skill'}: ${issue.message}`).join('\n'));
    }
    return parsed.data;
  }

  async function run(action: () => Promise<void>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      setError(message(failure));
    } finally {
      setBusy(false);
    }
  }

  async function afterSave(result: { skillId: string; status: string; version: number }): Promise<void> {
    await refresh();
    await openSkill(result.skillId, false);
    setPending(null);
    setNotice(result.status === 'unchanged' ? 'No changes to save.' : `Saved version ${result.version}.`);
  }

  async function save(): Promise<void> {
    await run(async () => {
      setNotice(null);
      const input = buildInput();
      const result = await window.conductor.skills.save(input);
      if (result.status === 'confirmation_required') {
        if (!result.diff) throw new Error('Update requires confirmation but no diff was returned.');
        setPending({ input, diff: result.diff });
        setNotice('Review the proposed changes before creating a new version.');
        return;
      }
      await afterSave(result);
    });
  }

  async function confirmSave(): Promise<void> {
    if (!pending) return;
    const confirmed = pending.input;
    await run(async () => {
      const result = await window.conductor.skills.save({ ...confirmed, confirmed: true });
      await afterSave(result);
    });
  }

  function declineSave(): void {
    setPending(null);
    setNotice('Update declined. The saved skill is unchanged.');
  }

  async function viewVersion(version: number): Promise<void> {
    if (!selected) return;
    setError(null);
    try {
      let detail = versions.find((candidate) => candidate.version === version);
      if (!detail) {
        detail = await window.conductor.skills.version({ skillId: selected.id, version });
        if (!detail) throw new Error('This version could not be found.');
        setVersions((current) => [...current, detail!].sort((a, b) => b.version - a.version));
      }
      setViewing(detail);
      setForm((current) => ({ ...current, ...bodyFormFields(detail) }));
      setNotice(`Viewing version ${version}. Saving edits proposes a new version based on it.`);
    } catch (failure) {
      setError(message(failure));
    }
  }

  async function rollback(): Promise<void> {
    if (!selected || !viewing) return;
    const version = viewing.version;
    await run(async () => {
      await window.conductor.skills.rollback({ skillId: selected.id, version });
      await refresh();
      await openSkill(selected.id, false);
      setNotice(`Restored version ${version}. Every prior version is retained.`);
    });
  }

  async function exportSkill(): Promise<void> {
    if (!selected) return;
    await run(async () => {
      const result = await window.conductor.skills.export({ skillId: selected.id, agentId, format });
      if (result.status !== 'exported') throw new Error('This agent does not support a compatible instruction format.');
      setExported(result.content);
      setExportName(`${selected.name.replace(/[^a-zA-Z0-9_-]+/g, '-') || 'skill'}.${result.format === 'json' ? 'json' : 'md'}`);
      setNotice('Export generated from the current saved version. Download it to add it to the target agent.');
    });
  }

  function chooseFormat(next: SkillExportFormat): void {
    setFormat(next);
    setExported('');
    setExportName('');
  }

  function download(): void {
    if (!exported) return;
    const url = URL.createObjectURL(new Blob([exported], { type: format === 'json' ? 'application/json' : 'text/markdown' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = exportName;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  async function refreshAutomation(): Promise<void> {
    setAutomationLoading(true);
    setAutomationError(null);
    try {
      const [nextBindings, nextUsages] = await Promise.all([
        window.conductor.skills.listBindings(),
        window.conductor.skills.listUsages({ limit: 100 }),
      ]);
      setBindings(nextBindings);
      setUsages(nextUsages);
    } catch (failure) {
      setAutomationError(message(failure));
    } finally {
      setAutomationLoading(false);
    }
  }

  async function changeBindingStatus(bindingId: string, status: SkillBindingStatus): Promise<void> {
    setAutomationBusyId(bindingId);
    setAutomationError(null);
    try {
      const updated = await window.conductor.skills.setBindingStatus({ bindingId, status, actor: 'local-user' });
      setBindings((current) => current.map((binding) => binding.id === bindingId ? updated : binding));
      setNotice(status === 'active' ? 'Automation binding enabled.' : 'Automation binding disabled. Historical usage is unchanged.');
    } catch (failure) {
      setAutomationError(message(failure));
    } finally {
      setAutomationBusyId(null);
    }
  }

  async function confirmBindingRemoval(): Promise<void> {
    if (!removalCandidate) return;
    const binding = removalCandidate;
    setAutomationBusyId(binding.id);
    setAutomationError(null);
    try {
      await window.conductor.skills.removeBinding({ bindingId: binding.id, actor: 'local-user' });
      setBindings((current) => current.filter((candidate) => candidate.id !== binding.id));
      setRemovalCandidate(null);
      setNotice('Automation binding removed. Historical usage is still available below.');
    } catch (failure) {
      setAutomationError(message(failure));
    } finally {
      setAutomationBusyId(null);
    }
  }

  return {
    items,
    visible,
    selected,
    form,
    activeTab,
    screenTab,
    query,
    scopeFilter,
    loading,
    busy,
    error,
    notice,
    versions,
    viewing,
    pending,
    adapters,
    projects,
    workflows,
    agentId,
    format,
    exported,
    exportName,
    bindings,
    usages,
    automationLoading,
    automationError,
    automationBusyId,
    removalCandidate,
    setActiveTab,
    setScreenTab,
    setQuery,
    setScopeFilter,
    changeForm,
    refresh,
    createNew,
    selectSkill,
    save,
    confirmSave,
    declineSave,
    viewVersion,
    rollback,
    setAgentId,
    setFormat: chooseFormat,
    exportSkill,
    download,
    refreshAutomation,
    setBindingStatus: changeBindingStatus,
    requestBindingRemoval: setRemovalCandidate,
    cancelBindingRemoval: () => setRemovalCandidate(null),
    confirmBindingRemoval,
  };
}
