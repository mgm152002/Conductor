import { describe, expect, it } from 'vitest';
import type { AgentQuestionRequest } from '../../src/shared/domain';
import { AgentQuestionBroker } from '../../src/main/orchestrator/agent-questions';

describe('agent question broker', () => {
  it('parks a question until the user answers it', async () => {
    const seen: AgentQuestionRequest[] = [];
    const broker = new AgentQuestionBroker((request) => { seen.push(request); });
    const pending = broker.ask({ taskId: 'task-1', agent: 'Codex', questions: [{ id: 'q1', question: 'Which database?' }] });
    expect(broker.listPending()).toHaveLength(1);
    expect(seen[0]).toMatchObject({ status: 'pending', agent: 'Codex' });
    expect(broker.answer(seen[0]!.id, { q1: ['Postgres'] })).toBe(true);
    await expect(pending).resolves.toEqual({ q1: ['Postgres'] });
    expect(broker.listPending()).toHaveLength(0);
    expect(broker.answer(seen[0]!.id, {})).toBe(false);
  });

  it('resolves with null when the task is cancelled or the caller aborts', async () => {
    const broker = new AgentQuestionBroker();
    const byTask = broker.ask({ taskId: 'task-2', agent: 'Codex', questions: [{ id: 'q1', question: 'Ok?' }] });
    broker.cancelTask('task-2');
    await expect(byTask).resolves.toBeNull();

    const controller = new AbortController();
    const bySignal = broker.ask({ taskId: 'task-3', agent: 'Codex', questions: [{ id: 'q1', question: 'Ok?' }] }, controller.signal);
    controller.abort();
    await expect(bySignal).resolves.toBeNull();
  });
});
