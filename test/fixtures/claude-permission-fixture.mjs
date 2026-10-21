// Fake `claude -p` for tests. With --permission-prompt-tool it asks the MCP
// permission server (Streamable HTTP) about one Bash call, like Claude Code
// does when its own rules would prompt, then prints the decision.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const prompt = await new Promise((resolve) => { let s = ''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => resolve(s)); });
const objective = JSON.parse(prompt.split('\n')[1] ?? '{}').objective ?? '';

// `--output-format json`: one result envelope, as Claude Code 2.1.310 prints it.
function result(text) {
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.0125,
    usage: { input_tokens: 30, cache_creation_input_tokens: 10, cache_read_input_tokens: 60, output_tokens: 12 }, modelUsage: { 'claude-test-model': {} } })}\n`);
}

const tool = flag('--permission-prompt-tool');
if (tool === undefined) {
  result(`decision=readonly mode=${flag('--permission-mode')} tools=${flag('--tools')} prompt=${objective}`);
  process.exit(0);
}
const [, server, name] = tool.split('__');
const url = JSON.parse(flag('--mcp-config')).mcpServers[server].url;

let id = 0;
async function rpc(method, params) {
  const message = { jsonrpc: '2.0', method, params, ...(method.startsWith('notifications/') ? {} : { id: ++id }) };
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(message) });
  if (res.status === 202) return undefined;
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).pop();
    return JSON.parse(data).result;
  }
  return JSON.parse(text).result;
}

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: 'test' } });
await rpc('notifications/initialized', {});
const tools = await rpc('tools/list', {});
if (!tools.tools.some((t) => t.name === name)) { process.stderr.write(`MCP tool ${tool} not found\n`); process.exit(1); }

const ask = async (toolName, input) => JSON.parse((await rpc('tools/call', { name, arguments: { tool_name: toolName, input, tool_use_id: `t${id}` } })).content[0].text);
const decision = await ask('Bash', { command: 'touch notes.txt', description: 'Create notes' });
if (decision.behavior === 'allow') writeFileSync(join(process.cwd(), 'notes.txt'), 'x');
result(`decision=${decision.behavior} input=${JSON.stringify(decision.updatedInput ?? null)} prompt=${objective}`);
