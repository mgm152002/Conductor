import type { Task } from '@shared/domain';

// A conversation thread is a chain of tasks: the first message and each
// follow-up. Tasks created before threads existed form one-task threads.

export interface ThreadView {
  key: string;
  /** The first task (its objective titles the thread). */
  root: Task;
  /** The most recent task; its state drives the thread's status. */
  latest: Task;
  /** All known tasks in the thread, oldest first. */
  tasks: Task[];
}

export function threadKey(task: Pick<Task, 'id' | 'threadId'>): string {
  return task.threadId ?? task.id;
}

export function groupThreads(tasks: Iterable<Task>): ThreadView[] {
  const groups = new Map<string, Task[]>();
  for (const task of tasks) {
    const key = threadKey(task);
    const list = groups.get(key) ?? [];
    list.push(task);
    groups.set(key, list);
  }
  const threads: ThreadView[] = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    threads.push({ key, root: list.find((task) => task.id === key) ?? list[0]!, latest: list[list.length - 1]!, tasks: list });
  }
  return threads.sort((a, b) => b.latest.updatedAt.localeCompare(a.latest.updatedAt) || b.key.localeCompare(a.key));
}

export function threadTasks(tasks: Record<string, Task>, key: string): Task[] {
  return Object.values(tasks)
    .filter((task) => threadKey(task) === key)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}
