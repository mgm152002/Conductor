import { useCallback, useEffect, useState } from 'react';
import type { PhoneControlStatus } from '@shared/phone-control';
import { Alert, Button, Dialog } from '../ui/primitives';
import { Spinner } from '../ui/icons';

// "Control on phone": turn on the tunnel, scan the QR code, and Conductor
// opens on the phone. Nothing is exposed until the user turns it on, and
// turning it off (or quitting) closes the tunnel and signs every phone out.

const clean = (err: unknown): string => (err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(err));

export function PhoneControlDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [status, setStatus] = useState<PhoneControlStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (action: () => Promise<PhoneControlStatus>): Promise<void> => {
    setBusy(true); setError(null);
    try { setStatus(await action()); } catch (err) { setError(clean(err)); } finally { setBusy(false); }
  }, []);
  useEffect(() => { void run(() => window.conductor.phone.status()); }, [run]);
  // Phones signed in is live information.
  useEffect(() => {
    if (status?.state !== 'on') return;
    const id = setInterval(() => { void window.conductor.phone.status().then(setStatus).catch(() => undefined); }, 3000);
    return () => { clearInterval(id); };
  }, [status?.state]);

  const on = status?.state === 'on';
  return (
    <Dialog open onClose={onClose} title="Control on phone" width="max-w-md"
      footer={<>
        {on ? <Button size="md" variant="ghost" disabled={busy} onClick={() => { void run(() => window.conductor.phone.stop()); }}>Turn off</Button> : null}
        <Button size="md" variant={on ? 'primary' : 'ghost'} onClick={onClose}>Done</Button>
      </>}>
      <div className="flex flex-col gap-4">
        {error !== null ? <Alert>{error}</Alert> : null}
        {status?.state === 'error' && status.error !== undefined ? <Alert>{status.error}</Alert> : null}
        {on && status.qr !== undefined ? (
          <>
            <div className="mx-auto w-56 rounded-2xl bg-white p-2"><img src={status.qr} alt="QR code that opens Conductor on your phone" className="block w-full" /></div>
            <p className="text-center text-xs text-muted-foreground">Scan with your phone’s camera. This code works once and expires in 10 minutes.</p>
            <p className="text-center text-xs text-foreground">{status.devices === 0 ? 'No phone connected yet.' : `${status.devices} phone${status.devices === 1 ? '' : 's'} connected.`}</p>
            <div className="flex justify-center gap-2">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => window.conductor.phone.newCode()); }}>New code</Button>
              {status.devices > 0 ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => { void run(() => window.conductor.phone.signOut()); }}>Sign phones out</Button> : null}
            </div>
          </>
        ) : (
          <>
            <p className="text-sm text-foreground">Chat with your agents, watch work, approve requests and check usage from your phone.</p>
            <p className="text-xs text-muted-foreground">Conductor opens a private ngrok tunnel to a page on this Mac. Only a phone that scans the QR code can use it, and you can turn it off at any time.</p>
            {status !== null && !status.ngrokInstalled ? <Alert tone="warning">ngrok isn’t installed. Run “brew install ngrok” and add your token with “ngrok config add-authtoken …”.</Alert> : null}
            <Button size="md" variant="primary" disabled={busy || status === null || status.state === 'starting'} onClick={() => { void run(() => window.conductor.phone.start()); }}>
              {busy || status?.state === 'starting' ? <Spinner size={13} /> : null}Turn on and show QR code
            </Button>
          </>
        )}
      </div>
    </Dialog>
  );
}
