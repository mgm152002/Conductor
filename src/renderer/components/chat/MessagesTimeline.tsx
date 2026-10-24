import { useState } from 'react';
import type { TimelineItem, WorkEntry } from '../../lib/timeline';
import { cn } from '../../lib/cn';
import { Markdown } from './Markdown';
import {
  ActivityIcon, AlertCircleIcon, CheckIcon, ChevronRightIcon, FileTextIcon, ListChecksIcon, PlayIcon,
  SearchIcon, ShieldIcon, SparklesIcon, Spinner, TerminalIcon, XIcon,
} from '../ui/icons';
import { AttachmentTray } from '../attachments';

// Renders the chat timeline built by lib/timeline: right-aligned user bubble,
// collapsible "work log" groups, assistant prose, errors, and diagnostics.

const ICONS: Record<WorkEntry['icon'], (p: { size?: number; className?: string }) => React.JSX.Element> = {
  terminal: TerminalIcon,
  file: FileTextIcon,
  thinking: SparklesIcon,
  tool: PlayIcon,
  search: SearchIcon,
  plan: ListChecksIcon,
  state: ActivityIcon,
  artifact: FileTextIcon,
  approval: ShieldIcon,
};

function UserMessage({ item }: { item: Extract<TimelineItem, { kind: 'user' }> }): React.JSX.Element {
  const checks = item.criteria.filter((criterion) => criterion !== 'response: nonempty');
  return (
    <div className="group flex flex-col items-end gap-1">
      <div className="relative max-w-[80%] min-w-0 rounded-2xl bg-message p-3 text-message-foreground">
        <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{item.text}</p>
        {item.attachments.length > 0 ? (
          <div className="mt-3">
            <AttachmentTray attachments={item.attachments} />
          </div>
        ) : null}
        {checks.length > 0 ? (
          <ul className="mt-2 flex flex-wrap gap-1" aria-label="Acceptance criteria">
            {checks.map((criterion, index) => (
              <li key={`${index}:${criterion}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-background/60 px-2 py-0.5 text-3xs text-muted-foreground">
                <ListChecksIcon size={10} />
                <span className="truncate">{criterion}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <time dateTime={item.at} className="pe-1 text-3xs text-muted-foreground/70 opacity-0 transition-opacity group-hover:opacity-100">
        {new Date(item.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
      </time>
    </div>
  );
}

function WorkRow({ entry }: { entry: WorkEntry }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const Icon = ICONS[entry.icon];
  const expandable = entry.detail !== undefined && entry.detail !== '';
  const toneIcon = entry.tone === 'running'
    ? <Spinner size={12} className="text-info" />
    : entry.tone === 'error'
      ? <XIcon size={12} className="text-destructive" />
      : entry.tone === 'success' && entry.icon === 'terminal'
        ? <CheckIcon size={12} className="text-success" />
        : null;
  const content = (
    <>
      <Icon size={14} className="shrink-0 text-muted-foreground" />
      <span className={cn('min-w-0 flex-1 truncate text-left', entry.icon === 'terminal' ? 'font-mono text-xs' : 'text-[13px]', entry.tone === 'error' ? 'text-destructive-foreground' : 'text-foreground/80')}>{entry.label}</span>
      {toneIcon}
      {expandable ? <ChevronRightIcon size={12} className={cn('shrink-0 text-muted-foreground transition-transform', open && 'rotate-90')} /> : null}
    </>
  );
  return (
    <li>
      {expandable ? (
        <button type="button" onClick={() => { setOpen((v) => !v); }} aria-expanded={open} className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          {content}
        </button>
      ) : (
        <div className="flex h-7 items-center gap-2 px-2">{content}</div>
      )}
      {open && expandable ? (
        <pre className="mx-2 mt-1 mb-2 max-h-72 overflow-auto rounded-lg border border-border bg-code px-3 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{entry.detail}</pre>
      ) : null}
    </li>
  );
}

function WorkGroup({ item, live }: { item: Extract<TimelineItem, { kind: 'work' }>; live: boolean }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const entries = item.entries;
  const commands = entries.filter((e) => e.icon === 'terminal').length;
  const files = entries.filter((e) => e.icon === 'file').length;
  const summaryParts = [
    commands > 0 ? `${commands} command${commands === 1 ? '' : 's'}` : null,
    files > 0 ? `${files} file change${files === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  const last = [...entries].reverse().find((e) => e.notice !== true) ?? entries[entries.length - 1]!;
  // Short groups and the live group stay expanded, like T3 Code's work log.
  const expanded = open || live || entries.length <= 3;
  return (
    <div className="rounded-xl border border-border/70 bg-muted/40">
      {entries.length > 3 && !live ? (
        <button type="button" onClick={() => { setOpen((v) => !v); }} aria-expanded={expanded} className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-xl px-2.5 text-left text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
          <ChevronRightIcon size={12} className={cn('transition-transform', expanded && 'rotate-90')} />
          <span className="shrink-0 font-medium whitespace-nowrap">Work log</span>
          <span className="shrink-0 whitespace-nowrap text-muted-foreground/70">· {entries.length} steps{summaryParts.length > 0 ? ` · ${summaryParts.join(', ')}` : ''}</span>
          {!expanded ? <span className="ml-auto min-w-0 truncate text-muted-foreground/70">{last.label}</span> : null}
        </button>
      ) : null}
      {expanded ? <ul className="flex flex-col py-1">{entries.map((entry) => <WorkRow key={entry.id} entry={entry} />)}</ul> : null}
    </div>
  );
}

function Diagnostics({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const lines = text.split('\n').length;
  return (
    <div className="rounded-xl border border-border/70">
      <button type="button" onClick={() => { setOpen((v) => !v); }} aria-expanded={open} className="flex h-8 w-full cursor-pointer items-center gap-2 px-2.5 text-left text-xs text-muted-foreground hover:text-foreground">
        <ChevronRightIcon size={12} className={cn('transition-transform', open && 'rotate-90')} />
        <TerminalIcon size={13} />
        <span>Agent diagnostics (stderr)</span>
        <span className="text-muted-foreground/70">· {lines} line{lines === 1 ? '' : 's'}</span>
      </button>
      {open ? <pre className="mx-2.5 mb-2.5 max-h-80 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-words text-muted-foreground">{text}</pre> : null}
    </div>
  );
}

export function MessagesTimeline({ items, live }: { items: TimelineItem[]; live: boolean }): React.JSX.Element {
  const lastWorkIndex = items.map((i) => i.kind).lastIndexOf('work');
  return (
    <ol className="flex flex-col gap-5" aria-live="polite" aria-relevant="additions text" aria-label="Conversation">
      {items.map((item, index) => (
        <li key={item.id}>
          {item.kind === 'user' ? <UserMessage item={item} /> : null}
          {item.kind === 'work' ? <WorkGroup item={item} live={live && index === lastWorkIndex && index === items.length - 1} /> : null}
          {item.kind === 'notice' ? (
            <div role="status" className="flex items-start gap-2 rounded-xl border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
              <SparklesIcon size={13} className="mt-0.5 shrink-0 text-primary" />
              <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{item.text}</p>
            </div>
          ) : null}
          {item.kind === 'assistant' ? <div className="px-1"><Markdown text={item.text} /></div> : null}
          {item.kind === 'error' && item.stale === true ? (
            <div className="flex items-start gap-2 rounded-xl border border-border px-3 py-2 text-xs text-muted-foreground">
              <AlertCircleIcon size={13} className="mt-0.5 shrink-0" />
              <p className="min-w-0 flex-1 break-words whitespace-pre-wrap"><span className="font-medium">Earlier attempt:</span> {item.text}</p>
            </div>
          ) : item.kind === 'error' ? (
            <div role="alert" className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/6 px-3 py-2 text-[13px] text-destructive-foreground">
              <AlertCircleIcon size={15} className="mt-0.5 shrink-0" />
              <p className="min-w-0 flex-1 break-words whitespace-pre-wrap">{item.text}</p>
            </div>
          ) : null}
          {item.kind === 'diagnostics' ? <Diagnostics text={item.text} /> : null}
        </li>
      ))}
    </ol>
  );
}
