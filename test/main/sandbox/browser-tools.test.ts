import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callBrowser, type BrowserDriver } from '@main/sandbox/browser-tools';
import { SandboxGateway } from '@main/sandbox/sandbox-gateway';
import type { GateRequest } from '@main/adapters/tool-gate';

// The browser tools an agent gets for Chrome on this Mac, driven against a
// fake browser so only Conductor's side (tool names, uploads, approvals) is
// under test.

function fakeBrowser(): BrowserDriver & { uploads: Array<{ selector: string; path: string }>; closed: boolean } {
  let page = 'about:blank';
  const browser = {
    uploads: [] as Array<{ selector: string; path: string }>,
    closed: false,
    navigate: async (url: string) => { page = url; return `${url} — Example Domain`; },
    where: async () => page,
    screenshot: async () => 'iVBORw0KGgo=',
    text: async () => 'page text',
    click: async (selector: string) => `Clicked ${selector}.`,
    type: async (selector: string) => `Typed into ${selector}.`,
    execute: async () => 'value',
    back: async () => page,
    upload: async (selector: string, file: { path: string; name: string }) => { browser.uploads.push({ selector, path: file.path }); return `Attached ${file.name} to ${selector}.`; },
    close: async () => { browser.closed = true; },
  };
  return browser;
}

const text = (result: unknown): string => ((result as { content: Array<{ text?: string }> }).content[0]?.text ?? '');

describe('uploads', () => {
  it('uploads only files attached to the task', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'att-'));
    writeFileSync(join(dir, 'resume.pdf'), '%PDF');
    const files = () => [{ path: join(dir, 'resume.pdf'), name: 'resume.pdf' }];
    const browser = fakeBrowser();
    expect(text(await callBrowser(browser, 'device', 'chrome_browser_upload_file', { selector: '#cv', file: 'Resume.PDF' }, undefined, files))).toBe('Attached resume.pdf to #cv.');
    expect(browser.uploads).toEqual([{ selector: '#cv', path: join(dir, 'resume.pdf') }]);
    const refused = await callBrowser(browser, 'device', 'chrome_browser_upload_file', { selector: '#cv', file: '/etc/passwd' }, undefined, files) as { isError?: boolean };
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('Attached: resume.pdf');
  });

  it('uploads a file from the agent\'s sandbox by its full path, brought to the Mac first', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbx-'));
    writeFileSync(join(dir, 'tailored.pdf'), '%PDF tailored');
    const asked: string[] = [];
    const fromSandbox = async (path: string) => { asked.push(path); return { path: join(dir, 'tailored.pdf'), name: 'tailored.pdf' }; };
    const browser = fakeBrowser();
    const out = await callBrowser(browser, 'device', 'chrome_browser_upload_file', { selector: '#cv', file: '/home/gem/workspace/tailored.pdf' }, undefined, () => [], fromSandbox);
    expect(text(out)).toBe('Attached tailored.pdf to #cv.');
    expect(asked).toEqual(['/home/gem/workspace/tailored.pdf']);
    // A bare name that is not attached is still refused, and points at the sandbox option.
    const refused = await callBrowser(browser, 'device', 'chrome_browser_upload_file', { selector: '#cv', file: 'other.pdf' }, undefined, () => [], fromSandbox);
    expect(text(refused)).toContain('give its full path');
  });
});

describe('gateway', () => {
  it('offers the Chrome tools only to runs that have it, asks before acting, and never needs the sandbox', async () => {
    const gateway = new SandboxGateway();
    const asked: GateRequest[] = [];
    const config = {
      agentName: 'Researcher', tools: [] as [], approval: 'risky' as const,
      sandbox: () => Promise.reject(new Error('no sandbox')),
      decide: async (request: GateRequest) => { asked.push(request); return 'accept' as const; },
    };
    const browser = fakeBrowser();
    const plain = await gateway.open(config);
    const withChrome = await gateway.open({ ...config, browser: { kind: 'device', driver: browser } });
    const client = new Client({ name: 't', version: '1' });
    await client.connect(new StreamableHTTPClientTransport(new URL(withChrome.url)));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('chrome_browser_navigate');
    expect(await plain.toolNames().catch(() => [])).not.toContain('chrome_browser_navigate');

    expect(text(await client.callTool({ name: 'chrome_browser_navigate', arguments: { url: 'https://example.com/' } }))).toContain('Example Domain');
    expect(asked).toHaveLength(0); // looking needs no approval
    await client.callTool({ name: 'chrome_browser_click', arguments: { selector: 'a' } });
    expect(asked.map((request) => request.summary)).toEqual(['Researcher: Chrome: click']);

    withChrome.dispose();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(browser.closed).toBe(true);
    await client.close();
    plain.dispose();
    gateway.close();
  });
});
