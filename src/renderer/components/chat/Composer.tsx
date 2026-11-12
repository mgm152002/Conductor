import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '@shared/domain';
import { useComposerStore, useTaskStore, useUiStore, useWorkspaceStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { cn } from '../../lib/cn';
import { ArrowUpIcon, ClockIcon, FolderIcon, LayersIcon, MonitorIcon, SparklesIcon, Spinner, StopIcon, XIcon } from '../ui/icons';
import { SANDBOX_AGENT_PREFIX, sandboxAgentIdFrom, useSandboxAgentStore } from '../../stores/sandbox-agent-store';
import type { QueuedMessage, QueuedMessageMode } from '@shared/message-queue';
import { ProviderAvatar, agentBrand } from '../ui/BrandMarks';
import { MenuSelect } from '../ui/MenuSelect';
import { useAgents } from '../../hooks/useAgents';
import type { RunOptions } from '@shared/agent-models';
import { preferredAgent } from '@shared/agent-preference';
import { ModelEffortPicker } from './ModelEffortPicker';
import { AttachButton, AttachmentTray, useAttachmentDraft } from '../attachments';

// The chat composer: a raised surface with an auto-growing prompt, a footer
// with the project and agent controls, and the one accent-coloured button on
// the screen, Send,
// that turns into Stop while the focused task is running. Enter sends;
// Shift+Enter inserts a newline.
//
// Sending from an existing thread posts a follow-up: a new task linked to the
// latest one. The same agent continues (Codex resumes its session); other
// agents receive the earlier turns as reference.

const MAX_OBJECTIVE = 10_000;

export function Composer({ task, autoFocus = false, variant = 'docked', currentAgentId }: { task: Task | null; autoFocus?: boolean; variant?: 'docked' | 'hero'; /** Agent that ran the previous turn, for same-thread model/CLI switching. */ currentAgentId?: string | undefined }): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const { selectProject } = useThreadNavigation();
  const [objective, setObjective] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deliveryMode, setDeliveryMode] = useState<QueuedMessageMode>('queue');
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachmentDraft = useAttachmentDraft();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const agents = useAgents();
  const agentId = useComposerStore((s) => s.agentId);
  const setAgentId = useComposerStore((s) => s.setAgentId);
  const planModeSetting = useUiStore((s) => s.planMode);
  const setPlanMode = useUiStore((s) => s.setPlanMode);
  // Sandbox agents can start a new thread (not continue one: a thread keeps
  // the agent it was started with). Their composer value is prefixed.
  const sandboxAgents = useSandboxAgentStore((s) => s.agents);
  const newThreadDraft = !(task !== null && variant === 'docked');
  const sandboxAgent = newThreadDraft ? sandboxAgents.find((agent) => agent.id === sandboxAgentIdFrom(agentId)) : undefined;
  // An agent runs its own task; plan mode doesn't apply to it.
  const planMode = planModeSetting && sandboxAgent === undefined;
  // In plan mode the picker chooses the planner, so it always names an agent.
  // Without an explicit pick, use the shared preference order (OpenCode first),
  // never the first entry in whatever order the agent list happened to arrive.
  const defaultAgentId = preferredAgent(agents.filter((agent) => agent.available).map((agent) => agent.id));
  const chosenAgent = agents.find((agent) => agent.id === agentId && agent.available)
    ?? (planMode && defaultAgentId !== undefined ? agents.find((agent) => agent.id === defaultAgentId) : undefined);
  // Mid-thread switching: with no explicit pick the previous turn's agent
  // continues, but its model/effort can still be changed for the next turn;
  // picking a different CLI in the agent menu switches provider in-thread.
  const effectiveAgent = chosenAgent ?? (task !== null && variant === 'docked' && currentAgentId !== undefined
    ? agents.find((agent) => agent.id === currentAgentId && agent.available) : undefined);
  // Model and effort are kept per agent: switching CLI shows that CLI's own
  // selection (each agent remembers its last model/effort), and sending a
  // message never clears any of them. Empty means Auto: Conductor picks by
  // how demanding the work is.
  const agentChoices = useComposerStore((s) => s.agentChoices);
  const sandboxLoaded = useSandboxAgentStore((s) => s.loaded);
  const setAgentChoice = useComposerStore((s) => s.setAgentChoice);
  const [subAgentsOpen, setSubAgentsOpen] = useState(false);
  useEffect(() => {
    if (agents.length === 0 || agentId === '' || agents.some((agent) => agent.id === agentId && agent.available)) return;
    // A sandbox agent pick stays while the agent exists (checked once loaded).
    if (sandboxAgentIdFrom(agentId) !== undefined && (!sandboxLoaded || sandboxAgents.some((agent) => `${SANDBOX_AGENT_PREFIX}${agent.id}` === agentId))) return;
    setAgentId(defaultAgentId ?? '');
  }, [agentId, agents, defaultAgentId, setAgentId, sandboxAgents, sandboxLoaded]);
  const customSubAgents = Object.values(agentChoices).filter((c) => Object.keys(c).length > 0).length;
  const mainChoice = effectiveAgent !== undefined ? agentChoices[effectiveAgent.id] ?? {} : {};
  const runOptions: RunOptions = {
    ...(effectiveAgent !== undefined && Object.keys(mainChoice).length > 0 ? { main: mainChoice } : {}),
    ...(planMode && customSubAgents > 0 ? { agents: Object.fromEntries(Object.entries(agentChoices).filter(([, c]) => Object.keys(c).length > 0)) } : {}),
  };

  const trimmed = objective.trim();
  const busy = task !== null && (isWorkingState(task.state) || task.state === 'WAITING_FOR_APPROVAL');
  const threadId = task !== null && variant === 'docked' ? (task.threadId ?? task.id) : null;
  // While the agent works, a message can still be sent: steered (interrupt
  // and run next) or queued (run after the current task finishes).
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_OBJECTIVE && activeWorkspaceId !== null && !submitting
    && !attachmentDraft.busy && attachmentDraft.errors.length === 0
    && (busy || !planMode || chosenAgent !== undefined);

  useEffect(() => {
    if (threadId === null) { setQueued([]); return; }
    let active = true;
    const refresh = (): void => {
      void window.conductor.task.queueList(threadId).then((list) => { if (active) setQueued(list); }).catch(() => undefined);
    };
    refresh();
    const stop = window.conductor.on('task.queue.updated', (payload) => {
      const event = payload as { threadId?: string; queue?: QueuedMessage[] };
      if (event.threadId === threadId && Array.isArray(event.queue)) setQueued(event.queue);
      else refresh();
    });
    return () => { active = false; stop(); };
  }, [threadId]);
  // Stop only applies while work is in flight; blocked or interrupted tasks
  // are handled with Retry / Resume in the header.
  const running = task !== null && (isWorkingState(task.state) || task.state === 'WAITING_FOR_APPROVAL');
  const showStop = running && trimmed.length === 0;
  const project = workspaces.find((w) => w.id === activeWorkspaceId);

  useLayoutEffect(() => {
    const element = textarea.current;
    if (element === null) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 240)}px`;
  }, [objective]);

  useEffect(() => {
    if (autoFocus) textarea.current?.focus();
  }, [autoFocus, task?.id]);

  async function submit(): Promise<void> {
    if (!canSubmit || activeWorkspaceId === null) return;
    setSubmitting(true);
    setError(null);
    try {
      if (busy && task !== null) {
        const entry = await window.conductor.task.enqueue({
          taskId: task.id,
          objective: trimmed,
          mode: deliveryMode,
          ...(chosenAgent !== undefined ? { agentId: chosenAgent.id } : {}),
          ...(Object.keys(runOptions).length > 0 ? { runOptions } : {}),
          ...(attachmentDraft.attachmentIds.length > 0 ? { attachmentIds: attachmentDraft.attachmentIds } : {}),
        });
        setQueued((current) => [...current.filter((item) => item.id !== entry.id), entry]);
        setObjective('');
        attachmentDraft.reset();
        return;
      }
      const created = await window.conductor.task.create({
        workspaceId: activeWorkspaceId,
        objective: trimmed,
        ...(task !== null && variant === 'docked' ? { parentTaskId: task.id } : {}),
        ...(sandboxAgent !== undefined ? { sandboxAgentId: sandboxAgent.id } : chosenAgent !== undefined ? { agentId: chosenAgent.id } : {}),
        ...(planMode ? { plan: true } : {}),
        ...(Object.keys(runOptions).length > 0 ? { runOptions } : {}),
        ...(attachmentDraft.attachmentIds.length > 0 ? { attachmentIds: attachmentDraft.attachmentIds } : {}),
      });
      useTaskStore.getState().upsert(created);
      useTaskStore.getState().focus(created.id);
      if (sandboxAgent !== undefined) {
        void useSandboxAgentStore.getState().refresh();
        // Back to normal routing for the next new thread.
        setAgentId('');
      }
      useUiStore.getState().setDraft(false);
      setObjective('');
      attachmentDraft.reset();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start the task');
    } finally {
      setSubmitting(false);
    }
  }

  async function stop(): Promise<void> {
    if (task === null) return;
    setStopping(true);
    setError(null);
    try {
      await window.conductor.task.cancel(task.id);
      const details = await window.conductor.task.details(task.id);
      useTaskStore.getState().upsert(details.task);
      useTaskStore.getState().bumpDetails(task.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not stop the task');
    } finally {
      setStopping(false);
    }
  }

  const placeholder = activeWorkspaceId === null
    ? 'Add a project to start a task'
    : task !== null && variant === 'docked'
      ? busy ? 'Steer the agent, or queue a follow-up…' : 'Reply…'
      : planMode ? 'Describe what to build…' : 'Ask anything…';

  return (
    <form
      aria-label="Universal task input"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onDragOver={attachmentDraft.onDragOver}
      onDrop={attachmentDraft.onDrop}
      className={cn('relative mx-auto w-full min-w-0 max-w-(--chat-max)', variant === 'docked' && 'max-h-[70dvh] overflow-y-auto pb-4')}
    >
      {queued.length > 0 ? (
        <ul aria-label="Queued messages" className="mb-2 flex flex-col gap-1.5 px-1">
          {queued.map((item) => (
            <li key={item.id} className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs">
              <span className={cn('shrink-0 rounded-full px-1.5 py-px text-3xs font-medium', item.mode === 'steer' ? 'bg-warning/15 text-warning' : 'bg-primary/12 text-primary')}>
                {item.mode === 'steer' ? 'Steering' : 'Queued'}
              </span>
              <span className="min-w-0 flex-1 truncate text-foreground" title={item.objective}>{item.objective}</span>
              {item.status === 'dispatching' ? <span className="shrink-0 text-3xs text-muted-foreground">Starting…</span> : (
                <button type="button" aria-label={`Cancel queued message: ${item.objective.slice(0, 40)}`} title="Remove from queue"
                  onClick={() => { void window.conductor.task.queueCancel(item.id).then(() => { setQueued((current) => current.filter((q) => q.id !== item.id)); }).catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not remove the queued message'); }); }}
                  className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
                  <XIcon size={12} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative rounded-2xl border border-border-strong bg-surface-raised shadow-composer transition-[border-color,box-shadow] focus-within:border-ring/60 focus-within:ring-3 focus-within:ring-ring/15">
        {planMode && subAgentsOpen ? (
          <div className="border-b border-border px-4 pt-3 pb-2.5">
            <p className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground"><LayersIcon size={12} /> Sub-agents</p>
            <p className="mt-0.5 text-3xs text-muted-foreground">Auto matches model and effort to each task.</p>
            <ul className="mt-2 flex flex-col gap-1.5">
              {agents.filter((a) => a.available).map((agent) => (
                <li key={agent.id} className="flex min-w-0 flex-wrap items-center gap-2">
                  <span className="w-28 shrink-0 truncate text-xs text-foreground">{agent.name}</span>
                  <ModelEffortPicker variant="box" agentId={agent.id} label={agent.name} value={agentChoices[agent.id] ?? {}}
                    onChange={(choice) => { setAgentChoice(agent.id, choice); }} />
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        <label htmlFor="task-objective" className="sr-only">What would you like Conductor to do?</label>
        <textarea
          id="task-objective"
          ref={textarea}
          rows={1}
          value={objective}
          maxLength={MAX_OBJECTIVE}
          placeholder={placeholder}
          disabled={submitting || activeWorkspaceId === null}
          onChange={(event) => { setObjective(event.target.value); }}
          onPaste={attachmentDraft.onPaste}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
          className={cn(
            'block w-full resize-none bg-transparent px-4 pt-3.5 pb-1 text-[15px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/60 disabled:cursor-not-allowed',
            variant === 'hero' ? 'min-h-24' : 'min-h-12',
          )}
        />

        <div className="px-3 pt-1">
          <AttachmentTray
            attachments={attachmentDraft.attachments}
            onRemove={(id) => { void attachmentDraft.remove(id); }}
            onPick={() => { void attachmentDraft.pick(); }}
            picker={false}
            busy={attachmentDraft.busy}
            disabled={submitting || activeWorkspaceId === null}
            progress={attachmentDraft.progress}
            errors={attachmentDraft.errors}
            onClearErrors={attachmentDraft.clearErrors}
          />
        </div>

        <div className="flex items-end gap-2 px-2.5 pt-1 pb-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" aria-label="Task options">
          <AttachButton onPick={() => { void attachmentDraft.pick(); }} count={attachmentDraft.attachments.length} disabled={attachmentDraft.busy || submitting || activeWorkspaceId === null} />
          <div className="min-w-0 max-w-full">
            <MenuSelect
              label="Project"
              value={activeWorkspaceId ?? ''}
              disabled={task !== null && variant === 'docked'}
              onChange={(next) => { if (next) void selectProject(next).catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not switch project'); }); }}
              title={project?.rootPath}
              className="max-w-full sm:max-w-48"
              options={workspaces.length === 0
                ? [{ value: '', label: 'No project', mark: <FolderIcon size={13} /> }]
                : workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, mark: <FolderIcon size={13} /> }))}
            />
          </div>
          <div className="min-w-0 max-w-full">
            <MenuSelect
              label="Agent"
              value={sandboxAgent !== undefined ? `${SANDBOX_AGENT_PREFIX}${sandboxAgent.id}` : chosenAgent?.id ?? ''}
              onChange={(next) => { setAgentId(next); }}
              title={planMode ? 'Planner' : task !== null && variant === 'docked' ? 'Agent for the next message' : 'Auto agent'}
              className="max-w-full sm:max-w-44"
              options={[
                ...(planMode
                  ? (chosenAgent === undefined ? [{ value: '', label: 'No agent available', mark: <SparklesIcon size={13} /> }] : [])
                  : [{
                      value: '',
                      label: task !== null && variant === 'docked' ? 'Same agent' : 'Auto',
                      mark: task !== null && variant === 'docked' && currentAgentId !== undefined
                        ? <ProviderAvatar brand={agentBrand(currentAgentId)} label={currentAgentId} size={13} />
                        : <SparklesIcon size={13} />,
                    }]),
                ...agents.map((agent) => ({
                  value: agent.id,
                  label: agent.name,
                  disabled: !agent.available,
                  ...(agent.available ? {} : { hint: 'Unavailable' }),
                  mark: <ProviderAvatar brand={agentBrand(agent.id)} label={agent.name} size={13} />,
                })),
                ...(newThreadDraft && !planModeSetting ? sandboxAgents.map((agent) => ({
                  value: `${SANDBOX_AGENT_PREFIX}${agent.id}`,
                  label: agent.name,
                  hint: 'Agent with a sandbox',
                  mark: <span aria-hidden="true" className="flex size-[13px] items-center justify-center rounded-[4px] text-[7px] font-bold text-white" style={{ background: agent.color }}>{agent.name.slice(0, 1).toUpperCase()}</span>,
                })) : []),
              ]}
            />
          </div>
          {sandboxAgent !== undefined ? (
            <span className="flex h-7 items-center gap-1.5 rounded-full bg-primary/10 px-2.5 text-2xs font-medium text-primary" title={`Runs on ${sandboxAgent.clis.join(' → ')} with its own sandbox`}>
              <MonitorIcon size={12} />Sandbox
            </span>
          ) : null}
          {sandboxAgent === undefined && effectiveAgent !== undefined ? <ModelEffortPicker agentId={effectiveAgent.id} value={mainChoice} onChange={(choice) => { setAgentChoice(effectiveAgent.id, choice); }} {...(planMode ? { label: 'Planner' } : {})} /> : null}
          {sandboxAgent === undefined ? <button
            type="button"
            onClick={() => { setPlanMode(!planMode); }}
            aria-pressed={planMode}
            title="Plan first, then run tasks in parallel"
            className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
              planMode ? 'bg-primary/12 text-primary hover:bg-primary/18' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
          >
            <LayersIcon size={13} />
            Plan
          </button> : null}
          {planMode ? (
            <button
              type="button"
              onClick={() => { setSubAgentsOpen((v) => !v); }}
              aria-expanded={subAgentsOpen}
              title="Sub-agent models"
              className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none', subAgentsOpen || customSubAgents > 0 ? 'text-foreground' : 'text-muted-foreground')}
            >
              Sub-agents{customSubAgents > 0 ? <span className="rounded-full bg-primary/15 px-1.5 text-3xs font-medium text-primary tabular-nums">{customSubAgents}</span> : <span className="text-3xs text-muted-foreground">Auto</span>}
            </button>
          ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-1">
          {busy ? (
            <div role="group" aria-label="How to send while the agent is working" className="mr-1 flex items-center rounded-full border border-border p-0.5">
              <button type="button" aria-pressed={deliveryMode === 'steer'} title="Interrupt the current task and run this message next"
                onClick={() => { setDeliveryMode('steer'); }}
                className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-2xs transition-colors focus-visible:outline-2 focus-visible:outline-ring', deliveryMode === 'steer' ? 'bg-warning/20 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                <ArrowUpIcon size={11} /> Steer
              </button>
              <button type="button" aria-pressed={deliveryMode === 'queue'} title="Let the current task finish, then run this message"
                onClick={() => { setDeliveryMode('queue'); }}
                className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-2xs transition-colors focus-visible:outline-2 focus-visible:outline-ring', deliveryMode === 'queue' ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
                <ClockIcon size={11} /> Queue
              </button>
            </div>
          ) : null}
          {trimmed.length > MAX_OBJECTIVE * 0.9 ? <span className="mr-1 text-3xs text-muted-foreground tabular-nums">{trimmed.length.toLocaleString()} / {MAX_OBJECTIVE.toLocaleString()}</span> : null}
          {showStop ? (
            <button type="button" onClick={() => { void stop(); }} disabled={stopping} aria-label="Stop task" title="Stop" className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {stopping ? <Spinner size={14} /> : <StopIcon size={14} />}
            </button>
          ) : (
            <button type="submit" disabled={!canSubmit} aria-label={submitting ? 'Sending…' : busy ? (deliveryMode === 'steer' ? 'Steer agent' : 'Queue message') : 'Start task'} title={busy ? (deliveryMode === 'steer' ? 'Steer (Enter): stop current work and run this next' : 'Queue (Enter): run this after current work') : 'Send (Enter)'} className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-[filter,transform,background-color] duration-150 hover:brightness-110 active:scale-90 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {submitting ? <Spinner size={14} /> : <ArrowUpIcon size={16} />}
            </button>
          )}
          </div>
        </div>
      </div>
      {error !== null ? <p role="alert" className="mt-2 px-3 text-xs text-destructive-foreground">{error}</p> : null}
    </form>
  );
}
