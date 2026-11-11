import { useState } from 'react';
import type { Workspace } from '@shared/domain';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { DeleteProjectDialog } from '../projects/DeleteProjectDialog';
import { Button } from '../ui/primitives';
import { ImageIcon, TrashIcon } from '../ui/icons';
import { EntityIcon } from '../ui/EntityIcon';
import { cn } from '../../lib/cn';
import { IconPickerDialog } from '../icons/IconPickerDialog';

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
  const [iconProject, setIconProject] = useState<Workspace | null>(null);

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
    <section className="flex flex-col gap-3">
      {deleting !== null ? <DeleteProjectDialog project={deleting} open onClose={() => { setDeleting(null); }} /> : null}
      {iconProject !== null ? <IconPickerDialog key={iconProject.id} target={{ kind: 'project', id: iconProject.id, name: iconProject.name, icon: iconProject.icon ?? null }} open onClose={() => { setIconProject(null); }} /> : null}
      <div className="flex flex-col gap-2">
        <h2 className="text-[13px] font-semibold text-foreground">
          Workspaces
        </h2>
        {loading ? (
          <p className="text-[13px] text-muted-foreground">
            Loading workspaces…
          </p>
        ) : workspaces.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            No workspaces yet. Create one below to start.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border">
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <li key={workspace.id} className="group/project relative flex items-stretch">
                  <button
                    type="button"
                    onClick={() => {
                      void select(workspace.id).catch(() => {
                        // The hook displays selection errors inline.
                      });
                    }}
                    aria-pressed={isActive}
                    title={isActive ? 'Active project' : 'Make this the active project'}
                    className={cn(
                      'flex w-full min-w-0 cursor-pointer items-center gap-3 px-3.5 py-3 text-left transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring',
                      isActive ? 'bg-primary/7' : 'hover:bg-accent',
                    )}
                  >
                    <EntityIcon icon={workspace.icon ?? null} name={workspace.name} kind="project" size={28} active={isActive} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-[13px] font-semibold text-foreground">{workspace.name}</span>
                        {isActive ? (
                          <span className="shrink-0 rounded-full bg-success/12 px-1.5 py-px text-3xs font-medium text-success">
                            Active
                          </span>
                        ) : null}
                      </span>
                      <span className="w-full truncate pr-16 font-mono text-2xs text-muted-foreground" title={workspace.rootPath}>
                        {workspace.rootPath}
                      </span>
                    </span>
                  </button>
                  <span className="absolute top-2 right-2 flex items-center gap-0.5 opacity-60 transition-opacity group-focus-within/project:opacity-100 group-hover/project:opacity-100">
                    <Button variant="ghost" size="icon-sm" title="Change icon" aria-label={`Icon for ${workspace.name}`} onClick={() => { setIconProject(workspace); }}>
                      <ImageIcon size={13} />
                    </Button>
                    <Button variant="ghost" size="icon-sm" title="Delete project" className="hover:text-destructive-foreground" aria-label={`Delete ${workspace.name}`} onClick={() => { setDeleting(workspace); }}>
                      <TrashIcon size={13} />
                    </Button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <form
        className="flex flex-col gap-3 rounded-xl border border-dashed border-border-strong p-3.5"
        onSubmit={(event) => {
          void handleCreate(event);
        }}
        aria-label="Create workspace"
      >
        <p className="text-[13px] font-semibold text-foreground">Add a project</p>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
          <div className="flex min-w-0 flex-col gap-1">
            <label
              htmlFor="workspace-name"
              className="text-2xs font-medium text-muted-foreground"
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
              className="inset-field h-8 px-2.5 text-[13px]"
              placeholder="My project"
            />
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <label
              htmlFor="workspace-root"
              className="text-2xs font-medium text-muted-foreground"
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
              className="inset-field h-8 px-2.5 font-mono text-[13px]"
              placeholder="/Users/you/projects/my-project"
            />
          </div>
        </div>
        {error !== null ? (
          <p role="alert" className="text-xs text-destructive-foreground">{error}</p>
        ) : null}
        <Button variant="primary" size="sm" type="submit" disabled={!canCreate} className="self-start">
          {submitting ? 'Creating…' : 'Create workspace'}
        </Button>
      </form>
    </section>
  );
}
