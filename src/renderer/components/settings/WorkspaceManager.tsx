import { useState } from 'react';
import type { Workspace } from '@shared/domain';
import { useWorkspaces } from '../../hooks/useWorkspaces';
import { DeleteProjectDialog } from '../projects/DeleteProjectDialog';
import { Badge, Button, inputClassName } from '../ui/primitives';
import { ChevronRightIcon, ImageIcon, IssueIcon, PlusIcon, PullRequestIcon, TrashIcon } from '../ui/icons';
import { ProjectPullRequestsDialog, type ProjectGitHubTab } from '../projects/ProjectPullRequestsDialog';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';
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
  const [github, setGithub] = useState<{ project: Workspace; tab: ProjectGitHubTab } | null>(null);

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

  // Project list: one grouped card, each row the project's icon,
  // name and folder, then "Add a project" as its own settings group.
  return (
    <div className="flex flex-col gap-8">
      {deleting !== null ? <DeleteProjectDialog project={deleting} open onClose={() => { setDeleting(null); }} /> : null}
      {github !== null ? <ProjectPullRequestsDialog key={`${github.project.id}:${github.tab}`} project={github.project} initialTab={github.tab} open onClose={() => { setGithub(null); }} /> : null}
      {iconProject !== null ? <IconPickerDialog key={iconProject.id} target={{ kind: 'project', id: iconProject.id, name: iconProject.name, icon: iconProject.icon ?? null }} open onClose={() => { setIconProject(null); }} /> : null}
      <section className="space-y-2.5">
        <p className="px-3 text-sm text-muted-foreground sm:px-4">Choose a project to make it the active one, change its icon or remove it.</p>
        {loading ? <p className="px-4 text-sm text-muted-foreground">Loading projects…</p> : workspaces.length === 0 ? (
          <p className="px-4 text-sm text-muted-foreground">No projects yet. Add one below to start.</p>
        ) : (
          <SettingsGroup>
            {workspaces.map((workspace) => {
              const isActive = workspace.id === activeWorkspaceId;
              return (
                <div key={workspace.id} className="group/project relative flex items-center">
                  <button
                    type="button"
                    onClick={() => { void select(workspace.id).catch(() => { /* the hook shows the error */ }); }}
                    aria-pressed={isActive}
                    title={isActive ? 'Active project' : 'Make this the active project'}
                    className="flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-xl px-3 py-3 text-left outline-none transition-colors hover:bg-accent/40 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-4"
                  >
                    <EntityIcon icon={workspace.icon ?? null} name={workspace.name} kind="project" size={20} active={isActive} />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-foreground">{workspace.name}</span>
                        {isActive ? <Badge tone="success">Active</Badge> : null}
                      </span>
                      <span className="truncate pe-36 text-xs text-muted-foreground" title={workspace.rootPath}>{workspace.rootPath}</span>
                    </span>
                    <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground" />
                  </button>
                  <span className="absolute top-1/2 right-10 flex -translate-y-1/2 items-center gap-0.5 opacity-0 transition-opacity group-focus-within/project:opacity-100 group-hover/project:opacity-100">
                    <Button variant="ghost" size="icon-sm" title="Issues — start threads from them" aria-label={`Issues for ${workspace.name}`} onClick={() => { setGithub({ project: workspace, tab: 'issues' }); }}><IssueIcon /></Button>
                    <Button variant="ghost" size="icon-sm" title="Pull requests" aria-label={`Pull requests for ${workspace.name}`} onClick={() => { setGithub({ project: workspace, tab: 'pulls' }); }}><PullRequestIcon /></Button>
                    <Button variant="ghost" size="icon-sm" title="Change icon" aria-label={`Icon for ${workspace.name}`} onClick={() => { setIconProject(workspace); }}><ImageIcon /></Button>
                    <Button variant="ghost" size="icon-sm" title="Delete project" className="hover:text-destructive-foreground" aria-label={`Delete ${workspace.name}`} onClick={() => { setDeleting(workspace); }}><TrashIcon /></Button>
                  </span>
                </div>
              );
            })}
          </SettingsGroup>
        )}
      </section>

      <SettingsSection title="Add a project">
        <form onSubmit={(event) => { void handleCreate(event); }} aria-label="Create workspace">
          <SettingsGroup>
            <SettingsRow title="Name" description="What the project is called in the sidebar and in threads."
              control={<input id="workspace-name" type="text" value={name} maxLength={255} onChange={(event) => { setName(event.target.value); }} className={cn(inputClassName, 'w-72')} placeholder="My project" />} />
            <SettingsRow title="Folder" description="The project's root folder on this Mac."
              control={<input id="workspace-root" type="text" value={rootPath} onChange={(event) => { setRootPath(event.target.value); }} className={cn(inputClassName, 'w-72')} placeholder="/Users/you/projects/my-project" />} />
            <div className="flex items-center justify-end gap-3 px-3 py-3 sm:px-4">
              {error !== null ? <p role="alert" className="me-auto text-xs text-destructive-foreground">{error}</p> : null}
              <Button variant="primary" size="sm" type="submit" disabled={!canCreate}><PlusIcon />{submitting ? 'Adding…' : 'Add project'}</Button>
            </div>
          </SettingsGroup>
        </form>
      </SettingsSection>
    </div>
  );
}
