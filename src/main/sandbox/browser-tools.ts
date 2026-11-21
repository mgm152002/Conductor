// The browser tools an agent gets for a browser outside its sandbox (Chrome
// on this Mac): the tool list it sees, and the code that runs each call on a
// BrowserDriver. Uploads are limited to the task's attachments or files from
// the agent's own sandbox, and saved secrets are typed without the agent ever
// seeing them.

type Json = Record<string, unknown>;

const MAX_TEXT = 60_000;

/** What a browser an agent drives outside the sandbox can do (today: Chrome on this Mac). */
export interface BrowserDriver {
  navigate(url: string, signal?: AbortSignal): Promise<string>;
  where(signal?: AbortSignal): Promise<string>;
  screenshot(signal?: AbortSignal): Promise<string>;
  text(selector: string | undefined, signal?: AbortSignal): Promise<string>;
  click(selector: string, signal?: AbortSignal): Promise<string>;
  type(selector: string, text: string, opts: { clear?: boolean; submit?: boolean }, signal?: AbortSignal): Promise<string>;
  execute(script: string, args?: unknown[], signal?: AbortSignal): Promise<unknown>;
  back(signal?: AbortSignal): Promise<string>;
  upload(selector: string, file: { path: string; name: string }, signal?: AbortSignal): Promise<string>;
  close(): Promise<void>;
}

/** Which outside browser: Chrome on the user's own Mac. */
export type BrowserKind = 'device';

const BROWSER_NAMES: Record<BrowserKind, { prefix: string; label: string; what: string }> = {
  device: { prefix: 'chrome_browser', label: 'Chrome', what: 'Chrome on the user\'s Mac (its own profile, running in the background)' },
};

export const browserToolPrefix = (kind: BrowserKind): string => `${BROWSER_NAMES[kind].prefix}_`;
export const browserLabel = (kind: BrowserKind): string => BROWSER_NAMES[kind].label;

/**
 * Secrets the user saved for agents (Secrets screen). The agent names one by
 * its label; the value goes from the Keychain into the field and is blanked
 * out of anything the agent reads back.
 */
export interface BrowserSecrets {
  labels(): string[];
  value(label: string): Promise<string | undefined>;
}

/** The tools for an outside browser, e.g. chrome_browser_navigate. */
export function browserTools(kind: BrowserKind, withSecrets = false): Array<{ name: string; description: string; inputSchema: Json }> {
  const { prefix: p, what } = BROWSER_NAMES[kind];
  const sel = { type: 'string', description: 'CSS selector, or XPath starting with / or (.' };
  const tools: Array<{ name: string; description: string; inputSchema: Json }> = [
    { name: `${p}_navigate`, description: `Open a URL in ${what}. This is the browser to use for web work.`, inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'], additionalProperties: false } },
    { name: `${p}_get_text`, description: 'Read the visible text of the page, or of one element.', inputSchema: { type: 'object', properties: { selector: sel }, additionalProperties: false } },
    { name: `${p}_screenshot`, description: 'Take a screenshot of the page.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: `${p}_click`, description: 'Click an element.', inputSchema: { type: 'object', properties: { selector: sel }, required: ['selector'], additionalProperties: false } },
    { name: `${p}_type`, description: 'Type text into a field. Set submit to press Enter afterwards, clear to empty the field first.', inputSchema: { type: 'object', properties: { selector: sel, text: { type: 'string' }, clear: { type: 'boolean' }, submit: { type: 'boolean' } }, required: ['selector', 'text'], additionalProperties: false } },
    { name: `${p}_execute_script`, description: 'Run JavaScript in the page and get its return value (use `return …`).', inputSchema: { type: 'object', properties: { script: { type: 'string' } }, required: ['script'], additionalProperties: false } },
    { name: `${p}_upload_file`, description: 'Attach a file to a file field (<input type=file>), e.g. a resume on an application form: one the user attached to this task (by its name), or one in your sandbox (by its full path).', inputSchema: { type: 'object', properties: { selector: sel, file: { type: 'string', description: 'The attached file\'s name, or the full path of a file in your sandbox (e.g. a resume you built there).' } }, required: ['selector', 'file'], additionalProperties: false } },
    { name: `${p}_back`, description: 'Go back one page.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    { name: `${p}_close`, description: 'Close this browser tab when you are done with it; the next call opens a fresh one.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  ];
  if (withSecrets) {
    tools.push({ name: `${p}_type_secret`, description: 'Type one of the user\'s saved secrets (a password, say) into a field, by the secret\'s name. You never see the value. Set submit to press Enter afterwards.', inputSchema: { type: 'object', properties: { selector: sel, secret: { type: 'string', description: 'The saved secret\'s name.' }, submit: { type: 'boolean' } }, required: ['selector', 'secret'], additionalProperties: false } });
  }
  return tools;
}

const str = (args: Json, key: string): string => (typeof args[key] === 'string' ? args[key] : '');

/** Run one call on an outside browser; resolves to MCP tool-result content. */
export async function callBrowser(
  browser: BrowserDriver, kind: BrowserKind, name: string, args: Json, signal?: AbortSignal,
  files: () => Array<{ path: string; name: string }> = () => [],
  fromSandbox?: (path: string) => Promise<{ path: string; name: string }>,
  secrets?: BrowserSecrets & { typed?: Set<string> },
): Promise<Json> {
  // A secret typed earlier in this run never comes back to the agent, whatever it reads.
  const hide = (value: string): string => {
    let out = value;
    for (const secret of secrets?.typed ?? []) if (secret.length >= 4) out = out.split(secret).join('[secret]');
    return out;
  };
  const text = (value: string): Json => ({ content: [{ type: 'text', text: hide(value) }] });
  const prefix = browserToolPrefix(kind);
  const action = name.startsWith(prefix) ? name.slice(prefix.length) : '';
  try {
    switch (action) {
      case 'navigate': {
        const url = str(args, 'url').trim();
        if (!/^https?:\/\//i.test(url)) return { ...text('Give a full http(s) URL.'), isError: true };
        return text(await browser.navigate(url, signal));
      }
      case 'get_text': return text(await browser.text(str(args, 'selector').trim() || undefined, signal));
      case 'screenshot': return { content: [{ type: 'image', data: await browser.screenshot(signal), mimeType: 'image/png' }] };
      case 'click': return text(await browser.click(str(args, 'selector'), signal));
      case 'type': return text(await browser.type(str(args, 'selector'), str(args, 'text'), { clear: args['clear'] === true, submit: args['submit'] === true }, signal));
      case 'execute_script': {
        const value = await browser.execute(str(args, 'script'), [], signal);
        const out = typeof value === 'string' ? value : JSON.stringify(value ?? null);
        return text(out.length > MAX_TEXT ? `${out.slice(0, MAX_TEXT)}…` : out);
      }
      case 'upload_file': {
        // Only the task's attachments or a file from the agent's own sandbox can be sent, never any other file on the Mac.
        const available = files();
        const wanted = str(args, 'file').trim();
        let file = available.find((item) => item.name === wanted) ?? available.find((item) => item.name.toLowerCase() === wanted.toLowerCase());
        if (file === undefined && fromSandbox !== undefined && wanted.startsWith('/')) file = await fromSandbox(wanted);
        if (file === undefined) return { ...text(available.length === 0 ? `No files are attached to this task.${fromSandbox !== undefined ? ' For a file in your sandbox, give its full path.' : ''}` : `No attached file is called "${wanted}". Attached: ${available.map((item) => item.name).join(', ')}.${fromSandbox !== undefined ? ' For a file in your sandbox, give its full path.' : ''}`), isError: true };
        return text(await browser.upload(str(args, 'selector'), file, signal));
      }
      case 'type_secret': {
        const label = str(args, 'secret').trim();
        const known = secrets?.labels() ?? [];
        const match = known.find((item) => item === label) ?? known.find((item) => item.toLowerCase() === label.toLowerCase());
        const value = match !== undefined ? await secrets?.value(match) : undefined;
        if (match === undefined || value === undefined) return { ...text(known.length === 0 ? 'No secrets are saved for you.' : `No saved secret is called "${label}". Saved: ${known.join(', ')}.`), isError: true };
        secrets?.typed?.add(value);
        await browser.type(str(args, 'selector'), value, { clear: true, submit: args['submit'] === true }, signal);
        return text(`Typed the secret "${match}" into ${str(args, 'selector')}.${args['submit'] === true ? ` ${await browser.where(signal)}` : ''}`);
      }
      case 'back': return text(await browser.back(signal));
      case 'close': await browser.close(); return text('Closed the Chrome tab.');
      default: return { ...text(`Unknown tool ${name}.`), isError: true };
    }
  } catch (error) {
    return { ...text(`The Chrome browser could not do that: ${error instanceof Error ? error.message : 'unknown error'}`), isError: true };
  }
}
