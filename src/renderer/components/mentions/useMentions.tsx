import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Skill, Task } from '@shared/domain';
import type { ChatThread } from '@shared/chat-contract';
import { useTaskStore, useWorkspaceStore } from '../../stores';
import { useChatStore } from '../../stores/chat-store';
import { useSandboxAgentStore } from '../../stores/sandbox-agent-store';
import { groupThreads } from '../../lib/threads';
import { threadTitle } from '../../lib/thread-status';
import { activeToken, markdownDraftFile, rankMentions, referenceFileName, replaceToken, type ActiveToken } from '../../lib/mentions';
import { cn } from '../../lib/cn';
import { BotIcon, CommandIcon, FileTextIcon, MessageIcon, SparklesIcon, WorkflowIcon } from '../ui/icons';
import type { AttachmentDraft } from '../attachments/useAttachmentDraft';

// The @ / menu shared by every message box. `@` references a project file
// (its path goes into the message), another work thread, agent chat or quick
// chat (attached as a Markdown transcript the agent can read). `/` runs one of
// the box's commands or attaches a skill's procedure.

export interface MentionCommand {
  name: string;
  description: string;
  run: () => void;
}

type OptionIcon = 'file' | 'thread' | 'agent' | 'chat' | 'skill' | 'command';
interface MentionOption {
  key: string;
  group: string;
  label: string;
  detail?: string | undefined;
  icon: OptionIcon;
  /** The text that replaces the token ('' removes it). */
  insertion: string;
  /** Extra work after inserting: attaching a file or transcript, or running a command. */
  after?: (() => Promise<void> | void) | undefined;
}

const ICONS: Record<OptionIcon, (props: { size: number; className?: string }) => React.JSX.Element> = {
  file: FileTextIcon, thread: WorkflowIcon, agent: BotIcon, chat: MessageIcon, skill: SparklesIcon, command: CommandIcon,
};

// Project files and skills change rarely; fetch once a minute at most.
const FILE_TTL_MS = 60_000;
const fileCache = new Map<string, { at: number; files: Promise<string[]> }>();
function projectFiles(workspaceId: string): Promise<string[]> {
  const cached = fileCache.get(workspaceId);
  if (cached !== undefined && Date.now() - cached.at < FILE_TTL_MS) return cached.files;
  const files = window.conductor.workspace.files(workspaceId).catch(() => [] as string[]);
  fileCache.set(workspaceId, { at: Date.now(), files });
  return files;
}
// Every thread and chat, not just the ones the sidebar happens to have loaded.
let conversationCache: { at: number; data: Promise<{ tasks: Task[]; chats: ChatThread[] }> } | undefined;
function allConversations(): Promise<{ tasks: Task[]; chats: ChatThread[] }> {
  if (conversationCache !== undefined && Date.now() - conversationCache.at < 15_000) return conversationCache.data;
  const data = Promise.all([
    window.conductor.task.list({ limit: 500 }).catch(() => [] as Task[]),
    window.conductor.chat.list().catch(() => [] as ChatThread[]),
  ]).then(([tasks, chats]) => ({ tasks, chats }));
  conversationCache = { at: Date.now(), data };
  return data;
}
let skillCache: { at: number; skills: Promise<Skill[]> } | undefined;
function allSkills(): Promise<Skill[]> {
  if (skillCache !== undefined && Date.now() - skillCache.at < FILE_TTL_MS) return skillCache.skills;
  const skills = window.conductor.skills.list().catch(() => [] as Skill[]);
  skillCache = { at: Date.now(), skills };
  return skills;
}

async function chatTranscript(chatId: string): Promise<{ title: string; markdown: string }> {
  const conversation = await window.conductor.chat.get(chatId);
  const body = conversation.messages
    .filter((message) => message.content.trim() !== '')
    .map((message) => `## ${message.role === 'user' ? 'User' : 'Assistant'}\n\n${message.content.trim()}`)
    .join('\n\n');
  return { title: conversation.thread.title, markdown: `# Chat: ${conversation.thread.title}\n\n${body}\n` };
}

async function skillMarkdown(skillId: string): Promise<{ name: string; markdown: string }> {
  const skill = await window.conductor.skills.get(skillId);
  if (skill === undefined || skill === null) throw new Error('That skill was not found');
  const body = skill.body;
  const list = (items: readonly string[]): string => items.map((item) => `- ${item}`).join('\n');
  const parts = [
    `# Skill: ${skill.name}`,
    body.purpose !== '' ? `## Purpose\n\n${body.purpose}` : '',
    body.applicability !== '' ? `## When to use\n\n${body.applicability}` : '',
    body.requiredContext.length > 0 ? `## Required context\n\n${list(body.requiredContext)}` : '',
    `## Steps\n\n${body.steps.map((step, index) => `${index + 1}. ${step.instruction}${step.constraints.length > 0 ? `\n${step.constraints.map((c) => `   - ${c}`).join('\n')}` : ''}`).join('\n')}`,
    body.failureHandling !== '' ? `## If something fails\n\n${body.failureHandling}` : '',
  ].filter((part) => part !== '');
  return { name: skill.name, markdown: `${parts.join('\n\n')}\n` };
}

export interface UseMentionsOptions {
  text: string;
  setText: (text: string) => void;
  textarea: React.RefObject<HTMLTextAreaElement | null>;
  /** The message box; the menu opens above it. */
  anchor: React.RefObject<HTMLElement | null>;
  attachments?: AttachmentDraft | undefined;
  /** Project whose files `@` lists; none hides files. */
  workspaceId?: string | null | undefined;
  /** With the project's folder: a picked file is also attached (for chats that cannot read the project). */
  attachFilesFrom?: string | undefined;
  commands?: readonly MentionCommand[] | undefined;
  /** The conversation being typed in, left out of the list. */
  currentThreadKey?: string | null | undefined;
  currentChatId?: string | null | undefined;
}

export function useMentions(options: UseMentionsOptions): {
  menu: React.ReactNode;
  /** Call first in the textarea's onKeyDown; true means the menu used the key. */
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
  /** Spread onto the textarea so the menu follows the caret and closes on blur. */
  textareaProps: { onSelect: () => void; onClick: () => void; onFocus: () => void; onBlur: () => void };
} {
  const { text, setText, textarea, anchor, attachments, workspaceId, attachFilesFrom, commands = [], currentThreadKey, currentChatId } = options;
  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [active, setActive] = useState(0);
  const track = useCallback(() => { setCaret(textarea.current?.selectionStart ?? 0); }, [textarea]);
  useLayoutEffect(() => { track(); }, [text, track]);

  const token: ActiveToken | null = focused ? activeToken(text, caret) : null;
  const open = token !== null && dismissed !== token.start;
  useEffect(() => { if (token === null) setDismissed(null); }, [token]);

  // Sources, loaded when the menu first opens.
  const [files, setFiles] = useState<string[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  const needFiles = open && token.trigger === '@' && workspaceId != null;
  const needSkills = open && token.trigger === '/';
  const needConversations = open && token.trigger === '@' && attachments !== undefined;
  const [loaded, setLoaded] = useState<{ tasks: Task[]; chats: ChatThread[] }>({ tasks: [], chats: [] });
  useEffect(() => {
    if (!needConversations) return;
    let live = true;
    void allConversations().then((data) => { if (live) setLoaded(data); });
    return () => { live = false; };
  }, [needConversations]);
  useEffect(() => {
    if (!needFiles || workspaceId == null) return;
    let live = true;
    void projectFiles(workspaceId).then((list) => { if (live) setFiles(list); });
    return () => { live = false; };
  }, [needFiles, workspaceId]);
  useEffect(() => {
    if (!needSkills) return;
    let live = true;
    void allSkills().then((list) => { if (live) setSkills(list); });
    return () => { live = false; };
  }, [needSkills]);
  const tasks = useTaskStore((s) => s.tasks);
  const agentThreads = useSandboxAgentStore((s) => s.threads);
  const sandboxAgents = useSandboxAgentStore((s) => s.agents);
  const storeChats = useChatStore((s) => s.threads);
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  // The store's (live) copies win over the fetched list.
  const allTasks = useMemo(() => {
    const merged = new Map<string, Task>(loaded.tasks.map((task) => [task.id, task]));
    for (const task of Object.values(tasks)) merged.set(task.id, task);
    return [...merged.values()];
  }, [loaded.tasks, tasks]);
  const chats = useMemo(() => {
    const merged = new Map<string, ChatThread>(loaded.chats.map((chat) => [chat.id, chat]));
    for (const chat of storeChats) merged.set(chat.id, chat);
    return [...merged.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }, [loaded.chats, storeChats]);

  const attach = useCallback(async (file: Parameters<AttachmentDraft['addFiles']>[0] extends Iterable<infer F> ? F : never) => {
    if (attachments !== undefined) await attachments.addFiles([file]);
  }, [attachments]);

  const items = useMemo((): MentionOption[] => {
    if (!open) return [];
    const query = token.query;
    if (token.trigger === '/') {
      const commandItems = rankMentions(commands, query, (c) => c.name, 8).map((command): MentionOption => ({
        key: `command:${command.name}`, group: 'Commands', label: `/${command.name}`, detail: command.description, icon: 'command', insertion: '', after: command.run,
      }));
      const skillItems = attachments === undefined ? [] : rankMentions(skills, query, (s) => s.name, 8).map((skill): MentionOption => ({
        key: `skill:${skill.id}`, group: 'Skills', label: skill.name, detail: 'Attach this skill’s steps', icon: 'skill', insertion: `/${skill.name.replace(/\s+/g, '-')}`,
        after: async () => { const { name, markdown } = await skillMarkdown(skill.id); await attach(markdownDraftFile(referenceFileName('skill', name), markdown)); },
      }));
      return [...commandItems, ...skillItems];
    }
    const empty = query.trim() === '';
    const fileItems = rankMentions(files, query, (path) => path, empty ? 6 : 10, true).map((path): MentionOption => {
      const slash = path.lastIndexOf('/');
      return {
        key: `file:${path}`, group: 'Files', label: path.slice(slash + 1), detail: slash > 0 ? path.slice(0, slash) : undefined, icon: 'file', insertion: `@${path}`,
        ...(attachFilesFrom !== undefined && attachments !== undefined ? { after: () => attach({ name: path.slice(slash + 1), size: 0, type: '', arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)), path: `${attachFilesFrom.replace(/\/+$/, '')}/${path}` }) } : {}),
      };
    });
    const referenceable = attachments !== undefined;
    const threads = referenceable ? groupThreads(allTasks).filter((thread) => thread.key !== currentThreadKey) : [];
    const projectName = (workspaceId: string): string | undefined => workspaces.find((w) => w.id === workspaceId)?.name;
    const agentName = (threadKey: string): string | undefined => {
      const agentId = agentThreads[threadKey];
      return agentId === undefined ? undefined : sandboxAgents.find((agent) => agent.id === agentId)?.name ?? 'Agent';
    };
    const threadItem = (thread: (typeof threads)[number]): MentionOption => {
      const title = threadTitle(thread.root);
      const agent = agentName(thread.key);
      return {
        key: `thread:${thread.key}`, group: agent !== undefined ? 'Agent chats' : 'Threads', label: title, detail: agent ?? projectName(thread.root.workspaceId), icon: agent !== undefined ? 'agent' : 'thread', insertion: `@${title}`,
        after: async () => { const transcript = await window.conductor.task.transcript(thread.key); await attach(markdownDraftFile(referenceFileName('thread', transcript.title), transcript.markdown)); },
      };
    };
    // The menu scrolls, so show a good number of each kind.
    const limit = empty ? 8 : 12;
    const workThreads = rankMentions(threads.filter((t) => agentThreads[t.key] === undefined), query, (t) => threadTitle(t.root), limit).map(threadItem);
    const agentChats = rankMentions(threads.filter((t) => agentThreads[t.key] !== undefined), query, (t) => threadTitle(t.root), limit).map(threadItem);
    const chatItems = !referenceable ? [] : rankMentions(chats.filter((chat) => chat.id !== currentChatId), query, (chat) => chat.title, limit).map((chat): MentionOption => ({
      key: `chat:${chat.id}`, group: 'Chats', label: chat.title, icon: 'chat', insertion: `@${chat.title}`,
      after: async () => { const transcript = await chatTranscript(chat.id); await attach(markdownDraftFile(referenceFileName('chat', transcript.title), transcript.markdown)); },
    }));
    return [...fileItems, ...workThreads, ...agentChats, ...chatItems];
  }, [open, token?.trigger, token?.query, commands, skills, files, allTasks, workspaces, agentThreads, sandboxAgents, chats, currentThreadKey, currentChatId, attachments, attachFilesFrom, attach]);

  useEffect(() => { setActive(0); }, [token?.trigger, token?.query]);

  const choose = useCallback((option: MentionOption) => {
    if (token === null) return;
    const next = replaceToken(text, token, option.insertion);
    setText(next.text);
    requestAnimationFrame(() => {
      const element = textarea.current;
      if (element === null) return;
      element.focus();
      element.setSelectionRange(next.caret, next.caret);
      setCaret(next.caret);
    });
    void Promise.resolve(option.after?.()).catch(() => undefined);
  }, [text, token, setText, textarea]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === 'Escape') { event.preventDefault(); setDismissed(token.start); return true; }
    if (items.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((current) => (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
      event.preventDefault();
      choose(items[Math.min(active, items.length - 1)]!);
      return true;
    }
    return false;
  }, [open, token, items, active, choose]);

  const menu = open ? (
    <MentionMenu anchor={anchor} items={items} active={Math.min(active, Math.max(items.length - 1, 0))} onHover={setActive} onChoose={choose}
      empty={token.trigger === '@' ? (workspaceId == null ? 'No matching conversations' : 'No matching files or conversations') : 'No matching commands or skills'} />
  ) : null;

  return {
    menu,
    onKeyDown,
    textareaProps: { onSelect: track, onClick: track, onFocus: () => { setFocused(true); track(); }, onBlur: () => { setFocused(false); } },
  };
}

/** Height of the window header (with the traffic lights) the menu stays below. */
const HEADER_CLEARANCE = 52;

function MentionMenu({ anchor, items, active, onHover, onChoose, empty }: {
  anchor: React.RefObject<HTMLElement | null>;
  items: MentionOption[]; active: number; empty: string;
  onHover: (index: number) => void; onChoose: (option: MentionOption) => void;
}): React.JSX.Element | null {
  const [rect, setRect] = useState<DOMRect | null>(null);
  useLayoutEffect(() => {
    const measure = (): void => { setRect(anchor.current?.getBoundingClientRect() ?? null); };
    measure();
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true); };
  }, [anchor]);
  useEffect(() => {
    document.getElementById(`mention-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);
  if (rect === null) return null;
  let previousGroup = '';
  return createPortal(
    <div
      role="listbox"
      aria-label="Mentions"
      onMouseDown={(event) => { event.preventDefault(); }}
      // Never taller than the room above the box, minus the window header, so
      // the first rows are never hidden under it; the list scrolls instead.
      style={{ position: 'fixed', left: rect.left, width: rect.width, bottom: window.innerHeight - rect.top + 8, maxHeight: Math.max(96, Math.min(360, rect.top - 8 - HEADER_CLEARANCE)) }}
      className="composer-glass z-[100] overflow-y-auto overscroll-contain rounded-xl border border-border p-1 shadow-composer"
    >
      {items.length === 0 ? <p className="px-2.5 py-2 text-xs text-muted-foreground">{empty}</p> : items.map((item, index) => {
        const Icon = ICONS[item.icon];
        const heading = item.group !== previousGroup ? item.group : null;
        previousGroup = item.group;
        return (
          <div key={item.key}>
            {heading !== null ? <p className="px-2.5 pt-2 pb-1 text-3xs font-medium tracking-wide text-muted-foreground uppercase">{heading}</p> : null}
            <div
              id={`mention-${index}`}
              role="option"
              aria-selected={index === active}
              onMouseEnter={() => { onHover(index); }}
              onClick={() => { onChoose(item); }}
              className={cn('flex h-8 cursor-pointer items-center gap-2 rounded-lg px-2.5 text-[13px]', index === active ? 'bg-accent text-foreground' : 'text-foreground/85')}
            >
              <Icon size={14} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 shrink truncate">{item.label}</span>
              {item.detail !== undefined ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.detail}</span> : null}
            </div>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
