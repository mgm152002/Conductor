// Fake `agy -p --output-format stream-json` for tests. It loads
// <--add-dir>/.agents/hooks.json like Antigravity does and runs the
// PreToolUse hook (via `sh -c`, payload on stdin) before each tool call.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const objective = JSON.parse((flag('-p') ?? '').split('\n')[1] ?? '{}').objective ?? '';
const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const cid = 'c0ffee00-0000-4000-8000-000000000000';

const dir = flag('--add-dir');
const hooks = dir ? JSON.parse(readFileSync(join(dir, '.agents', 'hooks.json'), 'utf8')) : {};
const handlers = Object.values(hooks).flatMap((h) => h.PreToolUse ?? []).flatMap((g) => g.hooks);

function gate(name, toolArgs) {
  for (const handler of handlers) {
    const result = JSON.parse(execFileSync('/bin/sh', ['-c', handler.command], { input: JSON.stringify({ conversationId: cid, stepIdx: 1, toolCall: { name, args: toolArgs } }) }).toString());
    if (result.decision !== 'allow') return result.decision;
  }
  return 'allow';
}

out({ event: 'init', conversation_id: cid, init: { cwd: process.cwd(), tools: ['view_file', 'run_command'], permission_mode: args.includes('--dangerously-skip-permissions') ? 'always-proceed' : 'request-review' } });
const read = gate('view_file', { AbsolutePath: join(process.cwd(), 'README.md') });
const first = gate('run_command', { CommandLine: 'touch notes.txt', toolSummary: 'Create notes' });
const second = gate('run_command', { CommandLine: 'touch notes.txt', toolSummary: 'Create notes' });
out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 2, state: first === 'allow' ? 'DONE' : 'ERROR', step_type: 'tool', tool_name: 'run_command' } });
const response = `${dir ? '' : 'nohook '}read=${read} first=${first} second=${second} mode=${flag('--mode')} prompt=${objective}\n`;
out({ event: 'step_update', step_update: { conversation_id: cid, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: response } });
out({ event: 'result', result: { conversation_id: cid, status: 'SUCCESS', response, num_turns: 1 } });
