import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeviceChrome, chromeProfiles, pickProfile } from '@main/sandbox/device-chrome';
import { fakeCdp } from './fake-cdp';

/** A fake Chrome data folder with two profiles; only "Profile 1" has a Google picture. */
function fakeChrome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-data-'));
  writeFileSync(join(dir, 'Local State'), JSON.stringify({ profile: { info_cache: {
    Default: { name: 'Person 1', is_using_default_avatar: true },
    'Profile 1': { name: 'Manoj', user_name: 'someone@example.com', gaia_picture_file_name: 'Google Profile Picture.png', is_using_default_avatar: false },
    'Profile 9': { name: 'Gone' },
  } } }));
  for (const profile of ['Default', 'Profile 1']) {
    mkdirSync(join(dir, profile, 'Cache'), { recursive: true });
    mkdirSync(join(dir, profile, 'Sessions'), { recursive: true });
    writeFileSync(join(dir, profile, 'Cookies'), `cookies of ${profile}`);
    writeFileSync(join(dir, profile, 'Cache', 'big'), 'cache');
    writeFileSync(join(dir, profile, 'Sessions', 'tabs'), 'tabs');
  }
  return dir;
}

describe('device chrome profiles', () => {
  it('lists the user\'s profiles and picks the signed-in one with a picture', () => {
    const data = fakeChrome();
    const profiles = chromeProfiles(data);
    expect(profiles.map((profile) => profile.dir)).toEqual(['Default', 'Profile 1']); // a missing folder is left out
    expect(pickProfile(profiles, 'auto')?.name).toBe('Manoj');
    expect(pickProfile(profiles, 'Default')?.name).toBe('Person 1');
    expect(pickProfile(profiles, 'Nope')).toBeUndefined();
  });

  it('copies the chosen profile without caches or open tabs, and records it', async () => {
    const data = fakeChrome();
    const profileDir = join(mkdtempSync(join(tmpdir(), 'agent-chrome-')), 'agent-chrome');
    let wanted = 'auto';
    const chrome = new DeviceChrome({ profileDir, visible: () => false, chromeDataDir: data, sourceProfile: () => wanted, candidates: [] });
    const status = await chrome.refreshProfile();
    expect(status.profile).toMatchObject({ name: 'Manoj', email: 'someone@example.com' });
    expect(readFileSync(join(profileDir, 'Default', 'Cookies'), 'utf8')).toBe('cookies of Profile 1');
    expect(existsSync(join(profileDir, 'Default', 'Cache'))).toBe(false);
    expect(existsSync(join(profileDir, 'Default', 'Sessions'))).toBe(false);

    wanted = 'Default';
    await chrome.refreshProfile();
    expect(readFileSync(join(profileDir, 'Default', 'Cookies'), 'utf8')).toBe('cookies of Default');
    expect(chrome.status().profile?.name).toBe('Person 1');
  });

  it('says plainly when the profile cannot be read', async () => {
    const chrome = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => false, chromeDataDir: join(tmpdir(), 'no-such-chrome'), sourceProfile: () => 'auto', candidates: [] });
    await expect(chrome.refreshProfile()).rejects.toThrow(/could not be copied/);
    expect(chrome.status().profileError).toMatch(/could not be copied/);
  });
});

/** A Chrome data folder whose DevToolsActivePort points at `port`. */
const dataDirFor = (port: number, path: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'chrome-data-'));
  writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n${path}`);
  return dir;
};

describe('current browser (attach)', () => {
  it('connects to the user\'s Chrome even though it serves no /json/version', async () => {
    const chrome = await fakeCdp();
    try {
      const current = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => true, attach: true, chromeDataDir: dataDirFor(chrome.port, chrome.path), candidates: [] });
      const tab = current.session();
      expect(await tab.screenshot()).toBe('cG5n');
      expect(chrome.methods).toContain('Target.createTarget');
      await tab.close();
      await current.shutdown();
    } finally { await chrome.close(); }
  });

  it('falls back to Conductor\'s Chrome when the current one cannot be reached', async () => {
    const own = await fakeCdp({ discovery: true });
    try {
      // Conductor's own Chrome, already running on its profile.
      const profileDir = mkdtempSync(join(tmpdir(), 'agent-chrome-'));
      writeFileSync(join(profileDir, 'DevToolsActivePort'), `${own.port}\n${own.path}`);
      const fallback = new DeviceChrome({ profileDir, visible: () => true, candidates: [] });
      const unreachable = mkdtempSync(join(tmpdir(), 'chrome-data-')); // remote debugging never turned on
      const current = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => true, attach: true, chromeDataDir: unreachable, candidates: [], fallback });
      const tab = current.session();
      expect(await tab.screenshot()).toBe('cG5n');
      expect(own.methods).toContain('Target.createTarget');
      await tab.close();
      await fallback.shutdown();
    } finally { await own.close(); }
  });

  it('says how to turn remote debugging on when there is nothing to fall back to', async () => {
    const current = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => true, attach: true, chromeDataDir: dataDirFor(1, '/devtools/browser/gone'), candidates: [] });
    await expect(current.session().screenshot()).rejects.toThrow(/chrome:\/\/inspect\/#remote-debugging/);
  });
});

describe('pages that render after they load', () => {
  it('waits for a script-built page (like Workday) to show its text before reading it', async () => {
    // The document is "complete" at once, but its body stays empty for the first few checks.
    let checks = 0;
    const chrome = await fakeCdp({
      answer: (method, params) => {
        if (method !== 'Runtime.evaluate') return undefined;
        const expression = String(params['expression']);
        if (expression === 'document.readyState') return { result: { value: 'complete' } };
        if (expression.includes('location.href')) return { result: { value: { url: 'https://example.wd1.myworkdayjobs.com/job/1', title: checks > 4 ? 'AI Infrastructure Engineer Intern' : '' } } };
        checks += 1;
        const body = checks > 4 ? 'AI Infrastructure Engineer Intern\nApply' : '';
        return { result: { value: expression.endsWith('.length') ? body.length : body } };
      },
    });
    try {
      const current = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => true, attach: true, chromeDataDir: dataDirFor(chrome.port, chrome.path), candidates: [] });
      const tab = current.session();
      expect(await tab.navigate('https://example.wd1.myworkdayjobs.com/job/1')).toContain('AI Infrastructure Engineer Intern');
      expect(await tab.text(undefined)).toContain('Apply');
      await tab.close();
      await current.shutdown();
    } finally { await chrome.close(); }
  }, 20_000);
});

describe('clicks on pages that update themselves', () => {
  /** A fake single-page app: clicking swaps the detail panel, `delay` checks later (never, if undefined). */
  const spa = (delay: number | undefined) => {
    let clicked = false;
    let since = 0;
    const body = (): string => (clicked && delay !== undefined && since > delay ? 'Marvell AI Infrastructure Engineer Intern' : 'Presto AI Engineering Intern');
    return fakeCdp({
      answer: (method, params) => {
        if (method === 'Input.dispatchMouseEvent' && params['type'] === 'mouseReleased') { clicked = true; return {}; }
        if (method !== 'Runtime.evaluate') return undefined;
        const expression = String(params['expression']);
        if (expression === 'document.readyState') return { result: { value: 'complete' } };
        if (expression.includes('getBoundingClientRect')) return { result: { value: { x: 10, y: 10, w: 100, h: 20 } } };
        if (expression.includes('location.href') && expression.includes('title:')) return { result: { value: { url: 'https://jobright.ai/jobs/liked', title: 'Liked Jobs' } } };
        if (clicked) since += 1;
        const text = body();
        if (expression.includes('/*page*/')) return { result: { value: text } };
        return { result: { value: expression.endsWith('.length') ? text.length : text } };
      },
    });
  };

  it('waits for the page to change after a click before reporting back', async () => {
    const chrome = await spa(3);
    try {
      const current = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => true, attach: true, chromeDataDir: dataDirFor(chrome.port, chrome.path), candidates: [] });
      const tab = current.session();
      expect(await tab.click('//li[2]')).not.toMatch(/did not change/);
      expect(await tab.text(undefined)).toContain('Marvell');
      await current.shutdown();
    } finally { await chrome.close(); }
  }, 20_000);

  it('says so when a click changed nothing, so the agent can try again', async () => {
    const chrome = await spa(undefined);
    try {
      const current = new DeviceChrome({ profileDir: mkdtempSync(join(tmpdir(), 'agent-chrome-')), visible: () => true, attach: true, chromeDataDir: dataDirFor(chrome.port, chrome.path), candidates: [] });
      expect(await current.session().click('//li[2]')).toMatch(/did not change/);
      await current.shutdown();
    } finally { await chrome.close(); }
  }, 20_000);
});

describe('sandbox stop', () => {
  it('accepts agent, group and workflow sandbox keys', async () => {
    const { INTEGRATION_SCHEMAS } = await import('@shared/integrations-contract');
    const schema = INTEGRATION_SCHEMAS['sandbox.stop'];
    const id = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    for (const agentId of [id, `group-${id}`, `group-flow-${id}`]) expect(schema.safeParse({ agentId }).success).toBe(true);
    expect(schema.safeParse({ agentId: '../etc' }).success).toBe(false);
  });
});
