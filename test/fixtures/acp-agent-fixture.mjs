// Fake ACP agent (`opencode acp` / `kiro-cli acp`) for tests. On
// session/prompt it streams a message, asks session/request_permission for one
// command, and reports the selected option.
import { createInterface } from 'node:readline';

const send = (m) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
const config = process.env.OPENCODE_CONFIG_CONTENT ? JSON.parse(process.env.OPENCODE_CONFIG_CONTENT).permission['*'] : 'none';
let nextId = 1000;
const waiting = new Map();
let prompt;

const update = (sessionId, u) => send({ method: 'session/update', params: { sessionId, update: u } });

createInterface({ input: process.stdin }).on('line', async (line) => {
  const msg = JSON.parse(line);
  if (msg.method === undefined) { waiting.get(msg.id)?.(msg.result); waiting.delete(msg.id); return; }
  switch (msg.method) {
    case 'initialize':
      send({ id: msg.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: false }, authMethods: [] } });
      break;
    case 'session/new':
      send({ id: msg.id, result: { sessionId: 'sess-1', models: { currentModelId: 'm/default', availableModels: [] } } });
      break;
    case 'session/set_model':
      send({ id: msg.id, result: {} });
      break;
    case 'session/cancel':
      if (prompt) { send({ id: prompt, result: { stopReason: 'cancelled' } }); prompt = undefined; }
      break;
    case 'session/prompt': {
      prompt = msg.id;
      const { sessionId } = msg.params;
      const objective = JSON.parse(msg.params.prompt[0].text.split('\n')[1]).objective;
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Creating ' } });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'notes.' } });
      update(sessionId, { sessionUpdate: 'tool_call', toolCallId: 'c1', title: 'touch notes.txt', kind: 'execute', status: 'pending' });
      const id = nextId++;
      const answer = new Promise((resolve) => waiting.set(id, resolve));
      send({ id, method: 'session/request_permission', params: { sessionId, toolCall: { toolCallId: 'c1', title: 'touch notes.txt', kind: 'execute', rawInput: { command: 'touch notes.txt' } },
        options: [{ optionId: 'once', name: 'Allow', kind: 'allow_once' }, { optionId: 'always', name: 'Always allow', kind: 'allow_always' }, { optionId: 'reject', name: 'Deny', kind: 'reject_once' }] } });
      const result = await answer;
      if (prompt === undefined) break; // cancelled meanwhile
      const outcome = result.outcome.outcome === 'selected' ? result.outcome.optionId : 'cancelled';
      update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: outcome === 'once' ? 'completed' : 'failed' });
      update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `decision=${outcome} config=${config} prompt=${objective}` } });
      send({ id: prompt, result: { stopReason: 'end_turn' } });
      prompt = undefined;
      break;
    }
    default:
      if (msg.id !== undefined) send({ id: msg.id, error: { code: -32601, message: 'not found' } });
  }
});
