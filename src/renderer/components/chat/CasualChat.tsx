import { useEffect, useMemo, useRef, useState } from 'react';
import { NavLink } from 'react-router-dom';
import type { RunChoice } from '@shared/agent-models';
import type { ChatSpace, ChatThread } from '@shared/chat-contract';
import { useChatStore } from '../../stores/chat-store';
import { useComposerStore } from '../../stores/composer-store';
import { useAgents } from '../../hooks/useAgents';
import { MessagesTimeline } from './MessagesTimeline';
import { HandoffDivider } from './AgentMark';
import { ModelEffortPicker } from './ModelEffortPicker';
import { Mem0OfflineNotice } from './Mem0OfflineNotice';
import { PendingQuestionPanel } from './PendingQuestionPanel';
import { ChatPendingApprovals } from './PendingApprovalPanel';
import { DeleteChatDialog } from '../threads/DeleteChatDialog';
import { RenameChatDialog } from '../threads/RenameChatDialog';
import { SpaceNameDialog } from '../threads/SpaceDialogs';
import { ArrowUpIcon, MessageIcon, PencilIcon, PlusIcon, StopIcon, TrashIcon } from '../ui/icons';
import { EntityIcon } from '../ui/EntityIcon';
import { ProviderAvatar, agentBrand } from '../ui/BrandMarks';
import { MenuSelect } from '../ui/MenuSelect';
import { AttachButton, AttachmentTray, useAttachmentDraft } from '../attachments';
import { cn } from '../../lib/cn';
import { buildChatMessageTimeline, messageShowsCurrentHandoff } from '../../lib/timeline';
import { hasArtifactBlock, hasDeliveredFileLink, requestedArtifactKind, synthesizeSpec } from '@shared/generated-artifacts';
import { GeneratedArtifact } from './GeneratedArtifact';
import { MessageActions } from './MessageActions';
import { useElementHeight } from '../../hooks/useElementHeight';
import { useMentions, type MentionCommand } from '../mentions/useMentions';
import { WorkingIndicator } from './WorkingIndicator';

/** Project-free conversation: no plans, project context or task workflow. */
export function CasualChat(): React.JSX.Element {
  const selectedId = useChatStore((state) => state.selectedId);
  const conversation = useChatStore((state) => selectedId === null ? undefined : state.conversations[selectedId]);
  const draftKey = selectedId ?? 'new';
  const text = useChatStore((state) => state.drafts[draftKey] ?? '');
  const agents = useAgents().filter((agent) => !agent.remote && agent.available);
  // The CLI/model selection lives in the persisted composer store, per CLI:
  // sending a message, opening another thread, or switching CLI never clears
  // it — it changes only when the user picks something else.
  const agentId = useComposerStore((s) => s.chatAgentId);
  const setAgentId = useComposerStore((s) => s.setChatAgentId);
  const chatChoices = useComposerStore((s) => s.chatChoices);
  const setChatChoice = useComposerStore((s) => s.setChatChoice);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const [deletingThread, setDeletingThread] = useState<ChatThread | null>(null);
  const [renamingThread, setRenamingThread] = useState<ChatThread | null>(null);
  const spaces = useChatStore((state) => state.spaces);
  const threads = useChatStore((state) => state.threads);
  /** Space chosen for the next new chat; existing chats use their stored space. */
  const [draftSpaceId, setDraftSpaceId] = useState<string | null>(null);
  const [creatingSpace, setCreatingSpace] = useState(false);
  const currentSpaceId = conversation?.thread.spaceId ?? (selectedId === null ? draftSpaceId : null);
  const currentSpace = spaces.find((space) => space.id === currentSpaceId) ?? null;
  const spaceSiblingCount = currentSpaceId === null ? 0 : threads.filter((thread) => thread.spaceId === currentSpaceId && thread.id !== selectedId).length;
  const attachmentDraft = useAttachmentDraft();
  const scroller = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const stick = useRef(true);
  const [dock, dockHeight] = useElementHeight<HTMLDivElement>();
  const box = useRef<HTMLFormElement>(null);
  const chatCommands = useMemo((): MentionCommand[] => [
    { name: 'new', description: 'Start a new chat', run: () => { useChatStore.getState().select(null); } },
  ], []);
  const mentions = useMentions({
    text, setText: (value) => { useChatStore.getState().setDraft(draftKey, value); }, textarea, anchor: box, attachments: attachmentDraft,
    // Quick chats have no project, so @ offers other conversations, not files.
    workspaceId: null, commands: chatCommands, currentChatId: selectedId,
  });
  const currentSelection = useRef(selectedId);
  currentSelection.current = selectedId;
  const busy = submitting || conversation?.messages.some((message) => message.status === 'streaming') === true;
  // Mid-thread switching: a local pick wins over the thread's last agent, so
  // the next message can move to another CLI (and its models) in the same
  // conversation; history is passed to whichever agent runs next.
  const selectedAgent = (agents.some((agent) => agent.id === agentId) ? agentId : '')
    || conversation?.thread.agentId || agents[0]?.id || '';
  const runChoice: RunChoice = chatChoices[selectedAgent] ?? {};
  const agentName = (id: string): string => agents.find((agent) => agent.id === id)?.name ?? id;

  useEffect(() => {
    void window.conductor.chat.listSpaces().then((list) => { useChatStore.getState().setSpaces(list); }).catch(() => undefined);
  }, []);

  async function assignSpace(spaceId: string | null): Promise<void> {
    if (selectedId === null) { setDraftSpaceId(spaceId); return; }
    try {
      const updated = await window.conductor.chat.setThreadSpace(selectedId, spaceId);
      useChatStore.getState().setThreadSpace(updated);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not move the chat'); }
  }

  useEffect(() => {
    setError(null);
    setLoadFailed(false);
    stick.current = true;
    textarea.current?.focus();
    if (selectedId === null) { setLoading(false); return; }
    let active = true;
    setLoading(true);
    void window.conductor.chat.get(selectedId).then((snapshot) => {
      if (active) useChatStore.getState().receive(snapshot);
    }).catch((err: unknown) => { if (active) { setError(err instanceof Error ? err.message : 'Could not load chat'); setLoadFailed(true); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [selectedId, revision]);

  useEffect(() => {
    const element = scroller.current;
    if (element && stick.current) element.scrollTop = element.scrollHeight;
  }, [conversation, dockHeight]);

  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [text]);

  async function send(): Promise<void> {
    if (!selectedAgent) { setLoadFailed(false); setError('Connect an available local agent before sending.'); return; }
    if (!text.trim() || busy || loading || attachmentDraft.busy || attachmentDraft.errors.length > 0) return;
    setError(null); setLoadFailed(false); setSubmitting(true);
    const originatingId = selectedId;
    try {
      const snapshot = await window.conductor.chat.send({
        ...(selectedId === null ? {} : { threadId: selectedId }),
        ...(selectedId === null && draftSpaceId !== null ? { spaceId: draftSpaceId } : {}),
        content: text.trim(), agentId: selectedAgent,
        ...(Object.keys(runChoice).length > 0 ? { runOptions: runChoice } : {}),
        ...(attachmentDraft.attachmentIds.length > 0 ? { attachments: attachmentDraft.attachmentIds } : {}),
      });
      const store = useChatStore.getState();
      store.receive(snapshot);
      store.setDraft(draftKey, '');
      attachmentDraft.reset();
      if (currentSelection.current === originatingId) store.select(snapshot.thread.id);
      stick.current = true;
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not send message'); }
    finally { setSubmitting(false); textarea.current?.focus(); }
  }

  /** Copy this chat up to `messageId` into a new chat and open it. */
  async function fork(messageId: string): Promise<void> {
    if (selectedId === null) return;
    setError(null); setLoadFailed(false);
    try {
      const forked = await window.conductor.chat.fork(selectedId, messageId);
      const store = useChatStore.getState();
      store.receive(forked);
      store.select(forked.thread.id);
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not fork the chat'); }
  }

  async function stop(): Promise<void> {
    if (selectedId === null) return;
    setLoadFailed(false);
    try { await window.conductor.chat.cancel(selectedId); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not stop reply'); }
  }

  const hasMessages = (conversation?.messages.length ?? 0) > 0;
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      <header className={cn('window-header flex shrink-0 items-center gap-2 px-4', hasMessages || conversation !== undefined ? 'border-b border-border' : '')}>
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <h1 className={cn('min-w-0 truncate text-[13px] font-medium', conversation === undefined && 'sr-only')}>{conversation?.thread.title ?? 'New chat'}</h1>
          {conversation !== undefined ? (
            <>
              <button
                type="button"
                onClick={() => { setRenamingThread(conversation.thread); }}
                aria-label={`Rename chat: ${conversation.thread.title}`}
                title="Rename chat"
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <PencilIcon size={13} />
              </button>
              <button
                type="button"
                onClick={() => { setDeletingThread(conversation.thread); }}
                aria-label={`Delete chat: ${conversation.thread.title}`}
                title="Delete chat"
                className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-destructive-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                <TrashIcon size={13} />
              </button>
            </>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <MenuSelect
            label="Space for this chat"
            value={currentSpaceId ?? ''}
            title={currentSpace !== null ? `In Space "${currentSpace.name}"` : 'Put this chat in a space to share context'}
            onChange={(value) => {
              if (value === '__new__') { setCreatingSpace(true); return; }
              void assignSpace(value === '' ? null : value);
            }}
            className="max-w-44"
            options={[
              { value: '', label: 'No space', mark: <MessageIcon size={13} /> },
              ...spaces.map((space: ChatSpace) => ({ value: space.id, label: `Space: ${space.name}`, mark: <EntityIcon icon={space.icon ?? null} name={space.name} kind="space" size={16} /> })),
              { value: '__new__', label: 'New space…', mark: <PlusIcon size={13} /> },
            ]}
          />
        </div>
      </header>
      {creatingSpace ? (
        <SpaceNameDialog
          space={null}
          open
          onClose={() => { setCreatingSpace(false); }}
          onSaved={(saved) => { void assignSpace(saved.id); }}
        />
      ) : null}
      {deletingThread !== null ? <DeleteChatDialog thread={deletingThread} open onClose={() => { setDeletingThread(null); }} /> : null}
      {renamingThread !== null ? <RenameChatDialog key={renamingThread.id} thread={renamingThread} open onClose={() => { setRenamingThread(null); }} /> : null}
      <div className={hasMessages ? 'relative flex min-h-0 flex-1 flex-col' : 'contents'}>
      <div ref={scroller} onScroll={(event) => { const el = event.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }} className={hasMessages ? 'min-h-0 flex-1 overflow-y-auto' : 'shrink-0 pt-[22vh]'}>
        {hasMessages ? (
          <div className="mx-auto flex w-full max-w-(--chat-max) flex-col gap-7 px-6 pt-8" style={{ paddingBottom: dockHeight + 24 }} aria-label="Chat messages">
            {conversation?.messages.map((message, index) => {
              // A handoff divider wherever the replying CLI or model changed
              // from the previous reply: the switch is visible in the answer
              // space, with the new CLI's mark, instead of happening silently.
              const previousAssistant = message.role === 'assistant'
                ? [...(conversation?.messages.slice(0, index) ?? [])].reverse().find((m) => m.role === 'assistant' && m.agentId !== undefined)
                : undefined;
              const showHandoff = previousAssistant !== undefined && message.agentId !== undefined
                && (previousAssistant.agentId !== message.agentId
                  || (previousAssistant.model !== undefined && message.model !== undefined && previousAssistant.model !== message.model))
                // Replies recorded before this dedupe may already carry the
                // same switch as an inline handoff activity.
                && !messageShowsCurrentHandoff(message);
              return (
              <div key={message.id} className="group/msg flex flex-col gap-7">
                {showHandoff ? (
                  <HandoffDivider
                    fromAgent={agentName(previousAssistant!.agentId!)}
                    toAgentId={message.agentId!}
                    toAgent={agentName(message.agentId!)}
                    {...(previousAssistant!.model !== undefined ? { fromModel: previousAssistant!.model } : {})}
                    {...(message.model !== undefined ? { toModel: message.model } : {})}
                    reason="The CLI or model changed between replies"
                  />
                ) : null}
              <article aria-label={message.role === 'user' ? 'You' : 'Assistant'} className={cn('min-w-0 [overflow-wrap:anywhere]', message.role === 'user' && 'ml-auto max-w-[80%] rounded-2xl bg-message px-4 py-2.5 text-message-foreground')}>
                {message.role === 'user' && message.attachments.length > 0 ? <div className="mb-2"><AttachmentTray attachments={message.attachments} /></div> : null}
                {message.role === 'user' ? <p className="whitespace-pre-wrap text-sm leading-relaxed">{message.content}</p> : (message.content || (message.activity?.length ?? 0) > 0 || message.error) ? <MessagesTimeline items={buildChatMessageTimeline(message)} live={message.status === 'streaming'} /> : message.status === 'streaming' ? <WorkingIndicator label="Thinking" /> : null}
                {message.role === 'assistant' && message.status === 'streaming' && message.content ? null : message.role === 'assistant' && message.status === 'streaming' && (message.activity?.length ?? 0) > 0 && !message.content ? <WorkingIndicator className="mt-1.5" label="Working" /> : null}
                {message.status === 'cancelled' ? <p className="mt-2 text-xs text-muted-foreground">Stopped.</p> : null}
              </article>
              {message.status !== 'streaming' ? (
                <MessageActions
                  className="-mt-6"
                  align={message.role === 'user' ? 'end' : 'start'}
                  text={message.content}
                  at={message.createdAt}
                  {...(message.role === 'assistant' && !busy ? { onFork: () => { void fork(message.id); } } : {})}
                />
              ) : null}
              {(() => {
                // Fallback: the user asked for a file but this agent (any CLI)
                // replied in plain text — Conductor still builds the file.
                if (message.role !== 'assistant' || message.status !== 'complete' || message.content.trim() === '' || hasArtifactBlock(message.content) || hasDeliveredFileLink(message.content)) return null;
                const request = [...(conversation?.messages.slice(0, index) ?? [])].reverse().find((m) => m.role === 'user');
                const kind = request !== undefined ? requestedArtifactKind(request.content) : null;
                return kind !== null && request !== undefined ? <GeneratedArtifact spec={synthesizeSpec(kind, request.content, message.content)} /> : null;
              })()}
              </div>
              );
            })}
          </div>
        ) : (
          <div className="flex flex-col items-center px-6 pb-5 text-center">
            <h1 className="w-full text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">What’s on your mind?</h1>
          </div>
        )}
      </div>
      {/* With messages, the composer floats over the conversation's end. */}
      <div ref={dock} className={cn('mx-auto w-full max-w-(--chat-max) px-5 pb-5', hasMessages ? 'pointer-events-none absolute inset-x-0 bottom-0 [&>*]:pointer-events-auto' : 'min-h-0 flex-1 overflow-y-auto pt-1')}>
        {loading ? <p role="status" className="composer-glass mb-2 w-fit rounded-lg px-2.5 py-1 text-xs text-muted-foreground">Loading conversation…</p> : null}
        {error ? <p role="alert" className="composer-glass mb-2 w-fit rounded-lg px-2.5 py-1 text-xs text-destructive-foreground [overflow-wrap:anywhere]">{error} {loadFailed ? <button type="button" onClick={() => { setRevision((value) => value + 1); }} className="underline">Retry loading</button> : null}</p> : null}
        {!agents.length ? <p className="composer-glass mb-3 w-fit rounded-lg px-2.5 py-1 text-xs text-muted-foreground">Connect a local agent in <NavLink to="/connected-apps" className="underline">Connections</NavLink> to start chatting. No project is needed.</p> : null}
        <Mem0OfflineNotice />
        {selectedId !== null ? <PendingQuestionPanel scopeId={selectedId} /> : null}
        {selectedId !== null ? <ChatPendingApprovals threadId={selectedId} /> : null}
        {mentions.menu}
        <form ref={box} onSubmit={(event) => { event.preventDefault(); void send(); }} onDragOver={attachmentDraft.onDragOver} onDrop={attachmentDraft.onDrop} className="composer-glass rounded-2xl border border-input p-2.5 shadow-composer transition-[border-color,box-shadow] focus-within:border-ring/60">
          <label htmlFor="casual-message" className="sr-only">Message</label>
          <textarea ref={textarea} id="casual-message" value={text} maxLength={10000} onChange={(event) => { useChatStore.getState().setDraft(draftKey, event.target.value); }} onPaste={attachmentDraft.onPaste} {...mentions.textareaProps} onKeyDown={(event) => {
            if (mentions.onKeyDown(event)) return;
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} placeholder="Ask anything. @ other chats, / commands" rows={2} className="block max-h-45 min-h-14 w-full resize-none bg-transparent px-1.5 py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/60" />
          <div className="px-1 pt-1">
            <AttachmentTray
              attachments={attachmentDraft.attachments}
              onRemove={(id) => { void attachmentDraft.remove(id); }}
              onPick={() => { void attachmentDraft.pick(); }}
              picker={false}
              busy={attachmentDraft.busy}
              disabled={submitting}
              progress={attachmentDraft.progress}
              errors={attachmentDraft.errors}
              onClearErrors={attachmentDraft.clearErrors}
            />
          </div>
          <div className="mt-2 flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
              <AttachButton onPick={() => { void attachmentDraft.pick(); }} count={attachmentDraft.attachments.length} disabled={attachmentDraft.busy || submitting} />
              <MenuSelect
                label="Chat agent"
                value={selectedAgent}
                disabled={busy}
                title="Agent for the next message"
                onChange={(next) => { setAgentId(next); }}
                options={[
                  ...(!selectedAgent ? [{ value: '', label: 'Choose an agent' }] : []),
                  ...(selectedAgent && !agents.some((agent) => agent.id === selectedAgent)
                    ? [{ value: selectedAgent, label: selectedAgent, hint: 'Unavailable' }]
                    : []),
                  ...agents.map((agent) => ({
                    value: agent.id,
                    label: agent.name,
                    mark: <ProviderAvatar brand={agentBrand(agent.id)} label={agent.name} size={13} />,
                  })),
                ]}
              />
              {selectedAgent ? <ModelEffortPicker agentId={selectedAgent} value={runChoice} onChange={(choice) => { setChatChoice(selectedAgent, choice); }} /> : null}
            </div>
            {busy && selectedId !== null ? <button type="button" onClick={() => { void stop(); }} aria-label="Stop reply" className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-foreground text-background"><StopIcon size={14} /></button> : <button type="submit" aria-label="Send message" disabled={!text.trim() || busy || loading || !selectedAgent || attachmentDraft.busy || attachmentDraft.errors.length > 0} className="flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground transition-[filter,transform,background-color] duration-150 hover:brightness-110 active:scale-90 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground/60"><ArrowUpIcon size={16} /></button>}
          </div>
          {currentSpace !== null ? <p className="mt-1.5 px-1.5 text-3xs text-muted-foreground">Sharing context with {spaceSiblingCount} other {spaceSiblingCount === 1 ? 'chat' : 'chats'} in {currentSpace.name}</p> : null}
        </form>
      </div>
      </div>
    </div>
  );
}
