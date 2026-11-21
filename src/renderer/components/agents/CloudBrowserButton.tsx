import { useEffect, useState } from 'react';
import type { CloudBrowserInfo } from '@shared/integrations-contract';
import { cn } from '../../lib/cn';
import { Alert, Button, Dialog, inputClassName } from '../ui/primitives';
import { CloudIcon, Spinner } from '../ui/icons';
import { message } from './AgentDialog';

/**
 * Header button + dialog for an agent's or a flow's cloud browser: a remote
 * Selenium/WebDriver hub its runs can drive through the cloud_browser_* tools.
 * A flow's setting wins over its agents' own for that flow's steps.
 */
export function CloudBrowserButton({ scope, label }: { scope: `agent:${string}` | `flow:${string}`; label: string }): React.JSX.Element {
  const [info, setInfo] = useState<CloudBrowserInfo | null>(null);
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'remove' | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let live = true;
    window.conductor.cloudBrowser.get(scope).then((next) => { if (live) setInfo(next); }).catch(() => undefined);
    return () => { live = false; };
  }, [scope]);

  const close = (): void => { setOpen(false); setUrl(''); setApiKey(''); setResult(null); };

  // Fill the form with what is saved each time it opens, so it can be checked and edited.
  useEffect(() => {
    if (!open) return;
    let live = true;
    window.conductor.cloudBrowser.load(scope).then((saved) => {
      if (!live || saved === null) return;
      setUrl(saved.url);
      setApiKey(saved.apiKey ?? '');
    }).catch(() => undefined);
    return () => { live = false; };
  }, [open, scope]);

  async function run(kind: 'save' | 'test' | 'remove'): Promise<void> {
    setBusy(kind); setResult(null);
    try {
      if (kind === 'test') {
        const out = await window.conductor.cloudBrowser.test(scope, url.trim() || undefined, apiKey.trim() || undefined);
        setResult(out.ok ? { ok: true, text: `Connected${out.browser !== undefined ? ` · ${out.browser}` : ''}` } : { ok: false, text: out.error ?? 'Could not connect' });
      } else if (kind === 'save') {
        setInfo(await window.conductor.cloudBrowser.save(scope, url.trim(), apiKey.trim() || undefined));
        close();
      } else {
        await window.conductor.cloudBrowser.remove(scope);
        setInfo({ configured: false });
        close();
      }
    } catch (err) { setResult({ ok: false, text: message(err) }); }
    finally { setBusy(null); }
  }

  const configured = info?.configured === true;
  return (
    <>
      <Button size="sm" variant="ghost" title={configured ? `Cloud browser: ${info.host ?? ''}` : 'Give this a remote WebDriver browser'} onClick={() => { setOpen(true); }}>
        <CloudIcon size={13} />Cloud browser
        {configured ? <span className="size-1.5 rounded-full bg-success" aria-label="set up" /> : null}
      </Button>
      <Dialog open={open} onClose={close} title={`Cloud browser · ${label}`}
        footer={(
          <div className="flex w-full items-center gap-2">
            {configured ? <Button size="sm" variant="ghost" className="hover:text-destructive-foreground" disabled={busy !== null} onClick={() => { void run('remove'); }}>Remove</Button> : null}
            <span className="flex-1" />
            <Button size="sm" variant="outline" disabled={busy !== null || (!configured && url.trim() === '')} onClick={() => { void run('test'); }}>{busy === 'test' ? <Spinner size={12} /> : null}Test</Button>
            <Button size="sm" variant="primary" disabled={busy !== null || url.trim() === ''} onClick={() => { void run('save'); }}>{busy === 'save' ? <Spinner size={12} /> : null}Save</Button>
          </div>
        )}>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">WebDriver URL</span>
            <input className={cn(inputClassName, 'font-mono text-xs')} value={url} spellCheck={false} autoComplete="off" placeholder="https://user:key@host/wd/hub" onChange={(e) => { setUrl(e.target.value); setResult(null); }} />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-2xs font-medium text-muted-foreground">API key <span className="font-normal">(optional, replaces the password in the URL)</span></span>
            <input type="password" className={cn(inputClassName, 'font-mono text-xs')} value={apiKey} autoComplete="off" onChange={(e) => { setApiKey(e.target.value); setResult(null); }} />
          </label>
          {result !== null ? (result.ok ? <p role="status" className="text-xs text-success">{result.text}</p> : <Alert>{result.text}</Alert>) : null}
        </div>
      </Dialog>
    </>
  );
}
