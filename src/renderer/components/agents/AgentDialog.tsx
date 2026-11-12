import { useEffect, useId, useState } from 'react';
import {
  SANDBOX_AGENT_COLORS, SANDBOX_TOOL_GROUPS,
  type SandboxAgent, type SandboxAgentInput, type SandboxApprovalPolicy, type SandboxToolGroup,
} from '@shared/sandbox-agents';
import type { RunChoice } from '@shared/agent-models';
import type { AgentOption } from '@shared/integrations-contract';
import { AgentMark } from '../chat/AgentMark';
import { AgentAvatar } from '../ui/AgentAvatar';
import { Alert, Button, Dialog, Switch, inputClassName, textareaClassName } from '../ui/primitives';
import { ArrowUpIcon, ChevronDownIcon, PlusIcon, Spinner, XIcon } from '../ui/icons';
import { cn } from '../../lib/cn';
import { ModelEffortPicker } from '../chat/ModelEffortPicker';

// Creating and editing a sandbox agent: who it is, what it does, which CLIs
// it runs on (in fallback order), its sandbox tools and its approval gate.

export const APPROVAL: Record<SandboxApprovalPolicy, { label: string; description: string }> = {
  risky: { label: 'Ask for risky actions', description: 'Commands, code, file changes and browser clicks or typing wait for you. Reading and looking never ask.' },
  all: { label: 'Ask for everything', description: 'Every sandbox action waits for you.' },
  none: { label: 'Never ask', description: 'The sandbox is the boundary; actions run without asking.' },
};

/** Ready-made agents to start from. */
export const TEMPLATES: Array<Omit<SandboxAgentInput, 'clis'>> = [
  {
    name: 'Web researcher', color: '#4a6fe8', approval: 'risky', tools: ['browser', 'documents', 'files'],
    description: 'Researches a topic on the web and writes up what it found, with sources.',
    instructions: 'Search and read primary sources in the sandbox browser. Cross-check facts across at least two sources. Finish with a concise summary and a list of the URLs you used.',
  },
  {
    name: 'QA tester', color: '#2a9763', approval: 'risky', tools: ['browser', 'shell', 'files'],
    description: 'Clicks through a web app like a user and reports what breaks.',
    instructions: 'Open the app in the sandbox browser and exercise the flows you are asked about. For each problem, give the steps to reproduce, what you expected and what happened, and take a screenshot.',
  },
  {
    name: 'Data analyst', color: '#c58c1c', approval: 'risky', tools: ['code', 'files', 'documents'],
    description: 'Cleans data, runs analyses in Python and explains the results.',
    instructions: 'Work in the sandbox with Python. Show the code you ran and the key numbers, and say how confident you are in each conclusion.',
  },
];

export function message(err: unknown): string {
  return err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err);
}

export function AgentDialog({ open, initial, editingId, clis, onClose, onSaved }: {
  open: boolean;
  initial: SandboxAgentInput;
  editingId: string | null;
  clis: AgentOption[];
  onClose: () => void;
  onSaved: (agent: SandboxAgent) => void;
}): React.JSX.Element {
  const [form, setForm] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setForm(initial); setError(null); }, [initial]);
  const ids = { name: useId(), description: useId(), instructions: useId() };
  const local = clis.filter((cli) => !cli.remote);
  const unused = local.filter((cli) => !form.clis.includes(cli.id));


  const move = (index: number, delta: number): void => {
    const next = [...form.clis];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item!);
    setForm({ ...form, clis: next });
  };
  const toggleTool = (tool: SandboxToolGroup): void => {
    setForm({ ...form, tools: form.tools.includes(tool) ? form.tools.filter((t) => t !== tool) : [...form.tools, tool] });
  };

  async function save(): Promise<void> {
    setBusy(true); setError(null);
    try {
      const saved = editingId === null
        ? await window.conductor.sandboxAgents.create(form)
        : await window.conductor.sandboxAgents.update({ id: editingId, ...form });
      onSaved(saved);
      onClose();
    } catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }

  const nameOf = (id: string): string => clis.find((cli) => cli.id === id)?.name ?? id;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editingId === null ? 'New agent' : `Edit ${initial.name}`}
      width="max-w-2xl"
      footer={<>
        <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="md" variant="primary" disabled={busy || form.name.trim() === '' || form.clis.length === 0 || form.tools.length === 0} onClick={() => { void save(); }}>
          {busy ? <Spinner size={13} /> : null}{editingId === null ? 'Create agent' : 'Save'}
        </Button>
      </>}
    >
      <form className="flex max-h-[68vh] flex-col gap-4 overflow-y-auto pr-1" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <div className="flex items-end gap-3">
          <span className="agent-stage flex size-16 shrink-0 items-center justify-center rounded-2xl" style={{ ['--agent-color' as string]: form.color }}>
            <AgentAvatar agent={{ name: form.name || 'New agent', color: form.color }} size={48} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <label htmlFor={ids.name} className="text-2xs font-medium text-muted-foreground">Name</label>
            <input id={ids.name} className={inputClassName} value={form.name} maxLength={60} placeholder="Web researcher" onChange={(e) => { setForm({ ...form, name: e.target.value }); }} />
          </div>
          <div role="radiogroup" aria-label="Colour" className="flex shrink-0 gap-1.5 pb-1.5">
            {SANDBOX_AGENT_COLORS.map((color) => (
              <button key={color} type="button" role="radio" aria-checked={form.color === color} aria-label={color} onClick={() => { setForm({ ...form, color }); }}
                className={cn('size-5 cursor-pointer rounded-full focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring', form.color === color && 'ring-2 ring-foreground ring-offset-2 ring-offset-surface-raised')} style={{ background: color }} />
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.description} className="text-2xs font-medium text-muted-foreground">What it’s for</label>
          <input id={ids.description} className={inputClassName} value={form.description} maxLength={300} placeholder="Researches a topic on the web and writes up what it found" onChange={(e) => { setForm({ ...form, description: e.target.value }); }} />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.instructions} className="text-2xs font-medium text-muted-foreground">Instructions <span className="font-normal">(given to the CLI on every run)</span></label>
          <textarea id={ids.instructions} rows={4} className={textareaClassName} value={form.instructions} maxLength={8000} placeholder="How it should work, what to check, what to hand back…" onChange={(e) => { setForm({ ...form, instructions: e.target.value }); }} />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="mb-1 text-2xs font-medium text-muted-foreground">Runs on <span className="font-normal">(in order; when one is out of usage the next takes over; pick a model for each)</span></legend>
          {form.clis.length === 0 ? <p className="text-2xs text-muted-foreground">Add at least one CLI.</p> : (
            <ol className="flex flex-col gap-1.5">
              {form.clis.map((id, index) => {
                const cli = clis.find((option) => option.id === id);
                return (
                  <li key={id} className="flex items-center gap-2 rounded-xl border border-border bg-card px-2.5 py-1.5">
                    <span className="w-14 shrink-0 text-3xs font-medium text-muted-foreground">{index === 0 ? 'First' : `Fallback ${index}`}</span>
                    <AgentMark agentId={id} name={nameOf(id)} size={20} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">{nameOf(id)}</span>
                    {cli !== undefined && !cli.available ? <span className="text-3xs text-warning">not available</span> : null}
                    <ModelEffortPicker
                      agentId={id}
                      label={nameOf(id)}
                      value={(form.models?.[id] ?? {}) as RunChoice}
                      onChange={(choice) => {
                        const models = { ...form.models };
                        if (Object.keys(choice).length === 0) delete models[id]; else models[id] = choice;
                        setForm({ ...form, models });
                      }}
                    />
                    <Button size="icon-sm" variant="ghost" aria-label={`Move ${nameOf(id)} up`} disabled={index === 0} onClick={() => { move(index, -1); }}><ArrowUpIcon size={12} /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Move ${nameOf(id)} down`} disabled={index === form.clis.length - 1} onClick={() => { move(index, 1); }}><ChevronDownIcon size={12} /></Button>
                    <Button size="icon-sm" variant="ghost" aria-label={`Remove ${nameOf(id)}`} onClick={() => { const models = { ...form.models }; delete models[id]; setForm({ ...form, clis: form.clis.filter((c) => c !== id), models }); }}><XIcon size={12} /></Button>
                  </li>
                );
              })}
            </ol>
          )}
          {unused.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {unused.map((cli) => (
                <button key={cli.id} type="button" onClick={() => { setForm({ ...form, clis: [...form.clis, cli.id] }); }} disabled={!cli.available}
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-dashed border-border-strong pr-2.5 pl-1 text-2xs font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                  title={cli.available ? `Add ${cli.name}` : `${cli.name} is not available`}>
                  <AgentMark agentId={cli.id} name={cli.name} size={18} />{cli.name}<PlusIcon size={11} />
                </button>
              ))}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-2xs font-medium text-muted-foreground">Sandbox tools</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {SANDBOX_TOOL_GROUPS.map((group) => {
              const on = form.tools.includes(group.id);
              return (
                <label key={group.id} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 transition-colors', on ? 'border-primary/40 bg-primary/6' : 'border-border hover:border-border-strong')}>
                  <Switch label={group.label} checked={on} onChange={() => { toggleTool(group.id); }} />
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-foreground">{group.label}</span>
                    <span className="block text-3xs leading-snug text-muted-foreground">{group.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1 text-2xs font-medium text-muted-foreground">Approval gate</legend>
          <div role="radiogroup" aria-label="Approval gate" className="flex flex-col gap-1.5">
            {(Object.keys(APPROVAL) as SandboxApprovalPolicy[]).map((policy) => (
              <button key={policy} type="button" role="radio" aria-checked={form.approval === policy} onClick={() => { setForm({ ...form, approval: policy }); }}
                className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring', form.approval === policy ? 'border-primary/50 bg-primary/8' : 'border-border hover:border-border-strong')}>
                <span aria-hidden="true" className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border', form.approval === policy ? 'border-primary' : 'border-border-strong')}>
                  {form.approval === policy ? <span className="size-2 rounded-full bg-primary" /> : null}
                </span>
                <span className="min-w-0">
                  <span className="block text-xs font-medium text-foreground">{APPROVAL[policy].label}</span>
                  <span className="block text-3xs leading-snug text-muted-foreground">{APPROVAL[policy].description}</span>
                </span>
              </button>
            ))}
          </div>
          <p className="text-3xs text-muted-foreground">Your permission profile still applies: Trusted automation or Auto-approve everything accepts without asking.</p>
        </fieldset>
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}

