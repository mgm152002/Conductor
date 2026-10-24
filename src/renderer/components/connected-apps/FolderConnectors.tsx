import { useEffect, useId, useState } from 'react';
import type { ConnectorView, IngestedItemView } from '@shared/connector';
import type { DataControlSettings } from '@shared/domain';
import { useNavigate } from 'react-router-dom';
import { useWorkspaceStore } from '../../stores';
import { useConnectors } from '../../hooks/useConnectors';
import { relativeTime } from '../../lib/time';
import { cn } from '../../lib/cn';
import { reportMemoryCleanup } from '../../lib/memory-cleanup';
import { Badge, Button, Dialog, EmptyState, Switch, inputClassName } from '../ui/primitives';
import { CalendarIcon, ChevronRightIcon, DatabaseIcon, FileTextIcon, FolderIcon, FolderOpenIcon, MailIcon, MessageIcon, PlusIcon, RotateIcon, Spinner, TrashIcon } from '../ui/icons';
import { AddAccountDialog, type AccountKind } from './AddAccountDialog';

// Local folder connectors: index a folder's text files into searchable memory
// and attach relevant passages to a project's tasks. Indexing is local; the
// background-sync switch is the data-control `syncEnabled` preference.

function basename(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] ?? path;
}

function KindIcon({ kind, size = 15 }: { kind: ConnectorView['kind']; size?: number }): React.JSX.Element {
  const Icon = kind === 'email' ? MailIcon : kind === 'calendar' ? CalendarIcon : kind === 'messaging' ? MessageIcon : kind === 'files' ? FolderIcon : FileTextIcon;
  return <Icon size={size} className="shrink-0 text-muted-foreground" />;
}

function sourceLabel(connector: ConnectorView): string {
  const { config } = connector;
  if (config.email) return `${config.email.user} · ${config.email.host} · ${config.email.mailbox}`;
  if (config.calendar) return `iCalendar feed · ${config.calendar.label}`;
  if (config.messaging) return `Slack${config.messaging.channels?.length ? ` · #${config.messaging.channels.join(', #')}` : ' · channels you are in'}`;
  return config.rootPath ?? 'Not configured';
}

function itemNoun(connector: ConnectorView, count: number): string {
  const singular = connector.kind === 'email' ? 'message' : connector.kind === 'calendar' ? 'event' : connector.kind === 'messaging' ? 'message' : 'file';
  return count === 1 ? singular : `${singular}s`;
}

function HealthBadge({ connector }: { connector: ConnectorView }): React.JSX.Element {
  if (connector.syncing) return <Badge tone="info"><Spinner size={9} />Indexing</Badge>;
  if (connector.authState === 'revoked') return <Badge>Paused</Badge>;
  if (connector.authState === 'unauthorized') return <Badge tone="warning">Not connected</Badge>;
  if (connector.health === 'unhealthy') return <Badge tone="destructive">Sync failing</Badge>;
  if (connector.health === 'healthy') return <Badge tone="success">Up to date</Badge>;
  return <Badge>Waiting</Badge>;
}

function ConnectorRow({ connector, onError }: { connector: ConnectorView; onError: (message: string | null) => void }): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const navigate = useNavigate();
  const project = workspaces.find((w) => w.id === connector.config.workspaceId);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<IngestedItemView[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function act(name: string, run: () => Promise<unknown>): Promise<void> {
    setBusy(name);
    onError(null);
    try { reportMemoryCleanup(await run()); }
    catch (err) { onError(err instanceof Error ? err.message : `Could not ${name}`); }
    finally { setBusy(null); }
  }

  useEffect(() => {
    if (!open) return;
    let active = true;
    void window.conductor.connectors.items({ id: connector.id, limit: 200 }).then((list) => { if (active) setItems(list); }).catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, [open, connector.id, connector.itemCount]);

  return (
    <li className="rounded-xl border border-border bg-card">
      <div className="flex items-start gap-3 p-3.5">
        <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border text-muted-foreground"><KindIcon kind={connector.kind} /></div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="truncate text-sm font-medium text-foreground">{connector.name}</p>
            <HealthBadge connector={connector} />
          </div>
          <p className="mt-0.5 truncate font-mono text-2xs text-muted-foreground" title={sourceLabel(connector)}>{sourceLabel(connector)}</p>
          <p className="mt-1 text-2xs text-muted-foreground">
            {connector.itemCount.toLocaleString()} {itemNoun(connector, connector.itemCount)} indexed
            {connector.lastSyncedAt ? <> · synced {relativeTime(connector.lastSyncedAt)}{relativeTime(connector.lastSyncedAt) === 'now' ? '' : ' ago'}</> : null}
            {project !== undefined ? <> · context for <span className="text-foreground/80">{project.name}</span></> : <> · not linked to a project</>}
          </p>
          {connector.lastError && connector.health === 'unhealthy' ? <p className="mt-1.5 text-2xs break-words text-destructive-foreground">{connector.lastError}</p> : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {connector.authState === 'authorized' ? (
            <>
              <Button size="sm" variant="outline" disabled={busy !== null || connector.syncing} onClick={() => { void act('sync', () => window.conductor.connectors.sync({ id: connector.id })); }}>
                <RotateIcon size={12} />{connector.syncing ? 'Indexing…' : 'Sync now'}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => { void act('pause', () => window.conductor.connectors.revoke(connector.id)); }}>Pause</Button>
            </>
          ) : (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void act('reconnect', () => window.conductor.connectors.authorize(connector.id)); }}>Resume</Button>
          )}
          <Button size="icon-sm" variant="ghost" aria-label={`Remove ${connector.name}`} title="Remove" disabled={busy !== null} onClick={() => { setConfirmDelete(true); }}><TrashIcon size={13} /></Button>
        </div>
      </div>
      <div className="border-t border-border">
        <button type="button" onClick={() => { setOpen((v) => !v); }} aria-expanded={open} className="flex h-8 w-full cursor-pointer items-center gap-1.5 px-3.5 text-2xs text-muted-foreground hover:text-foreground">
          <ChevronRightIcon size={11} className={cn('transition-transform', open && 'rotate-90')} />Indexed {itemNoun(connector, 2)}
          <span className="ml-auto flex items-center gap-3">
            {connector.authState === 'authorized' ? <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); void act('reindex', () => window.conductor.connectors.sync({ id: connector.id, full: true })); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); void act('reindex', () => window.conductor.connectors.sync({ id: connector.id, full: true })); } }} className="hover:text-foreground hover:underline">Full re-index</span> : null}
            <span role="button" tabIndex={0} onClick={(e) => { e.stopPropagation(); navigate('/memory'); }} onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); navigate('/memory'); } }} className="hover:text-foreground hover:underline">Search in Memory</span>
          </span>
        </button>
        {open ? (
          <div className="max-h-64 overflow-y-auto px-3.5 pb-3">
            {items === null ? <p className="text-2xs text-muted-foreground">Loading…</p> : items.length === 0 ? <p className="text-2xs text-muted-foreground">Nothing indexed yet.</p> : (
              <ul className="flex flex-col">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center gap-2 py-0.5 text-2xs">
                    <KindIcon kind={connector.kind} size={11} />
                    <span className="min-w-0 flex-1 truncate font-mono text-foreground/85">{item.origin ?? item.externalId ?? item.id}</span>
                    <span className="shrink-0 text-muted-foreground tabular-nums">{relativeTime(item.ingestedAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ) : null}
      </div>
      <Dialog
        open={confirmDelete}
        onClose={() => { setConfirmDelete(false); }}
        title={`Remove ${connector.name}?`}
        description={connector.kind === 'files' ? 'This deletes the connector, its index and the memories created from its files. The folder itself is not touched.' : 'This deletes the connector, its stored credential, its index and the memories created from it. Nothing is changed in the account itself.'}
        footer={<>
          <Button size="md" variant="ghost" onClick={() => { setConfirmDelete(false); }}>Cancel</Button>
          <Button size="md" variant="destructive" disabled={busy !== null} onClick={() => { setConfirmDelete(false); void act('remove', () => window.conductor.connectors.delete(connector.id)); }}>Remove and delete index</Button>
        </>}
      />
    </li>
  );
}

function AddFolderDialog({ open, onClose }: { open: boolean; onClose: () => void }): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [rootPath, setRootPath] = useState('');
  const [name, setName] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pathId = useId();
  const nameId = useId();
  const projectId = useId();

  useEffect(() => {
    if (!open) return;
    setRootPath(''); setName(''); setError(null); setBusy(false); setWorkspaceId(activeWorkspaceId ?? '');
  }, [open, activeWorkspaceId]);

  async function browse(): Promise<void> {
    const picked = await window.conductor.system.pickDirectory({ title: 'Choose a folder to index' }).catch(() => null);
    if (picked === null) return;
    setRootPath(picked);
    if (name.trim() === '') setName(basename(picked));
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    setBusy(true); setError(null);
    try {
      await window.conductor.connectors.createFolder({
        name: name.trim() || basename(rootPath.trim()),
        rootPath: rootPath.trim(),
        ...(workspaceId !== '' ? { workspaceId } : {}),
      });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not connect the folder');
    } finally { setBusy(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Index a folder" description="Text files in the folder become searchable memory. Dotfiles, likely secrets, binaries, large files and dependency folders are skipped. Symlinks are not followed.">
      <form className="flex flex-col gap-3" onSubmit={(event) => { void submit(event); }} aria-label="Connect folder">
        <div className="flex flex-col gap-1.5">
          <label htmlFor={pathId} className="text-xs font-medium">Folder</label>
          <div className="flex gap-2">
            <input id={pathId} className={`${inputClassName} font-mono text-xs`} value={rootPath} onChange={(e) => { setRootPath(e.target.value); }} placeholder="/Users/you/Documents/notes" spellCheck={false} autoComplete="off" />
            <Button size="md" variant="outline" onClick={() => { void browse(); }}><FolderOpenIcon size={14} />Browse…</Button>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className="text-xs font-medium">Name</label>
          <input id={nameId} className={inputClassName} value={name} onChange={(e) => { setName(e.target.value); }} maxLength={255} autoComplete="off" />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={projectId} className="text-xs font-medium">Use as context for</label>
          <select id={projectId} className={inputClassName} value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); }}>
            <option value="">No project (search only)</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
          <p className="text-3xs text-muted-foreground">Tasks in this project receive the most relevant indexed passages as untrusted reference data.</p>
        </div>
        {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="md" variant="primary" type="submit" disabled={busy || !rootPath.trim().startsWith('/')}>{busy ? 'Connecting…' : 'Connect and index'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function FolderConnectors(): React.JSX.Element {
  const { connectors, loading, error: loadError } = useConnectors();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<DataControlSettings | null>(null);

  useEffect(() => { void window.conductor.dataControl.getSettings().then(setSettings).catch(() => {}); }, []);

  async function setAutoSync(value: boolean): Promise<void> {
    try { setSettings(await window.conductor.dataControl.setSettings({ syncEnabled: value })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not update sync setting'); }
  }

  const folders = connectors;
  const [account, setAccount] = useState<AccountKind | null>(null);

  return (
    <section aria-label="Indexed folders" className="flex flex-col gap-3">
      <header className="flex items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground"><DatabaseIcon size={15} className="text-muted-foreground" />Sources</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">Folders, email, calendars and Slack that Conductor indexes locally and attaches as task context.</p>
        </div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="outline" onClick={() => { setAccount('email'); }}><MailIcon size={13} />Email</Button>
          <Button size="sm" variant="outline" onClick={() => { setAccount('calendar'); }}><CalendarIcon size={13} />Calendar</Button>
          <Button size="sm" variant="outline" onClick={() => { setAccount('slack'); }}><MessageIcon size={13} />Slack</Button>
          <Button size="sm" variant="primary" onClick={() => { setAdding(true); }}><PlusIcon size={13} />Folder</Button>
        </div>
      </header>
      <div className="flex items-center justify-between gap-3 rounded-xl border border-border px-3.5 py-2.5">
        <div>
          <p className="text-xs font-medium text-foreground">Keep sources in sync</p>
          <p className="text-2xs text-muted-foreground">Re-index folders when files change, and every source every 15 minutes. Off: only “Sync now” updates the index.</p>
        </div>
        <Switch label="Keep sources in sync" checked={settings?.syncEnabled === true} disabled={settings === null} onChange={(value) => { void setAutoSync(value); }} />
      </div>
      {loadError !== null ? <p role="alert" className="text-xs text-destructive-foreground">{loadError}</p> : null}
      {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
      {loading ? <p role="status" className="text-xs text-muted-foreground">Loading connectors…</p> : folders.length === 0 ? (
        <EmptyState icon={<FolderIcon size={20} />} title="No sources yet" description="Add a folder, mailbox, calendar feed or Slack workspace to make it searchable and available as context.">
          <Button size="sm" variant="outline" onClick={() => { setAdding(true); }}><PlusIcon size={13} />Add folder</Button>
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-2">{folders.map((connector) => <ConnectorRow key={connector.id} connector={connector} onError={setError} />)}</ul>
      )}
      <AddFolderDialog open={adding} onClose={() => { setAdding(false); }} />
      <AddAccountDialog kind={account} onClose={() => { setAccount(null); }} />
    </section>
  );
}
