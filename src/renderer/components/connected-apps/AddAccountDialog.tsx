import { useEffect, useId, useState } from 'react';
import { useWorkspaceStore } from '../../stores';
import { Button, Dialog, inputClassName } from '../ui/primitives';

// Connect an email account (IMAP), a calendar feed (iCalendar URL) or a Slack
// workspace (token). Credentials are sent once to the main process, stored in
// the macOS Keychain and never shown again.

export type AccountKind = 'email' | 'calendar' | 'slack';

const IMAP_PRESETS: Record<string, { host: string; note: string }> = {
  'gmail.com': { host: 'imap.gmail.com', note: 'Gmail needs an app password (Google Account → Security → App passwords).' },
  'googlemail.com': { host: 'imap.gmail.com', note: 'Gmail needs an app password.' },
  'icloud.com': { host: 'imap.mail.me.com', note: 'iCloud needs an app-specific password (appleid.apple.com).' },
  'me.com': { host: 'imap.mail.me.com', note: 'iCloud needs an app-specific password.' },
  'outlook.com': { host: 'outlook.office365.com', note: 'Outlook.com accounts may require an app password.' },
  'hotmail.com': { host: 'outlook.office365.com', note: 'Outlook.com accounts may require an app password.' },
  'fastmail.com': { host: 'imap.fastmail.com', note: 'Fastmail needs an app password with IMAP access.' },
  'yahoo.com': { host: 'imap.mail.yahoo.com', note: 'Yahoo needs an app password.' },
};

function Field({ label, children, hint, id }: { label: string; id: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-foreground">{label}</label>
      {children}
      {hint !== undefined ? <p className="text-3xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

const TITLES: Record<AccountKind, { title: string; description: string }> = {
  email: { title: 'Connect email (IMAP)', description: 'Conductor reads the mailbox read-only (nothing is marked read or sent) and indexes recent messages locally. The password is stored in your macOS Keychain.' },
  calendar: { title: 'Subscribe to a calendar', description: 'Paste an iCalendar feed URL (Google Calendar “Secret address in iCal format”, iCloud public calendar, Outlook published calendar). The URL is stored in your Keychain.' },
  slack: { title: 'Connect Slack', description: 'Use a Slack user or bot token with read scopes (channels:history, groups:history, im:history, channels:read, groups:read, users:read). Only conversations the token can read are indexed. The token is stored in your Keychain.' },
};

export function AddAccountDialog({ kind, onClose }: { kind: AccountKind | null; onClose: () => void }): React.JSX.Element {
  const workspaces = useWorkspaceStore((s) => s.workspaces);
  const activeWorkspaceId = useWorkspaceStore((s) => s.activeWorkspaceId);
  const [name, setName] = useState('');
  const [user, setUser] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('993');
  const [password, setPassword] = useState('');
  const [mailbox, setMailbox] = useState('INBOX');
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [channels, setChannels] = useState('');
  const [workspaceId, setWorkspaceId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = { name: useId(), user: useId(), host: useId(), port: useId(), password: useId(), mailbox: useId(), url: useId(), token: useId(), channels: useId(), project: useId() };

  useEffect(() => {
    if (kind === null) return;
    setName(kind === 'email' ? 'Email' : kind === 'calendar' ? 'Calendar' : 'Slack');
    setUser(''); setHost(''); setPort('993'); setPassword(''); setMailbox('INBOX'); setUrl(''); setToken(''); setChannels('');
    setWorkspaceId(activeWorkspaceId ?? ''); setError(null); setBusy(false);
  }, [kind, activeWorkspaceId]);

  const domain = user.split('@')[1]?.toLowerCase() ?? '';
  const preset = IMAP_PRESETS[domain];

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (kind === null) return;
    setBusy(true); setError(null);
    const project = workspaceId !== '' ? { workspaceId } : {};
    try {
      if (kind === 'email') {
        await window.conductor.connectors.createEmail({ name: name.trim() || user, host: (host.trim() || preset?.host || '').trim(), port: Number(port) || 993, secure: true, user: user.trim(), password, mailbox: mailbox.trim() || 'INBOX', ...project });
      } else if (kind === 'calendar') {
        await window.conductor.connectors.createCalendar({ name: name.trim() || 'Calendar', url: url.trim(), ...project });
      } else {
        await window.conductor.connectors.createSlack({ name: name.trim() || 'Slack', token: token.trim(), channels: channels.split(/[\s,]+/).map((c) => c.replace(/^#/, '')).filter(Boolean), ...project });
      }
      setPassword(''); setToken(''); setUrl('');
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^Error invoking remote method '[^']+': /, '') : 'Could not connect the account');
    } finally {
      setBusy(false);
    }
  }

  const meta = kind !== null ? TITLES[kind] : TITLES.email;
  const ready = kind === 'email' ? user.includes('@') && password.length > 0 && (host.trim() !== '' || preset !== undefined)
    : kind === 'calendar' ? /^(https|webcals?):\/\//i.test(url.trim())
      : /^xox[a-z]-/i.test(token.trim());

  return (
    <Dialog open={kind !== null} onClose={onClose} title={meta.title} description={meta.description} width="max-w-lg">
      <form className="flex flex-col gap-3" onSubmit={(event) => { void submit(event); }} aria-label={meta.title}>
        <Field label="Name" id={ids.name}><input id={ids.name} className={inputClassName} value={name} onChange={(e) => { setName(e.target.value); }} maxLength={255} autoComplete="off" /></Field>
        {kind === 'email' ? (
          <>
            <Field label="Email address" id={ids.user}><input id={ids.user} className={inputClassName} value={user} onChange={(e) => { setUser(e.target.value); }} placeholder="you@example.com" autoComplete="off" spellCheck={false} /></Field>
            <div className="grid grid-cols-[1fr_6rem] gap-2">
              <Field label="IMAP server" id={ids.host} {...(preset ? { hint: preset.note } : {})}><input id={ids.host} className={inputClassName} value={host} onChange={(e) => { setHost(e.target.value); }} placeholder={preset?.host ?? 'imap.example.com'} autoComplete="off" spellCheck={false} /></Field>
              <Field label="Port" id={ids.port}><input id={ids.port} className={inputClassName} value={port} onChange={(e) => { setPort(e.target.value.replace(/\D/g, '')); }} inputMode="numeric" /></Field>
            </div>
            <Field label="Password or app password" id={ids.password}><input id={ids.password} type="password" className={inputClassName} value={password} onChange={(e) => { setPassword(e.target.value); }} autoComplete="new-password" /></Field>
            <Field label="Mailbox" id={ids.mailbox}><input id={ids.mailbox} className={inputClassName} value={mailbox} onChange={(e) => { setMailbox(e.target.value); }} autoComplete="off" /></Field>
          </>
        ) : null}
        {kind === 'calendar' ? (
          <Field label="iCalendar feed URL" id={ids.url} hint="Starts with https:// or webcal://. Events from the past week to 60 days ahead are indexed.">
            <input id={ids.url} type="password" className={`${inputClassName} font-mono text-xs`} value={url} onChange={(e) => { setUrl(e.target.value); }} placeholder="https://calendar.google.com/calendar/ical/…/basic.ics" autoComplete="off" spellCheck={false} />
          </Field>
        ) : null}
        {kind === 'slack' ? (
          <>
            <Field label="Token" id={ids.token}><input id={ids.token} type="password" className={`${inputClassName} font-mono text-xs`} value={token} onChange={(e) => { setToken(e.target.value); }} placeholder="xoxp-… or xoxb-…" autoComplete="off" spellCheck={false} /></Field>
            <Field label="Channels (optional)" id={ids.channels} hint="Comma-separated names. Leave empty to index every conversation the token is a member of (up to 30)."><input id={ids.channels} className={inputClassName} value={channels} onChange={(e) => { setChannels(e.target.value); }} placeholder="general, eng-team" autoComplete="off" /></Field>
          </>
        ) : null}
        <Field label="Use as context for" id={ids.project}>
          <select id={ids.project} className={inputClassName} value={workspaceId} onChange={(e) => { setWorkspaceId(e.target.value); }}>
            <option value="">No project (search only)</option>
            {workspaces.map((workspace) => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
          </select>
        </Field>
        <p className="text-3xs text-muted-foreground">Connecting records your consent for Conductor to contact this provider. You can revoke it in Settings → External provider consent.</p>
        {error !== null ? <p role="alert" className="text-xs text-destructive-foreground">{error}</p> : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="md" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button size="md" variant="primary" type="submit" disabled={busy || !ready}>{busy ? 'Connecting…' : 'Connect'}</Button>
        </div>
      </form>
    </Dialog>
  );
}
