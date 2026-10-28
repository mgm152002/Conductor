import { useState } from 'react';
import type { Workspace } from '@shared/domain';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { DeleteProjectDialog } from '../projects/DeleteProjectDialog';
import { Button } from '../ui/primitives';
import { TrashIcon } from '../ui/icons';

// Workspace create/list/select wired to the `window.conductor.workspace` bridge
// (Requirement 2, surfaced for task 5.2). Listing loads on mount; create
// validates name/root path in the main process and round-trips the persisted
// workspace; select persists the active workspace (kept across restarts by the
// main process). Field-level errors from the main process surface inline.

export function WorkspaceManager(): React.JSX.Element {
  const { workspaces, activeWorkspaceId, loading, error, create, select } =
    useWorkspaces();

  const [name, setName] = useState('');
  const [rootPath, setRootPath] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState<Workspace | null>(null);

  const canCreate =
    name.trim().length > 0 && rootPath.trim().length > 0 && !submitting;

  async function handleCreate(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    setSubmitting(true);
    try {
      await create({ name: name.trim(), rootPath: rootPath.trim() });
      setName('');
      setRootPath('');
    } catch {
      // Error is surfaced through the store/hook; keep the form populated.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="flex flex-col gap-4">
      {deleting !== null ? <DeleteProjectDialog project={deleting} open onClose={() => { setDeleting(null); }} /> : null}
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-foreground">
          Workspaces
        </h2>
        {loading ? (
          <p className="text-sm text-muted-foreground">
            Loading workspaces…
          </p>
        ) : workspaces.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No workspaces yet. Create one below to start.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <li key={workspace.id} className="flex items-stretch gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void select(workspace.id).catch(() => {
                        // The hook displays selection errors inline.
                      });
                    }}
                    aria-pressed={isActive}
                    className={
                      isActive
                        ? 'flex w-full flex-col items-start gap-0.5 bg-accent px-3 py-2.5 text-left'
                        : 'flex w-full flex-col items-start gap-0.5 px-3 py-2.5 text-left transition-colors hover:bg-accent'
                    }
                  >
                    <span className="flex w-full items-center justify-between gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {workspace.name}
                      </span>
                      {isActive ? (
                        <span className="text-xs font-medium text-success">
                          Active
                        </span>
                      ) : null}
                    </span>
                    <span className="truncate font-mono text-xs text-muted-foreground">
                      {workspace.rootPath}
                    </span>
                  </button>
                  <Button variant="destructive-outline" size="sm" className="h-auto self-stretch" aria-label={`Delete ${workspace.name}`} onClick={() => { setDeleting(workspace); }}>
                    <TrashIcon size={13} />Delete
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        className="flex flex-col gap-2 rounded-xl bg-muted/50 p-3"
        onSubmit={(event) => {
          void handleCreate(event);
        }}
        aria-label="Create workspace"
      >
        <label
          htmlFor="workspace-name"
          className="text-xs font-medium text-muted-foreground"
        >
          Name
        </label>
        <input
          id="workspace-name"
          type="text"
          value={name}
          maxLength={255}
          onChange={(event) => {
            setName(event.target.value);
          }}
          className="inset-field px-3 py-2 text-sm"
          placeholder="My project"
        />
        <label
          htmlFor="workspace-root"
          className="text-xs font-medium text-muted-foreground"
        >
          Root path
        </label>
        <input
          id="workspace-root"
          type="text"
          value={rootPath}
          onChange={(event) => {
            setRootPath(event.target.value);
          }}
          className="inset-field px-3 py-2 font-mono text-sm"
          placeholder="/Users/you/projects/my-project"
        />
        {error !== null ? (
          <p className="text-xs text-destructive-foreground">{error}</p>
        ) : null}
        <button
          type="submit"
          disabled={!canCreate}
          className="self-start rounded-full bg-primary px-4 py-2 text-sm font-medium text-primary-foreground shadow-sm transition-colors hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitting ? 'Creating…' : 'Create workspace'}
        </button>
      </form>
    </section>
  );
}
