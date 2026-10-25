import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { Task } from '@shared/domain';
import { useComposerStore, useTaskStore, useUiStore, useWorkspaceStore } from '../../stores';
import { isWorkingState } from '../../lib/thread-status';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { cn } from '../../lib/cn';
import { ArrowUpIcon, ChevronDownIcon, FolderIcon, LayersIcon, ListChecksIcon, SparklesIcon, Spinner, StopIcon } from '../ui/icons';
import { useAgents } from '../../hooks/useAgents';
import type { RunOptions } from '@shared/agent-models';
import { preferredAgent } from '@shared/agent-preference';
import { ModelEffortPicker } from './ModelEffortPicker';
import { AttachmentTray, useAttachmentDraft } from '../attachments';

// The chat composer, styled after T3 Code's floating rounded surface: an
// auto-growing prompt, a footer with the project and acceptance-check
// controls, and a round send button that turns into Stop while the focused
// task is running. Enter sends; Shift+Enter inserts a newline.
//
// Sending from an existing thread posts a follow-up: a new task linked to the
// latest one. The same agent continues (Codex resumes its session); other
// agents receive the earlier turns as reference.

const MAX_OBJECTIVE = 10_000;
const DEFAULT_CRITERIA = 'response: nonempty';

export function Composer({ task, autoFocus = false, variant = 'docked' }: { task: Task | null; autoFocus?: boolean; variant?: 'docked' | 'hero' }): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const { selectProject } = useThreadNavigation();
  const [objective, setObjective] = useState('');
  const [criteriaText, setCriteriaText] = useState(DEFAULT_CRITERIA);
  const [checksOpen, setChecksOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const attachmentDraft = useAttachmentDraft();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const projectSelectId = useId();
  const agentSelectId = useId();
  const agents = useAgents();
  const agentId = useComposerStore((s) => s.agentId);
  const setAgentId = useComposerStore((s) => s.setAgentId);
  const planMode = useUiStore((s) => s.planMode);
  const setPlanMode = useUiStore((s) => s.setPlanMode);
  // In plan mode the picker chooses the planner, so it always names an agent.
  // Without an explicit pick, use the shared preference order (OpenCode first),
  // never the first entry in whatever order the agent list happened to arrive.
  const defaultAgentId = preferredAgent(agents.filter((agent) => agent.available).map((agent) => agent.id));
  const chosenAgent = agents.find((agent) => agent.id === agentId && agent.available)
    ?? (planMode && defaultAgentId !== undefined ? agents.find((agent) => agent.id === defaultAgentId) : undefined);
  // Model and effort: for the chosen agent (or the planner), and in plan mode
  // per sub-agent. Empty means Auto: Conductor picks by how demanding the work is.
  const mainChoice = useComposerStore((s) => s.mainChoice);
  const setMainChoice = useComposerStore((s) => s.setMainChoice);
  const agentChoices = useComposerStore((s) => s.agentChoices);
  const setAgentChoice = useComposerStore((s) => s.setAgentChoice);
  const [subAgentsOpen, setSubAgentsOpen] = useState(false);
  useEffect(() => {
    if (agents.length === 0 || agentId === '' || agents.some((agent) => agent.id === agentId && agent.available)) return;
    setAgentId(defaultAgentId ?? '');
  }, [agentId, agents, defaultAgentId, setAgentId]);
  const customSubAgents = Object.values(agentChoices).filter((c) => Object.keys(c).length > 0).length;
  const runOptions: RunOptions = {
    ...(chosenAgent !== undefined && Object.keys(mainChoice).length > 0 ? { main: mainChoice } : {}),
    ...(planMode && customSubAgents > 0 ? { agents: Object.fromEntries(Object.entries(agentChoices).filter(([, c]) => Object.keys(c).length > 0)) } : {}),
  };

  const trimmed = objective.trim();
  const acceptanceCriteria = criteriaText.split('\n').map((line) => line.trim()).filter(Boolean);
  const criteriaValid = acceptanceCriteria.length > 0 && acceptanceCriteria.length <= 50 && acceptanceCriteria.every((c) => c.length <= 1000);
  const busy = task !== null && (isWorkingState(task.state) || task.state === 'WAITING_FOR_APPROVAL');
  const canSubmit = trimmed.length > 0 && trimmed.length <= MAX_OBJECTIVE && activeWorkspaceId !== null && criteriaValid && !submitting && !busy
    && !attachmentDraft.busy && attachmentDraft.errors.length === 0
    && (!planMode || chosenAgent !== undefined);
  // Stop only applies while work is in flight; blocked or interrupted tasks
  // are handled with Retry / Resume in the header.
  const running = task !== null && (isWorkingState(task.state) || task.state === 'WAITING_FOR_APPROVAL');
  const showStop = running && trimmed.length === 0;
  const customChecks = acceptanceCriteria.filter((c) => c !== DEFAULT_CRITERIA).length;
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
      const created = await window.conductor.task.create({
        workspaceId: activeWorkspaceId,
        objective: trimmed,
        acceptanceCriteria,
        ...(task !== null && variant === 'docked' ? { parentTaskId: task.id } : {}),
        ...(chosenAgent !== undefined ? { agentId: chosenAgent.id } : {}),
        ...(planMode ? { plan: true } : {}),
        ...(Object.keys(runOptions).length > 0 ? { runOptions } : {}),
        ...(attachmentDraft.attachmentIds.length > 0 ? { attachmentIds: attachmentDraft.attachmentIds } : {}),
      });
      useTaskStore.getState().upsert(created);
      useTaskStore.getState().focus(created.id);
      useUiStore.getState().setDraft(false);
      setObjective('');
      setCriteriaText(DEFAULT_CRITERIA);
      setChecksOpen(false);
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
      ? busy ? 'Wait for the current reply, or stop it…' : 'Reply…'
      : planMode ? 'Describe what to build; the planner splits it across agents…' : 'Ask Conductor to do anything…';

  return (
    <form
      aria-label="Universal task input"
      onSubmit={(event) => { event.preventDefault(); void submit(); }}
      onDragOver={attachmentDraft.onDragOver}
      onDrop={attachmentDraft.onDrop}
      className={cn('relative mx-auto w-full min-w-0 max-w-(--chat-max)', variant === 'docked' && 'max-h-[70dvh] overflow-y-auto pb-4')}
    >
      <div className="relative rounded-3xl border border-black/8 bg-surface-raised/90 shadow-composer backdrop-blur-xl transition-colors focus-within:border-ring/40 dark:border-white/6 dark:shadow-none">
        {planMode && subAgentsOpen ? (
          <div className="border-b border-border px-4 pt-3 pb-2.5">
            <p className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground"><LayersIcon size={12} /> Sub-agents</p>
            <p className="mt-0.5 text-3xs text-muted-foreground">The agents that run the plan's tasks. Auto gives each task a model and effort to match its difficulty, so quick tasks use cheaper models.</p>
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
        {checksOpen ? (
          <div className="border-b border-border px-4 pt-3 pb-2.5">
            <label htmlFor="task-acceptance-criteria" className="flex items-center gap-1.5 text-2xs font-medium text-muted-foreground">
              <ListChecksIcon size={12} /> Acceptance criteria
            </label>
            <textarea
              id="task-acceptance-criteria"
              value={criteriaText}
              onChange={(event) => { setCriteriaText(event.target.value); }}
              disabled={submitting}
              rows={3}
              aria-describedby="task-criteria-help"
              spellCheck={false}
              className="mt-1.5 w-full resize-none rounded-lg border border-border bg-transparent px-2.5 py-1.5 font-mono text-xs text-foreground outline-none focus-visible:border-ring"
            />
            <p id="task-criteria-help" className="mt-1 text-3xs leading-relaxed text-muted-foreground">
              One check per line. <code className="font-mono">contains: text</code> checks the reply, <code className="font-mono">file: relative/path</code> checks a workspace file. <code className="font-mono">response: nonempty</code> only checks that a reply was recorded.
            </p>
            {!criteriaValid ? <p className="mt-1 text-3xs text-destructive-foreground">Enter 1–50 criteria, each at most 1,000 characters.</p> : null}
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
            variant === 'hero' ? 'min-h-20' : 'min-h-11',
          )}
        />

        <div className="px-3 pt-1">
          <AttachmentTray
            attachments={attachmentDraft.attachments}
            onRemove={(id) => { void attachmentDraft.remove(id); }}
            onPick={() => { void attachmentDraft.pick(); }}
            busy={attachmentDraft.busy}
            disabled={submitting || activeWorkspaceId === null}
            progress={attachmentDraft.progress}
            errors={attachmentDraft.errors}
            onClearErrors={attachmentDraft.clearErrors}
          />
        </div>

        <div className="flex items-end gap-2 px-2.5 pt-1 pb-2.5">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1" aria-label="Task options">
          <div className="relative min-w-0 max-w-full">
            <label htmlFor={projectSelectId} className="sr-only">Project</label>
            <div className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground"><FolderIcon size={13} /></div>
            <select
              id={projectSelectId}
              value={activeWorkspaceId ?? ''}
              disabled={task !== null && variant === 'docked'}
              onChange={(event) => { if (event.target.value) void selectProject(event.target.value).catch((err: unknown) => { setError(err instanceof Error ? err.message : 'Could not switch project'); }); }}
              title={project?.rootPath}
              className="h-7 max-w-full sm:max-w-48 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-6 pl-7 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-default disabled:hover:bg-transparent"
            >
              {workspaces.length === 0 ? <option value="">No project</option> : null}
              {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground"><ChevronDownIcon size={11} /></div>
          </div>
          <div className="relative min-w-0 max-w-full">
            <label htmlFor={agentSelectId} className="sr-only">Agent</label>
            <div className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground"><SparklesIcon size={13} /></div>
            <select
              id={agentSelectId}
              value={chosenAgent?.id ?? ''}
              onChange={(event) => { setAgentId(event.target.value); }}
              title={planMode ? 'The agent that writes the plan' : task !== null && variant === 'docked' ? 'Auto continues with the agent from the previous message' : 'Auto picks an available agent'}
              className="h-7 max-w-full sm:max-w-44 cursor-pointer appearance-none truncate rounded-full bg-transparent pr-6 pl-7 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {planMode
                ? (chosenAgent === undefined ? <option value="">No agent available</option> : null)
                : <option value="">{task !== null && variant === 'docked' ? 'Same agent' : 'Auto'}</option>}
              {agents.map((agent) => <option key={agent.id} value={agent.id} disabled={!agent.available}>{planMode ? `Planner: ${agent.name}` : agent.name}{agent.available ? '' : ' (unavailable)'}</option>)}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-2 flex items-center text-muted-foreground"><ChevronDownIcon size={11} /></div>
          </div>
          {chosenAgent !== undefined ? <ModelEffortPicker agentId={chosenAgent.id} value={mainChoice} onChange={setMainChoice} {...(planMode ? { label: 'Planner' } : {})} /> : null}
          <button
            type="button"
            onClick={() => { setPlanMode(!planMode); }}
            aria-pressed={planMode}
            title="Plan mode: the chosen agent writes requirements and a task list, then tasks run on the agents it assigns, independent ones in parallel"
            className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none',
              planMode ? 'bg-primary/12 text-primary hover:bg-primary/18' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}
          >
            <LayersIcon size={13} />
            Plan
          </button>
          {planMode ? (
            <button
              type="button"
              onClick={() => { setSubAgentsOpen((v) => !v); }}
              aria-expanded={subAgentsOpen}
              title="Model and effort for the agents that run the plan's tasks"
              className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none', subAgentsOpen || customSubAgents > 0 ? 'text-foreground' : 'text-muted-foreground')}
            >
              Sub-agents{customSubAgents > 0 ? <span className="rounded-full bg-primary/15 px-1.5 text-3xs font-medium text-primary tabular-nums">{customSubAgents}</span> : <span className="text-3xs text-muted-foreground">Auto</span>}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => { setChecksOpen((v) => !v); }}
            aria-expanded={checksOpen}
            aria-controls="task-acceptance-criteria"
            className={cn('flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-xs transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:outline-none', checksOpen || customChecks > 0 ? 'text-foreground' : 'text-muted-foreground')}
          >
            <ListChecksIcon size={13} />
            Checks{customChecks > 0 ? <span className="rounded-full bg-primary/15 px-1.5 text-3xs font-medium text-primary tabular-nums">{customChecks}</span> : null}
          </button>
          </div>
          <div className="flex shrink-0 items-center gap-1">
          {trimmed.length > MAX_OBJECTIVE * 0.9 ? <span className="mr-1 text-3xs text-muted-foreground tabular-nums">{trimmed.length.toLocaleString()} / {MAX_OBJECTIVE.toLocaleString()}</span> : null}
          {showStop ? (
            <button type="button" onClick={() => { void stop(); }} disabled={stopping} aria-label="Stop task" title="Stop" className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-85 disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {stopping ? <Spinner size={14} /> : <StopIcon size={14} />}
            </button>
          ) : (
            <button type="submit" disabled={!canSubmit} aria-label={submitting ? 'Starting…' : 'Start task'} title="Send (Enter)" className="flex size-8 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-30 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
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
