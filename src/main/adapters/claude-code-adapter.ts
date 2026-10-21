import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { PERMISSION_TOOL, sharedApprovalBridge, type ApprovalBridge } from './approval-bridge';
import { GatedAgentAdapter, objectivePrompt, pinnedEffort, pinnedModel, type GatedAdapterConfig, type GatedLive, type Launch } from './gated-agent-adapter';
import type { CliEnvironment } from './local-cli-adapter';
import { isAccept, isSensitivePath, type GateRequest, type ToolApprover } from './tool-gate';

// Claude Code in print mode (`claude -p`), asking Conductor before each tool
// call through --permission-prompt-tool
// (https://code.claude.com/docs/en/cli-reference). The prompt tool is an MCP
// tool served by Conductor's loopback approval bridge.
//
// Claude Code only calls the prompt tool for actions its own rules would ask
// about (Bash commands outside its read-only set, file edits, web fetches,
// MCP tools); reads inside the project run without a prompt.
//
//   read_only          → Read, Glob and Grep only; anything else is refused
//   assisted_execution → default permission mode, each prompt goes to the user
//   trusted_automation → default permission mode, prompts accepted by Conductor

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

export const CLAUDE_APPROVAL_SERVER = 'conductor_approvals';
const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);
const APPROVAL_TIMEOUT_MS = 3_600_000;

/** What the user is asked for one Claude Code tool call. */
export function claudeGateRequest(toolName: string, input: Json): GateRequest {
  const reason = str(input['description']);
  if (READ_TOOLS.has(toolName)) {
    const path = str(input['file_path']) ?? str(input['notebook_path']) ?? str(input['path']);
    const sensitive = path !== undefined && isSensitivePath(path);
    return {
      kind: 'permissions',
      readOnly: !sensitive,
      summary: `Claude Code wants to read files${reason ? ` (${reason})` : ''}`,
      ...(path ? { detail: path } : {}),
      ...(sensitive ? { rememberKey: `read:${path}` } : {}),
    };
  }
  if (toolName === 'Bash') {
    return { kind: 'command', summary: `Claude Code wants to run a command${reason ? ` (${reason})` : ''}`, ...(str(input['command']) ? { detail: str(input['command'])! } : {}) };
  }
  if (FILE_TOOLS.has(toolName)) {
    const path = str(input['file_path']) ?? str(input['notebook_path']);
    return { kind: 'file_change', summary: 'Claude Code wants to change files', ...(path ? { detail: path } : {}) };
  }
  if (toolName === 'WebFetch') return { kind: 'permissions', summary: 'Claude Code wants to fetch a web page', ...(str(input['url']) ? { detail: str(input['url'])! } : {}), rememberKey: 'tool:WebFetch' };
  if (toolName === 'WebSearch') return { kind: 'permissions', summary: 'Claude Code wants to search the web', ...(str(input['query']) ? { detail: str(input['query'])! } : {}), rememberKey: 'tool:WebSearch' };
  return { kind: 'permissions', summary: `Claude Code wants to use ${toolName}`, detail: JSON.stringify(input).slice(0, 2000), rememberKey: `tool:${toolName}` };
}

export class ClaudeCodeAdapter extends GatedAgentAdapter {
  constructor(config: GatedAdapterConfig, approver: ToolApprover, env?: CliEnvironment, beforeStart?: (id: string) => void,
    private readonly bridge: ApprovalBridge = sharedApprovalBridge()) {
    super(config, approver, env, beforeStart, 'permission-prompt-tool');
  }

  protected async prepare(live: GatedLive): Promise<Launch> {
    const { data } = live;
    const model = pinnedModel(data, 'claude-code');
    const effort = pinnedEffort(data, 'claude-code');
    const modelArgs = [...(model !== undefined ? ['--model', model] : []), ...(effort !== undefined ? ['--effort', effort] : [])];
    const stdin = objectivePrompt(data);
    // Auto-approve lets a normally read-only run ask through the bridge, where
    // the gate accepts every request. With the toggle off the gate still
    // declines non-read tools because the run's mode is read_only.
    if (this.config.autoApprove?.() !== true && data.mode !== 'assisted_execution' && data.mode !== 'trusted_automation') {
      return { args: ['-p', '--output-format', 'json', '--permission-mode', 'dontAsk', '--tools', 'Read,Glob,Grep', ...modelArgs], cwd: data.rootPath, stdin };
    }
    const session = await this.bridge.open({
      permissionPrompt: async (args, signal) => {
        const toolName = str(args['tool_name']) ?? 'a tool';
        const input = obj(args['input']) ?? {};
        const request = { ...claudeGateRequest(toolName, input), cwd: data.rootPath };
        const decision = await live.gate.decide(request, signal);
        live.events.push('log', { message: `${request.summary}: ${isAccept(decision) ? 'approved' : 'declined'}`, detail: request.detail });
        if (isAccept(decision)) return { behavior: 'allow', updatedInput: input };
        return { behavior: 'deny', message: decision === 'cancel'
          ? 'The task was cancelled in Conductor.'
          : 'The user declined this action in Conductor. Do not retry it; continue another way or explain what you need.' };
      },
    });
    live.cleanup.push(() => { session.dispose(); });
    // HTTP MCP requests time out after 60 s unless the server sets `timeout`
    // (https://code.claude.com/docs/en/env-vars, MCP_TOOL_TIMEOUT); the user
    // may take longer than that to answer.
    const mcpConfig = { mcpServers: { [CLAUDE_APPROVAL_SERVER]: { type: 'http', url: `${session.baseUrl}/mcp`, timeout: APPROVAL_TIMEOUT_MS } } };
    return {
      args: ['-p', '--output-format', 'json', '--permission-mode', 'default',
        '--mcp-config', JSON.stringify(mcpConfig), '--permission-prompt-tool', `mcp__${CLAUDE_APPROVAL_SERVER}__${PERMISSION_TOOL}`, ...modelArgs],
      cwd: data.rootPath, stdin,
    };
  }

  /**
   * `--output-format json` prints one result envelope at the end (verified
   * with Claude Code 2.1.310): `{type:'result', is_error, result, usage,
   * total_cost_usd, modelUsage}`. The reply becomes stdout and the usage is
   * recorded; anything else on stdout is passed through as text.
   */
  protected attach(live: GatedLive, child: ChildProcessWithoutNullStreams): void {
    const lines: string[] = [];
    createInterface({ input: child.stdout }).on('line', (line) => { lines.push(line); });
    child.once('close', () => {
      const envelope = parseResult(lines.join('\n'));
      if (envelope === null) {
        for (const line of lines) live.events.push('stdout', line);
        return; // the exit code decides
      }
      const usage = claudeUsage(envelope, pinnedModel(live.data, 'claude-code'));
      if (usage !== undefined) live.events.push('log', { usage });
      const text = str(envelope['result']) ?? '';
      if (envelope['is_error'] === true) {
        this.finish(live, live.cancelled ? { status: 'cancelled' } : { status: 'failed', error: text || 'Claude Code reported an error' });
        return;
      }
      if (text.trim() !== '') live.events.push('stdout', text);
      this.finish(live, live.cancelled ? { status: 'cancelled' } : { status: 'succeeded', exitCode: 0 });
    });
  }
}

function parseResult(output: string): Json | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed = obj(JSON.parse(trimmed));
    return parsed?.['type'] === 'result' ? parsed : null;
  } catch {
    return null;
  }
}

/** Token usage from a Claude Code result envelope. Input counts include cache reads and writes. */
export function claudeUsage(envelope: Json, pinned?: string): Record<string, unknown> | undefined {
  const usage = obj(envelope['usage']);
  if (usage === null) return undefined;
  const n = (v: unknown): number => (typeof v === 'number' ? v : 0);
  const cacheRead = n(usage['cache_read_input_tokens']);
  const input = n(usage['input_tokens']) + n(usage['cache_creation_input_tokens']) + cacheRead;
  const output = n(usage['output_tokens']);
  const models = Object.keys(obj(envelope['modelUsage']) ?? {});
  const model = models[0] ?? pinned;
  return {
    inputTokens: input, cachedInputTokens: cacheRead, outputTokens: output,
    reasoningTokens: n(obj(usage['output_tokens_details'])?.['thinking_tokens']), totalTokens: input + output,
    ...(typeof envelope['total_cost_usd'] === 'number' ? { costUsd: envelope['total_cost_usd'] } : {}),
    ...(model ? { model } : {}),
  };
}
