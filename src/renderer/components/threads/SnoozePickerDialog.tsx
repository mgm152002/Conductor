import { useState } from 'react';
import {
  SNOOZE_PRESETS, customSnoozeUntil, snoozePresetUntil, type SnoozePresetId,
} from '../../lib/thread-tiers';
import { cn } from '../../lib/cn';
import { Button, Dialog, inputClassName } from '../ui/primitives';
import { ClockIcon } from '../ui/icons';

// Lets the user choose when a snoozed thread wakes up: a preset duration, a
// custom date/time, or no timer at all. Confirming hands the ISO wake time
// (or undefined for "until I wake it") to `onSnooze`.

function toLocalInputValue(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function SnoozePickerDialog({ open, onClose, onSnooze }: {
  open: boolean;
  onClose: () => void;
  /** `until` is an ISO-8601 wake time, or undefined to snooze indefinitely. */
  onSnooze: (until: string | undefined) => void;
}): React.JSX.Element {
  const [preset, setPreset] = useState<SnoozePresetId>('tomorrow');
  const [custom, setCustom] = useState('');
  const [error, setError] = useState<string | null>(null);
  const useCustom = custom !== '';

  const confirm = (): void => {
    if (useCustom) {
      const until = customSnoozeUntil(custom);
      if (until === null) { setError('Pick a wake time in the future.'); return; }
      onSnooze(until);
    } else {
      onSnooze(snoozePresetUntil(preset));
    }
    onClose();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Snooze thread"
      footer={<>
        <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
        <Button size="md" variant="primary" onClick={confirm}><ClockIcon size={13} /> Snooze</Button>
      </>}
    >
      <div role="radiogroup" aria-label="Snooze duration" className="flex flex-col gap-1">
        {SNOOZE_PRESETS.map((option) => {
          const selected = !useCustom && preset === option.id;
          return (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => { setPreset(option.id); setCustom(''); setError(null); }}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring',
                selected ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
              )}
            >
              <span aria-hidden="true" className={cn('size-2 shrink-0 rounded-full', selected ? 'bg-primary' : 'bg-border')} />
              <span className="flex-1 text-[13px] font-medium">{option.label}</span>
              <span className="text-2xs">{option.hint}</span>
            </button>
          );
        })}
      </div>
      <label className="mt-4 flex flex-col gap-1.5">
        <span className="text-xs font-medium text-foreground">Or pick a custom wake time</span>
        <input
          type="datetime-local"
          aria-label="Custom wake time"
          className={inputClassName}
          min={toLocalInputValue(new Date())}
          value={custom}
          onChange={(event) => { setCustom(event.target.value); setError(null); }}
        />
      </label>
      {useCustom ? <p className="mt-1.5 text-2xs text-muted-foreground">Wakes {new Date(custom).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</p> : null}
      {error !== null ? <p role="alert" className="mt-2 text-xs text-destructive-foreground">{error}</p> : null}
    </Dialog>
  );
}
