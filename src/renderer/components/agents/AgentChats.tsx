import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Task } from '@shared/domain';
import type { AgentGroup, AgentGroupMessage, SandboxAgent } from '@shared/sandbox-agents';
import { useTaskStore, useWorkspaceStore } from '../../stores';
import { useSandboxAgentStore } from '../../stores/sandbox-agent-store';
import { threadKey } from '../../lib/threads';
import { isWorkingState, threadTitle } from '../../lib/thread-status';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { AgentAvatar } from '../ui/AgentAvatar';
import { MenuSelect } from '../ui/MenuSelect';
import { AttachButton, AttachmentTray, useAttachmentDraft } from '../attachments';
import { Alert, Button } from '../ui/primitives';
import { ArrowUpIcon, FolderIcon, GlobeIcon, PencilIcon, SquarePenIcon, TrashIcon } from '../ui/icons';
import { AgentReply } from './AgentReply';
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
function ChatComposer({ placeholder, disabled, onSend, children }: {
  placeholder: string;
  disabled?: string | undefined;
  onSend: (text: string, attachmentIds: string[]) => Promise<void>;
  children?: React.ReactNode;
}): React.JSX.Element {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
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
    try { await onSend(trimmed, draft.attachmentIds); setText(''); draft.reset(); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); area.current?.focus(); }
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
        <button type="submit" aria-label="Send" disabled={text.trim() === '' || busy || disabled !== undefined || draft.busy || draft.errors.length > 0}
          className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground hover:brightness-110 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <ArrowUpIcon size={15} />
        </button>
        </div>
      </form>
    </div>
  );
}

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

  async function send(text: string, attachmentIds: string[]): Promise<void> {
    if (latest !== undefined && isWorkingState(latest.state)) {
      await window.conductor.task.enqueue({ taskId: latest.id, objective: text, mode: 'queue', ...(attachmentIds.length > 0 ? { attachmentIds } : {}) });
      return;
    }
    const workspaceId = latest?.workspaceId ?? projectId ?? await agentWorkspace();
    const created = await window.conductor.task.create({
      workspaceId, objective: text,
      ...(latest !== undefined ? { parentTaskId: latest.id } : { sandboxAgentId: agent.id }),
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
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <AgentAvatar agent={agent} size={34} mood={latest !== undefined && isWorkingState(latest.state) ? 'working' : 'idle'} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{agent.name}</h2>
          <p className="truncate text-2xs text-muted-foreground">{agent.description || agent.clis.join(' → ')}</p>
        </div>
        {chats.length > 1 ? (
          <MenuSelect
            label="Earlier chats"
            value={current ?? ''}
            onChange={(value) => { setThreadId(value); setFresh(false); }}
            className="max-w-48"
            options={chats.map((id) => ({ value: id, label: titleOf(id) }))}
          />
        ) : null}
        {sandboxRunning ? (
          <Button size="sm" variant="ghost" title="Watch its sandbox" onClick={() => { void window.conductor.sandbox.openViewer(agent.id).catch(() => undefined); }}><GlobeIcon size={13} />Watch</Button>
        ) : null}
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
            {turns.map((task) => (
              <div key={task.id} className="flex flex-col gap-4">
                <UserBubble text={task.objective} at={task.createdAt} task={task} />
                <AgentReply agent={agent} task={task} />
              </div>
            ))}
          </div>
        )}
      </div>
      <ChatComposer placeholder={`Message ${agent.name}`} onSend={send}>
        <div className="mb-2 flex items-center gap-2">
          <ProjectPicker value={chatProject} onChange={setProjectId} locked={turns.length > 0} />
        </div>
      </ChatComposer>
    </section>
  );
}

// ---- group ----------------------------------------------------------------------------

export function GroupChat({ group, agents, onDelete }: {
  group: AgentGroup;
  agents: SandboxAgent[];
  onDelete: () => void;
}): React.JSX.Element {
  const members = useMemo(() => group.agentIds.map((id) => agents.find((agent) => agent.id === id)).filter((agent): agent is SandboxAgent => agent !== undefined), [group, agents]);
  const tasks = useTaskStore((s) => s.tasks);
  const { projectId, setProjectId } = useConversationProject(`group:${group.id}`);
  const [messages, setMessages] = useState<AgentGroupMessage[]>([]);
  const [targets, setTargets] = useState<string[]>([]);
  const texts = useRef(new Map<string, string>());
  const load = useCallback(async () => {
    const list = await window.conductor.sandboxAgents.groupMessages(group.id);
    setMessages(list);
    // Reply tasks may not be in the store yet (they were created in main).
    const missing = list.flatMap((item) => Object.values(item.replies)).filter((taskId) => useTaskStore.getState().tasks[taskId] === undefined);
    await Promise.all(missing.map((taskId) => window.conductor.task.get(taskId).then((task) => { useTaskStore.getState().upsert(task); }).catch(() => undefined)));
  }, [group.id]);
  useEffect(() => { setTargets([]); texts.current.clear(); void load(); }, [load]);
  const working = messages.some((item) => Object.values(item.replies).some((taskId) => { const task = tasks[taskId]; return task !== undefined && isWorkingState(task.state); }));
  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => { void load(); }, 4_000);
    return () => { window.clearInterval(timer); };
  }, [working, load]);
  const scroll = useStickToBottom(group.id);
  const onText = useCallback((taskId: string, text: string) => { texts.current.set(taskId, text); }, []);

  async function send(text: string, attachmentIds: string[]): Promise<void> {
    // What members said in the last few exchanges, so they can build on it.
    const context = messages.slice(-3).flatMap((item) => Object.entries(item.replies).map(([agentId, taskId]) => {
      const reply = texts.current.get(taskId);
      const name = members.find((member) => member.id === agentId)?.name ?? 'Agent';
      return reply !== undefined ? `${name}: ${reply.length > 1200 ? `${reply.slice(0, 1200)}…` : reply}` : undefined;
    })).filter((line): line is string => line !== undefined).join('\n\n');
    await window.conductor.sandboxAgents.sendGroup({
      groupId: group.id, text,
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
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-4">
        <GroupAvatar members={members} size={34} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-foreground">{group.name}</h2>
          <p className="truncate text-2xs text-muted-foreground">{members.map((member) => member.name).join(', ')}</p>
        </div>
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
                {Object.entries(item.replies).map(([agentId, taskId]) => {
                  const agent = members.find((member) => member.id === agentId) ?? agents.find((candidate) => candidate.id === agentId);
                  const task: Task | undefined = tasks[taskId];
                  return agent !== undefined && task !== undefined ? <AgentReply key={taskId} agent={agent} task={task} onText={onText} /> : null;
                })}
              </div>
            ))}
          </div>
        )}
      </div>
      <ChatComposer placeholder={targets.length === 0 ? `Message everyone in ${group.name}` : `Message ${targets.map((id) => members.find((member) => member.id === id)?.name).join(', ')}`} onSend={send}>
        <div className="mb-2 flex flex-wrap items-center gap-1.5" role="group" aria-label="Send to">
          <ProjectPicker value={projectId} onChange={setProjectId} locked={messages.length > 0} />
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
