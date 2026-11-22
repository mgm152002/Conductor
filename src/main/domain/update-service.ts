import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants, createWriteStream, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { UpdateStatus } from '@shared/update-contract';

// Self-update without a Developer ID. Updates are downloaded by this process
// (so macOS never quarantines them), the DMG's app is copied beside the
// installed one, ad-hoc re-signed (same as our releases) and swapped in by a
// detached shell script after the app quits, which then relaunches it.
// If anything fails the script restores the previous app and reopens it.

export const UPDATE_REPO = 'mgm152002/Conductor';
const MAX_DMG_BYTES = 1024 * 1024 * 1024;

interface ReleaseAsset { name: string; browser_download_url: string; size: number; digest?: string }
interface Release { tag_name: string; html_url: string; body?: string; draft?: boolean; prerelease?: boolean; assets: ReleaseAsset[] }

/** Numeric dotted-version comparison; a leading "v" and any suffix after "-" are ignored. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string): number[] => v.replace(/^v/i, '').split('-')[0]!.split('.').map((n) => Number.parseInt(n, 10) || 0);
  const x = parts(a); const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The DMG for this CPU architecture, if the release has one. */
export function pickDmg(assets: readonly ReleaseAsset[], arch: string): ReleaseAsset | undefined {
  const dmgs = assets.filter((a) => a.name.toLowerCase().endsWith('.dmg'));
  return dmgs.find((a) => a.name.includes(arch)) ?? (dmgs.length === 1 && !/arm64|x64/.test(dmgs[0]!.name) ? dmgs[0] : undefined);
}

/** The .app bundle path for an executable inside it, or undefined outside a bundle. */
export function appBundlePath(execPath: string): string | undefined {
  const match = /^(.*?\.app)\/Contents\/MacOS\//.exec(execPath);
  return match?.[1];
}

// Positional args only; nothing is interpolated into the script.
export const INSTALL_SCRIPT = `#!/bin/bash
PID="$1"; DMG="$2"; APP="$3"; LOG="$4"
exec >>"$LOG" 2>&1
set -x
STAGE="$APP.update"; OLD="$APP.old"; MNT=""
cleanup() { [ -n "$MNT" ] && hdiutil detach "$MNT" -force >/dev/null 2>&1; rm -rf "$STAGE" "$DMG"; }
restore() { echo "update failed"; cleanup; [ -d "$OLD" ] && [ ! -d "$APP" ] && mv "$OLD" "$APP"; open "$APP"; exit 1; }
for i in $(seq 1 120); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
MNT="$(mktemp -d /tmp/conductor-update.XXXXXX)"
hdiutil attach -nobrowse -noverify -readonly -mountpoint "$MNT" "$DMG" || restore
SRC="$(find "$MNT" -maxdepth 1 -name '*.app' | head -n 1)"
[ -n "$SRC" ] || restore
rm -rf "$STAGE" "$OLD"
ditto "$SRC" "$STAGE" || restore
xattr -cr "$STAGE"
codesign --force --deep --sign - "$STAGE" || restore
mv "$APP" "$OLD" || restore
mv "$STAGE" "$APP" || restore
rm -rf "$OLD"
cleanup
open "$APP"
`;

export interface UpdateServiceDeps {
  currentVersion: string;
  isPackaged: boolean;
  execPath: string;
  arch: string;
  pid: number;
  /** Quit the app so the install script can replace it. */
  quit: () => void;
  fetch?: typeof fetch;
  /** Overridable in tests. */
  launchInstaller?: (args: string[]) => void;
  tempRoot?: string;
}

export class UpdateService {
  private release: Release | undefined;
  private installing = false;

  constructor(private readonly deps: UpdateServiceDeps) {}

  private get http(): typeof fetch { return this.deps.fetch ?? fetch; }

  private blockedReason(): string | undefined {
    if (!this.deps.isPackaged) return 'Updates install only in the packaged app.';
    if (process.platform !== 'darwin') return 'In-app updates are only available on macOS.';
    const bundle = appBundlePath(this.deps.execPath);
    if (bundle === undefined) return 'Conductor is not running from an app bundle.';
    try { accessSync(dirname(bundle), constants.W_OK); } catch {
      return `Conductor cannot write to ${dirname(bundle)}. Move it to Applications (or a folder you own) and retry.`;
    }
    return undefined;
  }

  async check(): Promise<UpdateStatus> {
    const res = await this.http(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'conductor-updater' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Could not check for updates (GitHub returned ${res.status}).`);
    const release = await res.json() as Release;
    this.release = release;
    const latest = release.tag_name.replace(/^v/i, '');
    const available = release.draft !== true && release.prerelease !== true
      && compareVersions(latest, this.deps.currentVersion) > 0 && pickDmg(release.assets, this.deps.arch) !== undefined;
    const blocked = this.blockedReason();
    return {
      currentVersion: this.deps.currentVersion,
      latestVersion: latest,
      updateAvailable: available,
      ...(release.body ? { notes: release.body } : {}),
      releaseUrl: release.html_url,
      ...(blocked !== undefined ? { installBlockedReason: blocked } : {}),
    };
  }

  async install(): Promise<void> {
    if (this.installing) throw new Error('An update is already being installed.');
    const blocked = this.blockedReason();
    if (blocked !== undefined) throw new Error(blocked);
    this.installing = true;
    try {
      const status = await this.check();
      const asset = status.updateAvailable && this.release !== undefined ? pickDmg(this.release.assets, this.deps.arch) : undefined;
      if (asset === undefined) throw new Error('Conductor is already up to date.');
      const url = new URL(asset.browser_download_url);
      if (url.protocol !== 'https:' || url.hostname !== 'github.com') throw new Error('Refusing to download an update from an unexpected host.');
      if (asset.size > MAX_DMG_BYTES) throw new Error('The update is larger than expected.');

      const dir = mkdtempSync(join(this.deps.tempRoot ?? tmpdir(), 'conductor-update-'));
      try {
        const dmg = join(dir, asset.name.replace(/[^\w.-]/g, '_'));
        const res = await this.http(url, { headers: { 'User-Agent': 'conductor-updater' }, signal: AbortSignal.timeout(15 * 60_000) });
        if (!res.ok || res.body === null) throw new Error(`Could not download the update (${res.status}).`);
        const hash = createHash('sha256');
        let bytes = 0;
        const source = Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]);
        source.on('data', (chunk: Buffer) => {
          bytes += chunk.length; hash.update(chunk);
          if (bytes > MAX_DMG_BYTES) source.destroy(new Error('The update is larger than expected.'));
        });
        await pipeline(source, createWriteStream(dmg));
        if (asset.size > 0 && bytes !== asset.size) throw new Error('The downloaded update is incomplete. Try again.');
        const expected = asset.digest?.startsWith('sha256:') ? asset.digest.slice(7) : undefined;
        if (expected !== undefined && hash.digest('hex') !== expected.toLowerCase()) throw new Error('The downloaded update failed its integrity check.');

        const script = join(dir, 'install.sh');
        writeFileSync(script, INSTALL_SCRIPT, { mode: 0o700 });
        const bundle = appBundlePath(this.deps.execPath)!;
        const logDir = join(this.deps.tempRoot ?? tmpdir(), 'conductor-updater-logs');
        mkdirSync(logDir, { recursive: true });
        this.launch([script, String(this.deps.pid), dmg, bundle, join(logDir, 'update.log')]);
      } catch (error) {
        rmSync(dir, { recursive: true, force: true });
        throw error;
      }
      this.deps.quit();
    } finally {
      this.installing = false;
    }
  }

  private launch(args: string[]): void {
    if (this.deps.launchInstaller !== undefined) { this.deps.launchInstaller(args); return; }
    const child = spawn('/bin/bash', args, { detached: true, stdio: 'ignore' });
    child.unref();
  }
}
