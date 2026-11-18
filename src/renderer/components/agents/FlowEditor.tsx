import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_REPLY_HOURS, flowProblem, FLOW_MAX_NODES, type AgentFlow, type FlowEdge, type FlowNode, type FlowRun, type FlowNodeStatus, type FlowSchedule } from '@shared/agent-flows';
import type { SandboxAgent } from '@shared/sandbox-agents';
import { buildCron, describeCron, readCron, WEEKDAYS, type ScheduleKind } from '../../lib/flow-schedule';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { AgentAvatar } from '../ui/AgentAvatar';
import { Alert, Button, Switch, inputClassName, textareaClassName } from '../ui/primitives';
import { ClockIcon, MailIcon, SparklesIcon, PlayIcon, PlusIcon, Spinner, TrashIcon, WorkflowIcon } from '../ui/icons';
import { message } from './AgentDialog';
import { MailPanel } from './MailPanel';
import { ModelEffortPicker } from '../chat/ModelEffortPicker';
import type { AgentOption } from '@shared/integrations-contract';
import { FLOW_TEMPLATES, pickAgent, type FlowTemplate } from '@shared/flow-templates';

// The flow canvas: agent steps as cards, arrows between them. A step starts
// when every step pointing at it has finished. Flows run by hand or on a schedule.

const REPLY = '__reply__';
const NODE_W = 232;
const NODE_H = 92;

const STATUS_TEXT: Record<FlowNodeStatus, string> = { waiting: 'Waiting', running: 'Working…', done: 'Done', failed: 'Failed', skipped: 'Skipped' };
const STATUS_RING: Record<FlowNodeStatus, string> = {
  waiting: 'border-border', running: 'border-info shadow-[0_0_0_3px_color-mix(in_srgb,var(--color-info)_25%,transparent)]',
  done: 'border-success', failed: 'border-destructive', skipped: 'border-border opacity-60',
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
        <ClockIcon size={14} className="text-muted-foreground" />
        <h3 className="flex-1 text-xs font-semibold text-foreground">Schedule</h3>
        <Switch label="Run on a schedule" checked={schedule?.enabled === true} onChange={(on) => { onChange({ cron: schedule?.cron ?? '0 9 * * *', enabled: on }); }} />
      </div>
      {schedule !== null ? (
        <>
          <select aria-label="Repeat" className={inputClassName} value={preset.kind} onChange={(e) => { set({ kind: e.target.value as ScheduleKind }); }}>
            <option value="minutes">Every few minutes</option><option value="hourly">Every hour</option><option value="daily">Every day</option>
            <option value="weekdays">Weekdays</option><option value="weekly">Every week</option><option value="custom">Custom (cron)</option>
          </select>
          {preset.kind === 'minutes' ? <label className="flex items-center gap-2 text-xs text-muted-foreground">Every<input type="number" min={1} max={59} aria-label="Minutes" className={cn(inputClassName, 'w-20')} value={preset.every} onChange={(e) => { set({ every: Number(e.target.value) }); }} />minutes</label> : null}
          {preset.kind === 'weekly' ? <select aria-label="Day" className={inputClassName} value={preset.day} onChange={(e) => { set({ day: Number(e.target.value) }); }}>{WEEKDAYS.map((day, i) => <option key={day} value={i}>{day}</option>)}</select> : null}
          {preset.kind === 'daily' || preset.kind === 'weekdays' || preset.kind === 'weekly' ? <label className="flex items-center gap-2 text-xs text-muted-foreground">At<input type="time" aria-label="Time" className={cn(inputClassName, 'w-28')} value={preset.time} onChange={(e) => { set({ time: e.target.value }); }} /></label> : null}
          {preset.kind === 'hourly' ? <label className="flex items-center gap-2 text-xs text-muted-foreground">At minute<input type="number" min={0} max={59} aria-label="Minute" className={cn(inputClassName, 'w-20')} value={Number(preset.time.slice(3))} onChange={(e) => { set({ time: `09:${String(Number(e.target.value) || 0).padStart(2, '0')}` }); }} /></label> : null}
          {preset.kind === 'custom' ? <input aria-label="Cron expression" className={cn(inputClassName, 'font-mono')} placeholder="minute hour day month weekday" value={schedule.cron} onChange={(e) => { onChange({ cron: e.target.value, enabled: schedule.enabled }); }} /> : null}
          <p className="text-2xs text-muted-foreground">
            {describeCron(schedule.cron)} · your computer’s time
            {schedule.enabled && nextRunAt !== null ? ` · next ${new Date(nextRunAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}
            {!schedule.enabled ? ' · paused' : ''}
          </p>
          <p className="text-2xs text-muted-foreground">Conductor has to be open for a scheduled run to start; one that was missed runs when it opens.</p>
        </>
      ) : <p className="text-2xs text-muted-foreground">Off. Use Run now to start it yourself.</p>}
    </section>
  );
}

export function FlowEditor({ flow, agents, onSaved, onDeleted, onOpenHistory }: {
  flow: AgentFlow | null;
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
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4">
        <WorkflowIcon size={16} className="text-muted-foreground" />
        <input aria-label="Flow name" value={draft.name} maxLength={80} onChange={(e) => { update({ name: e.target.value }); }} className="min-w-0 flex-1 bg-transparent font-display text-[15px] font-semibold text-foreground outline-none" />
        {live ? <span className="flex items-center gap-1.5 text-2xs text-info"><Spinner size={12} />Running</span> : null}
        {live && latest !== undefined ? <Button size="md" variant="outline" disabled={busy !== null} onClick={() => { void stopRun(latest.id); }}>Stop</Button> : null}
        <Button size="md" variant="ghost" title="Every run of your flows" onClick={onOpenHistory}><ClockIcon size={13} />History</Button>
        {flow !== null && latest !== undefined && !live ? <Button size="md" variant="outline" disabled={busy !== null || dirty} title={dirty ? 'Save your changes first' : 'Run again with the input of the last run'} onClick={() => { void runAgain(latest.input); }}><PlayIcon size={13} />Run again</Button> : null}
        <Button size="md" variant="outline" disabled={busy !== null || !dirty || draft.nodes.length === 0 || problem !== undefined} onClick={() => { void save(); }}>{busy === 'save' ? <Spinner size={13} /> : null}{dirty ? 'Save' : 'Saved'}</Button>
        <Button size="md" variant="primary" disabled={busy !== null || live || draft.nodes.length === 0 || problem !== undefined} onClick={() => { void runNow(); }}>{busy === 'run' ? <Spinner size={13} /> : <PlayIcon size={13} />}Run now</Button>
        {flow !== null ? <Button size="icon" variant="ghost" aria-label="Delete flow" title="Delete flow" onClick={onDeleted}><TrashIcon size={15} /></Button> : null}
      </header>
      {error !== null ? <div className="px-4 pt-3"><Alert action={<Button size="xs" variant="ghost" onClick={() => { setError(null); }}>Dismiss</Button>}>{error}</Alert></div> : null}
      {problem !== undefined && draft.nodes.length > 0 ? <div className="px-4 pt-3"><Alert tone="warning">{problem}</Alert></div> : null}

      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1 overflow-auto bg-muted/30" aria-label="Flow canvas" tabIndex={0}
          onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}
          onKeyDown={(e) => {
            if ((e.key === 'Delete' || e.key === 'Backspace') && (e.target as HTMLElement).tagName !== 'TEXTAREA' && (e.target as HTMLElement).tagName !== 'INPUT') {
              if (selected?.kind === 'node') removeNode(selected.id);
              else if (selected?.kind === 'edge') { update({ edges: draft.edges.filter((_, i) => i !== selected.index) }); setSelected(null); }
            }
          }}>
          <div ref={canvas} className="relative min-h-full min-w-full" style={{ width: size.w, height: size.h, backgroundImage: 'radial-gradient(var(--color-border) 1px, transparent 1px)', backgroundSize: '22px 22px' }}
            onPointerDown={(e) => { if (e.target === e.currentTarget) setSelected(null); }}>
            <svg className="pointer-events-none absolute inset-0" width={size.w} height={size.h} aria-hidden="true">
              <defs><marker id="flow-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="currentColor" /></marker></defs>
              {draft.edges.map((edge, index) => {
                const a = nodePos(edge.from); const b = nodePos(edge.to);
                if (a === undefined || b === undefined) return null;
                const d = edgePath({ x: a.x + NODE_W, y: a.y + NODE_H / 2 }, { x: b.x, y: b.y + NODE_H / 2 });
                const on = selected?.kind === 'edge' && selected.index === index;
                return (
                  <g key={`${edge.from}-${edge.to}`} className={on ? 'text-primary' : 'text-muted-foreground'}>
                    <path d={d} fill="none" stroke="currentColor" strokeWidth={on ? 2.5 : 1.75} markerEnd="url(#flow-arrow)" />
                    <path d={d} fill="none" stroke="transparent" strokeWidth={14} className="cursor-pointer" style={{ pointerEvents: 'stroke' }} onPointerDown={(e) => { e.stopPropagation(); setSelected({ kind: 'edge', index }); }} />
                  </g>
                );
              })}
              {connecting !== null && nodePos(connecting.from) !== undefined ? (
                <path d={edgePath({ x: nodePos(connecting.from)!.x + NODE_W, y: nodePos(connecting.from)!.y + NODE_H / 2 }, connecting)} fill="none" stroke="currentColor" strokeWidth={1.75} strokeDasharray="5 4" className="text-primary" />
              ) : null}
            </svg>
            {draft.nodes.map((item) => {
              const isReply = item.kind === 'reply';
              const agent = isReply ? undefined : agentById.get(item.agentId);
              const status = statusOf(item.id);
              const on = selected?.kind === 'node' && selected.id === item.id;
              return (
                <div key={item.id} data-node-id={item.id} onPointerDown={(e) => { dragNode(e, item); }}
                  className={cn('absolute flex cursor-grab touch-none select-none flex-col justify-center gap-1 rounded-2xl border-2 bg-card px-3 shadow-lift active:cursor-grabbing',
                    status !== undefined ? STATUS_RING[status] : on ? 'border-primary' : 'border-border')}
                  style={{ left: item.x, top: item.y, width: NODE_W, height: NODE_H }}>
                  <span data-handle title="Receives the work of the steps before it" className="absolute top-1/2 -left-2 size-3.5 -translate-y-1/2 rounded-full border-2 border-border-strong bg-card" />
                  <span data-handle role="button" aria-label={`Draw an arrow from ${agent?.name ?? 'this step'}`} title="Drag to another step to run it after this one"
                    onPointerDown={(e) => { startConnect(e, item); }}
                    className="absolute top-1/2 -right-2 size-3.5 -translate-y-1/2 cursor-crosshair rounded-full border-2 border-primary bg-card hover:scale-125" />
                  <span className="flex items-center gap-2">
                    {isReply ? <span className="grid size-[26px] place-items-center rounded-lg bg-info/15 text-info"><MailIcon size={14} /></span> : agent !== undefined ? <AgentAvatar agent={agent} size={26} /> : <span className="size-[26px] rounded-lg bg-muted" />}
                    <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-foreground">{isReply ? 'Wait for your reply' : agent?.name ?? 'Missing agent'}</span>
                    {status !== undefined ? <span className={cn('text-3xs font-medium', status === 'failed' ? 'text-destructive-foreground' : status === 'done' ? 'text-success' : 'text-muted-foreground')}>{status === 'running' ? <Spinner size={11} /> : STATUS_TEXT[status]}</span> : null}
                  </span>
                  <span className="line-clamp-2 text-2xs text-muted-foreground">{isReply ? `Pauses until you answer the email (up to ${item.waitHours ?? DEFAULT_REPLY_HOURS} h)` : item.prompt.trim() === '' ? 'Add what this step should do' : item.prompt}</span>
                </div>
              );
            })}
            {draft.nodes.length === 0 ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center" onPointerDown={(e) => { e.stopPropagation(); }}>
                <p className="text-sm font-semibold text-foreground">Describe the flow you want</p>
                <textarea aria-label="Describe the flow" rows={4} className={cn(textareaClassName, 'w-full max-w-md')} value={describe} onChange={(e) => { setDescribe(e.target.value); }}
                  placeholder="e.g. Every morning at 9, have the scraper find new Summer 2027 backend internships, the resume agent tailor a resume for each and email me the list, then apply to the ones I reply with." />
                <Button size="md" variant="primary" disabled={drafting || describe.trim().length < 3 || agents.length === 0} onClick={() => { void buildFromText(); }}>{drafting ? <Spinner size={13} /> : <SparklesIcon size={13} />}{drafting ? 'Building…' : 'Build it'}</Button>
                <p className="max-w-sm text-2xs text-muted-foreground">It lays out the steps for you to review and edit. Or add steps yourself below and draw arrows between them; steps with no arrow between them run at the same time.</p>
                <div className="flex flex-wrap justify-center gap-2">
                  {FLOW_TEMPLATES.map((template) => <Button key={template.id} size="sm" variant="outline" disabled={agents.length === 0} title={template.summary} onClick={() => { startFromTemplate(template); }}>Start from “{template.title}”</Button>)}
                </div>
              </div>
            ) : null}
          </div>
          <div className="sticky bottom-3 left-3 flex w-fit items-center gap-2 rounded-xl border border-border bg-card p-1.5 shadow-lift">
            <PlusIcon size={14} className="ml-1 text-muted-foreground" />
            <select aria-label="Add a step" className={cn(inputClassName, 'w-44')} value="" disabled={agents.length === 0} onChange={(e) => { if (e.target.value !== '') addStep(e.target.value); }}>
              <option value="">{agents.length === 0 ? 'Create an agent first' : 'Add a step…'}</option>
              {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
              <option value={REPLY}>Wait for my email reply</option>
            </select>
          </div>
        </div>

        <aside aria-label="Details" className="flex w-[300px] shrink-0 flex-col gap-4 overflow-y-auto border-l border-border p-4">
          {node !== undefined ? (
            <section className="flex flex-col gap-2.5" aria-label="Step">
              <h3 className="text-xs font-semibold text-foreground">Step</h3>
              {node.kind === 'reply' ? (
                <>
                  <p className="text-2xs text-muted-foreground">The flow pauses here until you reply to the email a step before sent you. What you wrote is handed to the steps after this one (for example “apply to all”).</p>
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
                  <select aria-label="Agent" className={inputClassName} value={node.agentId} onChange={(e) => { patchNode(node.id, { agentId: e.target.value }); }}>
                    {agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
                  </select>
                  <div className="flex flex-col gap-1.5">
                    <span className="text-2xs font-medium text-muted-foreground">Runs on</span>
                    <select aria-label="CLI for this step" className={inputClassName} value={node.cli ?? ''} onChange={(e) => { patchNode(node.id, { cli: e.target.value === '' ? undefined : e.target.value, model: undefined, effort: undefined }); }}>
                      <option value="">The agent’s own order ({(agentById.get(node.agentId)?.clis ?? []).map((id) => clis.find((c) => c.id === id)?.name ?? id).join(' → ') || 'none'})</option>
                      {clis.filter((c) => !c.remote).map((c) => <option key={c.id} value={c.id} disabled={!c.available}>{c.name}{c.available ? '' : ' (not available)'}</option>)}
                    </select>
                    {(node.cli ?? agentById.get(node.agentId)?.clis[0]) !== undefined ? (
                      <ModelEffortPicker variant="box" agentId={(node.cli ?? agentById.get(node.agentId)?.clis[0])!} label="Step model"
                        value={{ ...(node.model !== undefined ? { model: node.model } : {}), ...(node.effort !== undefined ? { effort: node.effort } : {}) }}
                        onChange={(choice) => { patchNode(node.id, { model: choice.model, effort: choice.effort }); }} />
                    ) : null}
                    <p className="text-2xs text-muted-foreground">{node.model === undefined && node.effort === undefined ? 'Model and effort: Auto (or what the agent set for that CLI).' : 'This step overrides the agent’s model.'}</p>
                  </div>
                  <textarea aria-label="What this step does" rows={9} className={textareaClassName} value={node.prompt} placeholder="What should this agent do? Use {{input}} for the flow's input." onChange={(e) => { patchNode(node.id, { prompt: e.target.value }); }} />
                  <p className="text-2xs text-muted-foreground">It also gets what the steps before it said.</p>
                </>
              )}
              {statusOf(node.id) !== undefined ? <StepOutput run={latest} nodeId={node.id} /> : null}
              <Button size="sm" variant="ghost" className="self-start text-destructive-foreground" onClick={() => { removeNode(node.id); }}><TrashIcon size={13} />Remove step</Button>
            </section>
          ) : selected?.kind === 'edge' ? (
            <section className="flex flex-col gap-2.5" aria-label="Arrow">
              <h3 className="text-xs font-semibold text-foreground">Arrow</h3>
              <Button size="sm" variant="outline" className="self-start" onClick={() => { update({ edges: draft.edges.filter((_, i) => i !== selected.index) }); setSelected(null); }}><TrashIcon size={13} />Remove arrow</Button>
            </section>
          ) : (
            <>
              <section className="flex flex-col gap-2" aria-label="Input">
                <h3 className="text-xs font-semibold text-foreground">What this flow should do</h3>
                <textarea aria-label="Flow input" rows={7} className={textareaClassName} value={draft.input} placeholder="The exact details of this run (for example which jobs you want). Steps use it as {{input}}, so edit it any time without touching the steps." onChange={(e) => { update({ input: e.target.value }); }} />
              </section>
              <SchedulePanel schedule={draft.schedule} nextRunAt={flow?.nextRunAt ?? null} onChange={(schedule) => { update({ schedule }); }} />
              <MailPanel onChange={onMailChange} />
            </>
          )}
          {flow !== null ? (
            <section className="flex flex-col gap-1.5" aria-label="Runs">
              <h3 className="text-xs font-semibold text-foreground">Runs</h3>
              {runs.length === 0 ? <p className="text-2xs text-muted-foreground">No runs yet.</p> : runs.map((run) => (
                <p key={run.id} className="flex items-center gap-2 text-2xs text-muted-foreground">
                  <span className={cn('size-1.5 shrink-0 rounded-full', run.status === 'running' ? 'bg-info' : run.status === 'done' ? 'bg-success' : 'bg-destructive')} />
                  <span className="flex-1">{run.status === 'running' ? 'Running' : run.status === 'done' ? 'Finished' : 'Failed'} · {run.trigger === 'schedule' ? 'scheduled' : 'by hand'}</span>
                  <span>{relativeTime(run.startedAt)}</span>
                </p>
              ))}
            </section>
          ) : <p className="text-2xs text-muted-foreground">Save the flow to run it or schedule it.</p>}
        </aside>
      </div>
    </div>
  );
}

function StepOutput({ run, nodeId }: { run: FlowRun | undefined; nodeId: string }): React.JSX.Element | null {
  const state = run?.nodes.find((item) => item.nodeId === nodeId);
  if (state === undefined) return null;
  return (
    <div className="rounded-xl bg-muted/60 p-2.5">
      <p className="text-2xs font-semibold text-foreground">Last run: {STATUS_TEXT[state.status]}</p>
      {state.note !== '' ? <p className="mt-1 text-2xs text-destructive-foreground">{state.note}</p> : null}
      {state.output !== '' ? <p className="mt-1 max-h-40 overflow-y-auto text-2xs whitespace-pre-wrap text-muted-foreground">{state.output}</p> : null}
    </div>
  );
}
