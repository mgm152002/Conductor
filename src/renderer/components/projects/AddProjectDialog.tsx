import { useEffect, useId, useState } from 'react';
import { useUiStore, useWorkspaceStore } from '../../stores';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import { Button, Dialog, inputClassName } from '../ui/primitives';
import { FolderOpenIcon } from '../ui/icons';

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? '';
}

/**
 * Add a project: pick a folder, name it, and optionally index it so the
 * folder's files become searchable context for the project's tasks.
 */
export function AddProjectDialog(): React.JSX.Element {
  const open = useUiStore((s) => s.addProjectOpen);
  const setOpen = useUiStore((s) => s.setAddProjectOpen);
  const { newThread } = useThreadNavigation();
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [nameTouched, setNameTouched] = useState(false);
  const [index, setIndex] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathId = useId();
  const nameId = useId();
  const indexId = useId();

  useEffect(() => {
    if (!open) return;
    setRootPath(''); setName(''); setNameTouched(false); setIndex(true); setError(null); setBusy(false);
  }, [open]);

  async function browse(): Promise<void> {
    try {
      const picked = await window.conductor.system.pickDirectory({ title: 'Choose a project folder' });
      if (picked === null) return;
      setRootPath(picked);
      if (!nameTouched) setName(basename(picked));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open the folder picker');
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const path = rootPath.trim();
    const label = name.trim() || basename(path);
    if (path === '' || label === '') return;
    setBusy(true);
    setError(null);
    try {
      const workspace = await window.conductor.workspace.create({ name: label, rootPath: path });
      useWorkspaceStore.getState().upsert(workspace);
      if (index) {
        try {
          await window.conductor.connectors.createFolder({ name: label, rootPath: path, workspaceId: workspace.id });
        } catch {
          // The project exists; indexing can be retried from Connections.
        }
      }
      setOpen(false);
      await newThread(workspace.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the project');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={() => { setOpen(false); }} title="Add project" description="A project is a folder Conductor's agents work in. Threads, memory and context are scoped to it.">
      <form className="flex flex-col gap-3" onSubmit={(event) => { void submit(event); }} aria-label="Create workspace">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={pathId} className="text-xs font-medium text-foreground">Folder</label>
          <div className="flex gap-2">
            <input id={pathId} className={`${inputClassName} font-mono text-xs`} placeholder="/Users/you/code/project" value={rootPath} onChange={(e) => { setRootPath(e.target.value); if (!nameTouched) setName(basename(e.target.value)); }} spellCheck={false} autoComplete="off" />
            <Button size="md" variant="outline" onClick={() => { void browse(); }}><FolderOpenIcon size={14} />Browse…</Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-xs font-medium text-foreground">Name</label>
          <input id={nameId} className={inputClassName} value={name} onChange={(e) => { setName(e.target.value); setNameTouched(true); }} maxLength={255} autoComplete="off" />
        </div>
        <label htmlFor={indexId} className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-border p-2.5">
          <input id={indexId} type="checkbox" className="mt-0.5 accent-[var(--primary)]" checked={index} onChange={(e) => { setIndex(e.target.checked); }} />
          <span className="text-xs">
            <span className="font-medium text-foreground">Index this folder for context</span>
            <span className="mt-0.5 block text-muted-foreground">Text files become searchable memory, and relevant passages are attached to this project's tasks. Indexing is local; dotfiles, likely secrets and dependency folders are skipped.</span>
          </span>
        </label>
        {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="md" variant="ghost" onClick={() => { setOpen(false); }}>Cancel</Button>
          <Button size="md" variant="primary" type="submit" disabled={busy || rootPath.trim() === ''}>{busy ? 'Adding…' : 'Add project'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
