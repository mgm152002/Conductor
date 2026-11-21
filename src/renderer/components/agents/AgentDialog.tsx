import { useEffect, useId, useState } from 'react';
import {
  SANDBOX_TOOL_GROUPS,
  type SandboxAgent, type SandboxAgentInput, type SandboxApprovalPolicy, type SandboxToolGroup,
} from '@shared/sandbox-agents';
import type { RunChoice } from '@shared/agent-models';
import type { AgentOption } from '@shared/integrations-contract';
import { AgentMark } from '../chat/AgentMark';
import { AgentAvatar } from '../ui/AgentAvatar';
import { Alert, Button, Dialog, Switch, inputClassName, textareaClassName } from '../ui/primitives';
import { ArrowUpIcon, ChevronDownIcon, PencilIcon, PlusIcon, Spinner, XIcon } from '../ui/icons';
import { cn } from '../../lib/cn';
import { fileToIcon, svgToIcon } from '../../lib/agent-icon';
import { IconChooser } from '../icons/IconChooser';
import { choiceDataUrl } from '../icons/IconPickerDialog';
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

const LABEL = 'text-sm font-medium text-foreground';
// Grouped rows: one rounded card, hairline dividers.
const GROUP = 'flex flex-col overflow-hidden rounded-xl border border-border/60 bg-card/40 *:not-first:border-t *:not-first:border-border/50';

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
  const [choosing, setChoosing] = useState(false);
  useEffect(() => { setForm(initial); setError(null); setChoosing(false); }, [initial]);
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
      <form className="flex max-h-[68vh] flex-col gap-5 overflow-y-auto pr-1" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        {/* Dialog shape: identity first, then labelled fields and grouped rows. */}
        <div className="flex items-start gap-4">
          {/* The icon opens the chooser below it: icon, emoji, monogram or image. */}
          <div className="flex shrink-0 flex-col items-center gap-1.5">
            <button type="button" aria-label="Choose icon" aria-expanded={choosing} title="Choose icon" onClick={() => { setChoosing((v) => !v); }}
              className="group/avatar relative cursor-pointer rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <AgentAvatar agent={{ name: form.name || 'New agent', color: form.color, icon: form.icon }} size={64} />
              <span aria-hidden="true" className="absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full border border-border bg-popover text-muted-foreground shadow-xs/5 group-hover/avatar:text-foreground"><PencilIcon size={11} /></span>
            </button>
            {form.icon !== undefined && form.icon !== '' ? <Button type="button" size="xs" variant="ghost" onClick={() => { setForm({ ...form, icon: '' }); }}>Reset</Button> : null}
          </div>
          {/* The icon chooser carries its own colours, so there is no separate colour row. */}
          <div className="flex min-w-0 flex-1 flex-col gap-1.5 self-center">
            <label htmlFor={ids.name} className={LABEL}>Name</label>
            <input id={ids.name} className={inputClassName} value={form.name} maxLength={60} placeholder="Web researcher" onChange={(e) => { setForm({ ...form, name: e.target.value }); }} />
          </div>
        </div>
        {choosing ? (
          <div className="rounded-xl border border-border/60 bg-card/40 p-3">
            <IconChooser name={form.name || 'Agent'} initialColor={form.color}
              onImage={fileToIcon}
              onChange={(choice) => {
                setError(null);
                const next = choice.kind === 'image' ? Promise.resolve(choice.dataUrl) : svgToIcon(choiceDataUrl(choice));
                void next.then((icon) => { setForm((current) => ({ ...current, icon })); }).catch((err: unknown) => { setError(message(err)); });
              }} />
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.description} className={LABEL}>What it’s for</label>
          <input id={ids.description} className={inputClassName} value={form.description} maxLength={300} placeholder="Researches a topic on the web and writes up what it found" onChange={(e) => { setForm({ ...form, description: e.target.value }); }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={ids.instructions} className={LABEL}>Instructions <span className="font-normal text-muted-foreground">· given to the CLI on every run</span></label>
          <textarea id={ids.instructions} rows={4} className={textareaClassName} value={form.instructions} maxLength={8000} placeholder="How it should work, what to check, what to hand back…" onChange={(e) => { setForm({ ...form, instructions: e.target.value }); }} />
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className={cn(LABEL, 'mb-0.5')}>Runs on</legend>
          <p className="-mt-1 text-xs text-muted-foreground">In order: when one is out of usage the next takes over. Pick a model for each.</p>
          {form.clis.length === 0 ? <p className="text-xs text-muted-foreground">Add at least one CLI.</p> : (
            <ol className={GROUP}>
              {form.clis.map((id, index) => {
                const cli = clis.find((option) => option.id === id);
                return (
                  <li key={id} className="flex items-center gap-2 px-3 py-2">
                    <AgentMark agentId={id} name={nameOf(id)} size={18} />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{nameOf(id)}<span className="text-xs text-muted-foreground"> · {index === 0 ? 'first' : `fallback ${index}`}</span></span>
                    {cli !== undefined && !cli.available ? <span className="text-xs text-warning">not available</span> : null}
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
                  className="flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border pr-2.5 pl-1.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-50"
                  title={cli.available ? `Add ${cli.name}` : `${cli.name} is not available`}>
                  <AgentMark agentId={cli.id} name={cli.name} size={18} />{cli.name}<PlusIcon size={11} />
                </button>
              ))}
            </div>
          ) : null}
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className={cn(LABEL, 'mb-1')}>Sandbox tools</legend>
          <div className={GROUP}>
            {SANDBOX_TOOL_GROUPS.map((group) => {
              const on = form.tools.includes(group.id);
              return (
                <label key={group.id} className="flex cursor-pointer items-center gap-3 px-3 py-2.5">
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm text-foreground">{group.label}</span>
                    <span className="block text-xs leading-snug text-muted-foreground">{group.description}</span>
                  </span>
                  <Switch label={group.label} checked={on} onChange={() => { toggleTool(group.id); }} />
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="flex flex-col gap-1.5">
          <legend className={cn(LABEL, 'mb-1')}>Approval gate</legend>
          <div role="radiogroup" aria-label="Approval gate" className={GROUP}>
            {(Object.keys(APPROVAL) as SandboxApprovalPolicy[]).map((policy) => (
              <button key={policy} type="button" role="radio" aria-checked={form.approval === policy} onClick={() => { setForm({ ...form, approval: policy }); }}
                className="flex w-full cursor-pointer items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-accent/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
                <span className="min-w-0 flex-1">
                  <span className="block text-sm text-foreground">{APPROVAL[policy].label}</span>
                  <span className="block text-xs leading-snug text-muted-foreground">{APPROVAL[policy].description}</span>
                </span>
                <span aria-hidden="true" className={cn('flex size-4 shrink-0 items-center justify-center rounded-full border', form.approval === policy ? 'border-primary bg-primary' : 'border-input')}>
                  {form.approval === policy ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
                </span>
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground">Your permission profile still applies: Trusted automation or Auto-approve everything accepts without asking.</p>
        </fieldset>
        {error !== null ? <Alert>{error}</Alert> : null}
      </form>
    </Dialog>
  );
}

