import { useEffect, useState } from 'react';
import type { Task } from '@shared/domain';
import { useApprovalStore, useTaskStore } from '../../stores';
import { Button, Switch } from '../ui/primitives';
import { ShieldIcon } from '../ui/icons';

// Pending approvals for the focused thread, attached above the composer like
// T3 Code's pending-approval panel. Approving or denying round-trips through
// the main process; the adapter is never invoked before an approval.

export function PendingApprovalPanel({ task }: { task: Task }): React.JSX.Element | null {
  const allPending = useApprovalStore((s) => s.pending);
  const pending = allPending.filter((request) => request.taskId === task.id);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [autoApprove, setAutoApprove] = useState(false);
  useEffect(() => {
    let active = true;
    void window.conductor.settings.get('execution.autoApprove')
      .then((value) => { if (active) setAutoApprove(value === true); })
      .catch(() => { /* the panel still works without the preference */ });
    return () => { active = false; };
  }, []);
  if (pending.length === 0 && error === null) return null;
  const request = pending[0];

  async function refresh(): Promise<void> {
    const [requests, updated] = await Promise.all([window.conductor.approval.list(), window.conductor.task.get(task.id)]);
    useApprovalStore.getState().setPending(requests);
    useTaskStore.getState().upsert(updated);
  }

  async function resolve(approvalId: string, decision: 'approved' | 'denied', remember = false): Promise<void> {
    setBusyId(approvalId);
    setError(null);
    try {
      await window.conductor.approval.resolve({ approvalId, decision, ...(remember ? { remember: true } : {}) });
      useApprovalStore.getState().remove(approvalId);
      useTaskStore.getState().bumpDetails(task.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update approval');
    } finally {
      setBusyId(null);
    }
  }

  async function toggleAutoApprove(next: boolean): Promise<void> {
    setBusyId('auto-approve');
    setError(null);
    try {
      // Persist first so any tool call that continues after these approvals
      // already sees the preference.
      await window.conductor.settings.set({ key: 'execution.autoApprove', value: next, scope: 'global' });
      setAutoApprove(next);
      if (next) {
        const ids = useApprovalStore.getState().pending
          .filter((item) => item.taskId === task.id)
          .map((item) => item.id);
        await Promise.all(ids.map((approvalId) => window.conductor.approval.resolve({ approvalId, decision: 'approved' })));
        for (const approvalId of ids) useApprovalStore.getState().remove(approvalId);
      }
      useTaskStore.getState().bumpDetails(task.id);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not update auto-approve');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section aria-label="Approval requests" className="mx-auto mb-2 w-full max-w-(--chat-max) rounded-2xl border border-warning/30 bg-warning/6 px-3.5 py-3">
      {request !== undefined ? (
        <>
          <div className="flex items-center gap-2 text-2xs text-muted-foreground">
            <ShieldIcon size={13} className="text-warning" />
            <span className="font-medium text-warning">Approval needed</span>
            {pending.length > 1 ? <span className="ml-auto tabular-nums">1/{pending.length}</span> : null}
          </div>
          <p className="mt-1.5 text-[13px] text-foreground">{request.summary.split('\n')[0]}</p>
          {request.summary.includes('\n') ? (
            <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg border border-border bg-code px-2.5 py-1.5 font-mono text-2xs whitespace-pre-wrap break-all text-foreground/90">{request.summary.split('\n').slice(1).join('\n')}</pre>
          ) : null}
          {request.requirements.length > 0 ? (
            <ul className="mt-1.5 flex flex-wrap gap-1">
              {request.requirements.map((requirement, index) => (
                <li key={`${requirement.kind}:${index}`} className="rounded-full border border-border bg-background/60 px-2 py-0.5 text-3xs text-muted-foreground">
                  {requirement.kind.replace(/_/g, ' ')}{requirement.scope ? ` · ${requirement.scope}` : ''}
                </li>
              ))}
            </ul>
          ) : null}
          <div className="mt-2.5 flex gap-2">
            <Button size="sm" variant="primary" disabled={busyId !== null} onClick={() => { void resolve(request.id, 'approved'); }}>{busyId === request.id ? 'Updating…' : 'Approve'}</Button>
            {task.state === 'RUNNING' || task.state === 'PLANNING' ? (
              <Button size="sm" variant="outline" disabled={busyId !== null} title="Allow similar actions for the rest of this task" onClick={() => { void resolve(request.id, 'approved', true); }}>Allow for this task</Button>
            ) : null}
            <Button size="sm" variant="outline" disabled={busyId !== null} onClick={() => { void resolve(request.id, 'denied'); }}>Deny</Button>
          </div>
          <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-border/60 pt-2.5">
            <div className="min-w-0">
              <p className="text-xs font-medium">Auto-approve everything</p>
              <p className="text-3xs text-muted-foreground">Accepts this and all future tool requests, for every task. Reads and searches never ask.</p>
            </div>
            <Switch label="Auto-approve everything" checked={autoApprove} disabled={busyId !== null} onChange={(next) => { void toggleAutoApprove(next); }} />
          </div>
        </>
      ) : null}
      {error !== null ? <p role="alert" className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
    </section>
  );
}
