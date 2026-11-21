import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeviceChrome, chromeProfiles, pickProfile } from '@main/sandbox/device-chrome';

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

describe('sandbox stop', () => {
  it('accepts agent, group and workflow sandbox keys', async () => {
    const { INTEGRATION_SCHEMAS } = await import('@shared/integrations-contract');
    const schema = INTEGRATION_SCHEMAS['sandbox.stop'];
    const id = '3f1c2a4b-5d6e-4f70-8a9b-0c1d2e3f4a5b';
    for (const agentId of [id, `group-${id}`, `group-flow-${id}`]) expect(schema.safeParse({ agentId }).success).toBe(true);
    expect(schema.safeParse({ agentId: '../etc' }).success).toBe(false);
  });
});
