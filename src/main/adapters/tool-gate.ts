import type { AdapterResult, AdapterStreamEvent, AdapterStreamEventKind } from '@shared/adapter';
import type { PermissionProfile } from '@shared/domain';

// Per-tool-call approvals shared by every agent adapter that can ask before a
// tool runs (Codex app-server, Claude Code's permission prompt tool, the ACP
// agents OpenCode and Kiro, and Antigravity's PreToolUse hook).
//
// The permission profile decides who answers:
//   read_only          → declined without asking (nothing may change)
//   assisted_execution → the user, through Conductor's approval panel
//   trusted_automation → accepted without asking

export type ToolApprovalKind = 'command' | 'file_change' | 'permissions';
export type ToolApprovalDecision = 'accept' | 'accept_for_session' | 'decline' | 'cancel';

export interface ToolApprovalRequest {
  taskId: string;
  stepId: string;
  kind: ToolApprovalKind;
  /** One-line description for the approval card. */
  summary: string;
  /** Command line, file list, or permission detail. */
  detail?: string;
  cwd?: string;
}

export interface ToolGateOptions {
  /**
   * Plan mode: the run is read-only, but the user still wants to approve
   * commands (ls, git log) the planner cannot do with read/grep. File changes
   * are still declined without asking.
   */
  approveCommands?: boolean;
  /**
   * The user's "auto-approve everything" toggle, read per decision so it also
   * applies to sessions that were already running when it was switched on.
   */
  autoApprove?: () => boolean;
}

/** Asks the user (through Conductor's approval UI) and resolves with their decision. */
export type ToolApprover = (request: ToolApprovalRequest, signal: AbortSignal) => Promise<ToolApprovalDecision>;

export interface AgentQuestionPrompt {
  taskId: string;
  stepId?: string;
  agent: string;
  questions: import('@shared/domain').AgentQuestion[];
}

/** Asks the user questions an agent raised mid-run; null means no answer. */
export type QuestionAsker = (
  prompt: AgentQuestionPrompt,
  signal: AbortSignal,
) => Promise<import('@shared/domain').AgentQuestionAnswers | null>;

export interface GateRequest {
  kind: ToolApprovalKind;
  summary: string;
  detail?: string;
  cwd?: string;
  /** A read or search inside the workspace: no approval is ever needed. */
  readOnly?: boolean;
  /**
   * What "Allow for this task" covers. Defaults to the exact command for
   * commands, every file change for file changes, and the summary otherwise.
   */
  rememberKey?: string;
}

/** Files that stay behind an explicit approval even when reads are automatic. */
export function isSensitivePath(path: string): boolean {
  return /(^|[/\\])\.env($|\.)/i.test(path)
    || /(^|[/\\])(id_rsa|id_ed25519|id_ecdsa)(\.pub)?$/i.test(path)
    || /(^|[/\\])[^/\\]*\.(pem|key|p12|pfx)$/i.test(path);
}

export const isAccept = (d: ToolApprovalDecision): boolean => d === 'accept' || d === 'accept_for_session';

/** One agent session's tool-call gate. */
export class ToolGate {
  private readonly remembered = new Set<string>();
  private readonly aborts = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly mode: PermissionProfile | undefined,
    private readonly approver: ToolApprover,
    private readonly ids: { taskId?: string | undefined; stepId?: string | undefined },
    private readonly options: ToolGateOptions = {},
  ) {}

  async decide(request: GateRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
    if (this.closed || signal?.aborted === true) return 'cancel';
    // Reads and searches never ask, and the auto-approve toggle covers every
    // tool, including ones a read-only profile would otherwise decline.
    if (request.readOnly === true) return 'accept';
    if (this.options.autoApprove?.() === true) return 'accept';
    if (this.mode === 'trusted_automation') return 'accept';
    const asks = this.mode === 'assisted_execution'
      || (this.mode === 'read_only' && this.options.approveCommands === true && request.kind === 'command');
    if (!asks) return 'decline';
    const key = request.rememberKey
      ?? (request.kind === 'command' ? `command:${request.detail ?? request.summary}` : request.kind === 'file_change' ? 'file_change' : `other:${request.summary}`);
    if (this.remembered.has(key)) return 'accept';
    const { taskId, stepId } = this.ids;
    if (taskId === undefined || stepId === undefined) return 'decline';
    const decision = await new Promise<ToolApprovalDecision>((resolve) => {
      const controller = new AbortController();
      const abort = (): void => { controller.abort(); resolve('cancel'); };
      this.aborts.add(abort);
      signal?.addEventListener('abort', abort, { once: true });
      void this.approver({
        taskId, stepId, kind: request.kind, summary: request.summary,
        ...(request.detail ? { detail: request.detail } : {}), ...(request.cwd ? { cwd: request.cwd } : {}),
      }, controller.signal)
        .then(resolve, () => { resolve('decline'); })
        .finally(() => { this.aborts.delete(abort); signal?.removeEventListener('abort', abort); });
    });
    if (decision === 'accept_for_session') this.remembered.add(key);
    return decision;
  }

  /** Answer every open request with 'cancel' and refuse new ones. */
  close(): void {
    this.closed = true;
    for (const abort of [...this.aborts]) abort();
    this.aborts.clear();
  }
}

/** Ordered adapter events plus the session's final result. */
export class EventQueue {
  private readonly queue: AdapterStreamEvent[] = [];
  private notify: (() => void) | undefined;
  private sequence = 0;
  private settle!: (result: AdapterResult) => void;
  done = false;
  readonly completion: Promise<AdapterResult>;

  constructor() {
    this.completion = new Promise<AdapterResult>((resolve) => { this.settle = resolve; });
  }

  push(kind: AdapterStreamEventKind, data: unknown): void {
    if (this.done) return;
    this.sequence += 1;
    this.queue.push({ kind, sequence: this.sequence, data, at: new Date().toISOString() });
    this.notify?.();
  }

  /** Settle once; later calls are ignored. Returns whether this call settled. */
  finish(result: AdapterResult): boolean {
    if (this.done) return false;
    this.done = true;
    this.settle(result);
    this.notify?.();
    return true;
  }

  async *drain(): AsyncIterable<AdapterStreamEvent> {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) { yield next; continue; }
      if (this.done) return;
      await new Promise<void>((resolve) => { this.notify = resolve; });
      this.notify = undefined;
    }
  }
}
