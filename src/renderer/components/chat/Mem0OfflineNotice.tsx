import { useMem0Health } from '../../hooks/useMem0Health';

// A small, non-blocking banner shown above the composer when the Mem0 memory
// service is unreachable, so the user knows replies won't use remembered
// context. Shared by casual Chat and project Work. It renders nothing while
// the first health check is pending or when Mem0 is reachable.

export function Mem0OfflineNotice({ className }: { className?: string }): React.JSX.Element | null {
  const mem0 = useMem0Health();
  if (!mem0 || mem0.reachable) return null;
  return (
    <p role="status" title={`Replies won’t use remembered details. ${mem0.detail ?? 'The memory service is unreachable.'}`} className={className ?? 'composer-glass mx-auto mb-2 flex w-fit max-w-(--chat-max) items-center gap-1.5 rounded-full px-2.5 py-1 text-2xs text-muted-foreground'}>
      <span aria-hidden className="inline-block size-1.5 shrink-0 rounded-full bg-destructive-foreground" />
      <span>Memory offline</span>
    </p>
  );
}
