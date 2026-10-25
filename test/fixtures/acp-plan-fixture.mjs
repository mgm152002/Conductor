// Fake ACP agent for plan-mode tests. Asked to plan, it replies with the JSON
// plan in $PLAN_FIXTURE_PLAN (or a default). Asked to do a plan task, it logs
// start/end times to $PLAN_FIXTURE_LOG (to check parallelism), waits, and
// replies with the task id and how many dependency results it was given.
// A task whose title contains FAIL ends with a refusal.
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const log = (line) => { if (process.env.PLAN_FIXTURE_LOG) appendFileSync(process.env.PLAN_FIXTURE_LOG, `${line}\n`); };
const agent = process.argv[2] ?? 'agent';
const DEFAULT_PLAN = {
  title: 'Notes feature', introduction: 'Add notes.',
  requirements: [{ id: '1', title: 'Notes', userStory: 'As a user, I want notes.', acceptanceCriteria: ['WHEN saved THEN notes SHALL persist', 'WHEN listed THEN notes SHALL show'] }],
  groups: [
    { id: '1', title: 'Build', tasks: [
      { id: '1.1', title: 'Storage', details: ['Add notes table'], requirements: ['1.1'], dependsOn: [], agent: 'kiro' },
      { id: '1.2', title: 'List view', details: ['Render notes'], requirements: ['1.2'], dependsOn: [], agent: 'opencode' },
    ] },
    { id: '2', title: 'Finish', tasks: [
      { id: '2.1', title: 'Wire up', details: [], requirements: ['1'], dependsOn: ['1.1', '1.2'], agent: 'not-installed' },
    ] },
  ],
};

let prompt;
createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) return;
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: {}, authMethods: [] } });
      break;
    case 'session/new':
      send({ id: msg.id, result: { sessionId: `s-${agent}-${process.pid}` } });
      break;
    case 'session/cancel':
      if (prompt !== undefined) { send({ id: prompt, result: { stopReason: 'cancelled' } }); prompt = undefined; }
      break;
    case 'session/prompt': {
      prompt = msg.id;
      const { sessionId } = msg.params;
      const body = JSON.parse(msg.params.prompt[0].text.split('\n')[1]);
      const say = (text) => send({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } } });
      const usage = { inputTokens: 100, outputTokens: 20, totalTokens: 120, cachedReadTokens: 40 };
      if (body.objective.startsWith('You are the planner')) {
        say(`Here is the plan:\n\`\`\`json\n${process.env.PLAN_FIXTURE_PLAN ?? JSON.stringify(DEFAULT_PLAN)}\n\`\`\`\n`);
        send({ id: msg.id, result: { stopReason: 'end_turn', usage } });
        prompt = undefined;
        break;
      }
      const task = /Do only this task:\n(\S+) ([^\n]*)/.exec(body.objective);
      const id = task?.[1] ?? '?';
      const deps = (body.contextData ?? []).filter((c) => c.kind === 'completed_dependency').length;
      log(`start ${id} ${Date.now()}`);
      await new Promise((r) => setTimeout(r, Number(process.env.PLAN_FIXTURE_DELAY ?? 300)));
      log(`end ${id} ${Date.now()}`);
      if (prompt === undefined) break; // cancelled meanwhile
      if (task?.[2]?.includes('FAIL')) { send({ id: msg.id, result: { stopReason: 'refusal' } }); prompt = undefined; break; }
      say(`done ${id} by ${agent} deps=${deps}`);
      send({ id: msg.id, result: { stopReason: 'end_turn', usage } });
      prompt = undefined;
      break;
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});
