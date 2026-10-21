import type { PermissionRequirement } from '@shared/domain';
import type { Store } from '../db/types';
import type { PermissionService } from '../domain/permission-service';
import type { ToolApprovalDecision, ToolApprovalRequest } from '../adapters/tool-gate';

// Per-tool-call approvals. When an agent (Codex, Claude Code, OpenCode, Kiro or Antigravity) asks to run a
// command or change files, the broker records an Approval_Request so it shows
// in the thread's approval panel, waits for the user's answer, and hands the
// decision back to the agent. Denying declines that one action; the task keeps
// running and the agent can try another way.

const SUBJECT = { type: 'agent' as const, id: 'orchestrator' };

interface Waiter { taskId: string; resolve: (decision: ToolApprovalDecision) => void }

function requirementFor(request: ToolApprovalRequest): PermissionRequirement {
  const scope = request.detail?.split('\n')[0]?.slice(0, 300);
  const kind = request.kind === 'command' ? 'command_exec' : request.kind === 'file_change' ? 'filesystem_write' : 'external_comm';
  return { kind, ...(scope ? { scope } : {}) };
}

export class ToolApprovalBroker {
  private readonly waiting = new Map<string, Waiter>();

  constructor(
    private readonly store: Store,
    private readonly permissions: PermissionService,
    /** Called when a request is created or resolved, so the UI refreshes. */
    private readonly onChange: (taskId: string) => void = () => {},
  ) {}

  /** Ask the user; resolves with their decision, or 'cancel' if aborted. */
  request(request: ToolApprovalRequest, signal?: AbortSignal): Promise<ToolApprovalDecision> {
    const detail = request.detail !== undefined ? `\n${request.detail.slice(0, 2000)}` : '';
    const approval = this.permissions.requestApproval({
      taskId: request.taskId,
      stepId: request.stepId,
      subject: SUBJECT,
      summary: `${request.summary}${detail}`,
      requirements: [requirementFor(request)],
    });
    return new Promise<ToolApprovalDecision>((resolve) => {
      const done = (decision: ToolApprovalDecision): void => {
        if (!this.waiting.delete(approval.id)) return;
        resolve(decision);
        this.onChange(request.taskId);
      };
      this.waiting.set(approval.id, { taskId: request.taskId, resolve: done });
      signal?.addEventListener('abort', () => {
        this.expire(approval.id);
        done('cancel');
      }, { once: true });
      this.onChange(request.taskId);
    });
  }

  /** Whether an approval belongs to a live tool call. */
  handles(approvalId: string): boolean {
    return this.waiting.has(approvalId);
  }

  /** Apply the user's decision. Returns false when the request is not a live tool call. */
  resolve(approvalId: string, decision: 'approved' | 'denied', remember = false): boolean {
    const waiter = this.waiting.get(approvalId);
    if (waiter === undefined) return false;
    if (decision === 'approved') {
      const result = this.permissions.approve(approvalId);
      waiter.resolve(result.resolved ? (remember ? 'accept_for_session' : 'accept') : 'decline');
    } else {
      this.permissions.deny(approvalId);
      waiter.resolve('decline');
    }
    return true;
  }

  /** Expire every open tool approval for a task (it was cancelled or ended). */
  cancelTask(taskId: string): void {
    for (const [id, waiter] of [...this.waiting]) {
      if (waiter.taskId !== taskId) continue;
      this.expire(id);
      waiter.resolve('cancel');
    }
  }

  private expire(approvalId: string): void {
    this.store.db.prepare(`UPDATE approval_requests SET status = 'expired', resolved_at = ? WHERE id = ? AND status = 'pending'`)
      .run(new Date().toISOString(), approvalId);
  }
}
