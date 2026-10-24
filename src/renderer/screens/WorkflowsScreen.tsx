import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AdapterRecord, DagWorkflow, WorkflowTestReport } from '@shared/domain';
import { WorkflowSaveSchema, type WorkflowHistoryRun } from '@shared/automation-contract';
import { ScreenScaffold } from './ScreenScaffold';
import { useWorkspaces } from '../hooks/useWorkspaces';
import { buttonClass, Field, inputClass, JsonField, lines, message, panelClass, pretty, readJson } from '../components/automation/fields';

const starter = {
  name: '', triggers: [{ kind: 'manual' as const }], inputSchema: null, outputSchema: null, requiredContext: [],
  steps: [{ id: 'step-1', description: 'Describe the work to perform', requiredCapability: 'objective.fulfill', dependsOn: [], requiresApproval: true }],
  validationCriteria: [], errorRecovery: { kind: 'abort' as const }, memoryUpdates: [],
};
function editFields(w: typeof starter | DagWorkflow) {
  return { name: w.name, triggers: pretty(w.triggers), inputSchema: pretty(w.inputSchema), outputSchema: pretty(w.outputSchema), requiredContext: w.requiredContext.join('\n'), steps: pretty(w.steps), validationCriteria: pretty(w.validationCriteria), errorRecovery: pretty(w.errorRecovery), memoryUpdates: pretty(w.memoryUpdates) };
}
export function WorkflowsScreen(): React.JSX.Element {
  const [items, setItems] = useState<DagWorkflow[]>([]);
  const [adapters, setAdapters] = useState<AdapterRecord[]>([]);
  const [selected, setSelected] = useState<DagWorkflow | null>(null);
  const [versions, setVersions] = useState<DagWorkflow[]>([]);
  const [history, setHistory] = useState<WorkflowHistoryRun[]>([]);
  const [fields, setFields] = useState(() => editFields(starter));
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [test, setTest] = useState<WorkflowTestReport | null>(null);
  const [runWorkspace, setRunWorkspace] = useState('');
  const [taskId, setTaskId] = useState('');
  const { workspaces, activeWorkspaceId, error: workspaceError } = useWorkspaces();
  const workspaceId = runWorkspace || activeWorkspaceId || workspaces[0]?.id || '';
  const change = (key: keyof typeof fields) => (value: string) => { setFields(f => ({ ...f, [key]: value })); setNotice(''); };
  const refresh = async () => { setItems(await window.conductor.workflows.list()); };
  async function load(workflow: DagWorkflow) {
    setSelected(workflow); setFields(editFields(workflow)); setTest(null); setNotice('');
    const [v, h] = await Promise.all([window.conductor.workflows.versions(workflow.workflowId), window.conductor.workflows.history(workflow.workflowId)]);
    setVersions(v); setHistory(h);
  }
  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  useEffect(() => { let live = true; window.conductor.workflows.list().then(list => { if (live) setItems(list); }).catch(e => { if (live) setError(message(e)); }).finally(() => { if (live) setLoading(false); }); return () => { live = false; }; }, []);
  useEffect(() => { let live = true; window.conductor.registry.listAdapters().then(list => { if (live) setAdapters(list); }).catch(() => { /* Editing saved definitions remains usable when capability discovery fails. */ }); return () => { live = false; }; }, []);
  const newWorkflow = () => { setSelected(null); setVersions([]); setHistory([]); setFields(editFields(starter)); setError(''); setNotice(''); setTest(null); setTaskId(''); };
  async function save() {
    const input = WorkflowSaveSchema.safeParse({
      ...(selected ? { workflowId: selected.workflowId } : {}), name: fields.name,
      triggers: readJson('Triggers', fields.triggers), inputSchema: readJson('Input schema', fields.inputSchema), outputSchema: readJson('Output schema', fields.outputSchema),
      requiredContext: lines(fields.requiredContext), steps: readJson('Steps', fields.steps), validationCriteria: readJson('Validation criteria', fields.validationCriteria),
      errorRecovery: readJson('Error recovery', fields.errorRecovery), memoryUpdates: readJson('Memory updates', fields.memoryUpdates),
    });
    if (!input.success) throw new Error(input.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('\n'));
    const saved = await window.conductor.workflows.save(input.data);
    await refresh(); await load(saved); setNotice(`Saved version ${saved.version}. Previous versions are retained.`);
  }
  async function execute(mode: 'start' | 'test') {
    if (!selected) return;
    const request = { workflowId: selected.workflowId, version: selected.version, workspaceId };
    if (mode === 'test') { setTest(await window.conductor.workflows.test(request)); }
    else { const task = await window.conductor.workflows.start(request); setTaskId(task.id); setNotice(`Workflow version ${selected.version} started. Monitor its task for approvals and results.`); }
    setHistory(await window.conductor.workflows.history(selected.workflowId));
  }
  return <ScreenScaffold title="Workflows" description="Create reusable dependency graphs, retain every version, and run saved workflows in a project.">
    <div className="grid gap-5 text-foreground  lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside className={`${panelClass} self-start space-y-3`} aria-label="Saved workflows">
        <div className="flex justify-between gap-2"><h2 className="font-semibold">Saved workflows</h2><button className={buttonClass} disabled={busy} onClick={newWorkflow}>New</button></div>
        <button className={buttonClass} disabled={busy || loading} onClick={() => void perform(refresh)}>Refresh</button>
        {loading ? <p role="status">Loading workflows…</p> : !items.length ? <p className="text-sm text-muted-foreground">No workflows yet. Create your first workflow with the editor.</p> : <ul className="space-y-2">{items.map(w => <li key={w.workflowId}><button className={`${buttonClass} w-full text-left ${selected?.workflowId === w.workflowId ? 'bg-accent ' : ''}`} disabled={busy} onClick={() => void perform(() => load(w))}>{w.name}<span className="block text-xs text-muted-foreground">v{w.version} · {w.steps.length} steps</span></button></li>)}</ul>}
      </aside>
      <div className="min-w-0 space-y-5">
        {error && <p role="alert" className="whitespace-pre-wrap rounded-md border border-destructive/30 p-3 text-sm text-destructive-foreground">{error}</p>}
        {notice && <p role="status" className="text-sm">{notice}</p>}
        {taskId && <Link className="text-sm underline" to="/active-tasks">View active tasks · {taskId.slice(0, 8)}</Link>}
        <form className={`${panelClass} space-y-4`} onSubmit={e => { e.preventDefault(); void perform(save); }}>
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold">{selected ? `Edit workflow · v${selected.version}` : 'Create workflow'}</h2>{selected && <label className="text-sm">View version <select aria-label="Workflow version" className={`${inputClass} w-auto`} disabled={busy} value={selected.version} onChange={e => { const w = versions.find(v => v.version === Number(e.target.value)); if (w) void perform(() => load(w)); }}>{versions.map(v => <option key={v.version} value={v.version}>v{v.version} · {new Date(v.createdAt).toLocaleString()}</option>)}</select></label>}</div>
          <fieldset disabled={busy} className="space-y-4">
            <Field label="Workflow name"><input className={inputClass} required maxLength={255} value={fields.name} onChange={e => change('name')(e.target.value)} /></Field>
            <JsonField label="Steps and dependencies (JSON)" value={fields.steps} onChange={change('steps')} rows={14} hint="Each step needs id, description, requiredCapability, and dependsOn. Dependencies use step ids. Cycles are rejected; up to 500 steps." />
            <details className="text-sm"><summary className="cursor-pointer font-medium">Registered capabilities</summary>{adapters.length ? <ul className="mt-2 space-y-1">{adapters.flatMap(adapter => adapter.capabilities.map(capability => <li key={`${adapter.id}-${capability.id}`} className="text-xs"><code>{capability.id}</code> · {adapter.name}{!adapter.available ? " (unavailable)" : ""}</li>))}</ul> : <p className="mt-2 text-xs text-muted-foreground">No capabilities discovered. Connect an agent before running a workflow.</p>}</details>
            <details className="text-sm"><summary className="cursor-pointer font-medium">Step options and example</summary><p className="my-2">Use requiredPermissions and requiresApproval for access gates. Advanced definitions can retain branch conditions, bounded loops, retry and timeout policies, and per-step error recovery. Running these advanced options is not supported yet; omit them from runnable steps.</p><pre className="overflow-auto rounded-md bg-accent p-3 text-xs">{pretty({ id: 'inspect', description: 'Inspect the project', requiredCapability: 'objective.fulfill', dependsOn: [], requiredPermissions: [{ kind: 'filesystem_read', scope: '/project' }], requiresApproval: false, loop: { continueWhile: 'repeat', maxIterations: 3 }, branch: { expression: 'approved', whenTrue: ['next-step-id'], whenFalse: [] }, policy: { maxRetries: 1, timeoutMs: 30000 }, errorRecovery: { kind: 'abort' } })}</pre></details>
            <JsonField label="Triggers (JSON)" value={fields.triggers} onChange={change('triggers')} hint={'Kinds: manual, scheduled, event. Optional config holds a cron or event name. Triggers and timers are definition metadata only; scheduled/event dispatch is not connected. Start saved workflows manually below.'} />
            <div className="grid gap-4 xl:grid-cols-2"><JsonField label="Input schema (JSON)" value={fields.inputSchema} onChange={change('inputSchema')} hint="Retained definition metadata; runtime schema enforcement is not connected. Use null if unspecified." /><JsonField label="Output schema (JSON)" value={fields.outputSchema} onChange={change('outputSchema')} hint="Retained definition metadata; runtime schema enforcement is not connected. Use null if unspecified." /></div>
            <Field label="Required context" hint="One context requirement per line. Retained as definition metadata."><textarea className={inputClass} rows={3} value={fields.requiredContext} onChange={e => change('requiredContext')(e.target.value)} /></Field>
            <JsonField label="Validation criteria (JSON)" value={fields.validationCriteria} onChange={change('validationCriteria')} hint={'Array of {"id":"criterion-1","description":"nonempty"}. Validation rules: nonempty, contains: text, file: relative/path. Other descriptions require an evaluator.'} />
            <JsonField label="Error recovery (JSON)" value={fields.errorRecovery} onChange={change('errorRecovery')} hint={'Run supports kind: abort. Other saved definitions may use continue, or compensate with compensateWith: a step id; those policies cannot run yet.'} rows={3} />
            <JsonField label="Memory updates (JSON)" value={fields.memoryUpdates} onChange={change('memoryUpdates')} hint={'Array of {"layer":"project","key":"result","value":null}. Retained for advanced definitions. Leave [] to run; runtime memory writes are not connected.'} />
            <button className={buttonClass} type="submit">{busy ? 'Working…' : selected ? 'Save new version' : 'Create workflow'}</button>
          </fieldset>
        </form>
        {selected && <section className={`${panelClass} space-y-4`} aria-label="Run saved workflow">
          <h2 className="font-semibold">Run saved version {selected.version}</h2><p className="text-xs text-muted-foreground">Save edits before running. Executions use the saved version and its permission and approval gates. Configuration validation checks the graph and available capabilities; run the workflow to verify its output criteria.</p>
          <p className="rounded-md border border-border p-3 text-xs">Run currently supports dependency-only steps with permission and approval gates, no step policy or error recovery overrides, workflow recovery set to abort, and no memory updates. Branches, loops, custom retries/timeouts, compensation, and run variables are saved-definition features with no connected execution path. Unsupported definitions are rejected before a task is created.</p>
          {workspaceError && <p role="alert" className="text-sm text-destructive-foreground">{workspaceError}</p>}
          <Field label="Project"><select className={inputClass} disabled={busy} value={workspaceId} onChange={e => setRunWorkspace(e.target.value)}>{!workspaces.length && <option value="">Create a project first</option>}{workspaces.map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select></Field>
          <div className="flex flex-wrap gap-2"><button className={buttonClass} disabled={busy || !workspaceId} onClick={() => void perform(() => execute('start'))}>Run saved workflow</button><button className={buttonClass} disabled={busy || !workspaceId} onClick={() => void perform(() => execute('test'))}>Validate configuration</button></div>
          {test && <div role="status"><h3 className="font-medium">Configuration validation · {test.durationMs} ms</h3>{test.results.length ? <ul>{test.results.map((r, index) => <li key={`${r.criterionId}-${index}`} className="mt-2 text-sm">{r.outcome.toUpperCase()} · {r.criterionId}: {r.detail || 'No detail provided'}</li>)}</ul> : <p className="text-sm">No validation criteria were reported. Configuration validation does not execute the workflow.</p>}</div>}
        </section>}
        {selected && <section className={`${panelClass} space-y-3`} aria-label="Workflow execution history"><div className="flex items-center justify-between gap-2"><h2 className="font-semibold">Execution history</h2><button className={buttonClass} disabled={busy} onClick={() => void perform(async () => setHistory(await window.conductor.workflows.history(selected.workflowId)))}>Refresh history</button></div>{!history.length ? <p className="text-sm text-muted-foreground">No workflow runs recorded yet.</p> : history.map(run => <details key={run.id}><summary className="cursor-pointer text-sm">v{run.version} · {run.status} · {new Date(run.startedAt).toLocaleString()}</summary><div className="overflow-auto">{run.taskId && <Link className="text-xs underline" to="/active-tasks">View task {run.taskId.slice(0, 8)} for outputs and approvals</Link>}<table className="w-full text-left text-xs"><thead><tr>{['Step', 'Iteration', 'Started', 'Ended', 'Outcome', 'Attempts', 'Recovery / detail'].map(h => <th key={h} className="p-2">{h}</th>)}</tr></thead><tbody>{run.history.map((s, index) => <tr key={`${s.stepId}-${index}`}><td className="p-2">{s.stepId}</td><td>{s.iteration ?? "—"}</td><td>{s.startedAt ?? "—"}</td><td>{s.endedAt ?? "—"}</td><td>{s.outcome}</td><td>{s.attempts ?? "—"}</td><td>{s.recoveryAction} {s.detail}</td></tr>)}</tbody></table></div></details>)}</section>}
      </div>
    </div>
  </ScreenScaffold>;
}
