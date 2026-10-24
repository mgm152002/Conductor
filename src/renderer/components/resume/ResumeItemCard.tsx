import { useState } from 'react';
import { useThreadNavigation } from '../../hooks/useThreadNavigation';
import type {
  ResumeAction,
  ResumeActResult,
  ResumeClassification,
  ResumeItem,
} from '@shared/domain';

// One reconciled task in the Resume Center. Presents the four actions —
// Resume, Inspect, Restart, Discard (Requirement 8.6) — and drives the
// confirmation flow for a consequential resume (8.7) and for a discard (8.8):
// the main process returns `confirmation_required` for those, which flips this
// card into an inline confirm step that re-issues the action with
// `confirmed: true`.

interface ResumeItemCardProps {
  item: ResumeItem;
  act: (input: {
    taskId: string;
    action: ResumeAction;
    confirmed?: boolean;
  }) => Promise<ResumeActResult>;
}

/** The action awaiting an explicit confirmation, with why it is needed. */
interface PendingConfirmation {
  action: Extract<ResumeAction, 'resume' | 'discard'>;
  reason: 'consequential' | 'discard';
}

const CLASSIFICATION_LABEL: Record<ResumeClassification, string> = {
  RESUMABLE: 'Resumable',
  RECOVERABLE_INTERRUPTION: 'Interrupted',
  BLOCKED: 'Blocked',
};

const CLASSIFICATION_STYLE: Record<ResumeClassification, string> = {
  RESUMABLE: 'text-success ',
  RECOVERABLE_INTERRUPTION: 'text-warning ',
  BLOCKED: 'text-destructive-foreground ',
};

function confirmPrompt(reason: 'consequential' | 'discard'): string {
  return reason === 'discard'
    ? 'Discard this task? This abandons it and cannot be undone. Artifacts already produced are kept.'
    : 'Resuming will re-execute a consequential action (a write, command, external message, or payment). Continue?';
}

export function ResumeItemCard({
  item,
  act,
}: ResumeItemCardProps): React.JSX.Element {
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<PendingConfirmation | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const { openThread } = useThreadNavigation();

  async function run(action: ResumeAction, confirmed: boolean): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await act({
        taskId: item.taskId,
        action,
        ...(confirmed ? { confirmed: true } : {}),
      });
      if (result.status === 'confirmation_required') {
        // The main process refused pending explicit confirmation. Flip the
        // card into the confirm step for this action.
        if (
          (action === 'resume' || action === 'discard') &&
          result.confirmationReason !== undefined
        ) {
          setPending({ action, reason: result.confirmationReason });
        }
        return;
      }
      setPending(null);
      if (action === 'inspect') {
        await openThread(await window.conductor.task.get(item.taskId));
      }
      if (result.status === 'applied') {
        setMessage(`${labelFor(action)} applied. Task is now ${result.state}.`);
      }
    } catch {
      // The hook surfaces the error at the Resume Center level; keep the card
      // interactive so the user can retry.
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium text-foreground">
            {item.objective}
          </span>
          <span className="text-xs text-muted-foreground">
            State: {item.state}
            {item.recommendedNextAction !== undefined
              ? ` · Next: ${item.recommendedNextAction}`
              : ''}
          </span>
        </div>
        <span
          className={`shrink-0 text-xs font-semibold ${CLASSIFICATION_STYLE[item.classification]}`}
        >
          {CLASSIFICATION_LABEL[item.classification]}
        </span>
      </div>

      {pending !== null ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-warning/30 bg-warning/6 p-3"
          role="alertdialog"
          aria-label={`Confirm ${pending.action}`}
        >
          <p className="text-xs text-foreground">
            {confirmPrompt(pending.reason)}
          </p>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                void run(pending.action, true);
              }}
              className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {pending.action === 'discard'
                ? 'Confirm discard'
                : 'Confirm resume'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPending(null);
              }}
              className="rounded-md border border-input px-3 py-1.5 text-xs font-medium text-foreground/80 transition-colors hover:bg-accent disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <ActionButton
            label="Resume"
            primary
            disabled={busy}
            onClick={() => {
              void run('resume', false);
            }}
          />
          <ActionButton
            label="Inspect"
            disabled={busy}
            onClick={() => {
              void run('inspect', false);
            }}
          />
          <ActionButton
            label="Restart"
            disabled={busy}
            onClick={() => {
              void run('restart', false);
            }}
          />
          <ActionButton
            label="Discard"
            destructive
            disabled={busy}
            onClick={() => {
              void run('discard', false);
            }}
          />
        </div>
      )}

      {message !== null ? (
        <p className="text-xs text-muted-foreground">{message}</p>
      ) : null}
    </div>
  );
}

function labelFor(action: ResumeAction): string {
  return action.charAt(0).toUpperCase() + action.slice(1);
}

interface ActionButtonProps {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  destructive?: boolean;
}

function ActionButton({
  label,
  onClick,
  disabled,
  primary,
  destructive,
}: ActionButtonProps): React.JSX.Element {
  const base =
    'rounded-md px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40';
  const variant = primary
    ? 'bg-primary text-primary-foreground hover:opacity-90   '
    : destructive
      ? 'border border-destructive/30 text-destructive-foreground hover:bg-destructive/10   '
      : 'border border-input text-foreground/80 hover:bg-accent   ';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled === true}
      className={`${base} ${variant}`}
    >
      {label}
    </button>
  );
}
