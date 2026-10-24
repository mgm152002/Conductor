import { useState } from 'react';
import type { Task } from '@shared/domain';
import type { ArtifactPreview, ArtifactSummary, TaskDetails } from '@shared/task-view';
import { FileTextIcon } from '../ui/icons';
import { RegionCard } from './RegionCard';

function ArtifactRow({ taskId, artifact }: { taskId: string; artifact: ArtifactSummary }): React.JSX.Element {
  const [preview, setPreview] = useState<ArtifactPreview | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function inspect(): Promise<void> {
    if (expanded) { setExpanded(false); return; }
    setExpanded(true);
    if (preview !== null) return;
    setLoading(true);
    setError(null);
    try { setPreview(await window.conductor.task.readArtifact({ taskId, artifactId: artifact.id })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not read artifact'); }
    finally { setLoading(false); }
  }
  return (
    <li className="rounded-lg border border-border">
      <div className="flex items-start gap-2 px-2.5 py-2">
        <FileTextIcon size={14} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium break-all text-foreground">{artifact.name ?? artifact.id}</p>
          <p className="mt-0.5 text-3xs text-muted-foreground">{artifact.mimeType ?? 'Stored output'}{artifact.sizeBytes === undefined ? '' : ` · ${artifact.sizeBytes.toLocaleString()} bytes`} · <time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString()}</time></p>
        </div>
        <button type="button" onClick={() => { void inspect(); }} disabled={loading} aria-expanded={expanded} className="shrink-0 cursor-pointer text-2xs font-medium text-primary hover:underline disabled:opacity-50">{loading ? 'Loading preview…' : expanded ? 'Hide preview' : 'Inspect output'}</button>
      </div>
      {expanded && error !== null ? <p role="alert" className="px-2.5 pb-2 text-2xs text-destructive-foreground">{error}</p> : null}
      {expanded && preview !== null ? (
        <div className="border-t border-border">
          <pre className="max-h-72 overflow-auto bg-code px-2.5 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{preview.text || '(Empty artifact)'}</pre>
          {preview.truncated ? <p className="px-2.5 py-1 text-3xs text-muted-foreground">Preview truncated.</p> : null}
        </div>
      ) : null}
    </li>
  );
}

export function ArtifactsRegion({ task, details }: { task: Task | null; details: TaskDetails | null }): React.JSX.Element {
  const artifacts = details?.artifacts ?? [];
  return (
    <RegionCard title="Artifacts" count={artifacts.length} emptyLabel="No outputs have been recorded for this task yet." isEmpty={artifacts.length === 0}>
      <ul className="flex flex-col gap-2">{task !== null ? artifacts.map((artifact) => <ArtifactRow key={`${task.id}:${artifact.id}`} taskId={task.id} artifact={artifact} />) : null}</ul>
    </RegionCard>
  );
}
