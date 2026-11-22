import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { UpdateService, appBundlePath, compareVersions, pickDmg } from '@main/domain/update-service';

const bytes = Buffer.from('fake dmg bytes');
const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const release = (over: Record<string, unknown> = {}) => ({
  tag_name: 'v0.7.0', html_url: 'https://github.com/x/y/releases/v0.7.0', body: 'notes',
  assets: [{ name: 'Conductor-0.7.0-arm64.dmg', browser_download_url: 'https://github.com/x/y/releases/download/v0.7.0/c.dmg', size: bytes.length, digest }],
  ...over,
});

function setup(rel: unknown, dl: Response = new Response(bytes)) {
  const root = mkdtempSync(join(tmpdir(), 'upd-test-'));
  const apps = join(root, 'Applications'); mkdirSync(join(apps, 'Conductor.app/Contents/MacOS'), { recursive: true });
  const launched: string[][] = []; const quit = vi.fn();
  const fetchMock = vi.fn(async (url: string | URL) => String(url).includes('api.github.com') ? Response.json(rel) : dl);
  const service = new UpdateService({
    currentVersion: '0.6.1', isPackaged: true, arch: 'arm64', pid: 42, quit,
    execPath: join(apps, 'Conductor.app/Contents/MacOS/Conductor'), fetch: fetchMock as unknown as typeof fetch,
    launchInstaller: (a) => launched.push(a), tempRoot: root,
  });
  return { service, launched, quit, apps };
}

describe('update helpers', () => {
  it('compares versions numerically', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('v0.6.1', '0.6.1')).toBe(0);
    expect(compareVersions('0.6.0', '0.6.1')).toBe(-1);
  });
  it('picks the dmg for the architecture and finds the bundle', () => {
    expect(pickDmg([{ name: 'a-x64.dmg', browser_download_url: '', size: 1 }, { name: 'a-arm64.dmg', browser_download_url: '', size: 1 }], 'arm64')?.name).toBe('a-arm64.dmg');
    expect(pickDmg([{ name: 'a-x64.dmg', browser_download_url: '', size: 1 }], 'arm64')).toBeUndefined();
    expect(appBundlePath('/Applications/Conductor.app/Contents/MacOS/Conductor')).toBe('/Applications/Conductor.app');
    expect(appBundlePath('/usr/bin/node')).toBeUndefined();
  });
});

describe('UpdateService', () => {
  it('reports a newer release', async () => {
    const { service } = setup(release());
    expect(await service.check()).toMatchObject({ updateAvailable: true, latestVersion: '0.7.0', currentVersion: '0.6.1' });
  });
  it('reports up to date for the same version or a draft', async () => {
    expect((await setup(release({ tag_name: 'v0.6.1' })).service.check()).updateAvailable).toBe(false);
    expect((await setup(release({ draft: true })).service.check()).updateAvailable).toBe(false);
  });
  it('downloads, verifies, launches the installer and quits', async () => {
    const { service, launched, quit, apps } = setup(release());
    await service.install();
    expect(quit).toHaveBeenCalledOnce();
    const [script, pid, dmg, app] = launched[0]!;
    expect(pid).toBe('42'); expect(app).toBe(join(apps, 'Conductor.app'));
    expect(readFileSync(dmg!)).toEqual(bytes); expect(existsSync(script!)).toBe(true);
  });
  it('rejects a download that fails the checksum', async () => {
    const { service, launched, quit } = setup(release(), new Response(Buffer.from('tampered bytes!')));
    await expect(service.install()).rejects.toThrow(/incomplete|integrity/);
    expect(launched).toHaveLength(0); expect(quit).not.toHaveBeenCalled();
  });
  it('refuses downloads from other hosts', async () => {
    const rel = release({ assets: [{ name: 'c-arm64.dmg', browser_download_url: 'https://evil.example/c.dmg', size: 1 }] });
    await expect(setup(rel).service.install()).rejects.toThrow(/unexpected host/);
  });
});
