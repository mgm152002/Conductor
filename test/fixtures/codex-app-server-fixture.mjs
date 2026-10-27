#!/usr/bin/env node
// Fake `codex app-server` speaking the v2 JSON-RPC shapes Conductor uses.
// Behaviour per turn (from the prompt text):
//   - asks approval for `touch notes.txt`, then reports the decision
//   - the default model "gpt-bad" fails with model_not_found; "gpt-good" works
import { createInterface } from 'node:readline';

if (process.argv[2] !== 'app-server') process.exit(2);
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
let nextId = 1000;
const waiting = new Map();
const threadId = '0b9c3d1e-7a2f-4c1b-9e8d-aaaaaaaaaaaa';
let model = 'gpt-bad';

function ask(method, params) {
  const id = nextId++;
  send({ id, method, params });
  return new Promise((resolve) => waiting.set(id, resolve));
}

async function runTurn(turnId, input) {
  send({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
  if (model === 'gpt-bad') {
    const message = '{"error":{"message":"The \'gpt-bad\' model is not supported when using Codex with a ChatGPT account.","code":"model_not_found"}}';
    send({ method: 'error', params: { error: { message }, willRetry: false, threadId, turnId } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'failed', error: { message }, items: [] } } });
    return;
  }
  const text = input.find((item) => item.type === 'text')?.text ?? '';
  const body = JSON.parse(text.split('\n').slice(1).join('\n'));
  if (body.objective === 'inspect attachments') {
    const reply = JSON.stringify({
      inputTypes: input.map((item) => item.type),
      imagePaths: input.filter((item) => item.type === 'localImage').map((item) => item.path),
      attachmentPaths: (body.attachments ?? []).map((item) => item.path),
      attachmentContents: body.attachmentContents ?? [],
    });
    send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg1', text: reply, phase: null } } });
    send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } });
    return;
  }
  send({ method: 'configWarning', params: { summary: 'Ignoring unknown features' } });
  const item = { type: 'commandExecution', id: 'cmd1', command: 'touch notes.txt', cwd: '/w', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null };
  send({ method: 'item/started', params: { item, threadId, turnId } });
  const answer = await ask('item/commandExecution/requestApproval', { kind: 'command', threadId, turnId, itemId: 'cmd1', startedAtMs: Date.now(), command: 'touch notes.txt', cwd: '/w', environmentId: null });
  const accepted = answer.decision === 'accept' || answer.decision === 'acceptForSession';
  send({ method: 'item/completed', params: { threadId, turnId, item: { ...item, status: accepted ? 'completed' : 'declined', exitCode: accepted ? 0 : null, aggregatedOutput: '' } } });
  const reply = `decision=${answer.decision} model=${model} prompt=${JSON.parse(text.split('\n').slice(1).join('\n')).objective}`;
  send({ method: 'item/completed', params: { threadId, turnId, item: { type: 'agentMessage', id: 'msg1', text: reply, phase: null } } });
  send({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', error: null, items: [] } } });
}

let turns = 0;
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && waiting.has(m.id)) { waiting.get(m.id)(m.result); waiting.delete(m.id); return; }
  switch (m.method) {
    case 'initialize': send({ id: m.id, result: { userAgent: 'fixture' } }); break;
    case 'initialized': break;
    case 'account/rateLimits/read':
      send({ id: m.id, result: { rateLimits: {
        primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 },
        secondary: { usedPercent: 60, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 5 * 86400 },
      } } });
      break;
    case 'thread/start':
    case 'thread/resume':
      if (!((m.params.approvalPolicy === 'untrusted' && m.params.sandbox === 'workspace-write')
        || (m.params.approvalPolicy === 'never' && m.params.sandbox === 'read-only'))) {
        send({ id: m.id, error: { message: `unexpected policy ${m.params.approvalPolicy}/${m.params.sandbox}` } }); break;
      }
      if (m.params.model) model = m.params.model;
      send({ id: m.id, result: { thread: { id: threadId } } }); break;
    case 'model/list': send({ id: m.id, result: { data: [{ model: 'gpt-bad', hidden: false, isDefault: true }, { model: 'gpt-good', hidden: false, isDefault: false }], nextCursor: null } }); break;
    case 'turn/start': {
      if (m.params.model) model = m.params.model;
      const turnId = `turn-${++turns}`;
      send({ id: m.id, result: { turn: { id: turnId, status: 'inProgress', items: [] } } });
      void runTurn(turnId, m.params.input);
      break;
    }
    case 'turn/interrupt': send({ id: m.id, result: {} }); process.exit(0); break;
    default: if (m.id !== undefined) send({ id: m.id, result: {} });
  }
});
