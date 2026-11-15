import { useEffect, useMemo } from 'react';
import type { Task } from '@shared/domain';
import type { SandboxAgent } from '@shared/sandbox-agents';
import { useTaskDetails } from '../../hooks/useTaskDetails';
import { betweenTurnHandoff, buildTimeline, latestActivity, turnRun, type TurnRun } from '../../lib/timeline';
import { agentLabel } from '../../lib/usage-format';
import { isWorkingState } from '../../lib/thread-status';
import { relativeTime } from '../../lib/time';
import { MessagesTimeline } from '../chat/MessagesTimeline';
import { DeliveredFiles } from '../workspace/ArtifactsRegion';
import { PendingApprovalPanel } from '../chat/PendingApprovalPanel';
import { AgentAvatar, type AgentMood } from '../ui/AgentAvatar';
import { Alert } from '../ui/primitives';
import { Spinner } from '../ui/icons';

// One agent's answer in a chat: its avatar and name, then what it did and
// said (the same timeline Work threads use), its approval requests inline,
// and a clear warning when its sandbox could not start.

const CAPACITY = /^Can’t start another agent sandbox/;

export function moodFor(task: Task, waiting: boolean): AgentMood {
  if (waiting || task.state === 'WAITING_FOR_APPROVAL') return 'waiting';
  if (isWorkingState(task.state)) return 'working';
  if (task.state === 'COMPLETED') return 'done';
  if (task.state === 'FAILED' || task.state === 'BLOCKED' || task.state === 'RECOVERABLE_INTERRUPTION') return 'error';
  return 'idle';
}

export function AgentReply({ agent, task, onText, previousRun, onRun }: {
  agent: SandboxAgent;
  task: Task;
  /** The CLI/model the previous turn ran with, to show a switch. */
  previousRun?: TurnRun | undefined;
  /** Reports the CLI/model this turn ran with, for the next turn's comparison. */
  onRun?: ((taskId: string, run: TurnRun) => void) | undefined;
  /** The reply's text once known, for group context. */
  onText?: (taskId: string, text: string) => void;
}): React.JSX.Element {
  const { details } = useTaskDetails(task);
  const live = isWorkingState(task.state);
  const ownRun = useMemo(() => turnRun(details), [details]);
  useEffect(() => { if (ownRun !== undefined) onRun?.(task.id, ownRun); }, [ownRun, onRun, task.id]);
  const items = useMemo(() => {
    if (details === null) return [];
    const built = buildTimeline(task, details);
    // Switching CLI or model between messages shows a divider before the reply.
    const handoff = betweenTurnHandoff(`handoff:${task.id}`, previousRun, ownRun, agentLabel, built, task.createdAt);
    return [...(handoff === null ? [] : [handoff]), ...built.filter((item) => item.kind !== 'user')];
  }, [task, details, previousRun, ownRun]);
  const reply = useMemo(() => items.filter((item) => item.kind === 'assistant').map((item) => item.text).join('\n\n').trim(), [items]);
  const capacity = useMemo(() => {
    for (const item of items) {
      if (item.kind !== 'work') continue;
      const hit = item.entries.find((entry) => CAPACITY.test(entry.label));
      if (hit !== undefined) return hit.label;
    }
    return undefined;
  }, [items]);
  useEffect(() => { if (reply !== '' && !live) onText?.(task.id, reply); }, [reply, live, onText, task.id]);
  const current = live ? latestActivity(items) : undefined;
  const visible = capacity !== undefined ? items.filter((item) => item.kind !== 'work' || !item.entries.some((entry) => CAPACITY.test(entry.label))) : items;

  return (
    <div className="flex gap-3">
      <AgentAvatar agent={agent} size={32} mood={moodFor(task, false)} className="mt-0.5" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 flex items-baseline gap-2 text-xs">
          <span className="font-semibold text-foreground">{agent.name}</span>
          <time dateTime={task.updatedAt} className="text-3xs text-muted-foreground">{relativeTime(task.updatedAt)}</time>
        </p>
        {capacity !== undefined ? <div className="mb-2"><Alert tone="warning">{capacity}</Alert></div> : null}
        {visible.length > 0 ? <MessagesTimeline items={visible} live={live} /> : null}
        {details !== null ? <div className="mt-3 empty:hidden"><DeliveredFiles taskId={task.id} artifacts={details.artifacts} /></div> : null}
        {live ? (
          <p role="status" className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size={11} />
            <span className="truncate">{current?.label ?? 'Thinking'}…</span>
          </p>
        ) : null}
        {!live && visible.length === 0 && capacity === undefined && details !== null && !details.artifacts.some((artifact) => artifact.delivered === true) ? <p className="text-xs text-muted-foreground">No reply.</p> : null}
        <div className="mt-2 empty:hidden"><PendingApprovalPanel task={task} /></div>
      </div>
    </div>
  );
}
