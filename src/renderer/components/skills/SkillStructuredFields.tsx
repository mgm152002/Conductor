import type { SkillIoField, SkillStep } from '@shared/domain';
import { Button, Badge, inputClassName, textareaClassName } from '../ui/primitives';
import { PlusIcon, TrashIcon } from '../ui/icons';
import { cn } from '../../lib/cn';
import type { ExampleDraft, KeyValueDraft } from '../../hooks/useSkills';

// Structured, repeatable row editors. Nothing here asks the user to type raw
// JSON: contracts, steps, constraints, and examples are all edited as rows.

function RowActions({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <div className="flex items-center gap-1">{children}</div>;
}

function AddRow({ children, onClick, ariaLabel }: { children: React.ReactNode; onClick: () => void; ariaLabel?: string }): React.JSX.Element {
  return (
    <Button variant="ghost" size="xs" onClick={onClick} aria-label={ariaLabel} className="self-start">
      <PlusIcon size={12} />
      {children}
    </Button>
  );
}

function RemoveRow({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }): React.JSX.Element {
  return (
    <Button variant="ghost" size="icon-sm" aria-label={label} title={label} disabled={disabled} onClick={onClick} className="text-muted-foreground hover:text-destructive-foreground">
      <TrashIcon size={13} />
    </Button>
  );
}

function EditorSection({ title, description, children }: { title: string; description?: string | undefined; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        {description !== undefined ? <p className="mt-0.5 text-2xs text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

export function StringRows({ label, hint, values, onChange, idPrefix, addLabel, placeholder, minItems = 0 }: {
  label: string;
  hint?: string;
  values: string[];
  onChange: (values: string[]) => void;
  /** Prefix for accessible labels, e.g. "Required context" → "Required context 1". */
  idPrefix: string;
  addLabel?: string;
  placeholder?: string;
  minItems?: number;
}): React.JSX.Element {
  const replace = (index: number, next: string): void => {
    onChange(values.map((value, current) => (current === index ? next : value)));
  };
  return (
    <fieldset className="space-y-2">
      <legend className="text-xs font-medium text-muted-foreground">{label}</legend>
      {hint !== undefined ? <p className="text-2xs text-muted-foreground/80">{hint}</p> : null}
      {values.map((value, index) => (
        <div key={index} className="flex items-start gap-1.5">
          <input
            className={inputClassName}
            aria-label={`${idPrefix} ${index + 1}`}
            placeholder={placeholder}
            value={value}
            onChange={(event) => replace(index, event.target.value)}
          />
          <RemoveRow
            label={`Remove ${idPrefix.toLowerCase()} ${index + 1}`}
            disabled={values.length <= minItems}
            onClick={() => onChange(values.filter((_, current) => current !== index))}
          />
        </div>
      ))}
      <AddRow onClick={() => onChange([...values, ''])} ariaLabel={addLabel ?? `Add ${idPrefix.toLowerCase()}`}>
        {addLabel ?? `Add ${label.toLowerCase()}`}
      </AddRow>
    </fieldset>
  );
}

function BlankField(): SkillIoField {
  return { name: '', description: '', required: false };
}

export function IoFieldRows({ label, description, fields, onChange }: {
  /** Singular accessible label, e.g. "Input contract field". */
  label: string;
  description?: string;
  fields: SkillIoField[];
  onChange: (fields: SkillIoField[]) => void;
}): React.JSX.Element {
  const replace = (index: number, patch: Partial<SkillIoField>): void => {
    onChange(fields.map((field, current) => (current === index ? { ...field, ...patch } : field)));
  };
  const lower = label.toLowerCase();
  return (
    <EditorSection title={label} description={description}>
      {fields.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-2xs text-muted-foreground">No fields yet. Add one for each value this contract accepts or returns.</p>
      ) : (
        <ol className="space-y-2">
          {fields.map((field, index) => (
            <li key={index} className="rounded-lg border border-border bg-background/40 p-3">
              <div className="flex items-start gap-2">
                <div className="grid min-w-0 flex-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                  <input
                    className={inputClassName}
                    aria-label={`${label} ${index + 1} name`}
                    placeholder="Field name, e.g. totalDue"
                    value={field.name}
                    onChange={(event) => replace(index, { name: event.target.value })}
                  />
                  <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5 rounded border-input accent-primary"
                      aria-label={`${label} ${index + 1} required`}
                      checked={field.required}
                      onChange={(event) => replace(index, { required: event.target.checked })}
                    />
                    Required
                  </label>
                </div>
                <RowActions>
                  <RemoveRow label={`Remove ${lower} ${index + 1}`} onClick={() => onChange(fields.filter((_, current) => current !== index))} />
                </RowActions>
              </div>
              <textarea
                className={cn(textareaClassName, 'mt-2 text-xs')}
                rows={2}
                aria-label={`${label} ${index + 1} description`}
                placeholder="What this value means and where it comes from"
                value={field.description}
                onChange={(event) => replace(index, { description: event.target.value })}
              />
              {field.schema !== undefined ? <Badge className="mt-2" tone="neutral">Custom schema preserved</Badge> : null}
            </li>
          ))}
        </ol>
      )}
      <AddRow onClick={() => onChange([...fields, BlankField()])} ariaLabel={`Add ${lower}`}>
        Add {lower}
      </AddRow>
    </EditorSection>
  );
}

export function StepRows({ steps, onChange }: {
  steps: SkillStep[];
  onChange: (steps: SkillStep[]) => void;
}): React.JSX.Element {
  const replace = (index: number, patch: Partial<SkillStep>): void => {
    onChange(steps.map((step, current) => (current === index ? { ...step, ...patch } : step)));
  };
  return (
    <EditorSection title="Procedure" description="Ordered steps. Add guardrails under each step that must hold while it runs.">
      {steps.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border px-3 py-2 text-2xs text-muted-foreground">At least one step is required.</p>
      ) : null}
      <ol className="space-y-3">
        {steps.map((step, index) => (
          <li key={index} role="group" aria-label={`Step ${index + 1}`} className="rounded-lg border border-border bg-background/40 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="text-2xs font-semibold uppercase tracking-wide text-muted-foreground">Step {index + 1}</span>
              <RemoveRow label={`Remove step ${index + 1}`} onClick={() => onChange(steps.filter((_, current) => current !== index))} />
            </div>
            <textarea
              className={textareaClassName}
              rows={2}
              aria-label={`Step ${index + 1} instruction`}
              placeholder="What should the agent do in this step?"
              value={step.instruction}
              onChange={(event) => replace(index, { instruction: event.target.value })}
            />
            <div className="mt-2">
              <StringRows
                label="Constraints"
                values={step.constraints}
                idPrefix={`Step ${index + 1} constraint`}
                addLabel="Add constraint"
                placeholder="A guardrail for this step"
                onChange={(constraints) => replace(index, { constraints })}
              />
            </div>
          </li>
        ))}
      </ol>
      <AddRow onClick={() => onChange([...steps, { instruction: '', constraints: [] }])} ariaLabel="Add step">
        Add step
      </AddRow>
    </EditorSection>
  );
}

function KeyValueRows({ legend, rows, onChange, idPrefix }: {
  legend: string;
  rows: KeyValueDraft[];
  onChange: (rows: KeyValueDraft[]) => void;
  /** Prefix for accessible labels, e.g. "Example 1 input". */
  idPrefix: string;
}): React.JSX.Element {
  const replace = (index: number, patch: Partial<KeyValueDraft>): void => {
    onChange(rows.map((row, current) => (current === index ? { ...row, ...patch } : row)));
  };
  const lower = idPrefix.toLowerCase();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <h4 className="text-2xs font-medium text-muted-foreground">{legend}</h4>
        <AddRow onClick={() => onChange([...rows, { key: '', value: '' }])} ariaLabel={`Add ${lower} row`}>
          Add row
        </AddRow>
      </div>
      {rows.length === 0 ? <p className="text-2xs text-muted-foreground/80">No values. Add a row for each field.</p> : null}
      {rows.map((row, index) => (
        <div key={index} className="flex items-start gap-1.5">
          <input
            className={cn(inputClassName, 'flex-[0_0_38%]')}
            aria-label={`${idPrefix} ${index + 1} key`}
            placeholder="Field"
            value={row.key}
            onChange={(event) => replace(index, { key: event.target.value })}
          />
          <input
            className={inputClassName}
            aria-label={`${idPrefix} ${index + 1} value`}
            placeholder="Value"
            value={row.value}
            onChange={(event) => replace(index, { value: event.target.value })}
          />
          <RemoveRow label={`Remove ${lower} ${index + 1}`} onClick={() => onChange(rows.filter((_, current) => current !== index))} />
        </div>
      ))}
    </div>
  );
}

export function ExampleRows({ examples, onChange }: {
  examples: ExampleDraft[];
  onChange: (examples: ExampleDraft[]) => void;
}): React.JSX.Element {
  const replace = (index: number, patch: Partial<ExampleDraft>): void => {
    onChange(examples.map((example, current) => (current === index ? { ...example, ...patch } : example)));
  };
  return (
    <EditorSection title="Examples and tests" description="Show the agent a representative input and the output it should produce. Values that look like numbers or booleans are stored as such.">
      {examples.length === 0 ? <p className="rounded-lg border border-dashed border-border px-3 py-2 text-2xs text-muted-foreground">At least one example is required.</p> : null}
      <ol className="space-y-3">
        {examples.map((example, index) => (
          <li key={index} role="group" aria-label={`Example ${index + 1}`} className="space-y-2 rounded-lg border border-border bg-background/40 p-3">
            <div className="flex items-start gap-1.5">
              <input
                className={inputClassName}
                aria-label={`Example ${index + 1} title`}
                placeholder="Example title, e.g. Standard vendor invoice"
                value={example.title}
                onChange={(event) => replace(index, { title: event.target.value })}
              />
              <RemoveRow label={`Remove example ${index + 1}`} onClick={() => onChange(examples.filter((_, current) => current !== index))} />
            </div>
            <KeyValueRows
              legend="Input"
              rows={example.input}
              idPrefix={`Example ${index + 1} input`}
              onChange={(input) => replace(index, { input })}
            />
            <KeyValueRows
              legend="Expected output"
              rows={example.expectedOutput}
              idPrefix={`Example ${index + 1} expected output`}
              onChange={(expectedOutput) => replace(index, { expectedOutput })}
            />
          </li>
        ))}
      </ol>
      <AddRow onClick={() => onChange([...examples, { title: '', input: [], expectedOutput: [] }])} ariaLabel="Add example">
        Add example
      </AddRow>
    </EditorSection>
  );
}
