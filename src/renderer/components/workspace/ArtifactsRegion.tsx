import { useEffect, useRef, useState } from 'react';
import type { Task } from '@shared/domain';
import type { FileBytes } from '@shared/file-preview';
import type { ArtifactSummary, TaskDetails } from '@shared/task-view';
import { DownloadIcon, FileTextIcon } from '../ui/icons';
import { RegionCard } from './RegionCard';
import { ArtifactAction, ArtifactCard, ArtifactPanel } from '../chat/GeneratedArtifact';
import { DownloadButton, FileViewer, base64ToBlob, downloadUrl, formatBytes } from '../chat/FileViewer';

interface OpenFile extends FileBytes { url: string }

/** An output the agent produced, handed back in the chat as a file card:
 *  what it is, and on Open the file itself, rendered in the artifact panel. */
export function ArtifactRow({ taskId, artifact }: { taskId: string; artifact: ArtifactSummary }): React.JSX.Element {
  const [file, setFile] = useState<OpenFile | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const urlRef = useRef<string | null>(null);
  useEffect(() => () => { if (urlRef.current !== null) URL.revokeObjectURL(urlRef.current); }, []);
  async function load(): Promise<OpenFile | null> {
    if (file !== null) return file;
    setLoading(true);
    setError(null);
    try {
      const bytes = await window.conductor.task.artifactFile({ taskId, artifactId: artifact.id });
      const opened = { ...bytes, url: URL.createObjectURL(base64ToBlob(bytes.dataBase64, bytes.mimeType)) };
      urlRef.current = opened.url;
      setFile(opened);
      return opened;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open this file');
      return null;
    } finally { setLoading(false); }
  }
  async function toggle(): Promise<void> {
    if (expanded) { setExpanded(false); return; }
    if (await load() !== null) setExpanded(true);
  }
  async function save(): Promise<void> {
    const opened = await load();
    if (opened !== null) downloadUrl(opened.url, opened.fileName);
  }
  const name = artifact.name ?? 'Document';
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toUpperCase();
  const meta = `${extension !== undefined ? `${extension} file` : artifact.mimeType ?? 'Document'}${artifact.sizeBytes === undefined ? '' : `, ${formatBytes(artifact.sizeBytes)}`}`;
  return (
    <li>
      <ArtifactCard
        icon={<FileTextIcon size={17} />}
        title={name}
        meta={error !== null ? error : loading ? 'Opening…' : `${meta}. Click to open`}
        error={error !== null}
        busy={loading}
        open={expanded && file !== null}
        onOpen={() => { void toggle(); }}
        label={`${expanded ? 'Close' : 'Open'} ${name}`}
        action={<ArtifactAction label={`Download ${name}`} onClick={() => { void save(); }}><DownloadIcon size={15} /></ArtifactAction>}
      />
      {expanded && file !== null ? (
        <ArtifactPanel
          title={name}
          meta={<>{meta}, <time dateTime={artifact.createdAt}>{new Date(artifact.createdAt).toLocaleString()}</time></>}
          icon={<FileTextIcon size={14} />}
          onClose={() => { setExpanded(false); }}
          actions={<DownloadButton onClick={() => { downloadUrl(file.url, file.fileName); }} />}
        >
          <FileViewer fileName={file.fileName} mimeType={file.mimeType} dataBase64={file.dataBase64} url={file.url} cacheKey={`task:${taskId}:${artifact.id}`} onDownload={() => { downloadUrl(file.url, file.fileName); }} />
        </ArtifactPanel>
      ) : null}
    </li>
  );
}

/** Files the agent handed back on purpose (from its sandbox), as cards under its reply. */
export function DeliveredFiles({ taskId, artifacts }: { taskId: string; artifacts: readonly ArtifactSummary[] }): React.JSX.Element | null {
  const delivered = artifacts.filter((artifact) => artifact.delivered === true);
  if (delivered.length === 0) return null;
  return (
    <ul className="flex flex-col gap-2" aria-label="Files from the agent">
      {delivered.map((artifact) => <ArtifactRow key={artifact.id} taskId={taskId} artifact={artifact} />)}
    </ul>
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
