import { randomUUID } from 'node:crypto';
import type { AgentQuestionAnswers, AgentQuestionRequest } from '@shared/domain';

// Questions an agent asks mid-run (Codex `requestUserInput`, MCP elicitation,
// an ACP question tool) are parked here until the user answers in the thread.
// The agent's RPC call stays open on the returned promise; cancelling the
// task or closing the app resolves it with null so the agent can move on.

interface Waiter {
  request: AgentQuestionRequest;
  resolve: (answers: AgentQuestionAnswers | null) => void;
}

export class AgentQuestionBroker {
  private readonly waiting = new Map<string, Waiter>();

  constructor(private readonly onChange: (request: AgentQuestionRequest) => void = () => {}) {}

  /** Ask the user; resolves with their answers, or null if cancelled/aborted. */
  ask(input: Omit<AgentQuestionRequest, 'id' | 'status' | 'createdAt'>, signal?: AbortSignal): Promise<AgentQuestionAnswers | null> {
    if (signal?.aborted === true) return Promise.resolve(null);
    const request: AgentQuestionRequest = {
      ...input, id: randomUUID(), status: 'pending', createdAt: new Date().toISOString(),
    };
    return new Promise<AgentQuestionAnswers | null>((resolve) => {
      const done = (answers: AgentQuestionAnswers | null): void => {
        if (!this.waiting.delete(request.id)) return;
        request.status = answers === null ? 'cancelled' : 'answered';
        this.onChange(request);
        resolve(answers);
      };
      this.waiting.set(request.id, { request, resolve: done });
      signal?.addEventListener('abort', () => { done(null); }, { once: true });
      this.onChange(request);
    });
  }

  listPending(): AgentQuestionRequest[] {
    return [...this.waiting.values()].map((waiter) => waiter.request);
  }

  /** Apply the user's answers. Returns false when the question is no longer open. */
  answer(id: string, answers: AgentQuestionAnswers): boolean {
    const waiter = this.waiting.get(id);
    if (waiter === undefined) return false;
    waiter.resolve(answers);
    return true;
  }

  /** Cancel every open question for a task (it was cancelled or ended). */
  cancelTask(taskId: string): void {
    for (const waiter of [...this.waiting.values()]) {
      if (waiter.request.taskId === taskId) waiter.resolve(null);
    }
  }
}
