import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_REPLY_HOURS, flowProblem, FLOW_MAX_NODES, type AgentFlow, type FlowEdge, type FlowNode, type FlowRun, type FlowNodeStatus, type FlowSchedule } from '@shared/agent-flows';
import type { SandboxAgent } from '@shared/sandbox-agents';
import { buildCron, describeCron, readCron, WEEKDAYS, type ScheduleKind } from '../../lib/flow-schedule';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { AgentAvatar } from '../ui/AgentAvatar';
import { Alert, Button, Switch, inputClassName, textareaClassName } from '../ui/primitives';
import { ClockIcon, GlobeIcon, MailIcon, SparklesIcon, PlayIcon, PlusIcon, Spinner, TrashIcon } from '../ui/icons';
import { message } from './AgentDialog';
import { MailPanel } from './MailPanel';
import { ModelEffortPicker } from '../chat/ModelEffortPicker';
import { MenuSelect } from '../ui/MenuSelect';
import { AgentMark } from '../chat/AgentMark';
import { RunMarkdown } from './RunMarkdown';
import type { AgentOption } from '@shared/integrations-contract';
import { FLOW_TEMPLATES, pickAgent, type FlowTemplate } from '@shared/flow-templates';

// The flow canvas: agent steps as cards, arrows between them. A step starts
// when every step pointing at it has finished. Flows run by hand or on a schedule.

const REPLY = '__reply__';
const NODE_W = 232;
const NODE_H = 92;

const STATUS_TEXT: Record<FlowNodeStatus, string> = { waiting: 'Waiting', running: 'Working…', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
// Cards stay neutral and signals state with a small dot, not a coloured frame.
const STATUS_DOT: Record<FlowNodeStatus, string> = {
  waiting: 'bg-muted-foreground/40', running: 'bg-info animate-status-pulse', done: 'bg-success', failed: 'bg-destructive', skipped: 'bg-muted-foreground/30',
};

interface Draft { name: string; input: string; nodes: FlowNode[]; edges: FlowEdge[]; schedule: FlowSchedule | null }
const fromFlow = (flow: AgentFlow | null): Draft => flow === null
  ? { name: 'New flow', input: '', nodes: [], edges: [], schedule: null }
  : { name: flow.name, input: flow.input, nodes: flow.nodes, edges: flow.edges, schedule: flow.schedule };

const edgePath = (from: { x: number; y: number }, to: { x: number; y: number }): string => {
  const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
};

function SchedulePanel({ schedule, onChange, nextRunAt }: { schedule: FlowSchedule | null; onChange: (value: FlowSchedule | null) => void; nextRunAt: string | null }): React.JSX.Element {
  const preset = readCron(schedule?.cron ?? '0 9 * * *');
  const set = (patch: Partial<typeof preset>): void => {
    const next = { ...preset, ...patch };
    onChange({ cron: buildCron(next), enabled: schedule?.enabled ?? true });
  };
  return (
    <section className="flex flex-col gap-2.5" aria-label="Schedule">
      <div className="flex items-center gap-2">
        <h3 className="flex-1 text-sm font-medium text-foreground">Schedule</h3>
        <Switch label="Run on a schedule" checked={schedule?.enabled === true} onChange={(on) => { onChange({ cron: schedule?.cron ?? '0 9 * * *', enabled: on }); }} />
      </div>
      {schedule !== null ? (
        <>
          <MenuSelect variant="box" label="Repeat" value={preset.kind} onChange={(value) => { set({ kind: value as ScheduleKind }); }} options={[
            { value: 'minutes', label: 'Every few minutes' }, { value: 'hourly', label: 'Every hour' }, { value: 'daily', label: 'Every day' },
            { value: 'weekdays', label: 'Weekdays' }, { value: 'weekly', label: 'Every week' }, { value: 'custom', label: 'Custom (cron)' },
          ]} />
          {preset.kind === 'minutes' ? <label className="flex items-center gap-2 text-xs text-muted-foreground">Every<input type="number" min={1} max={59} aria-label="Minutes" className={cn(inputClassName, 'w-20')} value={preset.every} onChange={(e) => { set({ every: Number(e.target.value) }); }} />minutes</label> : null}
          {preset.kind === 'weekly' ? <MenuSelect variant="box" label="Day" value={String(preset.day)} onChange={(value) => { set({ day: Number(value) }); }} options={WEEKDAYS.map((day, i) => ({ value: String(i), label: day }))} /> : null}
          {preset.kind === 'daily' || preset.kind === 'weekdays' || preset.kind === 'weekly' ? <label className="flex items-center gap-2 text-xs text-muted-foreground">At<input type="time" aria-label="Time" className={cn(inputClassName, 'w-28')} value={preset.time} onChange={(e) => { set({ time: e.target.value }); }} /></label> : null}
          {preset.kind === 'hourly' ? <label className="flex items-center gap-2 text-xs text-muted-foreground">At minute<input type="number" min={0} max={59} aria-label="Minute" className={cn(inputClassName, 'w-20')} value={Number(preset.time.slice(3))} onChange={(e) => { set({ time: `09:${String(Number(e.target.value) || 0).padStart(2, '0')}` }); }} /></label> : null}
          {preset.kind === 'custom' ? <input aria-label="Cron expression" className={cn(inputClassName, 'font-mono')} placeholder="minute hour day month weekday" value={schedule.cron} onChange={(e) => { onChange({ cron: e.target.value, enabled: schedule.enabled }); }} /> : null}
          <p className="text-xs text-muted-foreground">
            {describeCron(schedule.cron)}
            {schedule.enabled && nextRunAt !== null ? ` · next ${new Date(nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
            {!schedule.enabled ? ' · paused' : ''}
          </p>
        </>
      ) : null}
    </section>
  );
}

export function FlowEditor({ flow, agents, sandboxRunning = false, onSaved, onDeleted, onOpenHistory }: {
  flow: AgentFlow | null;
  /** The sandbox this flow's steps share is up, so its browser can be watched. */
  sandboxRunning?: boolean;
  agents: SandboxAgent[];
  onSaved: (flow: AgentFlow) => void;
  onDeleted: () => void;
  onOpenHistory: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = useState<Draft>(() => fromFlow(flow));
  const [selected, setSelected] = useState<{ kind: 'node'; id: string } | { kind: 'edge'; index: number } | null>(null);
  const [runs, setRuns] = useState<FlowRun[]>([]);
  const [busy, setBusy] = useState<'save' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mailReady, setMailReady] = useState(false);
  const onMailChange = useCallback((status: { configured: boolean }) => { setMailReady(status.configured); }, []);
  const [clis, setClis] = useState<AgentOption[]>([]);
  const [describe, setDescribe] = useState('');
  const [drafting, setDrafting] = useState(false);
  const [connecting, setConnecting] = useState<{ from: string; x: number; y: number } | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const saved = useMemo(() => JSON.stringify(fromFlow(flow)), [flow]);
  const dirty = JSON.stringify(draft) !== saved;
  const problem = flowProblem(draft.nodes, draft.edges);
  const latest = runs[0];
  const live = latest?.status === 'running';
  const statusOf = (nodeId: string): FlowNodeStatus | undefined => latest?.nodes.find((node) => node.nodeId === nodeId)?.status;

  const loadRuns = useCallback(async () => {
    if (flow === null) return;
    try { setRuns(await window.conductor.flows.runs(flow.id)); } catch { /* shown on the next poll */ }
  }, [flow]);
  useEffect(() => { void loadRuns(); }, [loadRuns]);
  useEffect(() => { void window.conductor.agents.list().then(setClis).catch(() => undefined); }, []);
  useEffect(() => { void window.conductor.mail.status().then((status) => { setMailReady(status.configured); }).catch(() => undefined); }, []);
  useEffect(() => {
    if (flow === null) return undefined;
    const timer = window.setInterval(() => { void loadRuns(); }, live ? 2_000 : 10_000);
    return () => { window.clearInterval(timer); };
  }, [flow, live, loadRuns]);

  const update = (patch: Partial<Draft>): void => { setDraft((current) => ({ ...current, ...patch })); setError(null); };
  const patchNode = (id: string, patch: { [K in keyof FlowNode]?: FlowNode[K] | undefined }): void => {
    update({ nodes: draft.nodes.map((node) => {
      if (node.id !== id) return node;
      const next: Record<string, unknown> = { ...node, ...patch };
      for (const key of Object.keys(next)) if (next[key] === undefined) delete next[key];
      return next as unknown as FlowNode;
    }) });
  };

  function addStep(agentId: string): void {
    if (draft.nodes.length >= FLOW_MAX_NODES) { setError(`A flow can have up to ${FLOW_MAX_NODES} steps.`); return; }
    const last = draft.nodes[draft.nodes.length - 1];
    const reply = agentId === REPLY;
    const node: FlowNode = { id: `step-${Math.random().toString(36).slice(2, 8)}`, kind: reply ? 'reply' : 'agent', agentId: reply ? '' : agentId, ...(reply ? { waitHours: DEFAULT_REPLY_HOURS } : {}), prompt: '', x: last !== undefined ? last.x + NODE_W + 70 : 60, y: last !== undefined ? last.y : 80 };
    update({ nodes: [...draft.nodes, node], edges: last !== undefined ? [...draft.edges, { from: last.id, to: node.id }] : draft.edges });
    setSelected({ kind: 'node', id: node.id });
  }

  function removeNode(id: string): void {
    update({ nodes: draft.nodes.filter((node) => node.id !== id), edges: draft.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setSelected(null);
  }

  async function buildFromText(): Promise<void> {
    setDrafting(true); setError(null);
    try {
      const made = await window.conductor.flows.draft(describe);
      setDraft({ name: made.name, input: made.input, nodes: made.nodes as FlowNode[], edges: made.edges, schedule: made.schedule });
      setSelected(null);
    } catch (err) { setError(message(err)); }
    finally { setDrafting(false); }
  }

  function startFromTemplate(template: FlowTemplate): void {
    const picks = Object.fromEntries(template.roles.map((role) => [role.role, pickAgent(role, agents) ?? ''])) as Record<'scraper' | 'tailor' | 'applier', string>;
    const made = template.build(picks);
    setDraft({ name: made.name, input: made.input, nodes: made.nodes, edges: made.edges, schedule: made.schedule });
    setSelected(null);
  }

  const point = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvas.current?.getBoundingClientRect();
    return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) };
  };

  function dragNode(event: React.PointerEvent, node: FlowNode): void {
    if (event.button !== 0 || (event.target as HTMLElement).closest('[data-handle]') !== null) return;
    event.preventDefault();
    setSelected({ kind: 'node', id: node.id });
    const start = point(event);
    const origin = { x: node.x, y: node.y };
    const move = (e: PointerEvent): void => {
      const now = point(e);
      patchNodeLive(node.id, Math.max(0, Math.round(origin.x + now.x - start.x)), Math.max(0, Math.round(origin.y + now.y - start.y)));
    };
    const up = (): void => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }
  const patchNodeLive = (id: string, x: number, y: number): void => { setDraft((current) => ({ ...current, nodes: current.nodes.map((node) => (node.id === id ? { ...node, x, y } : node)) })); };

  function startConnect(event: React.PointerEvent, node: FlowNode): void {
    event.preventDefault();
    event.stopPropagation();
    const move = (e: PointerEvent): void => { setConnecting({ from: node.id, ...point(e) }); };
    const up = (e: PointerEvent): void => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setConnecting(null);
      const target = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)?.closest<HTMLElement>('[data-node-id]')?.dataset['nodeId'];
      if (target === undefined || target === node.id) return;
      setDraft((current) => {
        if (current.edges.some((edge) => edge.from === node.id && edge.to === target)) return current;
        const edges = [...current.edges, { from: node.id, to: target }];
        if (flowProblem(current.nodes, edges) !== undefined) { setError('That arrow would make a loop. A step can’t wait on itself through other steps.'); return current; }
        return { ...current, edges };
      });
    };
    move(event.nativeEvent);
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  }

  const toInput = () => ({ ...(flow !== null ? { id: flow.id } : {}), name: draft.name.trim() === '' ? 'Untitled flow' : draft.name.trim(), input: draft.input, nodes: draft.nodes, edges: draft.edges, schedule: draft.schedule });

  async function save(): Promise<AgentFlow | undefined> {
    setBusy('save'); setError(null);
    try { const next = await window.conductor.flows.save(toInput()); onSaved(next); return next; }
    catch (err) { setError(message(err)); return undefined; }
    finally { setBusy(null); }
  }
  async function stopRun(runId: string): Promise<void> {
    setError(null);
    try { await window.conductor.flows.stopRun(runId); await loadRuns(); } catch (err) { setError(message(err)); }
  }
  async function runAgain(input: string): Promise<void> {
    if (flow === null) return;
    setBusy('run'); setError(null);
    try { await window.conductor.flows.run(flow.id, input); await loadRuns(); }
    catch (err) { setError(message(err)); }
    finally { setBusy(null); }
  }
  async function runNow(): Promise<void> {
    setBusy('run'); setError(null);
    try {
      const target = dirty || flow === null ? await save() : flow;
      if (target === undefined) return;
      await window.conductor.flows.run(target.id);
      await loadRuns();
    } catch (err) { setError(message(err)); }
    finally { setBusy(null); }
  }

  const size = useMemo(() => ({
    w: Math.max(900, ...draft.nodes.map((node) => node.x + NODE_W + 120)),
    h: Math.max(520, ...draft.nodes.map((node) => node.y + NODE_H + 120)),
  }), [draft.nodes]);
  const node = selected?.kind === 'node' ? draft.nodes.find((item) => item.id === selected.id) : undefined;
  const nodePos = (id: string): FlowNode | undefined => draft.nodes.find((item) => item.id === id);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="window-header flex shrink-0 items-center gap-1.5 border-b border-border px-4">
        <input aria-label="Flow name" value={draft.name} maxLength={80} onChange={(e) => { update({ name: e.target.value }); }} className="min-w-0 flex-1 bg-transparent text-sm font-medium text-foreground outline-none" />
        {live ? <span className="flex items-center gap-1.5 text-xs text-info"><Spinner size={12} />Running</span> : null}
        {live && latest !== undefined ? <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void stopRun(latest.id); }}>Stop</Button> : null}
        {flow !== null && sandboxRunning ? <Button size="sm" variant="ghost" title="Watch the flow’s browser live" onClick={() => { window.conductor.sandbox.openFlowViewer(flow.id).catch((err: unknown) => { setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not open the sandbox'); }); }}><GlobeIcon size={13} />Watch</Button> : null}
        <Button size="sm" variant="ghost" title="Every run of your flows" onClick={onOpenHistory}><ClockIcon size={13} />History</Button>
        {flow !== null && latest !== undefined && !live ? <Button size="sm" variant="outline" disabled={busy !== null || dirty} title={dirty ? 'Save your changes first' : 'Run again with the input of the last run'} onClick={() => { void runAgain(latest.input); }}><PlayIcon size={13} />Run again</Button> : null}
        <Button size="sm" variant="outline" disabled={busy !== null || !dirty || draft.nodes.length === 0 || problem !== undefined} onClick={() => { void save(); }}>{busy === 'save' ? <Spinner size={13} /> : null}{dirty ? 'Save' : 'Saved'}</Button>
        <Button size="sm" variant="primary" disabled={busy !== null || live || draft.nodes.length === 0 || problem !== undefined} onClick={() => { void runNow(); }}>{busy === 'run' ? <Spinner size={13} /> : <PlayIcon size={13} />}Run now</Button>
        {flow !== null ? <Button size="icon-sm" variant="ghost" aria-label="Delete flow" title="Delete flow" onClick={onDeleted}><TrashIcon size={13} /></Button> : null}
      </header>
      {error !== null ? <div className="px-4 pt-3"><Alert action={<Button size="xs" variant="ghost" onClick={() => { setError(null); }}>Dismiss</Button>}>{error}</Alert></div> : null}
      {problem !== undefined && draft.nodes.length > 0 ? <div className="px-4 pt-3"><Alert tone="warning">{problem}</Alert></div> : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-auto bg-background" aria-label="Flow canvas" tabIndex={0}
          onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
          onKeyDown={(e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'INPUT') {
              if (selected?.kind === 'node') removeNode(selected.id);
              else if (selected?.kind === 'edge') { update({ edges: draft.edges.filter((_, i) => i !== selected.index) }); setSelected(null); }
            }
          }}>
          <div ref={canvas} className="relative min-h-full min-w-full" style={{ width: size.w, height: size.h, backgroundImage: 'radial-gradient(color-mix(in srgb, var(--color-muted-foreground) 22%, transparent) 1px, transparent 1px)', backgroundSize: '20px 20px' }}
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
            <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h} aria-hidden="true">
              <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor" /></marker></defs>
              {draft.edges.map((edge, index) => {
                const a = nodePos(edge.from); const b = nodePos(edge.to);
                if (a === undefined || b === undefined) return null;
                const d = edgePath({ x: a.x + NODE_W, y: a.y + NODE_H / 2 }, { x: b.x, y: b.y + NODE_H / 2 });
                const on = selected?.kind === 'edge' && selected.index === index;
                return (
                  <g key={`${edge.from}-${edge.to}`} className={on ? 'text-foreground' : 'text-muted-foreground/60'}>
                    <path d={d} fill="none" stroke="currentColor" strokeWidth={on ? 2 : 1.25} markerEnd="url(#flow-arrow)" />
                    <path d={d} fill="none" stroke="transparent" strokeWidth={14} className="cursor-pointer" style={{ pointerEvents: 'stroke' }} onPointerDown={(e) => { e.stopPropagation(); setSelected({ kind: 'edge', index }); }} />
                  </g>
                );
              })}
              {connecting !== null && nodePos(connecting.from) !== undefined ? (
                <path d={edgePath({ x: nodePos(connecting.from)!.x + NODE_W, y: nodePos(connecting.from)!.y + NODE_H / 2 }, connecting)} fill="none" stroke="currentColor" strokeWidth={1.25} strokeDasharray="4 4" className="text-muted-foreground" />
              ) : null}
            </svg>
            {draft.nodes.map((item) => {
              const isReply = item.kind === 'reply';
              const agent = isReply ? undefined : agentById.get(item.agentId);
              const status = statusOf(item.id);
              const on = selected?.kind === 'node' && selected.id === item.id;
              return (
                <div key={item.id} data-node-id={item.id} onPointerDown={(e) => { dragNode(e, item); }}
                  className={cn('absolute flex cursor-grab touch-none select-none flex-col justify-center gap-1.5 rounded-xl border bg-card px-3.5 shadow-xs/5 transition-colors active:cursor-grabbing',
                    on ? 'border-ring ring-2 ring-ring/20' : 'border-border hover:border-input', status === 'skipped' && 'opacity-60')}
                  style={{ left: item.x, top: item.y, width: NODE_W, height: NODE_H }}>
                  <span data-handle title="Receives the work of the steps before it" className="absolute top-1/2 -left-[5px] size-2.5 -translate-y-1/2 rounded-full border border-input bg-background" />
                  <span data-handle role="button" aria-label={`Draw an arrow from ${agent?.name ?? 'this step'}`} title="Drag to another step to run it after this one"
                    onPointerDown={(e) => { startConnect(e, item); }}
                    className="absolute top-1/2 -right-[5px] size-2.5 -translate-y-1/2 cursor-crosshair rounded-full border border-input bg-background transition-transform hover:scale-150 hover:border-foreground" />
                  <span className="flex items-center gap-2">
                    {isReply ? <span className="grid size-5 place-items-center rounded-md bg-accent text-muted-foreground"><MailIcon size={12} /></span> : agent !== undefined ? <AgentAvatar agent={agent} size={20} /> : <span className="size-5 rounded-md bg-muted" />}
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">{isReply ? 'Wait for your reply' : agent?.name ?? 'Missing agent'}</span>
                    {status !== undefined ? <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">{status === 'running' ? <Spinner size={11} /> : <span aria-hidden="true" className={cn('size-1.5 rounded-full', STATUS_DOT[status])} />}{STATUS_TEXT[status]}</span> : null}
                  </span>
                  <span className="line-clamp-2 text-xs leading-snug text-muted-foreground">{isReply ? `Pauses until you answer the email (up to ${item.waitHours ?? DEFAULT_REPLY_HOURS} h)` : item.prompt.trim() === '' ? 'Add what this step should do' : item.prompt}</span>
                </div>
              );
            })}
            {draft.nodes.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" onPointerDown={(e) => { e.stopPropagation(); }}>
                <p className="text-sm font-medium text-foreground">Describe the flow you want</p>
                <textarea aria-label="Describe the flow" rows={4} className={cn(textareaClassName, 'w-full max-w-md')} value={describe} onChange={(e) => { setDescribe(e.target.value); }}
                  placeholder="e.g. Every morning at 9, have the scraper find new Summer 2027 backend internships, the resume agent tailor a resume for each and email me the list, then apply to the ones I reply with." />
                <Button size="md" variant="primary" disabled={drafting || describe.trim().length < 3 || agents.length === 0} onClick={() => { void buildFromText(); }}>{drafting ? <Spinner size={13} /> : <SparklesIcon size={13} />}{drafting ? 'Building…' : 'Build it'}</Button>
                <div className="flex flex-wrap justify-center gap-2">
                  {FLOW_TEMPLATES.map((template) => <Button key={template.id} size="sm" variant="outline" disabled={agents.length === 0} title={template.summary} onClick={() => { startFromTemplate(template); }}>Start from “{template.title}”</Button>)}
                </div>
              </div>
            ) : null}
          </div>
          <div className="sticky bottom-3 left-3 w-fit">
            <MenuSelect label="Add a step" value="" disabled={agents.length === 0} onChange={(value) => { if (value !== '') addStep(value); }} className="bg-popover shadow-lg/5"
              options={[
                { value: '', label: agents.length === 0 ? 'Create an agent first' : 'Add a step…', mark: <PlusIcon size={13} /> },
                ...agents.map((agent) => ({ value: agent.id, label: agent.name, mark: <AgentAvatar agent={agent} size={16} /> })),
                { value: REPLY, label: 'Wait for my email reply', mark: <MailIcon size={13} /> },
              ]} />
          </div>
        </div>

        <aside aria-label="Details" className="flex w-[320px] shrink-0 flex-col gap-6 overflow-y-auto border-l border-border bg-card/40 p-4">
          {node !== undefined ? (
            <section className="flex flex-col gap-2.5" aria-label="Step">
              <h3 className="text-sm font-medium text-foreground">Step</h3>
              {node.kind === 'reply' ? (
                <>
                  <p className="text-xs text-muted-foreground">Waits for your email reply, then passes it on.</p>
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">Give up after<input type="number" min={1} max={336} aria-label="Hours to wait" className={cn(inputClassName, 'w-20')} value={node.waitHours ?? DEFAULT_REPLY_HOURS} onChange={(e) => { patchNode(node.id, { waitHours: Math.max(1, Math.round(Number(e.target.value)) || DEFAULT_REPLY_HOURS) }); }} />hours</label>
                  {!mailReady ? (
                    <>
                      <Alert tone="warning">Email isn’t connected yet, so this step can’t be answered. Connect AgentMail here.</Alert>
                      <MailPanel onChange={onMailChange} />
                    </>
                  ) : null}
                </>
              ) : (
                <>
                  <MenuSelect variant="box" label="Agent" value={node.agentId} onChange={(value) => { patchNode(node.id, { agentId: value }); }}
                    options={agents.map((agent) => ({ value: agent.id, label: agent.name, mark: <AgentAvatar agent={agent} size={16} /> }))} />
                  <div className="flex flex-col gap-1.5">
                    <span className="text-xs text-muted-foreground">Runs on</span>
                    <MenuSelect variant="box" label="CLI for this step" value={node.cli ?? ''} onChange={(value) => { patchNode(node.id, { cli: value === '' ? undefined : value, model: undefined, effort: undefined }); }}
                      options={[
                        { value: '', label: 'The agent’s own order', hint: (agentById.get(node.agentId)?.clis ?? []).map((id) => clis.find((c) => c.id === id)?.name ?? id).join(' → ') || 'none' },
                        ...clis.filter((c) => !c.remote).map((c) => ({ value: c.id, label: c.name, disabled: !c.available, ...(c.available ? {} : { hint: 'not available' }), mark: <AgentMark agentId={c.id} name={c.name} size={14} /> })),
                      ]} />
                    {(node.cli ?? agentById.get(node.agentId)?.clis[0]) !== undefined ? (
                      <ModelEffortPicker variant="box" agentId={(node.cli ?? agentById.get(node.agentId)?.clis[0])!} label="Step model"
                        value={{ ...(node.model !== undefined ? { model: node.model } : {}), ...(node.effort !== undefined ? { effort: node.effort } : {}) }}
                        onChange={(choice) => { patchNode(node.id, { model: choice.model, effort: choice.effort }); }} />
                    ) : null}
                    <p className="text-xs text-muted-foreground">{node.model === undefined && node.effort === undefined ? 'Model and effort: Auto (or what the agent set for that CLI).' : 'This step overrides the agent’s model.'}</p>
                  </div>
                  <textarea aria-label="What this step does" rows={9} className={textareaClassName} value={node.prompt} placeholder="What should this agent do? Use {{input}} for the flow's input." onChange={(e) => { patchNode(node.id, { prompt: e.target.value }); }} />
                </>
              )}
              {statusOf(node.id) !== undefined ? <StepOutput run={latest} nodeId={node.id} /> : null}
              <Button size="sm" variant="ghost" className="self-start text-destructive-foreground" onClick={() => { removeNode(node.id); }}><TrashIcon size={13} />Remove step</Button>
            </section>
          ) : selected?.kind === 'edge' ? (
            <section className="flex flex-col gap-2.5" aria-label="Arrow">
              <h3 className="text-sm font-medium text-foreground">Arrow</h3>
              <Button size="sm" variant="outline" className="self-start" onClick={() => { update({ edges: draft.edges.filter((_, i) => i !== selected.index) }); setSelected(null); }}><TrashIcon size={13} />Remove arrow</Button>
            </section>
          ) : (
            <>
              <section className="flex flex-col gap-2" aria-label="Input">
                <h3 className="text-sm font-medium text-foreground">What this flow should do</h3>
                <textarea aria-label="Flow input" rows={7} className={textareaClassName} value={draft.input} placeholder="The exact details of this run (for example which jobs you want). Steps use it as {{input}}, so edit it any time without touching the steps." onChange={(e) => { update({ input: e.target.value }); }} />
              </section>
              <SchedulePanel schedule={draft.schedule} nextRunAt={flow?.nextRunAt ?? null} onChange={(schedule) => { update({ schedule }); }} />
              <MailPanel onChange={onMailChange} />
            </>
          )}
          {flow !== null ? (
            <section className="flex flex-col gap-1.5" aria-label="Runs">
              <h3 className="text-sm font-medium text-foreground">Runs</h3>
              {runs.length === 0 ? <p className="text-xs text-muted-foreground">No runs yet.</p> : (
                <ul className="flex flex-col">
                  {runs.map((run) => (
                    <li key={run.id} className="flex h-8 items-center gap-2 rounded-md px-2 text-sm text-foreground/85 hover:bg-accent">
                      <span className={cn('size-1.5 shrink-0 rounded-full', run.status === 'running' ? 'bg-info animate-status-pulse' : run.status === 'done' ? 'bg-success' : 'bg-destructive')} />
                      <span className="min-w-0 flex-1 truncate">{run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : 'Failed'}<span className="text-muted-foreground"> · {run.trigger === 'schedule' ? 'scheduled' : 'by hand'}</span></span>
                      <span className="text-xs text-muted-foreground tabular-nums">{relativeTime(run.startedAt)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </aside>
      </div>
    </div>
  );
}

function StepOutput({ run, nodeId }: { run: FlowRun | undefined; nodeId: string }): React.JSX.Element | null {
  const state = run?.nodes.find((item) => item.nodeId === nodeId);
  if (state === undefined) return null;
  return (
    <div className="rounded-xl border border-border bg-card p-3">
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground"><span aria-hidden="true" className={cn('size-1.5 rounded-full', STATUS_DOT[state.status])} />Last run · {STATUS_TEXT[state.status]}</p>
      {state.note !== '' ? <p className="mt-1.5 text-xs text-destructive-foreground">{state.note}</p> : null}
      {state.output !== '' ? <div className="mt-2 max-h-60 overflow-y-auto text-sm"><RunMarkdown text={state.output} /></div> : null}
    </div>
  );
}
