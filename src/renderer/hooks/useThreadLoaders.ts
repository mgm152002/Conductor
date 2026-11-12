import { useEffect } from 'react';
import { useTaskStore, useWorkspaceStore } from '../stores';
import { useChatStore } from '../stores/chat-store';
import { useSandboxAgentStore } from '../stores/sandbox-agent-store';

/**
 * Loads what the boards list: every project's recent threads (not only the
 * active project's) and the chat history with its spaces. Mounted once in the
 * app shell so the Work board, the Chat start page, the thread drawer and the
 * command palette all read the same stores.
 */
export function useThreadLoaders(): void {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  // Keyed by the id list so renames don't refetch every project's history.
  const workspaceKey = workspaces.map((w) => w.id).join(',');
  useEffect(() => {
    let cancelled = false;
    for (const id of workspaceKey === '' ? [] : workspaceKey.split(',')) {
      void window.conductor.task.list({ workspaceId: id, limit: 50 }).then((list) => {
        if (!cancelled) useTaskStore.getState().setTasks(list);
      }).catch(() => { /* surfaced by the main data pump */ });
    }
    return () => { cancelled = true; };
  }, [workspaceKey]);

  useEffect(() => {
    void window.conductor.chat.list().then((list) => { useChatStore.getState().setThreads(list); }).catch(() => { /* the drawer shows its own retry */ });
    void window.conductor.chat.listSpaces().then((list) => { useChatStore.getState().setSpaces(list); }).catch(() => { /* spaces are additive */ });
    void useSandboxAgentStore.getState().refresh();
    // Agent chats outside any project live in a hidden workspace; load them
    // so their notifications show up on every screen.
    void window.conductor.sandboxAgents.workspace()
      .then((workspaceId) => window.conductor.task.list({ workspaceId, limit: 100 }))
      .then((list) => { useTaskStore.getState().setTasks(list); })
      .catch(() => undefined);
  }, []);
}
