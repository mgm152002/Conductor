import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { GatedAgentAdapter, objectivePrompt, pinnedEffort, pinnedModel, type GatedAdapterConfig, type GatedLive, type Launch } from './gated-agent-adapter';
import type { CliEnvironment } from './local-cli-adapter';
import { isAccept, isSensitivePath, type GateRequest, type ToolApprovalDecision, type ToolApprover } from './tool-gate';

// Agents driven over the Agent Client Protocol (JSON-RPC 2.0, one JSON object
// per line on stdio; https://agentclientprotocol.com):
//   OpenCode  `opencode acp`   (https://opencode.ai/docs/cli/#acp)
//   Kiro CLI  `kiro-cli acp`   (https://kiro.dev/docs/cli/acp/)
//
// The agent sends `session/request_permission` before a tool runs; Conductor
// answers it through the tool gate. Conductor advertises no file-system or
// terminal capabilities, so the agent uses its own tools and every action it
// would ask about comes through that one request.
//
// OpenCode allows most tools by default, so for read-only and assisted runs
// Conductor adds an inline config (OPENCODE_CONFIG_CONTENT, the highest
// user-level precedence) that makes everything except reads and searches
// ask. Subagents (`task`) are denied there, because OpenCode does not forward
// a subagent's permission requests over ACP.

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | null => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : null);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);

const RPC_TIMEOUT_MS = 120_000;
const PROTOCOL_VERSION = 1;
/** How many times a turn ended by a declined tool is continued. */
const DECLINE_CONTINUATIONS = 2;

/**
 * Sent when the agent ended its turn right after Conductor declined a tool
 * (OpenCode does this instead of carrying on). Read-only runs have no shell,
 * so point the agent at the tools that are actually allowed; assisted runs
 * (and plan mode, where the user can deny a command) only had one action
 * denied.
 */
export function declinedToolContinuation(mode: GatedLive['data']['mode'], approveCommands = false): string {
  if (mode === 'assisted_execution' || approveCommands) {
    return 'The user declined that tool call. Do not repeat it. Continue the task another way, or finish with what you have; '
      + 'only ask for actions you actually need.';
  }
  return 'Conductor declined that tool call because this run is read-only. Do not use shell commands or change files. '
    + 'Continue the task with the read, glob, grep and list tools, then give your full final answer.';
}

/** Inline OpenCode config: ask for everything except reads and searches. */
export const OPENCODE_ASK_CONFIG = {
  permission: {
    '*': 'ask',
    read: { '*': 'allow', '*.env': 'ask', '*.env.*': 'ask', '*.env.example': 'allow' },
    glob: 'allow', grep: 'allow', list: 'allow', lsp: 'allow', todoread: 'allow', todowrite: 'allow', question: 'allow',
    task: 'deny',
  },
  // Without this, denying one tool call ends OpenCode's turn with no reply
  // (seen with OpenCode 1.19.4). It is kept for older versions; 2.x ignores it
  // and returns stopReason "cancelled", which `run` handles by continuing the
  // turn with DECLINED_TOOL_CONTINUATION.
  experimental: { continue_loop_on_deny: true },
};

function openCodeConfig(existing: string | undefined): string {
  let base: Json = {};
  try { base = obj(JSON.parse(existing ?? '{}')) ?? {}; } catch { /* replace an invalid value */ }
  return JSON.stringify({
    ...base,
    permission: { ...(obj(base['permission']) ?? {}), ...OPENCODE_ASK_CONFIG.permission },
    experimental: { ...(obj(base['experimental']) ?? {}), ...OPENCODE_ASK_CONFIG.experimental },
  });
}

/** What the user is asked for one ACP permission request. */
export function acpGateRequest(agentName: string, toolCall: Json): GateRequest {
  const title = str(toolCall['title']) ?? 'use a tool';
  const raw = toolCall['rawInput'];
  const input = obj(raw);
  const locations = Array.isArray(toolCall['locations'])
    ? (toolCall['locations'] as unknown[]).map((l) => str(obj(l)?.['path'])).filter((p): p is string => p !== undefined) : [];
  const paths = locations.length > 0 ? locations : [str(input?.['filePath']) ?? str(input?.['path']) ?? str(input?.['file_path'])].filter((p): p is string => p !== undefined);
  switch (str(toolCall['kind'])) {
    case 'read':
    case 'search': {
      const sensitive = paths.some(isSensitivePath);
      return {
        kind: 'permissions',
        readOnly: !sensitive,
        summary: `${agentName} wants to ${str(toolCall['kind']) === 'search' ? 'search files' : 'read files'}${title !== 'use a tool' ? ` (${title})` : ''}`,
        ...(paths.length > 0 ? { detail: paths.join('\n') } : {}),
        ...(sensitive ? { rememberKey: `read:${paths.join('|')}` } : {}),
      };
    }
    case 'execute': {
      const command = input?.['command'];
      const line = Array.isArray(command) ? command.filter((c) => typeof c === 'string').join(' ') : str(command) ?? str(input?.['cmd']) ?? title;
      return { kind: 'command', summary: `${agentName} wants to run a command`, detail: line };
    }
    case 'edit':
    case 'delete':
    case 'move': {
      const files = paths;
      return { kind: 'file_change', summary: `${agentName} wants to change files (${title})`, ...(files.length > 0 ? { detail: files.join('\n') } : {}) };
    }
    default: {
      const detail = raw !== undefined && raw !== null ? JSON.stringify(raw).slice(0, 2000) : locations.join('\n');
      return { kind: 'permissions', summary: `${agentName} asks to ${title}`, ...(detail ? { detail } : {}), rememberKey: `tool:${title}` };
    }
  }
}

/** The ACP outcome for a gate decision, using only options the agent offered. */
export function acpOutcome(options: unknown, decision: ToolApprovalDecision): Json {
  const list = Array.isArray(options) ? options.map(obj).filter((o): o is Json => o !== null) : [];
  const pick = (...kinds: string[]): string | undefined => {
    for (const kind of kinds) {
      const found = list.find((o) => o['kind'] === kind && typeof o['optionId'] === 'string');
      if (found !== undefined) return found['optionId'] as string;
    }
    return undefined;
  };
  // "Allow for this task" is remembered by Conductor, never persisted as an
  // agent rule, so a one-time allow is preferred.
  const optionId = decision === 'cancel' ? undefined
    : isAccept(decision) ? pick('allow_once', 'allow_always') : pick('reject_once', 'reject_always');
  return optionId !== undefined ? { outcome: { outcome: 'selected', optionId } } : { outcome: { outcome: 'cancelled' } };
}

/** The model a new ACP session reports (config option or the unstable `models` field). */
function currentModel(created: Json): string | undefined {
  const options = Array.isArray(created['configOptions']) ? (created['configOptions'] as unknown[]).map(obj) : [];
  const option = options.find((o) => o?.['id'] === 'model');
  return str(option?.['currentValue']) ?? str(obj(created['models'])?.['currentModelId']);
}

export interface AcpAgentSpec {
  /** Arguments that start the ACP server, e.g. ['acp']. */
  args: string[];
  /** Agent id used for Settings → Agent models. */
  modelKey: string;
  /** Command that signs the user in, for error messages. */
  loginHint: string;
  /** Extra environment for a run. */
  env?: (mode: GatedLive['data']['mode']) => Record<string, string> | undefined;
}

export const ACP_AGENTS: Record<string, AcpAgentSpec> = {
  opencode: {
    args: ['acp'], modelKey: 'opencode', loginHint: 'opencode auth login',
    env: (mode) => (mode === 'trusted_automation' ? undefined : { OPENCODE_CONFIG_CONTENT: openCodeConfig(process.env['OPENCODE_CONFIG_CONTENT']) }),
  },
  kiro: { args: ['acp'], modelKey: 'kiro', loginHint: 'kiro-cli login' },
};

export class AcpAgentAdapter extends GatedAgentAdapter {
  constructor(config: GatedAdapterConfig, private readonly spec: AcpAgentSpec, approver: ToolApprover, env?: CliEnvironment, beforeStart?: (id: string) => void) {
    super(config, approver, env, beforeStart, 'acp');
  }

  protected async prepare(live: GatedLive): Promise<Launch> {
    const env = this.spec.env?.(live.data.mode);
    return { args: this.spec.args, cwd: live.data.rootPath, ...(env !== undefined ? { env } : {}) };
  }

  protected attach(live: GatedLive, child: ChildProcessWithoutNullStreams): void {
    const name = this.config.name;
    const { data } = live;
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: ReturnType<typeof setTimeout> }>();
    const send = (message: Json): void => { if (!child.stdin.destroyed) child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); };
    const request = (method: string, params: unknown, timeoutMs: number | null = RPC_TIMEOUT_MS): Promise<unknown> => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = timeoutMs === null ? undefined : setTimeout(() => { pending.delete(id); reject(new Error(`${name} did not answer ${method}`)); }, timeoutMs);
      pending.set(id, { resolve, reject, ...(timer ? { timer } : {}) });
      send({ id, method, params });
    });

    let sessionId: string | undefined;
    let model: string | undefined;
    let message = '';
    // Tool calls declined during the current turn. ACP agents such as OpenCode
    // end the turn with stopReason "cancelled" when one is declined; that is
    // not a user cancellation, so `run` can ask the agent to carry on.
    let declinedTools = 0;
    const flush = (): void => {
      if (message.trim() !== '') live.events.push('stdout', message.replace(/\n+$/, ''));
      message = '';
    };

    const onPermission = async (id: unknown, params: Json): Promise<void> => {
      const toolCall = obj(params['toolCall']) ?? {};
      const gateRequest = { ...acpGateRequest(name, toolCall), cwd: data.rootPath };
      const decision = await live.gate.decide(gateRequest);
      if (!isAccept(decision) && decision !== 'cancel') declinedTools += 1;
      live.events.push('log', { message: `${gateRequest.summary}: ${isAccept(decision) ? 'approved' : 'declined'}`, detail: gateRequest.detail });
      send({ id, result: acpOutcome(params['options'], decision) });
    };

    const onUpdate = (params: Json): void => {
      const update = obj(params['update']) ?? {};
      switch (update['sessionUpdate']) {
        case 'agent_message_chunk': {
          const content = obj(update['content']);
          if (content?.['type'] === 'text' && typeof content['text'] === 'string') message += content['text'];
          break;
        }
        case 'tool_call':
          flush();
          live.events.push('log', { message: `${name}: ${str(update['title']) ?? 'tool call'}`, kind: str(update['kind']) });
          break;
        case 'tool_call_update': {
          const status = str(update['status']);
          if (status === 'failed') live.events.push('log', { message: `${name}: ${str(update['title']) ?? 'tool call'} failed` });
          break;
        }
        case 'usage_update': {
          // Context-window usage, plus the session's cost when the agent knows it.
          const cost = obj(update['cost']);
          if (cost !== null && typeof cost['amount'] === 'number' && (cost['currency'] === undefined || cost['currency'] === 'USD')) {
            live.events.push('log', { usage: { costUsd: cost['amount'], ...(model ? { model } : {}) } });
          }
          break;
        }
        default:
          break; // thoughts, plans, commands, modes, usage
      }
    };

    createInterface({ input: child.stdout }).on('line', (line) => {
      let msg: Json | null = null;
      try { msg = obj(JSON.parse(line)); } catch { /* not JSON-RPC */ }
      if (msg === null) return;
      const id = msg['id'];
      const method = str(msg['method']);
      if (method === undefined) {
        if (typeof id !== 'number') return;
        const waiter = pending.get(id);
        if (waiter === undefined) return;
        pending.delete(id);
        if (waiter.timer) clearTimeout(waiter.timer);
        const error = obj(msg['error']);
        if (error !== null) waiter.reject(Object.assign(new Error(str(error['message']) ?? `${name} request failed`), { code: error['code'] }));
        else waiter.resolve(msg['result']);
        return;
      }
      const params = obj(msg['params']) ?? {};
      if (id !== undefined && id !== null) {
        if (method === 'session/request_permission') void onPermission(id, params);
        else send({ id, error: { code: -32601, message: `Conductor does not provide ${method}` } });
        return;
      }
      if (method === 'session/update' && (sessionId === undefined || params['sessionId'] === sessionId)) onUpdate(params);
    });
    child.once('close', () => {
      for (const waiter of pending.values()) { if (waiter.timer) clearTimeout(waiter.timer); waiter.reject(new Error(`${name} exited`)); }
      pending.clear();
    });

    live.interrupt = () => {
      if (sessionId !== undefined) send({ method: 'session/cancel', params: { sessionId } });
      else child.kill('SIGTERM');
    };

    const run = async (): Promise<void> => {
      await request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
        clientInfo: { name: 'conductor', version: '0.1.0' },
      });
      const pinned = pinnedModel(data, this.spec.modelKey);
      const effort = pinnedEffort(data, this.spec.modelKey);
      const created = obj(await request('session/new', {
        cwd: data.rootPath, mcpServers: [],
        ...(pinned !== undefined || effort !== undefined ? { _meta: { kiro: { ...(pinned !== undefined ? { modelId: pinned } : {}), ...(effort !== undefined ? { effortLevel: effort } : {}) } } } : {}),
      }));
      sessionId = str(created?.['sessionId']);
      if (sessionId === undefined) throw new Error(`${name} did not return a session id`);
      model = pinned ?? currentModel(created ?? {});
      if (pinned !== undefined) await this.selectModel(live, request, sessionId, created ?? {}, pinned);
      if (effort !== undefined) await this.selectEffort(live, request, sessionId, created ?? {}, effort);
      if (live.cancelled) { this.finish(live, { status: 'cancelled' }); return; }
      const sid = sessionId;
      const turn = async (text: string): Promise<Json | null> => {
        declinedTools = 0;
        const reply = obj(await request('session/prompt', { sessionId: sid, prompt: [{ type: 'text', text }] }, null));
        flush();
        const usage = obj(reply?.['usage']);
        if (usage !== null) {
          const n = (key: string): number | undefined => (typeof usage[key] === 'number' ? usage[key] as number : undefined);
          live.events.push('log', { usage: {
            inputTokens: n('inputTokens'), cachedInputTokens: n('cachedReadTokens'), outputTokens: n('outputTokens'),
            reasoningTokens: n('thoughtTokens'), totalTokens: n('totalTokens'), ...(model ? { model } : {}),
          } });
        }
        return reply;
      };
      let done = await turn(objectivePrompt(data));
      // A declined tool is not a user cancellation: OpenCode ends the turn
      // instead of carrying on, so continue the same session and ask it to use
      // the read-only tools. Bounded, and skipped for real cancellations.
      for (let attempt = 0; attempt < DECLINE_CONTINUATIONS; attempt += 1) {
        const reason = str(done?.['stopReason']) ?? 'end_turn';
        if (reason !== 'cancelled' || live.cancelled || declinedTools === 0) break;
        live.events.push('log', { message: `${name} stopped after a tool was declined; asking it to continue with read-only tools.` });
        done = await turn(declinedToolContinuation(data.mode, data.approveCommands === true));
      }
      const stop = str(done?.['stopReason']) ?? 'end_turn';
      if (live.cancelled) this.finish(live, { status: 'cancelled' });
      else if (stop === 'cancelled') {
        // The agent ended the turn on its own; keep a reason so the planner can
        // say more than "did not finish".
        this.finish(live, { status: 'failed', error: declinedTools > 0
          ? `${name} stopped after a tool was declined.`
          : `${name} cancelled the turn before finishing.` });
      }
      else if (stop === 'refusal') this.finish(live, { status: 'failed', error: `${name} refused the request` });
      else {
        if (stop !== 'end_turn') live.events.push('stderr', `${name} stopped early (${stop}).`);
        this.finish(live, { status: 'succeeded', exitCode: 0 });
      }
    };
    void run().catch((error: unknown) => {
      flush();
      const code = (error as { code?: unknown }).code;
      const text = error instanceof Error ? error.message : String(error);
      const auth = code === -32000 || /auth/i.test(text);
      this.finish(live, live.cancelled ? { status: 'cancelled' }
        : { status: 'failed', error: auth ? `${text}. Sign in with \`${this.spec.loginHint}\` in a terminal.` : text });
    });
  }

  /** Set reasoning effort when the agent advertises an effort option (Kiro: effortLevel). */
  private async selectEffort(live: GatedLive, request: (m: string, p: unknown) => Promise<unknown>, sessionId: string, created: Json, effort: string): Promise<void> {
    const options = Array.isArray(created['configOptions']) ? (created['configOptions'] as unknown[]).map(obj) : [];
    const option = options.find((o) => typeof o?.['id'] === 'string' && /effort|reasoning/i.test(o['id'] as string));
    if (option == null) return; // e.g. OpenCode has no effort setting
    try { await request('session/set_config_option', { sessionId, configId: option['id'], value: effort }); }
    catch (error) { live.events.push('stderr', `${this.config.name} did not accept effort ${effort}: ${error instanceof Error ? error.message : String(error)}`); }
  }

  /** Pin the model through whichever mechanism the agent advertised. */
  private async selectModel(live: GatedLive, request: (m: string, p: unknown) => Promise<unknown>, sessionId: string, created: Json, model: string): Promise<void> {
    const options = Array.isArray(created['configOptions']) ? (created['configOptions'] as unknown[]).map(obj) : [];
    try {
      if (options.some((o) => o?.['id'] === 'model')) await request('session/set_config_option', { sessionId, configId: 'model', value: model });
      else if (obj(created['models']) !== null) await request('session/set_model', { sessionId, modelId: model });
    } catch (error) {
      live.events.push('stderr', `${this.config.name} did not accept model ${model}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
