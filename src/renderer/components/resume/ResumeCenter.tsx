import { useResumeCenter } from '../../hooks/useResumeCenter';
import { ResumeItemCard } from './ResumeItemCard';
import { useTaskStore, useWorkspaceStore } from '../../stores';

// The Resume Center UI (Requirement 8.6–8.8). On boot the main process
// reconciles every non-terminal task into a classification (RESUMABLE /
// RECOVERABLE_INTERRUPTION / BLOCKED); this surface lists each reconciled task
// and offers the four actions — Resume, Inspect, Restart, Discard — per task.
//
// The consequential-resume confirmation (8.7) and the discard confirmation
// (8.8) are enforced in the main process (it returns `confirmation_required`
// for an unconfirmed consequential resume or discard); this UI renders that
// requirement as an inline confirm step on the relevant card and re-issues the
// action with `confirmed: true` once the user confirms.

export function ResumeCenter(): React.JSX.Element {
  const { snapshot, loading, error, act } = useResumeCenter();
  const tasks = useTaskStore((state) => state.tasks);
  const workspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const items = (snapshot?.items ?? []).filter((item) => tasks[item.taskId]?.workspaceId === workspaceId && workspaceId !== null);

  return (
    <section className="flex flex-col gap-4" aria-label="Resume Center">
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-semibold text-foreground">
          Resume Center
        </h2>
        <p className="text-xs text-muted-foreground">
          Tasks reconciled on launch. Pick up where you left off, inspect a
          task, restart it, or discard it.
        </p>
      </div>

      {error !== null ? (
        <p className="text-xs text-destructive-foreground" role="alert">
          {error}
        </p>
      ) : null}

      {loading && items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Reconciling tasks…
        </p>
      ) : items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tasks to resume. Everything is either completed or not yet started.
        </p>
      ) : (
        <ul className="flex flex-col gap-3">
          {items.map((item) => (
            <li key={item.taskId}>
              <ResumeItemCard item={item} act={act} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
