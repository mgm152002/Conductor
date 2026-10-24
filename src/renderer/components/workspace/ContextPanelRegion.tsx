import { useEffect, useState } from 'react';
import type { Task } from '@shared/domain';
import { useWorkspaceStore } from '../../stores';
import { BrainIcon, FileTextIcon } from '../ui/icons';
import { RegionCard } from './RegionCard';

interface ResolvedRef {
  id: string;
  kind: 'memory' | 'context' | 'missing';
  title: string;
  ingested: boolean;
  veracity?: string;
}

const MAX_RESOLVED = 40;

function titleOf(content: string): string {
  const first = content.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
  return first.length > 90 ? `${first.slice(0, 87)}…` : first;
}

async function resolveRef(id: string): Promise<ResolvedRef> {
  try {
    const { memory } = await window.conductor.memory.inspect(id);
    return { id, kind: 'memory', title: titleOf(memory.content), ingested: memory.provenance.method === 'ingested', veracity: memory.veracity };
  } catch { /* not a memory */ }
  try {
    const item = await window.conductor.context.inspect(id);
    return { id, kind: 'context', title: titleOf(item.content), ingested: false, veracity: item.veracity };
  } catch { /* deleted since the task loaded it */ }
  return { id, kind: 'missing', title: id, ingested: false };
}

/** The project and the context references loaded into the task, resolved to readable titles. */
export function ContextPanelRegion({ task }: { task: Task | null }): React.JSX.Element {
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = workspaces.find((item) => item.id === (task?.workspaceId ?? activeWorkspaceId));
  const refs = task?.contextRefs ?? [];
  const refsKey = refs.join(',');
  const [resolved, setResolved] = useState<ResolvedRef[]>([]);

  useEffect(() => {
    let active = true;
    if (refs.length === 0) { setResolved([]); return; }
    void Promise.all(refs.slice(0, MAX_RESOLVED).map(resolveRef)).then((list) => { if (active) setResolved(list); });
    return () => { active = false; };
  }, [refsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <RegionCard title="Context" emptyLabel="Select a workspace to establish context." isEmpty={workspace === undefined && task === null}>
      <dl className="flex flex-col gap-4 text-xs">
        <div>
          <dt className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">Workspace</dt>
          <dd className="mt-1 text-foreground">{workspace?.name ?? task?.workspaceId ?? 'None selected'}</dd>
          {workspace ? <dd className="mt-0.5 font-mono text-3xs break-all text-muted-foreground">{workspace.rootPath}</dd> : null}
        </div>
        {task !== null ? (
          <>
            <div>
              <dt className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">Task</dt>
              <dd className="mt-1 font-mono text-3xs break-all text-muted-foreground">{task.id}</dd>
            </div>
            <div>
              <dt className="text-3xs font-medium tracking-wide text-muted-foreground uppercase">Input context references</dt>
              <dd className="mt-1.5">
                {refs.length === 0 ? <span className="text-muted-foreground">No references loaded yet.</span> : (
                  <ul className="flex flex-col gap-1">
                    {(resolved.length > 0 ? resolved : refs.slice(0, MAX_RESOLVED).map((id): ResolvedRef => ({ id, kind: 'missing', title: id, ingested: false }))).map((ref, index) => (
                      <li key={`${index}:${ref.id}`} className="flex items-start gap-1.5 rounded-md px-1.5 py-1 hover:bg-accent" title={ref.id}>
                        {ref.ingested ? <FileTextIcon size={12} className="mt-0.5 shrink-0 text-muted-foreground" /> : <BrainIcon size={12} className="mt-0.5 shrink-0 text-muted-foreground" />}
                        <span className={ref.kind === 'missing' ? 'min-w-0 flex-1 font-mono text-3xs break-all text-muted-foreground' : 'min-w-0 flex-1 break-words text-foreground/90'}>{ref.title}</span>
                        {ref.veracity !== undefined ? <span className="shrink-0 text-3xs text-muted-foreground">{ref.ingested ? 'file' : ref.veracity.replace(/_/g, ' ')}</span> : null}
                      </li>
                    ))}
                    {refs.length > MAX_RESOLVED ? <li className="px-1.5 text-3xs text-muted-foreground">+{refs.length - MAX_RESOLVED} more</li> : null}
                  </ul>
                )}
              </dd>
            </div>
          </>
        ) : null}
      </dl>
    </RegionCard>
  );
}
