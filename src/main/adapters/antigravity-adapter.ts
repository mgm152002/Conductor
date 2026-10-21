import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { sharedApprovalBridge, type ApprovalBridge } from './approval-bridge';
import { GatedAgentAdapter, pinnedModel, promptParts, type GatedAdapterConfig, type GatedLive, type Launch } from './gated-agent-adapter';
import type { CliEnvironment } from './local-cli-adapter';
import { argvPrompt } from './objective-cli-adapter';
import { isAccept, type GateRequest, type ToolApprover } from './tool-gate';

// Antigravity CLI (`agy -p`) asking Conductor before each tool call.
//
// Print mode cannot prompt, and a PreToolUse hook's "allow" does not grant a
// permission there, so the run uses --dangerously-skip-permissions (terminal
// commands stay inside Antigravity's --sandbox) and a PreToolUse hook on every
// tool becomes the gate: the hook asks Conductor and answers allow or deny.
// Verified against agy 1.4.7: a hook in an --add-dir folder's
// .agents/hooks.json runs for every tool; "deny" blocks the call and the
// agent continues; the hook may wait (timeout set to an hour) for the user.
//
// The hook script lives outside every directory the agent can write to, and
// fails closed (deny) if Conductor cannot be reached.
//
//   read_only          → reads and searches only; everything else denied
//   assisted_execution → reads and searches run; other tools ask the user
//   trusted_automation → no hook; Antigravity auto-approves (as before)

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

/** Tools that only read or report state; they run without asking (inside the workspace). */
export const AGY_READ_TOOLS: ReadonlySet<string> = new Set([
  'view_file', 'read_file', 'list_dir', 'grep_search', 'find_by_name', 'command_status', 'wait', 'wait_5_seconds', 'finish',
  'ask_question', 'list_permissions', 'list_resources', 'read_resource', 'manage_task', 'list_browser_pages',
  'view_file_outline', 'view_code_item', 'codebase_search',
]);
// write_file and edit_file are the names agy 1.4.7 reports at run time.
const FILE_TOOLS = new Set(['write_to_file', 'write_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content', 'sed_file', 'notebook_edit']);
const COMMAND_TOOLS = new Set(['run_command', 'send_command_input', 'notebook_execution', 'execute_browser_javascript']);
const PATH_KEY = /path|file|dir|uri/i;
const HOOK_TIMEOUT_S = 3600;

function pathArgs(args: Json): string[] {
  return Object.entries(args)
    .filter(([key, value]) => PATH_KEY.test(key) && typeof value === 'string' && /^(\/|~|file:\/\/)/.test(value))
    .map(([, value]) => (value as string).replace(/^file:\/\//, ''));
}

/** Real path (symlinks such as /var → /private/var resolved), even for a file that does not exist yet. */
function canonical(path: string): string {
  try { return realpathSync(path); } catch { /* missing */ }
  try { return join(realpathSync(dirname(path)), basename(path)); } catch { return resolve(path); }
}

function inside(root: string, path: string): boolean {
  if (path.startsWith('~')) return false;
  const within = (r: string, p: string): boolean => {
    const rel = relative(r, p);
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  return within(resolve(root), resolve(path)) || within(canonical(root), canonical(path));
}

export type AgyGate = { allow: true } | { allow: false; request: GateRequest } | { allow: 'never' };

/** Read-only commands that run without asking, like Codex's and Claude Code's safe sets. */
const SAFE_COMMANDS = new Set(['ls', 'pwd', 'cat', 'head', 'tail', 'wc', 'grep', 'rg', 'find', 'tree', 'stat', 'file', 'du', 'which', 'echo']);
const SAFE_GIT = new Set(['status', 'diff', 'log', 'show', 'branch', 'rev-parse', 'ls-files', 'blame']);

/**
 * A single simple read-only command whose paths stay in the workspace: no
 * shell operators, redirects, substitutions, or options that execute or delete.
 */
export function isSafeReadCommand(command: string, rootPath: string): boolean {
  if (/[;&|<>`$\n\\(){}]/.test(command) || command.length > 500) return false;
  const words = command.trim().split(/\s+/).map((w) => w.replace(/^(['"])(.*)\1$/, '$2'));
  const [program, sub] = words;
  if (program === undefined) return false;
  if (program === 'git' ? !SAFE_GIT.has(sub ?? '') : !SAFE_COMMANDS.has(program)) return false;
  if (program === 'find' && words.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)$/.test(w))) return false;
  if (program === 'git' && words.some((w) => /^--(output|ext-diff)/.test(w))) return false;
  return words.slice(1).every((w) => !w.split('/').includes('..') && !/(^|\/)\.env/.test(w) && (!/^[/~]/.test(w) || inside(rootPath, w)));
}

/** How one Antigravity tool call is handled. */
export function classifyAgyTool(name: string, args: Json, rootPath: string, readOnly: boolean): AgyGate {
  const paths = pathArgs(args);
  const purpose = str(args['toolSummary']);
  if (AGY_READ_TOOLS.has(name)) {
    const outside = paths.filter((p) => !inside(rootPath, p));
    if (outside.length === 0) return { allow: true };
    return { allow: false, request: { kind: 'permissions', summary: 'Antigravity wants to read outside the workspace', detail: outside.join('\n'), rememberKey: `read:${outside.join('|')}` } };
  }
  if (name === 'run_command' && str(args['CommandLine']) !== undefined && isSafeReadCommand(str(args['CommandLine'])!, rootPath)) return { allow: true };
  if (readOnly) return { allow: 'never' };
  if (COMMAND_TOOLS.has(name)) {
    const command = str(args['CommandLine']) ?? str(args['Input']) ?? JSON.stringify(args).slice(0, 2000);
    return { allow: false, request: { kind: 'command', summary: `Antigravity wants to run a command${purpose ? ` (${purpose})` : ''}`, detail: command } };
  }
  if (FILE_TOOLS.has(name)) {
    return { allow: false, request: { kind: 'file_change', summary: `Antigravity wants to change files${purpose ? ` (${purpose})` : ''}`, ...(paths.length > 0 ? { detail: paths.join('\n') } : {}) } };
  }
  const detail = JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'toolSummary'))).slice(0, 2000);
  return { allow: false, request: { kind: 'permissions', summary: `Antigravity wants to use ${name}${purpose ? ` (${purpose})` : ''}`, detail, rememberKey: `tool:${name}` } };
}

/** POSIX shell single-quoted literal. */
const shq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

export class AntigravityAdapter extends GatedAgentAdapter {
  /** Model named in hook payloads, per session (agy only reports it there). */
  private readonly models = new Map<string, string>();

  constructor(config: GatedAdapterConfig, approver: ToolApprover, env?: CliEnvironment, beforeStart?: (id: string) => void,
    private readonly bridge: ApprovalBridge = sharedApprovalBridge()) {
    super(config, approver, env, beforeStart, 'pre-tool-hook');
  }

  protected async prepare(live: GatedLive): Promise<Launch> {
    const { data } = live;
    const autoApprove = this.config.autoApprove?.() === true;
    const readOnly = !autoApprove && data.mode !== 'assisted_execution' && data.mode !== 'trusted_automation';
    const model = pinnedModel(data, 'antigravity');
    const { header, body } = promptParts(data);
    // Effort is part of the model id (e.g. "gemini-3.8-flash-high"); a separate
    // --effort flag conflicts with --model, so it is never passed.
    const args = [...(model !== undefined ? ['--model', model] : []), '--sandbox', '--dangerously-skip-permissions',
      '--mode', readOnly ? 'plan' : 'accept-edits', '--output-format', 'stream-json', '--print-timeout', '0'];

    if (data.mode !== 'trusted_automation') {
      const session = await this.bridge.open({
        hook: async (payload, signal) => {
          if (typeof payload['modelName'] === 'string') this.models.set(live.handle.sessionId, payload['modelName']);
          const call = obj(payload['toolCall']) ?? {};
          const name = str(call['name']) ?? 'unknown_tool';
          // With "auto-approve everything" on, a read-only run still lets the
          // gate accept a non-read tool instead of classifying it as blocked.
          const autoApprove = this.config.autoApprove?.() === true;
          const verdict = classifyAgyTool(name, obj(call['args']) ?? {}, data.rootPath, readOnly && !autoApprove);
          if (verdict.allow === true) return { decision: 'allow' };
          if (verdict.allow === 'never') {
            live.events.push('log', { message: `Antigravity tried ${name}: blocked (read-only)` });
            return { decision: 'deny', reason: 'Conductor is in read-only mode; this tool is not available.' };
          }
          const request = { ...verdict.request, cwd: data.rootPath };
          const decision = await live.gate.decide(request, signal);
          live.events.push('log', { message: `${request.summary}: ${isAccept(decision) ? 'approved' : 'declined'}`, detail: request.detail });
          return isAccept(decision)
            ? { decision: 'allow' }
            : { decision: 'deny', reason: decision === 'cancel' ? 'The task was cancelled in Conductor.' : 'The user declined this action in Conductor. Do not retry it; continue another way or explain what you need.' };
        },
      });
      live.cleanup.push(() => { session.dispose(); });
      // <base>/hook.sh is outside the agent's workspace; <base>/root is added
      // to the workspace only so Antigravity loads root/.agents/hooks.json.
      const base = mkdtempSync(join(tmpdir(), 'conductor-agy-'));
      const agents = join(base, 'root', '.agents');
      live.cleanup.push(() => {
        try { chmodSync(agents, 0o700); } catch { /* not created */ }
        rmSync(base, { recursive: true, force: true });
      });
      const script = join(base, 'hook.sh');
      writeFileSync(script, [
        '#!/bin/sh',
        '# Conductor approval gate for one Antigravity run. Fails closed.',
        `out=$(/usr/bin/curl -sS --fail -X POST -H 'content-type: application/json' --data-binary @- ${shq(`${session.baseUrl}/hook`)} 2>/dev/null)`,
        'if [ -n "$out" ]; then printf \'%s\' "$out"; else printf \'%s\' \'{"decision":"deny","reason":"Conductor could not ask the user about this tool call."}\'; fi',
        'exit 0',
        '',
      ].join('\n'), { mode: 0o700 });
      mkdirSync(agents, { recursive: true });
      writeFileSync(join(agents, 'hooks.json'), JSON.stringify({
        'conductor-approvals': { PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `/bin/sh ${shq(script)}`, timeout: HOOK_TIMEOUT_S }] }] },
      }), { mode: 0o400 });
      chmodSync(agents, 0o500);
      args.push('--add-dir', join(base, 'root'));
    }
    args.push('-p', argvPrompt(header, body));
    return { args, cwd: data.rootPath };
  }

  protected attach(live: GatedLive, child: ChildProcessWithoutNullStreams): void {
    let reply = '';
    let result: Json | null = null;
    createInterface({ input: child.stdout }).on('line', (line) => {
      let event: Json | null = null;
      try { event = obj(JSON.parse(line)); } catch { /* not stream-json */ }
      if (event === null) { if (line.trim() !== '') live.events.push('log', { message: line }); return; }
      if (event['event'] === 'step_update') {
        const step = obj(event['step_update']) ?? {};
        if (step['step_type'] === 'agent_response' && typeof step['text_delta'] === 'string') reply += step['text_delta'];
        if (step['step_type'] === 'tool' && step['state'] !== 'ACTIVE') {
          const info = obj(step['tool_info']) ?? {};
          const error = str(obj(info['error'])?.['message']);
          live.events.push('log', { message: `${str(step['tool_name']) ?? 'tool'}: ${error ?? 'done'}` });
        }
      } else if (event['event'] === 'result') {
        result = obj(event['result']);
      }
    });
    child.once('close', () => {
      const final = result;
      if (final === null) return; // exitResult reports the failure
      const status = str(final['status']);
      const response = str(final['response']) ?? reply;
      const usage = obj(final['usage']);
      if (usage !== null) {
        const n = (key: string): number | undefined => (typeof usage[key] === 'number' ? usage[key] as number : undefined);
        const model = this.models.get(live.handle.sessionId) ?? pinnedModel(live.data, 'antigravity');
        live.events.push('log', { usage: {
          inputTokens: n('input_tokens'), cachedInputTokens: n('cache_read_tokens'), outputTokens: n('output_tokens'),
          reasoningTokens: n('thinking_tokens'), totalTokens: n('total_tokens'), ...(model ? { model } : {}),
        } });
      }
      this.models.delete(live.handle.sessionId);
      if (status === 'SUCCESS') {
        if (response.trim() !== '') live.events.push('stdout', response.replace(/\n$/, ''));
        this.finish(live, { status: 'succeeded', exitCode: 0 });
      } else if (live.cancelled || status === 'CANCELED' || status === 'INTERRUPTED') {
        this.finish(live, { status: 'cancelled' });
      } else {
        this.finish(live, { status: 'failed', error: str(final['error']) ?? `Antigravity ended with status ${status ?? 'unknown'}` });
      }
    });
  }
}
