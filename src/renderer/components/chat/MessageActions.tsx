import { useEffect, useState } from 'react';
import { cn } from '../../lib/cn';
import { CheckIcon, CopyIcon, ForkIcon } from '../ui/icons';

// The quiet row under a message that appears on hover: copy, fork from here,
// and the time. The parent marks the hover area with the `group/msg` class.

function ActionButton({ label, onClick, disabled = false, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="flex size-7 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-not-allowed disabled:opacity-40"
    >
      {children}
    </button>
  );
}

export function MessageActions({ text, at, onFork, forkLabel = 'Fork from here', align = 'start', className }: {
  /** What Copy puts on the clipboard; no Copy button when empty. */
  text?: string | undefined;
  /** When the message was sent (ISO). */
  at?: string | undefined;
  /** Starts a new conversation from this message; no Fork button when absent. */
  onFork?: (() => void) | undefined;
  forkLabel?: string;
  align?: 'start' | 'end';
  className?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => { setCopied(false); }, 1500);
    return () => { window.clearTimeout(timer); };
  }, [copied]);
  const copy = (): void => {
    if (text === undefined || text === '') return;
    void navigator.clipboard.writeText(text).then(() => { setCopied(true); }).catch(() => undefined);
  };
  const time = at !== undefined && Number.isFinite(Date.parse(at))
    ? new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : undefined;
  return (
    <div
      className={cn(
        'flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover/msg:opacity-100 focus-within:opacity-100',
        align === 'end' && 'justify-end',
        className,
      )}
    >
      {text !== undefined && text !== '' ? (
        <ActionButton label={copied ? 'Copied' : 'Copy'} onClick={copy}>
          {copied ? <CheckIcon size={14} className="text-success" /> : <CopyIcon size={14} />}
        </ActionButton>
      ) : null}
      {onFork !== undefined ? <ActionButton label={forkLabel} onClick={onFork}><ForkIcon size={14} /></ActionButton> : null}
      {time !== undefined ? <time dateTime={at} className="px-1.5 text-xs text-muted-foreground tabular-nums">{time}</time> : null}
    </div>
  );
}
