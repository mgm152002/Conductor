import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { AuditLog } from '@main/domain/audit-log';
import { SecretStore, type KeychainWriter } from '@main/secrets/secret-store';
import { browserTools, callBrowser, type BrowserDriver } from '@main/sandbox/browser-tools';

async function setup(): Promise<{ secrets: SecretStore; keychain: Map<string, string>; audit: AuditLog }> {
  const store = new SqliteStore(join(mkdtempSync(join(tmpdir(), 'secrets-')), 'app.db'));
  await store.migrate();
  const keychain = new Map<string, string>();
  const writer: KeychainWriter = { write: async ({ account }, value) => { keychain.set(account, value); }, remove: async ({ account }) => { keychain.delete(account); } };
  const audit = new AuditLog(store);
  return { secrets: new SecretStore(store, audit, writer), keychain, audit };
}

describe('secret store update', () => {
  it('renames, rotates in place and reassigns, never logging the value', async () => {
    const { secrets, keychain, audit } = await setup();
    const made = await secrets.put({ label: 'LinkedIn', value: 'old-pass', owner: 'agents:all' });
    const updated = await secrets.update(made.id, { label: 'LinkedIn password', value: 'new-pass', owner: null });
    expect(updated).toMatchObject({ id: made.id, label: 'LinkedIn password' });
    expect(updated.owner).toBeUndefined();
    expect(keychain.get(made.id)).toBe('new-pass');
    expect(JSON.stringify(audit.list())).not.toContain('new-pass');
    await expect(secrets.update('sec_00000000000000000000000000000000', { label: 'x' })).rejects.toThrow(/no longer exists/);
    await expect(secrets.update(made.id, { label: ' ' })).rejects.toThrow(/label/);
  });
});

describe('agent secrets in the browser', () => {
  it('types a saved secret by name and blanks it out of what the agent reads back', async () => {
    const typed: string[] = [];
    let page = '';
    const driver = {
      type: async (_selector: string, text: string) => { typed.push(text); page = `password field: ${text}`; return 'typed'; },
      text: async () => page, where: async () => 'here', execute: async () => page,
    } as unknown as BrowserDriver;
    const secrets = { labels: () => ['LinkedIn password'], value: async (label: string) => (label === 'LinkedIn password' ? 'hunter2-secret' : undefined), typed: new Set<string>() };
    const out = await callBrowser(driver, 'device', 'chrome_browser_type_secret', { selector: '#pw', secret: 'linkedin password' }, undefined, () => [], undefined, secrets);
    const text = (result: unknown): string => ((result as { content: Array<{ text: string }> }).content[0]!.text);
    expect(text(out)).toBe('Typed the secret "LinkedIn password" into #pw.');
    expect(typed).toEqual(['hunter2-secret']);
    expect(text(await callBrowser(driver, 'device', 'chrome_browser_get_text', {}, undefined, () => [], undefined, secrets))).toBe('password field: [secret]');
    expect(text(await callBrowser(driver, 'device', 'chrome_browser_execute_script', { script: 'return 1' }, undefined, () => [], undefined, secrets))).not.toContain('hunter2');
    const unknown = await callBrowser(driver, 'device', 'chrome_browser_type_secret', { selector: '#pw', secret: 'Gmail' }, undefined, () => [], undefined, secrets) as { isError?: boolean };
    expect(unknown.isError).toBe(true);
    expect(text(unknown)).toContain('Saved: LinkedIn password');
  });

  it('offers the tool only when the agent has secrets', () => {
    expect(browserTools('device').some((tool) => tool.name === 'chrome_browser_type_secret')).toBe(false);
    expect(browserTools('device', true).some((tool) => tool.name === 'chrome_browser_type_secret')).toBe(true);
  });
});
