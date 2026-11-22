import { UPDATE_SCHEMAS } from '@shared/update-contract';
import type { UpdateService } from '../domain/update-service';
import type { IpcRouter } from './router';

export function registerUpdateHandlers(router: IpcRouter, updates: UpdateService): void {
  router.handle('update.check', UPDATE_SCHEMAS['update.check'], () => updates.check());
  router.handle('update.install', UPDATE_SCHEMAS['update.install'], () => updates.install());
}
