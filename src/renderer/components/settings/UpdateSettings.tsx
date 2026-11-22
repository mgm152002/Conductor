import { useCallback, useEffect, useState } from 'react';
import type { UpdateStatus } from '@shared/update-contract';
import { Badge, Button } from '../ui/primitives';
import { SettingsGroup, SettingsRow, SettingsSection } from './SettingsLayout';

// Updates for an unsigned app: "Update" downloads the newest GitHub Release,
// replaces the installed app and relaunches it, all from the main process.

export function UpdateSettings(): React.JSX.Element {
  const [status, setStatus] = useState<UpdateStatus | null>(null);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true); setError(null);
    try { setStatus(await window.conductor.updates.check()); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setChecking(false); }
  }, []);
  useEffect(() => { void check(); }, [check]);

  const install = async (): Promise<void> => {
    setInstalling(true); setError(null);
    try { await window.conductor.updates.install(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setInstalling(false); }
  };

  const badge = status === null ? null
    : status.updateAvailable ? <Badge tone="success">Update available</Badge> : <Badge>Up to date</Badge>;

  return (
    <SettingsSection title="Updates">
      <SettingsGroup>
        <SettingsRow
          title={<>Conductor {status?.currentVersion ?? ''} {badge}</>}
          description={status?.updateAvailable === true
            ? `Version ${status.latestVersion} is ready. Updating downloads it, replaces the app and reopens Conductor.`
            : 'Checks GitHub Releases for a newer version.'}
          control={<>
            <Button disabled={checking || installing} onClick={() => { void check(); }}>{checking ? 'Checking…' : 'Check for updates'}</Button>
            {status?.updateAvailable === true
              ? <Button variant="primary" disabled={installing || status.installBlockedReason !== undefined} onClick={() => { void install(); }}>
                {installing ? 'Updating… Conductor will restart' : `Update to ${status.latestVersion}`}
              </Button> : null}
          </>}
        />
        {status?.installBlockedReason !== undefined && status.updateAvailable
          ? <p className="px-3 pb-3 text-xs text-muted-foreground sm:px-4">{status.installBlockedReason}</p> : null}
        {status?.updateAvailable === true && status.notes !== undefined
          ? <pre className="mx-3 mb-3 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-md bg-muted/50 p-3 text-xs text-muted-foreground sm:mx-4">{status.notes}</pre> : null}
        {error !== null ? <p role="alert" className="px-3 pb-3 text-xs text-destructive sm:px-4">{error}</p> : null}
      </SettingsGroup>
    </SettingsSection>
  );
}
