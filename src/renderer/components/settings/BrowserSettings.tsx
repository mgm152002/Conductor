import { useEffect, useState } from 'react';
import type { ChromeProfile, DeviceChromeStatus } from '@shared/integrations-contract';
import { BROWSER_PREFERENCE_KEY, DEVICE_CHROME_PROFILE_KEY, DEVICE_CHROME_VISIBLE_KEY, browserPreferenceOf, type BrowserPreference } from '@shared/sandbox-agents';
import { cn } from '../../lib/cn';
import { Button } from '../ui/primitives';
import { MenuSelect } from '../ui/MenuSelect';

const OPTIONS: Array<{ id: BrowserPreference; label: string; hint: string }> = [
  { id: 'device', label: 'This Mac', hint: 'Agents browse in Conductor’s own Chrome on this Mac: a separate profile that runs hidden (or in the background), so your own windows are never touched. The sandbox starts only when an agent needs its terminal or files.' },
  { id: 'current', label: 'Current browser', hint: 'Agents work in tabs of the Chrome you already have open, with your own logins and no copying. In Chrome, open chrome://inspect/#remote-debugging and turn on “Allow remote debugging for this browser instance”. Agents open their own windows; close them any time. Until that is on, agents use Conductor’s own Chrome instead.' },
  { id: 'sandbox', label: 'Sandbox', hint: 'Agents browse inside their sandbox, which starts with every run. Chrome on this Mac is not used.' },
];

function Segmented<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: Array<{ id: T; label: string }>; onChange: (next: T) => void }): React.JSX.Element {
  return (
    <span className="seg-control" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button key={option.id} type="button" role="radio" aria-checked={value === option.id} data-active={value === option.id ? 'true' : undefined}
          className={cn('seg-item cursor-pointer')} onClick={() => { onChange(option.id); }}>{option.label}</button>
      ))}
    </span>
  );
}

/** Which browser agents and flows use, and how Conductor's own Chrome behaves. */
export function BrowserSettings(): React.JSX.Element {
  const [value, setValue] = useState<BrowserPreference>('sandbox');
  const [visible, setVisible] = useState(false);
  const [chrome, setChrome] = useState<DeviceChromeStatus | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [profiles, setProfiles] = useState<{ list: ChromeProfile[]; error?: string } | undefined>(undefined);
  const [profile, setProfile] = useState('auto');
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    window.conductor.settings.get(BROWSER_PREFERENCE_KEY).then((saved) => { setValue(browserPreferenceOf(saved)); }).catch(() => undefined);
    window.conductor.settings.get(DEVICE_CHROME_VISIBLE_KEY).then((saved) => { setVisible(saved === true); }).catch(() => undefined);
    window.conductor.deviceChrome.status().then(setChrome).catch(() => undefined);
    window.conductor.settings.get(DEVICE_CHROME_PROFILE_KEY).then((saved) => { if (typeof saved === 'string' && saved !== '') setProfile(saved); }).catch(() => undefined);
  }, []);
  useEffect(() => {
    if (value !== 'device' || profiles !== undefined) return;
    window.conductor.deviceChrome.profiles().then((out) => { setProfiles({ list: out.profiles, ...(out.error !== undefined ? { error: out.error } : {}) }); }).catch(() => undefined);
  }, [value, profiles]);

  const message = (err: unknown, fallback: string): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : fallback);
  /** Copy the chosen profile's logins now (also after picking another profile). */
  const copy = async (): Promise<void> => {
    setCopying(true);
    setError(undefined);
    try { setChrome(await window.conductor.deviceChrome.refresh()); } catch (err) { setError(message(err, 'The profile could not be copied.')); }
    finally { setCopying(false); }
  };
  const chooseProfile = (next: string): void => {
    setProfile(next);
    void window.conductor.settings.set({ key: DEVICE_CHROME_PROFILE_KEY, value: next, scope: 'global' }).then(copy).catch(() => undefined);
  };
  const auto = profiles?.list.find((item) => item.picture) ?? profiles?.list.find((item) => item.email !== undefined) ?? profiles?.list[0];

  const choose = (next: BrowserPreference): void => {
    setValue(next);
    void window.conductor.settings.set({ key: BROWSER_PREFERENCE_KEY, value: next, scope: 'global' }).catch(() => undefined);
  };
  const chooseVisible = (next: boolean): void => {
    setVisible(next);
    void window.conductor.settings.set({ key: DEVICE_CHROME_VISIBLE_KEY, value: next, scope: 'global' }).catch(() => undefined);
  };
  const show = async (): Promise<void> => {
    setOpening(true);
    setError(undefined);
    try { await window.conductor.deviceChrome.show(); } catch (err) { setError(message(err, 'Chrome could not open.')); }
    finally { setOpening(false); }
  };

  const current = OPTIONS.find((option) => option.id === value)!;
  const missing = (value === 'device' || value === 'current') && chrome !== undefined && !chrome.available;
  return (
    <>
      <div className="group-row">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">Agents browse with</p>
          <p className="text-xs text-muted-foreground">{current.hint}</p>
          {missing ? <p className="mt-1 text-xs text-destructive">Google Chrome isn’t installed, so agents will use the sandbox browser until it is.</p> : null}
        </div>
        <Segmented label="Agents browse with" value={value} options={OPTIONS} onChange={choose} />
      </div>
      {value === 'device' ? (
        <>
          <div className="group-row">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Chrome profile</p>
              <p className="text-xs text-muted-foreground">
                Agents start from a private copy of this profile, so they are signed in where you are. Your own Chrome is never touched, and their browsing is not synced to your Google account.
                {chrome?.profile !== undefined ? ` Copied ${new Date(chrome.profile.copiedAt).toLocaleString()}.` : ''}
              </p>
              {profiles?.error !== undefined ? <p className="mt-1 text-xs text-destructive">{profiles.error}</p> : null}
              {chrome?.profileError !== undefined ? <p className="mt-1 text-xs text-destructive">{chrome.profileError}</p> : null}
            </div>
            <div className="flex shrink-0 items-center gap-2">
              <MenuSelect variant="box" label="Chrome profile" value={profile} disabled={copying} className="max-w-[260px]" onChange={chooseProfile}
                options={[
                  { value: 'auto', label: auto !== undefined ? `Automatic (${auto.name}${auto.email !== undefined ? ` · ${auto.email}` : ''})` : 'Automatic' },
                  ...(profiles?.list ?? []).map((item) => ({ value: item.dir, label: `${item.name}${item.email !== undefined ? ` · ${item.email}` : ''}` })),
                ]} />
              <Button size="sm" variant="outline" disabled={copying || chrome?.available === false} onClick={() => { void copy(); }}>{copying ? 'Copying…' : 'Refresh logins'}</Button>
            </div>
          </div>
          <div className="group-row">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Chrome window</p>
              <p className="text-xs text-muted-foreground">
                {visible ? 'Opens behind your windows without taking focus, so you can glance at what agents do.' : 'Runs with no window at all. Agents still keep the sites you signed into.'}
              </p>
            </div>
            <Segmented label="Chrome window" value={visible ? 'shown' : 'hidden'} options={[{ id: 'hidden', label: 'Hidden' }, { id: 'shown', label: 'In background' }]} onChange={(next) => { chooseVisible(next === 'shown'); }} />
          </div>
          <div className="group-row">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-foreground">Sign in to sites</p>
              <p className="text-xs text-muted-foreground">
                Opens the agents’ Chrome so you can log in to a site they need that your profile isn’t signed into. Logins made there are kept until you refresh from your profile.
              </p>
              {error !== undefined ? <p className="mt-1 text-xs text-destructive">{error}</p> : null}
            </div>
            <Button size="sm" variant="outline" disabled={opening || chrome?.available === false} onClick={() => { void show(); }}>
              {opening ? 'Opening…' : `Open ${chrome?.browser ?? 'Chrome'}`}
            </Button>
          </div>
        </>
      ) : null}
    </>
  );
}
