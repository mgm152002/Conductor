import type { Task } from '@shared/domain';
import type { TaskDetails } from '@shared/task-view';
import { cn } from '../../lib/cn';
import { CheckIcon, ClockIcon, XIcon } from '../ui/icons';
import { RegionCard } from './RegionCard';

// Per-criterion verification evidence. A criterion is only ever shown as
// passed or failed from a recorded result, never inferred from task state.
export function VerificationRegion({ task, details }: { task: Task | null; details: TaskDetails | null }): React.JSX.Element {
  const criteria = task?.acceptanceCriteria ?? [];
  const verification = details?.verification;
  const subtitle = verification == null ? 'No verification recorded' : !verification.finished ? 'Verification unfinished' : verification.verified ? 'Verified checkpoint' : 'Verification did not pass';
  return (
    <RegionCard title="Verification results" subtitle={subtitle} emptyLabel="No acceptance criteria have been specified." isEmpty={task === null}>
      {criteria.length === 0 ? <p className="text-xs text-muted-foreground">No acceptance criteria have been specified.</p> : (
        <ul className="flex flex-col gap-2">
          {criteria.map((criterion, index) => {
            const result = verification?.criteria.find((item) => item.index === index && item.criterion === criterion);
            const label = result === undefined ? 'Pending' : result.satisfied ? 'Passed' : 'Failed';
            return (
              <li key={`${index}:${criterion}`} className="rounded-lg border border-border px-2.5 py-2 text-xs">
                <div className="flex items-start gap-2">
                  <span className={cn('mt-px flex size-4 shrink-0 items-center justify-center rounded-full', result === undefined ? 'bg-accent text-muted-foreground' : result.satisfied ? 'bg-success/15 text-success' : 'bg-destructive/15 text-destructive')} aria-hidden="true">
                    {result === undefined ? <ClockIcon size={10} /> : result.satisfied ? <CheckIcon size={10} /> : <XIcon size={10} />}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-foreground break-words">{criterion}</span>
                  <span className={cn('shrink-0 text-2xs font-medium', result === undefined ? 'text-muted-foreground' : result.satisfied ? 'text-success' : 'text-destructive-foreground')}>{label}</span>
                </div>
                {result?.detail ? <p className="mt-1 ml-6 text-2xs whitespace-pre-wrap text-muted-foreground">{result.detail}</p> : null}
              </li>
            );
          })}
        </ul>
      )}
      {verification != null ? <p className="mt-3 text-3xs break-all text-muted-foreground/80">Checkpoint: {verification.checkpointId}{verification.verifiedAt ? <> · <time dateTime={verification.verifiedAt}>{new Date(verification.verifiedAt).toLocaleString()}</time></> : null}</p> : null}
    </RegionCard>
  );
}
