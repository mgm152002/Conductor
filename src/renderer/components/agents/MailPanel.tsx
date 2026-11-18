import { useEffect, useState } from 'react';
import { Alert, Button, inputClassName } from '../ui/primitives';
import { Spinner } from '../ui/icons';
import { message } from './AgentDialog';

type Status = { configured: boolean; inbox?: string; owner?: string; listening: boolean };

/** Connect the agents' email inbox (AgentMail) so steps can email you and wait for your reply. */
export function MailPanel({ onChange }: { onChange?: (status: Status) => void }): React.JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [owner, setOwner] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.conductor.mail.status().then((next) => { setStatus(next); onChange?.(next); }).catch(() => undefined);
  }, [onChange]);

  async function connect(): Promise<void> {
    setBusy(true); setError(null);
    try { const next = await window.conductor.mail.connect({ apiKey, owner }); setStatus(next); onChange?.(next); setApiKey(''); }
    catch (err) { setError(message(err)); }
    finally { setBusy(false); }
  }
  async function disconnect(): Promise<void> {
    await window.conductor.mail.disconnect().catch(() => undefined);
    const next = { configured: false, listening: false };
    setStatus(next); onChange?.(next);
  }

  return (
    <section className="flex flex-col gap-2" aria-label="Email">
      <h3 className="text-xs font-semibold text-foreground">Email (AgentMail)</h3>
      {status?.configured === true ? (
        <>
          <p className="text-2xs text-muted-foreground">Agents write from <span className="font-mono text-foreground">{status.inbox}</span> to <span className="font-mono text-foreground">{status.owner}</span> only. Your replies are heard {status.listening ? 'live' : 'every half minute while the live link reconnects'}.</p>
          <Button size="xs" variant="ghost" className="self-start" onClick={() => { void disconnect(); }}>Disconnect</Button>
        </>
      ) : (
        <>
          <p className="text-2xs text-muted-foreground">Lets steps email you and wait for your reply. The key is kept in a private file on this computer.</p>
          <input aria-label="AgentMail API key" type="password" autoComplete="off" className={inputClassName} placeholder="am_…" value={apiKey} onChange={(e) => { setApiKey(e.target.value); }} />
          <input aria-label="Your email address" type="email" className={inputClassName} placeholder="Your email (where reports go)" value={owner} onChange={(e) => { setOwner(e.target.value); }} />
          <Button size="sm" variant="outline" className="self-start" disabled={busy || apiKey.trim() === '' || owner.trim() === ''} onClick={() => { void connect(); }}>{busy ? <Spinner size={13} /> : null}Connect</Button>
        </>
      )}
      {error !== null ? <Alert>{error}</Alert> : null}
    </section>
  );
}
