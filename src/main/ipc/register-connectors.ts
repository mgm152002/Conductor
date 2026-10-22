import { BrowserWindow, dialog, type WebContents } from 'electron';
import { CONNECTOR_SCHEMAS, type ConnectorEvent } from '@shared/connector-contract';
import type { ConnectorRuntime } from '../connectors/connector-runtime';
import type { IpcRouter } from './router';

/**
 * Relays connector state changes to the renderer over the allowlisted
 * `connector.updated` channel. The resolver is installed once the window
 * exists; emits before that (or after it closes) are dropped.
 */
export class IpcConnectorEventEmitter {
  private getWebContents: () => WebContents | null = () => null;

  constructor(private readonly router: IpcRouter) {}

  setWebContentsResolver(resolver: () => WebContents | null): void {
    this.getWebContents = resolver;
  }

  emit(event: ConnectorEvent): void {
    const target = this.getWebContents();
    if (target === null || target.isDestroyed()) return;
    try {
      this.router.emit(target, 'connector.updated', event);
    } catch {
      // Transport failures never affect connector state.
    }
  }
}

export function registerConnectorHandlers({ router, runtime }: { router: IpcRouter; runtime: ConnectorRuntime }): void {
  router.handle('connector.list', CONNECTOR_SCHEMAS['connector.list'], () => runtime.list());
  router.handle('connector.createFolder', CONNECTOR_SCHEMAS['connector.createFolder'], (_event, input) =>
    runtime.createFolder({
      name: input.name,
      rootPath: input.rootPath,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    }));
  router.handle('connector.createEmail', CONNECTOR_SCHEMAS['connector.createEmail'], (_event, input) =>
    runtime.createEmail({
      name: input.name, host: input.host, port: input.port, secure: input.secure, user: input.user, password: input.password,
      ...(input.mailbox !== undefined ? { mailbox: input.mailbox } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    }));
  router.handle('connector.createCalendar', CONNECTOR_SCHEMAS['connector.createCalendar'], (_event, input) =>
    runtime.createCalendar({ name: input.name, url: input.url, ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) }));
  router.handle('connector.createSlack', CONNECTOR_SCHEMAS['connector.createSlack'], (_event, input) =>
    runtime.createSlack({
      name: input.name, token: input.token,
      ...(input.channels !== undefined ? { channels: input.channels } : {}),
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    }));
  router.handle('connector.authorize', CONNECTOR_SCHEMAS['connector.authorize'], (_event, input) => runtime.authorize(input.id));
  router.handle('connector.sync', CONNECTOR_SCHEMAS['connector.sync'], async (_event, input) => {
    const outcome = await runtime.sync(input.id, 'event', { full: input.full === true });
    return {
      connector: runtime.view(input.id),
      succeeded: outcome.succeeded,
      ingestedCount: outcome.ingested.length,
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
    };
  });
  router.handle('connector.revoke', CONNECTOR_SCHEMAS['connector.revoke'], (_event, input) => runtime.revoke(input.id));
  router.handle('connector.delete', CONNECTOR_SCHEMAS['connector.delete'], async (_event, input) => ({
    id: input.id,
    ...(await runtime.delete(input.id)),
  }));
  router.handle('connector.items', CONNECTOR_SCHEMAS['connector.items'], (_event, input) => runtime.items(input.id, input.limit));

  // Native folder picker. Only the chosen path crosses IPC; the renderer never
  // gets filesystem access of its own.
  router.handle('system.pickDirectory', CONNECTOR_SCHEMAS['system.pickDirectory'], async (event, input) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: input?.title ?? 'Choose a folder',
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
    };
    const result = owner !== null ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
}
