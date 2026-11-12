import { useState } from 'react';
import type { Task } from '@shared/domain';
import type { ArtifactPreview, ArtifactSummary, TaskDetails } from '@shared/task-view';
import { FileTextIcon } from '../ui/icons';
import { RegionCard } from './RegionCard';
import { ArtifactCard, ArtifactPanel, formatBytes } from '../chat/GeneratedArtifact';

/** An output the agent produced, handed back in the chat as a document
 *  card: what it is, when, and its contents on Open. */
export function ArtifactRow({ taskId, artifact }: { taskId: string; artifact: ArtifactSummary }): React.JSX.Element {
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
  const name = artifact.name ?? 'Document';
  const meta = `${artifact.mimeType ?? 'Document'}${artifact.sizeBytes === undefined ? '' : `, ${formatBytes(artifact.sizeBytes)}`}`;
  return (
    <li>
      <ArtifactCard
        icon={<FileTextIcon size={17} />}
        title={name}
        meta={error !== null ? error : loading ? 'Opening…' : `${meta}. Click to open`}
        error={error !== null}
        busy={loading}
        open={expanded && preview !== null}
        onOpen={() => { void inspect(); }}
        label={`${expanded ? 'Close' : 'Open'} ${name}`}
      />
      {expanded && preview !== null ? (
        <ArtifactPanel
          title={name}
          meta={<>{meta}, <time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString()}</time></>}
          icon={<FileTextIcon size={14} />}
          onClose={() => { setExpanded(false); }}
          actions={<CopyButton text={preview.text} />}
        >
          <pre className="rounded-xl border border-border bg-code px-4 py-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words text-foreground/85">{preview.text || '(Empty artifact)'}</pre>
          {preview.truncated ? <p className="mt-2 text-2xs text-muted-foreground">Preview truncated.</p> : null}
        </ArtifactPanel>
      ) : null}
    </li>
  );
}

function CopyButton({ text }: { text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => { void navigator.clipboard.writeText(text).then(() => { setCopied(true); window.setTimeout(() => { setCopied(false); }, 1500); }).catch(() => undefined); }}
      className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-border-strong bg-card px-2.5 text-xs font-medium text-foreground transition-colors hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
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
