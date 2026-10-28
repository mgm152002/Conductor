import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApprovalRequest, Task } from '@shared/domain';
import { useApprovalStore, useQuestionStore, useTaskStore, useWorkspaceStore } from '../stores';
import { isTerminalTask } from '../stores/task-store';
import { pickFocusedTask } from '../components/workspace/useFocusedTask';

function message(error: unknown): string {
  return error instanceof Error ? error.message : 'Unexpected error';
}

/** One application-wide bridge subscription, including persisted boot state. */
export function useTaskEvents(): { errors: string[]; retry: () => void } {
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [attempt, setAttempt] = useState(0);
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const hasActiveTasks = useTaskStore((state) => Object.values(state.tasks).some((task) => !isTerminalTask(task)));
  const mounted = useRef(false);
  const approvalRequest = useRef(0);

  const report = useCallback((source: string, error?: unknown) => {
    if (!mounted.current) return;
    setErrors((current) => {
      const next = { ...current };
      if (error === undefined) delete next[source];
      else next[source] = `${source}: ${message(error)}`;
      return next;
    });
  }, []);

  const refreshApprovals = useCallback(async (): Promise<void> => {
    const request = ++approvalRequest.current;
    try {
      const pending = await window.conductor.approval.list();
      if (!mounted.current || request !== approvalRequest.current) return;
      useApprovalStore.getState().setPending(pending);
      report('Approvals');
    } catch (error) { if (request === approvalRequest.current) report('Approvals', error); }
  }, [report]);

  const refreshTasks = useCallback(async (): Promise<void> => {
    const selected = useWorkspaceStore.getState().activeWorkspaceId;
    const previous = Object.values(useTaskStore.getState().tasks).filter((task) => !isTerminalTask(task));
    try {
      const [active, recent] = await Promise.all([
        window.conductor.task.listActive(),
        selected === null ? Promise.resolve([] as Task[]) : window.conductor.task.list({ workspaceId: selected, limit: 100 }),
      ]);
      if (!mounted.current) return;
      const activeIds = new Set(active.map((task) => task.id));
      const ended = await Promise.allSettled(previous.filter((task) => !activeIds.has(task.id)).map((task) => window.conductor.task.get(task.id)));
      if (!mounted.current) return;
      useTaskStore.getState().setTasks([...active, ...recent, ...ended.flatMap((result) => result.status === 'fulfilled' ? [result.value] : [])]);
      report('Tasks');
    } catch (error) { report('Tasks', error); }
  }, [report]);

  useEffect(() => {
    mounted.current = true;
    const stopTasks = window.conductor.on('task.updated', (payload) => {
      const task = payload as Task;
      if (task && typeof task.id === 'string' && typeof task.updatedAt === 'string') {
        useTaskStore.getState().upsert(task);
        useTaskStore.getState().bumpDetails(task.id);
        void refreshApprovals();
      }
    });
    const stopStream = window.conductor.on('task.stream', (payload) => {
      const event = payload as { taskId?: string };
      if (event && typeof event.taskId === 'string') useTaskStore.getState().bumpDetails(event.taskId);
    });
    const stopQuestions = window.conductor.on('question.requested', (payload) => {
      const request = payload as import('@shared/domain').AgentQuestionRequest;
      if (request && typeof request.id === 'string') {
        useQuestionStore.getState().push(request);
        if (typeof request.taskId === 'string') useTaskStore.getState().bumpDetails(request.taskId);
      }
    });
    void window.conductor.question.list().then((pending) => { if (mounted.current) useQuestionStore.getState().setPending(pending); }).catch(() => {});
    const stopApprovals = window.conductor.on('approval.requested', (payload) => {
      const request = payload as ApprovalRequest;
      if (request && typeof request.id === 'string') {
        if (request.status === 'pending') useApprovalStore.getState().push(request);
        else useApprovalStore.getState().remove(request.id);
        useTaskStore.getState().bumpDetails(request.taskId);
      }
      void refreshApprovals();
    });
    return () => { mounted.current = false; approvalRequest.current += 1; stopTasks(); stopStream(); stopApprovals(); stopQuestions(); };
  }, [refreshApprovals]);

  useEffect(() => {
    let active = true;
    const initialSelection = useWorkspaceStore.getState().activeWorkspaceId;
    useWorkspaceStore.getState().setLoading(true);
    void Promise.all([window.conductor.workspace.list(), window.conductor.workspace.active()]).then(([workspaces, selected]) => {
      if (!active) return;
      const store = useWorkspaceStore.getState();
      store.setWorkspaces(workspaces);
      if (store.activeWorkspaceId === initialSelection) store.setActive(workspaces.some((item) => item.id === selected) ? selected : null);
      report('Workspaces');
    }).catch((error: unknown) => { if (active) report('Workspaces', error); }).finally(() => { if (active) useWorkspaceStore.getState().setLoading(false); });
    void refreshTasks();
    void refreshApprovals();
    return () => { active = false; };
  }, [attempt, refreshTasks, refreshApprovals, report]);

  useEffect(() => { void refreshTasks(); void refreshApprovals(); }, [workspaceId, refreshTasks, refreshApprovals]);

  useEffect(() => {
    if (!hasActiveTasks) return;
    let polling = false;
    const timer = window.setInterval(() => {
      if (polling) return;
      polling = true;
      void Promise.allSettled([refreshTasks(), refreshApprovals()]).finally(() => {
        polling = false;
        if (!mounted.current) return;
        const store = useTaskStore.getState();
        const focused = pickFocusedTask(store.tasks, store.focusedTaskId, useWorkspaceStore.getState().activeWorkspaceId);
        if (focused !== null) store.bumpDetails(focused.id);
      });
    }, 3000);
    return () => { window.clearInterval(timer); };
  }, [hasActiveTasks, refreshTasks, refreshApprovals]);

  return { errors: Object.values(errors), retry: () => { setAttempt((value) => value + 1); } };
}
