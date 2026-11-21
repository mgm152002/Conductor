import { useEffect, useState } from 'react';
import { BROWSER_PREFERENCE_KEY, isBrowserPreference, type BrowserPreference } from '@shared/sandbox-agents';
import { cn } from '../../lib/cn';

const OPTIONS: Array<{ id: BrowserPreference; label: string; hint: string }> = [
  { id: 'cloud', label: 'Cloud', hint: 'Agents with a cloud browser run on it alone. No sandbox starts, so no Docker memory is used; they have no terminal or files, but can upload attached files to forms.' },
  { id: 'both', label: 'Both', hint: 'Agents keep their sandbox (terminal, files) and also get the cloud browser, which they use first.' },
  { id: 'sandbox', label: 'Sandbox', hint: 'Agents always use the sandbox and its browser; cloud browsers are ignored.' },
];

/** Which browser agents and flows use when a cloud browser is set up for them. */
export function BrowserSettings(): React.JSX.Element {
  const [value, setValue] = useState<BrowserPreference>('cloud');
  useEffect(() => {
    window.conductor.settings.get(BROWSER_PREFERENCE_KEY).then((saved) => { if (isBrowserPreference(saved)) setValue(saved); }).catch(() => undefined);
  }, []);
  const choose = (next: BrowserPreference): void => {
    setValue(next);
    void window.conductor.settings.set({ key: BROWSER_PREFERENCE_KEY, value: next, scope: 'global' }).catch(() => undefined);
  };
  const current = OPTIONS.find((option) => option.id === value)!;
  return (
    <div className="group-row">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-foreground">Preferred browser</p>
        <p className="text-2xs text-muted-foreground">{current.hint}</p>
      </div>
      <span className="seg-control" role="radiogroup" aria-label="Preferred browser">
        {OPTIONS.map((option) => (
          <button key={option.id} type="button" role="radio" aria-checked={value === option.id} data-active={value === option.id ? 'true' : undefined}
            className={cn('seg-item cursor-pointer')} onClick={() => { choose(option.id); }}>{option.label}</button>
        ))}
      </span>
    </div>
  );
}
