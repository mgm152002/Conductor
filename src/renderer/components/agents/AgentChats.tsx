import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CloudBrowserButton } from './CloudBrowserButton';
import type { Task } from '@shared/domain';
import type { RunChoice } from '@shared/agent-models';
import type { AgentGroup, AgentGroupMessage, AgentGroupPlan, SandboxAgent } from '@shared/sandbox-agents';
import type { QueuedMessage, QueuedMessageMode } from '@shared/message-queue';
import { useTaskStore, useWorkspaceStore } from '../../stores';
import { useSandboxAgentStore } from '../../stores/sandbox-agent-store';
import { threadKey } from '../../lib/threads';
import type { TurnRun } from '../../lib/timeline';
import { isWorkingState, threadTitle } from '../../lib/thread-status';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { AgentAvatar } from '../ui/AgentAvatar';
import { MenuSelect } from '../ui/MenuSelect';
import { AttachButton, AttachmentTray, useAttachmentDraft } from '../attachments';
import { Alert, Button } from '../ui/primitives';
import { ArrowUpIcon, CheckIcon, ClockIcon, FolderIcon, GlobeIcon, PencilIcon, Spinner, SquarePenIcon, StopIcon, TrashIcon, XIcon } from '../ui/icons';
import { AgentReply } from './AgentReply';
import { AgentMark } from '../chat/AgentMark';
import { ModelEffortPicker } from '../chat/ModelEffortPicker';
import { useAgents } from '../../hooks/useAgents';
import { useTaskDetails } from '../../hooks/useTaskDetails';
import { message } from './AgentDialog';

// The two conversation panes of the Agents screen: a 1:1 chat with one agent
// (its own thread, continued message by message) and a group chat, where a
// message goes to every member or just the ones you pick, and each answers in
// the same conversation knowing what the others said.

/** The user's message; `task` supplies the files sent with it. */
function UserBubble({ text, at, task }: { text: string; at: string; task?: Task | undefined }): React.JSX.Element {
  const { details } = useTaskDetails(task ?? null);
  const files = details?.attachments ?? [];
  return (
    <div className="flex flex-col items-end gap-1">
      {files.length > 0 ? <div className="max-w-[78%]"><AttachmentTray attachments={files} /></div> : null}
      <div className="max-w-[78%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-[13.5px] leading-relaxed whitespace-pre-wrap break-words text-primary-foreground">{text}</div>
      <time dateTime={at} className="pr-1 text-3xs text-muted-foreground">{relativeTime(at)}</time>
    </div>
  );
}

/** Message box shared by both panes, with attachments (picked, pasted or dropped). */
function ChatComposer({ placeholder, disabled, working = false, workingName, onSend, onStop, children }: {
  placeholder: string;
  disabled?: string | undefined;
  /** The agent is still working: the message is steered or queued, as the user picks. */
  working?: boolean;
  /** Who is working, for the button titles. */
  workingName?: string | undefined;
  onSend: (text: string, attachmentIds: string[], mode: QueuedMessageMode) => Promise<void>;
  /** Stops the work in progress. While working, the send button becomes a stop button until something is typed. */
  onStop?: (() => Promise<void>) | undefined;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<QueuedMessageMode>('queue');
  const who = workingName ?? 'the agent';
  const [busy, setBusy] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const draft = useAttachmentDraft();
  useLayoutEffect(() => {
    const element = area.current;
    if (element === null) return;
    element.style.height = '0px';
    element.style.height = `${Math.min(element.scrollHeight, 200)}px`;
  }, [text]);
  const send = async (): Promise<void> => {
    const trimmed = text.trim();
    if (trimmed === '' || busy || disabled !== undefined || draft.busy || draft.errors.length > 0) return;
    setBusy(true); setError(null);
    try { await onSend(trimmed, draft.attachmentIds, mode); setText(''); draft.reset(); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); area.current?.focus(); }
  };
  const showStop = working && onStop !== undefined && text.trim() === '' && draft.attachments.length === 0;
  const stop = async (): Promise<void> => {
    if (onStop === undefined || stopping) return;
    setStopping(true); setError(null);
    try { await onStop(); }
    catch (err) { setError(message(err)); }
    finally { setStopping(false); }
  };
  return (
    <div className="mx-auto w-full max-w-3xl shrink-0 px-5 pt-3 pb-4">
      {error !== null ? <div className="mb-2"><Alert>{error}</Alert></div> : null}
      {disabled !== undefined ? <p className="mb-2 text-xs text-muted-foreground">{disabled}</p> : null}
      {children}
      <form
        className="flex flex-col gap-1 rounded-2xl border border-border-strong bg-surface-raised px-3 py-2 focus-within:border-ring/60"
        onSubmit={(event) => { event.preventDefault(); void send(); }}
        onDragOver={draft.onDragOver}
        onDrop={draft.onDrop}
      >
        {draft.attachments.length > 0 || draft.busy || draft.errors.length > 0 ? (
          <AttachmentTray
            attachments={draft.attachments}
            onRemove={(id) => { void draft.remove(id); }}
            onPick={() => { void draft.pick(); }}
            picker={false}
            busy={draft.busy}
            disabled={busy}
            progress={draft.progress}
            errors={draft.errors}
            onClearErrors={draft.clearErrors}
          />
        ) : null}
        <div className="flex items-end gap-2">
        <AttachButton onPick={() => { void draft.pick(); }} count={draft.attachments.length} disabled={busy || draft.busy || disabled !== undefined} />
        <label className="sr-only" htmlFor="agent-chat-input">Message</label>
        <textarea
          id="agent-chat-input"
          ref={area}
          rows={1}
          value={text}
          maxLength={10_000}
          disabled={disabled !== undefined}
          placeholder={placeholder}
          onChange={(event) => { setText(event.target.value); }}
          onPaste={draft.onPaste}
          onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }}
          className="max-h-50 min-h-6 flex-1 resize-none bg-transparent py-1 text-[14px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 disabled:cursor-not-allowed"
        />
        {working ? (
          <div role="group" aria-label="How to send while the agent is working" className="mb-1 flex shrink-0 items-center rounded-full border border-border p-0.5">
            <button type="button" aria-pressed={mode === 'steer'} title={`Stop what ${who} is doing and answer this next`}
              onClick={() => { setMode('steer'); }}
              className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-2xs transition-colors focus-visible:outline-2 focus-visible:outline-ring', mode === 'steer' ? 'bg-warning/20 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <ArrowUpIcon size={11} /> Steer
            </button>
            <button type="button" aria-pressed={mode === 'queue'} title={`Let ${who} finish, then answer this`}
              onClick={() => { setMode('queue'); }}
              className={cn('flex h-6 cursor-pointer items-center gap-1 rounded-full px-2 text-2xs transition-colors focus-visible:outline-2 focus-visible:outline-ring', mode === 'queue' ? 'bg-primary/15 text-foreground' : 'text-muted-foreground hover:text-foreground')}>
              <ClockIcon size={11} /> Queue
            </button>
          </div>
        ) : null}
        {showStop ? (
          <button type="button" onClick={() => { void stop(); }} disabled={stopping} aria-label={`Stop ${who}`} title={`Stop ${who}`}
            className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background transition-opacity hover:opacity-90 disabled:cursor-default disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {stopping ? <Spinner size={14} /> : <StopIcon size={14} />}
          </button>
        ) : (
        <button type="submit" aria-label={working ? (mode === 'steer' ? 'Steer agent' : 'Queue message') : 'Send'} disabled={text.trim() === '' || busy || disabled !== undefined || draft.busy || draft.errors.length > 0}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground hover:brightness-110 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <ArrowUpIcon size={15} />
        </button>
        )}
        </div>
      </form>
    </div>
  );
}

/** A message held while an agent works: steering it, or queued behind it. */
function HeldMessage({ mode, label, starting, onCancel }: { mode: QueuedMessageMode; label: string; starting?: boolean; onCancel: () => void }): React.JSX.Element {
  return (
    <li className="flex min-w-0 items-center gap-2 rounded-lg border border-border bg-surface-raised px-2.5 py-1.5 text-xs">
      <span className={cn('shrink-0 rounded-full px-1.5 py-px text-3xs font-medium', mode === 'steer' ? 'bg-warning/15 text-warning' : 'bg-primary/12 text-primary')}>
        {mode === 'steer' ? 'Steering' : 'Queued'}
      </span>
      <span className="min-w-0 flex-1 truncate text-foreground" title={label}>{label}</span>
      {starting === true ? <span className="shrink-0 text-3xs text-muted-foreground">Starting…</span> : (
        <button type="button" aria-label={`Cancel: ${label.slice(0, 40)}`} title="Don’t send this"
          onClick={onCancel}
          className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
          <XIcon size={12} />
        </button>
      )}
    </li>
  );
}

/** The messages waiting in a thread, kept current as they are sent or cancelled. */
function useQueuedMessages(threadId: string | null): QueuedMessage[] {
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
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
    });
    return () => { active = false; stop(); };
  }, [threadId]);
  return queued;
}

const cancelQueued = (id: string): void => { void window.conductor.task.queueCancel(id).catch(() => undefined); };
const isBusy = (task: Task | undefined): boolean => task !== undefined && (isWorkingState(task.state) || task.state === 'WAITING_FOR_APPROVAL');

/** Keeps a conversation scrolled to the newest message unless the user scrolled up. */
function useStickToBottom(dependency: unknown): { ref: React.RefObject<HTMLDivElement | null>; onScroll: (event: React.UIEvent<HTMLDivElement>) => void } {
  const ref = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current && ref.current !== null) ref.current.scrollTop = ref.current.scrollHeight;
  });
  useEffect(() => { stick.current = true; }, [dependency]);
  return { ref, onScroll: (event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; } };
}

// ---- project ----------------------------------------------------------------------

const PROJECT_KEY = 'conductor.agents.project';
let agentSpace: Promise<string> | undefined;

/** The hidden workspace agent chats use when no project is chosen. */
function agentWorkspace(): Promise<string> {
  agentSpace ??= window.conductor.sandboxAgents.workspace().catch((error: unknown) => { agentSpace = undefined; throw error; });
  return agentSpace;
}

/**
 * Which project a conversation works in: none by default (the agent's own
 * space, outside any project), or one the user picks. Chosen per
 * conversation and fixed once it has messages.
 */
function useConversationProject(conversationId: string): { projectId: string | null; setProjectId: (id: string | null) => void } {
  const read = (): string | null => {
    try { return (JSON.parse(window.localStorage.getItem(PROJECT_KEY) ?? '{}') as Record<string, string>)[conversationId] ?? null; } catch { return null; }
  };
  const [projectId, setState] = useState<string | null>(read);
  useEffect(() => { setState(read()); }, [conversationId]); // eslint-disable-line react-hooks/exhaustive-deps
  const setProjectId = (id: string | null): void => {
    setState(id);
    try {
      const all = JSON.parse(window.localStorage.getItem(PROJECT_KEY) ?? '{}') as Record<string, string>;
      if (id === null) delete all[conversationId]; else all[conversationId] = id;
      window.localStorage.setItem(PROJECT_KEY, JSON.stringify(all));
    } catch { /* session only */ }
  };
  return { projectId, setProjectId };
}

/** "No project" or a project, shown above the message box. */
function ProjectPicker({ value, onChange, locked }: { value: string | null; onChange: (id: string | null) => void; locked: boolean }): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  return (
    <MenuSelect
      label="Project"
      value={value ?? ''}
      disabled={locked}
      title={locked ? 'This conversation’s project is fixed. Start a new chat to change it.' : 'Let the agent work in a project, or keep it outside any project'}
      onChange={(next) => { onChange(next === '' ? null : next); }}
      className="max-w-56"
      options={[
        { value: '', label: 'No project', mark: <FolderIcon size={13} /> },
        ...workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name, mark: <FolderIcon size={13} /> })),
      ]}
    />
  );
}

const stickyKey = (agentId: string): string => `conductor.agent-cli.${agentId}`;
function readSticky(agentId: string): { cli: string; choice: RunChoice } {
  try {
    const raw = JSON.parse(localStorage.getItem(stickyKey(agentId)) ?? 'null') as { cli?: unknown; choice?: { model?: unknown; effort?: unknown } } | null;
    const choice: RunChoice = {};
    if (typeof raw?.choice?.model === 'string') choice.model = raw.choice.model;
    if (typeof raw?.choice?.effort === 'string') choice.effort = raw.choice.effort;
    return { cli: typeof raw?.cli === 'string' ? raw.cli : '', choice };
  } catch { return { cli: '', choice: {} }; }
}
function writeSticky(agentId: string, cli: string, choice: RunChoice): void {
  try { localStorage.setItem(stickyKey(agentId), JSON.stringify({ cli, choice })); } catch { /* remembering is optional */ }
}

// ---- 1:1 ------------------------------------------------------------------------------

export function AgentChat({ agent, onEdit, onDelete, sandboxRunning }: {
  agent: SandboxAgent;
  onEdit: () => void;
  onDelete: () => void;
  sandboxRunning: boolean;
}): React.JSX.Element {
  const threads = useSandboxAgentStore((s) => s.threads);
  const groupThreads = useSandboxAgentStore((s) => s.groupThreads);
  const focusThread = useSandboxAgentStore((s) => s.focusThread);
  const tasks = useTaskStore((s) => s.tasks);
  // This agent's own chats (not its group threads), newest first.
  const chats = useMemo(() => {
    const ids = Object.entries(threads).filter(([threadId, id]) => id === agent.id && !(threadId in groupThreads)).map(([threadId]) => threadId);
    const latest = (threadId: string): string => Object.values(tasks).filter((task) => threadKey(task) === threadId).reduce((at, task) => (task.updatedAt > at ? task.updatedAt : at), '');
    return ids.sort((a, b) => latest(b).localeCompare(latest(a)));
  }, [threads, groupThreads, tasks, agent.id]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [fresh, setFresh] = useState(false);
  // The CLI and model for the next message; '' keeps the thread's current CLI
  // (or the agent's first available one) and the agent's own model choice.
  // Sticky: remembered per agent, across chats and restarts.
  const [cli, setCli] = useState(() => readSticky(agent.id).cli);
  const [choice, setChoice] = useState<RunChoice>(() => readSticky(agent.id).choice);
  const cliOptions = useAgents();
  useEffect(() => { const saved = readSticky(agent.id); setCli(saved.cli); setChoice(saved.choice); }, [agent.id]);
  useEffect(() => { writeSticky(agent.id, cli, choice); }, [agent.id, cli, choice]);
  // A remembered CLI the agent no longer runs on falls back to Auto.
  useEffect(() => { if (cli !== '' && !agent.clis.includes(cli)) { setCli(''); setChoice({}); } }, [agent.clis, cli]);
  useEffect(() => { setThreadId(null); setFresh(false); }, [agent.id]);
  // Opened from the inbox: show that exact conversation.
  useEffect(() => {
    if (focusThread === null || threads[focusThread] !== agent.id) return;
    setThreadId(focusThread);
    setFresh(false);
    useSandboxAgentStore.setState({ focusThread: null });
  }, [focusThread, threads, agent.id]);
  const current = fresh ? null : threadId ?? chats[0] ?? null;
  useEffect(() => {
    if (current === null) return;
    void window.conductor.task.thread(current).then((list) => { useTaskStore.getState().setTasks(list); }).catch(() => undefined);
  }, [current]);
  const turns = useMemo(() => (current === null ? [] : Object.values(tasks).filter((task) => threadKey(task) === current)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))), [tasks, current]);
  const scroll = useStickToBottom(current);
  const latest = turns[turns.length - 1];
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const { projectId, setProjectId } = useConversationProject(`agent:${agent.id}`);
  // An existing chat keeps the project it started in.
  const chatProject = turns[0] !== undefined ? (workspaces.some((w) => w.id === turns[0]!.workspaceId) ? turns[0]!.workspaceId : null) : projectId;

  const queued = useQueuedMessages(current);
  const busy = isBusy(latest);
  // Which CLI and model each turn ran with, so a switch shows between turns.
  const [turnRuns, setTurnRuns] = useState<Map<string, TurnRun>>(() => new Map());
  const reportRun = useCallback((taskId: string, run: TurnRun) => {
    setTurnRuns((previous) => {
      const known = previous.get(taskId);
      if (known?.agentId === run.agentId && known.model === run.model) return previous;
      return new Map(previous).set(taskId, run);
    });
  }, []);

  /** Stop what the agent is doing, and the messages waiting behind it, which the user would not expect to start afterwards. */
  async function stopWork(): Promise<void> {
    queued.forEach((item) => { cancelQueued(item.id); });
    if (latest !== undefined) await window.conductor.task.cancel(latest.id);
  }

  async function send(text: string, attachmentIds: string[], mode: QueuedMessageMode): Promise<void> {
    if (latest !== undefined && busy) {
      await window.conductor.task.enqueue({
        taskId: latest.id, objective: text, mode,
        ...(cli !== '' ? { agentId: cli } : {}),
        ...(cli !== '' && Object.keys(choice).length > 0 ? { runOptions: { main: choice } } : {}),
        ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      });
      return;
    }
    const workspaceId = latest?.workspaceId ?? projectId ?? await agentWorkspace();
    const created = await window.conductor.task.create({
      workspaceId, objective: text,
      ...(latest !== undefined ? { parentTaskId: latest.id } : { sandboxAgentId: agent.id }),
      ...(cli !== '' ? { agentId: cli } : {}),
      ...(cli !== '' && Object.keys(choice).length > 0 ? { runOptions: { main: choice } } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
    });
    useTaskStore.getState().upsert(created);
    if (latest === undefined) {
      await useSandboxAgentStore.getState().refresh();
      setThreadId(threadKey(created));
      setFresh(false);
    }
  }

  const titleOf = (id: string): string => {
    const root = Object.values(tasks).find((task) => task.id === id);
    return root !== undefined ? threadTitle(root) : 'Chat';
  };

  return (
    <section aria-label={`Chat with ${agent.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="window-header flex shrink-0 items-center gap-2 border-b border-border px-4">
        <AgentAvatar agent={agent} size={22} mood={latest !== undefined && isWorkingState(latest.state) ? 'working' : 'idle'} />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={agent.description || agent.clis.join(' → ')}>{agent.name}</h2>
        {chats.length > 1 || (fresh && chats.length > 0) ? (
          <MenuSelect
            label="Earlier chats"
            value={current ?? ''}
            onChange={(value) => { if (value !== '') { setThreadId(value); setFresh(false); } }}
            className="max-w-48"
            // A new chat has no title yet; without its own entry the picker would keep showing the newest earlier chat.
            options={[...(current === null ? [{ value: '', label: 'New chat' }] : []), ...chats.map((id) => ({ value: id, label: titleOf(id) }))]}
          />
        ) : null}
        {sandboxRunning ? (
          <Button size="sm" variant="ghost" title="Watch its browser live" onClick={() => { void window.conductor.sandbox.openViewer(agent.id).catch(() => undefined); }}><GlobeIcon size={13} />Watch</Button>
        ) : null}
        <CloudBrowserButton scope={`agent:${agent.id}`} label={agent.name} />
        <Button size="icon" variant="ghost" aria-label="New chat" title="New chat" onClick={() => { setFresh(true); }}><SquarePenIcon size={15} /></Button>
        <Button size="icon" variant="ghost" aria-label={`Edit ${agent.name}`} title="Edit" onClick={onEdit}><PencilIcon size={14} /></Button>
        <Button size="icon" variant="ghost" aria-label={`Delete ${agent.name}`} title="Delete" onClick={onDelete} className="hover:text-destructive-foreground"><TrashIcon size={14} /></Button>
      </header>
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {turns.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <AgentAvatar agent={agent} size={72} />
            <p className="text-sm font-semibold text-foreground">{agent.name}</p>
            {agent.description !== '' ? <p className="max-w-sm text-xs text-muted-foreground">{agent.description}</p> : null}
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
            {turns.map((task, index) => (
              <div key={task.id} className="flex flex-col gap-4">
                <UserBubble text={task.objective} at={task.createdAt} task={task} />
                <AgentReply agent={agent} task={task} previousRun={index > 0 ? turnRuns.get(turns[index - 1]!.id) : undefined} onRun={reportRun} />
              </div>
            ))}
          </div>
        )}
      </div>
      <ChatComposer placeholder={busy ? `Steer ${agent.name}, or queue a follow-up` : `Message ${agent.name}`} working={busy} workingName={agent.name} onSend={send} onStop={stopWork}>
        {queued.length > 0 ? (
          <ul aria-label="Waiting messages" className="mb-2 flex flex-col gap-1.5">
            {queued.map((item) => (
              <HeldMessage key={item.id} mode={item.mode} label={item.objective} starting={item.status === 'dispatching'} onCancel={() => { cancelQueued(item.id); }} />
            ))}
          </ul>
        ) : null}
        <div className="mb-2 flex items-center gap-2">
          <ProjectPicker value={chatProject} onChange={setProjectId} locked={turns.length > 0} />
          <MenuSelect
            label="CLI"
            value={cli}
            onChange={(next) => { setCli(next); setChoice({}); }}
            title="Switch the CLI for this and later messages"
            className="max-w-44"
            options={[
              { value: '', label: 'Auto CLI' },
              ...agent.clis.map((id) => {
                const option = cliOptions.find((o) => o.id === id);
                return { value: id, label: option?.name ?? id, ...(option !== undefined && !option.available ? { hint: 'not available' } : {}), mark: <AgentMark agentId={id} name={option?.name ?? id} size={14} /> };
              }),
            ]}
          />
          {cli !== '' ? <ModelEffortPicker agentId={cli} value={choice} onChange={setChoice} label="Next message" /> : null}
        </div>
      </ChatComposer>
    </section>
  );
}

// ---- group ----------------------------------------------------------------------------

export function GroupChat({ group, agents, sandboxRunning, onDelete }: {
  group: AgentGroup;
  agents: SandboxAgent[];
  /** One of the group's sandboxes is up, so its browser can be watched. */
  sandboxRunning: boolean;
  onDelete: () => void;
}): React.JSX.Element {
  const members = useMemo(() => group.agentIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is SandboxAgent => agent !== undefined), [group, agents]);
  const tasks = useTaskStore((s) => s.tasks);
  const { projectId, setProjectId } = useConversationProject(`group:${group.id}`);
  const [messages, setMessages] = useState<AgentGroupMessage[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  // The CLI and model for the next message, remembered per group. '' is Auto:
  // each member runs on its own first CLI. Otherwise members that have the
  // chosen CLI run on it; the rest keep their own. A CLI that runs out of
  // usage hands over to that member's next one, in its own order.
  const stickyId = `group:${group.id}`;
  const [cli, setCli] = useState(() => readSticky(stickyId).cli);
  const [choice, setChoice] = useState<RunChoice>(() => readSticky(stickyId).choice);
  const cliOptions = useAgents();
  useEffect(() => { const saved = readSticky(stickyId); setCli(saved.cli); setChoice(saved.choice); }, [stickyId]);
  useEffect(() => { writeSticky(stickyId, cli, choice); }, [stickyId, cli, choice]);
  const texts = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    const list = await window.conductor.sandboxAgents.groupMessages(group.id);
    setMessages(list);
    // Reply tasks may not be in the store yet (they were created in main).
    const missing = list.flatMap((item) => Object.values(item.replies)).filter((taskId) => useTaskStore.getState().tasks[taskId] === undefined);
    await Promise.all(missing.map((taskId) => window.conductor.task.get(taskId).then((task) => { useTaskStore.getState().upsert(task); }).catch(() => undefined)));
  }, [group.id]);
  useEffect(() => { setTargets([]); texts.current.clear(); void load(); }, [load]);
  const waiting = messages.some((item) => item.waiting !== undefined || item.plan?.mode === 'planning' || item.plan?.steps.some((step) => step.status === 'waiting' || step.status === 'running') === true);
  const working = waiting || messages.some((item) => Object.values(item.replies).some((taskId) => isBusy(tasks[taskId])));
  // A held message was sent, cancelled or started: show it straight away.
  useEffect(() => window.conductor.on('task.queue.updated', () => { void load(); }), [load]);
  // Members who would get the next message and are still busy with an earlier one.
  const busyMembers = members.filter((member) => (targets.length === 0 || targets.includes(member.id))
    && messages.some((item) => item.waiting?.[member.id] !== undefined || isBusy(tasks[item.replies[member.id] ?? ''])));
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void load(); }, 2_500);
    return () => { window.clearInterval(timer); };
  }, [working, load]);
  const scroll = useStickToBottom(group.id);
  // CLIs any member runs on, in the order the members list them.
  const groupClis = useMemo(() => [...new Set(members.flatMap((member) => member.clis))], [members]);
  // A remembered CLI no member runs on any more falls back to Auto.
  useEffect(() => { if (cli !== '' && !groupClis.includes(cli)) { setCli(''); setChoice({}); } }, [groupClis, cli]);
  const onText = useCallback((taskId: string, text: string) => { texts.current.set(taskId, text); }, []);

  /** Stop every member still working on this group's messages, and the messages held for them. Parts waiting on a stopped one are skipped. */
  async function stopGroup(): Promise<void> {
    const held = messages.flatMap((item) => Object.values(item.waiting ?? {}).map((entry) => entry.queueId));
    held.forEach((queueId) => { cancelQueued(queueId); });
    const running = messages.flatMap((item) => Object.values(item.replies)).filter((taskId) => isBusy(tasks[taskId]));
    await Promise.all(running.map((taskId) => window.conductor.task.cancel(taskId)));
    await load();
  }

  async function send(text: string, attachmentIds: string[], mode: QueuedMessageMode): Promise<void> {
    // What members said in the last few exchanges, so they can build on it.
    const context = messages.slice(-3).flatMap((item) => Object.entries(item.replies).map(([agentId, taskId]) => {
      const reply = texts.current.get(taskId);
      const name = members.find((member) => member.id === agentId)?.name ?? 'Agent';
      return reply !== undefined ? `${name}: ${reply.length > 1200 ? `${reply.slice(0, 1200)}…` : reply}` : undefined;
    })).filter((line): line is string => line !== undefined).join('\n\n');
    await window.conductor.sandboxAgents.sendGroup({
      groupId: group.id, text, mode,
      ...(cli !== '' ? { agentId: cli } : {}),
      ...(cli !== '' && Object.keys(choice).length > 0 ? { runOptions: { main: choice } } : {}),
      ...(projectId !== null ? { workspaceId: projectId } : {}),
      ...(attachmentIds.length > 0 ? { attachmentIds } : {}),
      ...(targets.length > 0 ? { agentIds: targets } : {}),
      ...(context !== '' ? { context } : {}),
    });
    await useSandboxAgentStore.getState().refresh();
    await load();
  }

  return (
    <section aria-label={`Group chat ${group.name}`} className="flex min-h-0 min-w-0 flex-1 flex-col">
      <header className="window-header flex shrink-0 items-center gap-2 border-b border-border px-4">
        <GroupAvatar members={members} size={22} />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground" title={members.map((member) => member.name).join(', ')}>{group.name}</h2>
        {sandboxRunning ? (
          <Button size="sm" variant="ghost" title="Watch the group’s browsers live" onClick={() => { void window.conductor.sandbox.openGroupViewer(group.id).catch(() => undefined); }}><GlobeIcon size={13} />Watch</Button>
        ) : null}
        <Button size="icon" variant="ghost" aria-label={`Delete group ${group.name}`} title="Delete group" onClick={onDelete} className="hover:text-destructive-foreground"><TrashIcon size={14} /></Button>
      </header>
      <div ref={scroll.ref} onScroll={scroll.onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <GroupAvatar members={members} size={64} />
            <p className="text-sm font-semibold text-foreground">{group.name}</p>
          </div>
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-6 px-5 py-6">
            {messages.map((item) => (
              <div key={item.id} className="flex flex-col gap-4">
                <UserBubble text={item.text} at={item.createdAt} task={tasks[Object.values(item.replies)[0] ?? '']} />
                {item.plan !== undefined ? <GroupPlanCard plan={item.plan} agents={agents} /> : null}
                {repliesInOrder(item, tasks).map(([agentId, taskId]) => {
                  const agent = members.find((member) => member.id === agentId) ?? agents.find((candidate) => candidate.id === agentId);
                  const task: Task | undefined = tasks[taskId];
                  return agent !== undefined && task !== undefined ? <AgentReply key={taskId} agent={agent} task={task} onText={onText} /> : null;
                })}
                {item.waiting !== undefined ? (
                  <ul aria-label="Waiting for members" className="flex flex-col gap-1.5">
                    {Object.entries(item.waiting).map(([agentId, held]) => {
                      const name = agents.find((candidate) => candidate.id === agentId)?.name ?? 'Agent';
                      return (
                        <HeldMessage key={agentId} mode={held.mode}
                          label={held.mode === 'steer' ? `Stopping ${name}’s current work to answer this` : `${name} will answer this after finishing its current work`}
                          onCancel={() => { void window.conductor.task.queueCancel(held.queueId).then(load).catch(() => undefined); }} />
                      );
                    })}
                  </ul>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </div>
      <ChatComposer placeholder={targets.length === 0 ? `Message everyone in ${group.name}` : `Message ${targets.map((id) => members.find((member) => member.id === id)?.name).join(', ')}`}
        working={busyMembers.length > 0 || working} workingName={busyMembers.length === 1 ? busyMembers[0]!.name : 'the members still working'} onSend={send} onStop={stopGroup}>
        <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Send to">
          <ProjectPicker value={projectId} onChange={setProjectId} locked={messages.length > 0} />
          <MenuSelect
            label="CLI"
            value={cli}
            onChange={(next) => { setCli(next); setChoice({}); }}
            title="Run the next messages on this CLI. Members that don’t have it keep their own."
            className="max-w-44"
            options={[
              { value: '', label: 'Auto CLI', hint: 'each member’s own order' },
              ...groupClis.map((id) => {
                const option = cliOptions.find((o) => o.id === id);
                return { value: id, label: option?.name ?? id, ...(option !== undefined && !option.available ? { hint: 'not available' } : {}), mark: <AgentMark agentId={id} name={option?.name ?? id} size={14} /> };
              }),
            ]}
          />
          {cli !== '' ? <ModelEffortPicker agentId={cli} value={choice} onChange={setChoice} label="Next message" /> : null}
          <span aria-hidden="true" className="mx-1 h-4 w-px bg-border" />
          <button type="button" aria-pressed={targets.length === 0} onClick={() => { setTargets([]); }}
            className={cn('h-6 cursor-pointer rounded-full px-2.5 text-2xs font-medium focus-visible:outline-2 focus-visible:outline-ring', targets.length === 0 ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
            Everyone
          </button>
          {members.map((member) => {
            const on = targets.includes(member.id);
            return (
              <button key={member.id} type="button" aria-pressed={on} onClick={() => { setTargets(on ? targets.filter((id) => id !== member.id) : [...targets, member.id]); }}
                className={cn('flex h-6 cursor-pointer items-center gap-1.5 rounded-full pr-2.5 pl-0.5 text-2xs font-medium focus-visible:outline-2 focus-visible:outline-ring', on ? 'bg-foreground text-background' : 'text-muted-foreground hover:bg-accent hover:text-foreground')}>
                <AgentAvatar agent={member} size={20} />@{member.name}
              </button>
            );
          })}
        </div>
      </ChatComposer>
    </section>
  );
}

/**
 * A message's replies in the order the work happened: the plan's order when
 * there is one (the parts that came first on top), otherwise by when each
 * member's task started. Object order alone follows however the answers were
 * recorded, which is not the order they ran in.
 */
function repliesInOrder(item: AgentGroupMessage, tasks: Record<string, Task>): Array<[string, string]> {
  const position = (agentId: string): number => {
    const index = item.plan?.steps.findIndex((step) => step.agentId === agentId) ?? -1;
    return index < 0 ? Number.MAX_SAFE_INTEGER : index;
  };
  return Object.entries(item.replies).sort(([agentA, taskA], [agentB, taskB]) =>
    position(agentA) - position(agentB) || (tasks[taskA]?.createdAt ?? '').localeCompare(tasks[taskB]?.createdAt ?? ''));
}

/**
 * How a message to the group was split: independent parts at once, each in
 * its own sandbox, or parts that build on each other in one shared sandbox,
 * in order. Hidden for a lone member, where there is nothing to split.
 */
function GroupPlanCard({ plan, agents }: { plan: AgentGroupPlan; agents: SandboxAgent[] }): React.JSX.Element | null {
  if (plan.mode === 'planning') {
    return <p role="status" className="flex items-center gap-2 px-1 text-xs text-muted-foreground"><Spinner size={11} />Planning how to split this between the members…</p>;
  }
  if (plan.steps.length < 2) return null;
  const name = (id: string): string => agents.find((agent) => agent.id === id)?.name ?? 'Agent';
  const dag = plan.mode === 'dag';
  return (
    <section aria-label="Plan" className="rounded-xl border border-border bg-card/60 px-3 py-2.5">
      <p className="flex flex-wrap items-center gap-x-2 text-2xs font-medium text-foreground">
        <span className="rounded-full bg-accent px-2 py-px text-3xs">{dag ? 'In order · one shared sandbox' : 'In parallel · separate sandboxes'}</span>
        {plan.summary !== '' ? <span className="font-normal text-muted-foreground">{plan.summary}</span> : null}
      </p>
      <ol className="mt-2 flex flex-col gap-1.5">
        {plan.steps.map((step, index) => {
          const member = agents.find((agent) => agent.id === step.agentId);
          return (
            <li key={`${step.agentId}-${index}`} className="flex items-start gap-2 text-xs">
              {member !== undefined ? <AgentAvatar agent={member} size={18} className="mt-px" /> : null}
              <span className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{name(step.agentId)}</span>
                {step.dependsOn.length > 0 ? <span className="text-muted-foreground"> · after {step.dependsOn.map((position) => name(plan.steps[position]?.agentId ?? '')).join(', ')}</span> : null}
                <span className="block text-muted-foreground [overflow-wrap:anywhere]">{step.instruction.length > 220 ? `${step.instruction.slice(0, 219)}…` : step.instruction}</span>
                {step.note !== undefined ? <span className="block text-destructive-foreground">{step.note}</span> : null}
              </span>
              <span className="mt-px flex shrink-0 items-center gap-1 text-3xs text-muted-foreground" title={step.status}>
                {step.status === 'running' ? <Spinner size={11} /> : step.status === 'done' ? <CheckIcon size={12} className="text-success" /> : step.status === 'failed' || step.status === 'skipped' ? <XIcon size={12} className="text-destructive" /> : <ClockIcon size={12} />}
                {step.status === 'waiting' ? 'waiting' : step.status === 'running' ? 'working' : step.status}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** Up to three members' faces, overlapped. */
export function GroupAvatar({ members, size }: { members: SandboxAgent[]; size: number }): React.JSX.Element {
  const shown = members.slice(0, 3);
  const each = Math.round(size * (shown.length > 1 ? 0.68 : 1));
  return (
    <span aria-hidden="true" className="relative inline-flex shrink-0" style={{ width: size, height: size }}>
      {shown.map((member, index) => (
        <span key={member.id} className="absolute rounded-full bg-background" style={{
          width: each, height: each,
          left: shown.length === 1 ? 0 : index === 0 ? 0 : index === 1 ? size - each : (size - each) / 2,
          top: shown.length === 1 ? 0 : index === 2 ? size - each : index === 0 ? 0 : (size - each) * 0.35,
        }}>
          <AgentAvatar agent={member} size={each} />
        </span>
      ))}
    </span>
  );
}
