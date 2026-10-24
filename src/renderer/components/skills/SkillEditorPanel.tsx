import type { SkillExportFormat, SkillScope, SkillVersion, SkillVersionBody } from '@shared/domain';
import { Badge, Button, Dialog, EmptyState, Alert, inputClassName, textareaClassName } from '../ui/primitives';
import { FileTextIcon, RotateIcon, Spinner } from '../ui/icons';
import { cn } from '../../lib/cn';
import {
  changedSkillFields, formToBody, type SkillDetailTab, type SkillsController,
} from '../../hooks/useSkills';
import { ExampleRows, IoFieldRows, StepRows, StringRows } from './SkillStructuredFields';

export interface SkillEditorPanelProps {
  controller: SkillsController;
}

const TABS: Array<{ id: SkillDetailTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'procedure', label: 'Procedure' },
  { id: 'contracts', label: 'Contracts' },
  { id: 'examples', label: 'Examples' },
  { id: 'versions', label: 'Versions' },
  { id: 'export', label: 'Export' },
];

const FIELD_LABELS: Record<keyof SkillVersionBody, string> = {
  purpose: 'Purpose',
  applicability: 'Applicability',
  requiredContext: 'Required context',
  inputContract: 'Input contract',
  outputContract: 'Output contract',
  steps: 'Steps',
  toolRequirements: 'Tool requirements',
  failureHandling: 'Failure handling',
  verificationCriteria: 'Verification criteria',
  examples: 'Examples and tests',
};

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'string') return value.trim() || 'Empty';
  if (Array.isArray(value)) {
    if (value.length === 0) return 'None';
    return value.map((item, index) => `${index + 1}. ${typeof item === 'string' ? item : JSON.stringify(item)}`).join('\n');
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  return String(value);
}

const fieldLabelClass = 'text-xs font-medium text-muted-foreground';

function FieldBlock({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={fieldLabelClass}>{label}</span>
      {children}
      {hint !== undefined ? <span className="text-2xs text-muted-foreground/80">{hint}</span> : null}
    </div>
  );
}

function OverviewTab({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { form, selected, projects, workflows, changeForm } = controller;
  const referenceOptions = form.scope === 'project'
    ? projects.map((project) => ({ id: project.id, name: project.name }))
    : workflows.map((workflow) => ({ id: workflow.workflowId, name: `${workflow.name} · v${workflow.version}` }));
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Identity</h3>
          <p className="mt-0.5 text-2xs text-muted-foreground">Name and scope cannot change after the first save; create a new skill to change them.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldBlock label="Skill name">
            <input
              className={inputClassName}
              aria-label="Skill name"
              required
              maxLength={255}
              disabled={!!selected}
              value={form.name}
              placeholder="e.g. Parse Acme invoices"
              onChange={(event) => changeForm({ name: event.target.value })}
            />
          </FieldBlock>
          <FieldBlock label="Scope">
            <select
              className={inputClassName}
              aria-label="Skill scope"
              disabled={!!selected}
              value={form.scope}
              onChange={(event) => changeForm({ scope: event.target.value as SkillScope, scopeRef: '' })}
            >
              <option value="global">Global</option>
              <option value="project">Project</option>
              <option value="workflow">Workflow</option>
            </select>
          </FieldBlock>
        </div>
        {form.scope !== 'global' ? (
          <FieldBlock label={form.scope === 'project' ? 'Project reference' : 'Workflow reference'} hint="Choose the saved project or workflow this skill applies to.">
            {selected ? (
              <input className={inputClassName} aria-label="Skill scope reference" disabled value={form.scopeRef} />
            ) : (
              <select
                className={inputClassName}
                aria-label="Skill scope reference"
                required
                value={form.scopeRef}
                onChange={(event) => changeForm({ scopeRef: event.target.value })}
              >
                <option value="">Choose {form.scope}</option>
                {referenceOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
              </select>
            )}
          </FieldBlock>
        ) : null}
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <h3 className="text-xs font-semibold text-foreground">Purpose and applicability</h3>
        <FieldBlock label="Purpose" hint="What outcome does this skill produce?">
          <textarea
            className={textareaClassName}
            aria-label="Purpose"
            rows={3}
            required
            value={form.purpose}
            placeholder="Extract invoice totals, tax, and line items from Acme PDFs."
            onChange={(event) => changeForm({ purpose: event.target.value })}
          />
        </FieldBlock>
        <FieldBlock label="Applicability" hint="When should Conductor choose this skill?">
          <textarea
            className={textareaClassName}
            aria-label="Applicability"
            rows={3}
            required
            value={form.applicability}
            placeholder="Use for invoices whose vendor ID is ACME-001."
            onChange={(event) => changeForm({ applicability: event.target.value })}
          />
        </FieldBlock>
      </section>

      <section className="space-y-3 border-t border-border pt-5">
        <h3 className="text-xs font-semibold text-foreground">Context and tools</h3>
        <StringRows
          label="Required context"
          hint="Each item the skill needs before it can run. Add one row per item."
          values={form.requiredContext}
          idPrefix="Required context"
          addLabel="Add required context"
          placeholder="e.g. Vendor invoice text"
          minItems={1}
          onChange={(requiredContext) => changeForm({ requiredContext })}
        />
        <StringRows
          label="Tool requirements"
          hint="Capabilities or tools the skill expects, one per row."
          values={form.toolRequirements}
          idPrefix="Tool requirement"
          addLabel="Add tool requirement"
          placeholder="e.g. filesystem_read"
          minItems={1}
          onChange={(toolRequirements) => changeForm({ toolRequirements })}
        />
      </section>
    </div>
  );
}

function ProcedureTab({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { form, changeForm } = controller;
  return (
    <div className="space-y-6">
      <StepRows steps={form.steps} onChange={(steps) => changeForm({ steps })} />
      <section className="space-y-3 border-t border-border pt-5">
        <FieldBlock label="Failure handling" hint="What should happen when a step fails or required data is missing?">
          <textarea
            className={textareaClassName}
            aria-label="Failure handling"
            rows={3}
            required
            value={form.failureHandling}
            placeholder="Stop and report the missing field; never guess a total."
            onChange={(event) => changeForm({ failureHandling: event.target.value })}
          />
        </FieldBlock>
        <StringRows
          label="Verification criteria"
          hint="How to confirm the skill achieved its purpose. Add one row per criterion."
          values={form.verificationCriteria}
          idPrefix="Verification criterion"
          addLabel="Add verification criterion"
          placeholder="Totals reconcile with line items"
          minItems={1}
          onChange={(verificationCriteria) => changeForm({ verificationCriteria })}
        />
      </section>
    </div>
  );
}

function ContractsTab({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { form, changeForm } = controller;
  return (
    <div className="space-y-6">
      <p className="rounded-lg bg-muted/40 px-3 py-2 text-2xs text-muted-foreground">
        Contracts describe the values this skill accepts and returns. Add a row for each named value; schemas already saved on a field are preserved.
      </p>
      <IoFieldRows
        label="Input contract field"
        description="Values the skill needs to start."
        fields={form.inputContract}
        onChange={(inputContract) => changeForm({ inputContract })}
      />
      <div className="border-t border-border pt-5">
        <IoFieldRows
          label="Output contract field"
          description="Values the skill promises to produce."
          fields={form.outputContract}
          onChange={(outputContract) => changeForm({ outputContract })}
        />
      </div>
    </div>
  );
}

function ExamplesTab({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { form, changeForm } = controller;
  return <ExampleRows examples={form.examples} onChange={(examples) => changeForm({ examples })} />;
}

function VersionRow({ version, current, viewing, disabled, onView }: {
  version: SkillVersion;
  current: boolean;
  viewing: boolean;
  disabled: boolean;
  onView: () => void;
}): React.JSX.Element {
  return (
    <li>
      <button
        type="button"
        aria-pressed={viewing}
        disabled={disabled}
        onClick={onView}
        className={cn(
          'flex w-full flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50',
          viewing ? 'border-ring bg-accent ring-1 ring-ring/20' : 'border-border hover:bg-accent/50',
        )}
      >
        <span className="text-sm font-medium text-foreground">Version {version.version}</span>
        {current ? <Badge tone="success">Current</Badge> : null}
        {viewing ? <Badge tone="primary">Viewing</Badge> : null}
        <span className="ml-auto text-2xs text-muted-foreground">{version.provenance.method.replaceAll('_', ' ')} · {new Date(version.createdAt).toLocaleString()}</span>
      </button>
    </li>
  );
}

function VersionsTab({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { selected, versions, viewing, form, busy, viewVersion, rollback } = controller;
  if (!selected) {
    return (
      <EmptyState title="No saved versions yet" description="Save the skill once to start a version history you can review or restore.">
        <Button variant="primary" size="sm" onClick={() => controller.setActiveTab('overview')}>Continue editing</Button>
      </EmptyState>
    );
  }
  const draft = formToBody(form);
  const changes = viewing ? changedSkillFields(viewing, draft) : [];
  return (
    <div className="space-y-5">
      {viewing && viewing.version !== selected.currentVersion ? (
        <Alert tone="warning">
          You are viewing version {viewing.version}, not the current head (version {selected.currentVersion}). Saving now proposes a new version based on this one; restoring makes it current immediately.
        </Alert>
      ) : null}
      <section className="space-y-2">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Version history</h3>
          <p className="mt-0.5 text-2xs text-muted-foreground">Every confirmed save appends a version. Restoring keeps all prior versions.</p>
        </div>
        {versions.length === 0 ? (
          <div role="status" className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner size={13} />Loading version history…</div>
        ) : (
          <ul className="space-y-1.5" aria-label="Skill versions">
            {versions.map((version) => (
              <VersionRow
                key={version.version}
                version={version}
                current={version.version === selected.currentVersion}
                viewing={viewing?.version === version.version}
                disabled={busy}
                onView={() => void viewVersion(version.version)}
              />
            ))}
          </ul>
        )}
      </section>

      {viewing ? (
        <section className="space-y-3 rounded-xl border border-border bg-background/40 p-4" aria-label={`Review version ${viewing.version}`}>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">Reviewing version {viewing.version}</h3>
            {viewing.version !== selected.currentVersion ? <Badge tone="warning">Not current</Badge> : <Badge tone="success">Current head</Badge>}
          </div>
          <dl className="grid gap-x-4 gap-y-2 text-2xs sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Provenance</dt><dd className="mt-0.5 text-foreground">{viewing.provenance.method.replaceAll('_', ' ')}</dd></div>
            <div><dt className="text-muted-foreground">Source</dt><dd className="mt-0.5 break-words text-foreground">{viewing.provenance.source}</dd></div>
            <div><dt className="text-muted-foreground">Created</dt><dd className="mt-0.5 text-foreground">{new Date(viewing.createdAt).toLocaleString()}</dd></div>
          </dl>

          <div>
            <h4 className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Changes in this draft</h4>
            {changes.length === 0 ? (
              <p className="mt-1 text-xs text-muted-foreground">The editor matches version {viewing.version}.</p>
            ) : (
              <ul className="mt-1.5 flex flex-wrap gap-1.5" aria-label="Changed fields">
                {changes.map((field) => <li key={field}><Badge tone="warning">{FIELD_LABELS[field]}</Badge></li>)}
              </ul>
            )}
          </div>

          {viewing.version !== selected.currentVersion ? (
            <div className="space-y-2 border-t border-border pt-3">
              <p className="text-2xs text-muted-foreground">Restoring makes version {viewing.version} current and keeps every later version available.</p>
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => void rollback()}>
                <RotateIcon size={13} />
                Restore version {viewing.version} as current
              </Button>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

function ExportTab({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { selected, adapters, agentId, format, exported, exportName, busy, setAgentId, setFormat, exportSkill, download, setActiveTab } = controller;
  if (!selected) {
    return (
      <EmptyState title="Save this skill first" description="Export becomes available after the first version is saved.">
        <Button variant="primary" size="sm" onClick={() => setActiveTab('overview')}>Continue editing</Button>
      </EmptyState>
    );
  }
  return (
    <div className="space-y-5">
      <section className="space-y-3">
        <div>
          <h3 className="text-xs font-semibold text-foreground">Export current saved version</h3>
          <p className="mt-0.5 text-2xs text-muted-foreground">Generate a portable instruction file. Downloading does not install or alter an agent.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <FieldBlock label="Export target">
            <select className={inputClassName} aria-label="Export target" disabled={busy} value={agentId} onChange={(event) => setAgentId(event.target.value)}>
              <option value="portable-file">Portable instruction file</option>
              {adapters.map((adapter) => (
                <option key={adapter.id} value={adapter.id}>{adapter.name}{adapter.available ? '' : ' (unavailable)'}</option>
              ))}
            </select>
          </FieldBlock>
          <FieldBlock label="Instruction format">
            <select
              className={inputClassName}
              aria-label="Instruction format"
              disabled={busy}
              value={format}
              onChange={(event) => setFormat(event.target.value as SkillExportFormat)}
            >
              <option value="markdown">Markdown</option>
              <option value="json">JSON</option>
            </select>
          </FieldBlock>
        </div>
        <Button variant="primary" size="sm" type="button" disabled={busy || !agentId} onClick={() => void exportSkill()}>
          <FileTextIcon size={13} />
          {busy ? 'Working…' : 'Generate export'}
        </Button>
      </section>

      {exported ? (
        <section className="space-y-2 border-t border-border pt-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-xs font-semibold text-foreground">Preview</h3>
            <Button variant="outline" size="xs" onClick={download}>Download {exportName}</Button>
          </div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-background/60 p-3 text-2xs">{exported}</pre>
        </section>
      ) : null}
    </div>
  );
}

function PendingDiffDialog({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { pending, form, selected, busy, confirmSave, declineSave } = controller;
  return (
    <Dialog
      open={pending !== null}
      onClose={declineSave}
      title={`Review changes to ${form.name.trim() || selected?.name || 'this skill'}`}
      description={selected
        ? `Confirming saves these changes as version ${selected.currentVersion + 1}. Declining keeps the saved skill unchanged.`
        : 'Confirming saves these changes. Declining keeps the existing skill unchanged.'}
      width="max-w-2xl"
      footer={(
        <>
          <Button variant="ghost" onClick={declineSave} disabled={busy}>Decline update</Button>
          <Button variant="primary" onClick={() => void confirmSave()} disabled={busy}>{busy ? 'Saving…' : 'Confirm new version'}</Button>
        </>
      )}
    >
      {pending ? (
        <ul className="max-h-[60vh] space-y-4 overflow-y-auto pr-1" aria-label="Proposed changes">
          {pending.diff.entries.map((entry) => (
            <li key={entry.field} className="space-y-1.5">
              <h4 className="text-xs font-semibold text-foreground">{FIELD_LABELS[entry.field] ?? entry.field}</h4>
              <div className="grid gap-2 lg:grid-cols-2">
                <div>
                  <span className="text-2xs text-muted-foreground">Before</span>
                  <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-2 text-2xs">{formatDiffValue(entry.before)}</pre>
                </div>
                <div>
                  <span className="text-2xs text-muted-foreground">After</span>
                  <pre className="mt-0.5 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-accent/60 p-2 text-2xs">{formatDiffValue(entry.after)}</pre>
                </div>
              </div>
            </li>
          ))}
          {pending.diff.entries.length === 0 ? <li className="text-xs text-muted-foreground">No field differences were detected.</li> : null}
        </ul>
      ) : null}
    </Dialog>
  );
}

export function SkillEditorPanel({ controller }: SkillEditorPanelProps): React.JSX.Element {
  const { selected, form, activeTab, busy, viewing, pending, setActiveTab, save } = controller;
  const draft = formToBody(form);
  const dirty = selected ? changedSkillFields(selected.body, draft).length > 0 : true;
  const fromOlderVersion = !!selected && !!viewing && viewing.version !== selected.currentVersion;

  return (
    <>
      <section className="flex min-w-0 flex-col rounded-xl border border-border bg-card" aria-label="Skill editor">
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{selected ? selected.name : form.name.trim() || 'New skill'}</h2>
            <p className="mt-0.5 text-2xs text-muted-foreground">
              {selected ? `${selected.scope}${selected.scopeRef ? ` · ${selected.scopeRef}` : ''} · current v${selected.currentVersion}` : 'Not saved yet'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            {selected ? <Badge tone="success">v{selected.currentVersion}</Badge> : <Badge tone="info">Draft</Badge>}
            {dirty ? <Badge tone="warning">Unsaved changes</Badge> : selected ? <Badge>Saved</Badge> : null}
            {fromOlderVersion && viewing ? <Badge tone="primary">Based on v{viewing.version}</Badge> : null}
          </div>
        </header>

        <div className="overflow-x-auto border-b border-border px-2" role="tablist" aria-label="Skill details">
          <div className="flex min-w-max">
            {TABS.map((tab) => {
              const active = activeTab === tab.id;
              const requiresSkill = (tab.id === 'versions' || tab.id === 'export') && !selected;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  id={`skill-tab-${tab.id}`}
                  aria-selected={active}
                  aria-controls={`skill-panel-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'relative px-3 py-2.5 text-xs font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring',
                    active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
                    requiresSkill ? 'opacity-70' : '',
                  )}
                >
                  {tab.label}
                  {active ? <span className="absolute inset-x-2 bottom-0 h-0.5 rounded-full bg-primary" aria-hidden="true" /> : null}
                </button>
              );
            })}
          </div>
        </div>

        <form
          className="flex min-h-0 flex-1 flex-col"
          noValidate
          onSubmit={(event) => { event.preventDefault(); void save(); }}
        >
          <div className="flex-1 px-4 py-4" role="tabpanel" id={`skill-panel-${activeTab}`} aria-labelledby={`skill-tab-${activeTab}`}>
            {activeTab === 'overview' ? <OverviewTab controller={controller} /> : null}
            {activeTab === 'procedure' ? <ProcedureTab controller={controller} /> : null}
            {activeTab === 'contracts' ? <ContractsTab controller={controller} /> : null}
            {activeTab === 'examples' ? <ExamplesTab controller={controller} /> : null}
            {activeTab === 'versions' ? <VersionsTab controller={controller} /> : null}
            {activeTab === 'export' ? <ExportTab controller={controller} /> : null}
          </div>

          <footer className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-border bg-card/95 px-4 py-3 backdrop-blur">
            <p className="text-2xs text-muted-foreground">
              {selected
                ? dirty ? `Saving creates version ${selected.currentVersion + 1}.` : 'No changes to save.'
                : 'Saving creates the first version.'}
            </p>
            <div className="flex items-center gap-2">
              {activeTab !== 'versions' && selected ? (
                <Button variant="ghost" size="sm" type="button" onClick={() => setActiveTab('versions')}>Review versions</Button>
              ) : null}
              <Button variant="primary" size="sm" type="submit" disabled={busy || pending !== null}>
                {busy ? 'Working…' : selected ? 'Review and save changes' : 'Create skill'}
              </Button>
            </div>
          </footer>
        </form>
      </section>

      <PendingDiffDialog controller={controller} />
    </>
  );
}
