import { z } from 'zod';

// In-app updates. Conductor is distributed unsigned (no Apple Developer
// account), so Squirrel/electron-updater cannot be used: the main process
// instead fetches the newest GitHub Release DMG itself and swaps the app
// bundle in place (see main/domain/update-service.ts).

export interface UpdateStatus {
  currentVersion: string;
  /** Newest published version, when the check succeeded. */
  latestVersion?: string;
  updateAvailable: boolean;
  /** Release notes (markdown) of the newest version. */
  notes?: string;
  /** Release page, for manual download. */
  releaseUrl?: string;
  /** Why an update cannot be installed in place (dev build, read-only install…). */
  installBlockedReason?: string;
}

export const UPDATE_SCHEMAS = {
  'update.check': z.void(),
  'update.install': z.void(),
} as const;

export interface UpdateBridge {
  check(): Promise<UpdateStatus>;
  /** Downloads the update, then quits and relaunches the app on the new version. */
  install(): Promise<void>;
}
