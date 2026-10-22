import { watch as fsWatch } from 'node:fs';
import { isAbsolute } from 'node:path';
import type {
  Connector,
  ConnectorConfig,
  ConnectorKind,
  ConnectorView,
  IngestedItemView,
  SyncTrigger,
} from '@shared/connector';
import type { ConnectorService } from './connector-service';
import type { IngestionWorker, SyncOutcome } from './ingestion-worker';
import { isIgnoredDirectory } from './files-connector';
import type { SecretStore } from '../secrets/secret-store';
import { EmailConnectorLifecycle } from './email-connector';
import { CalendarConnectorLifecycle, normalizeFeedUrl } from './calendar-connector';
import { SlackConnectorLifecycle } from './slack-connector';
import { NetworkAccess } from './network-access';
import { Mem0Error } from '../domain/mem0-client';

// The ConnectorRuntime is the live side of the connector framework. The
// ConnectorService persists state and the IngestionWorker performs one sync;
// this runtime decides WHEN syncs happen and keeps them from overlapping:
//
//  * user actions (connect, sync now, full resync, revoke, delete);
//  * event-driven sync: a recursive file watcher per authorized folder
//    connector, debounced, so edits are re-indexed shortly after they happen;
//  * scheduled sync: a periodic sweep of every authorized connector.
//
// Background (event/scheduled) sync only runs while the user's data-control
// `syncEnabled` preference is on. User-initiated syncs always run.

export interface Watcher {
  close(): void;
}

export type WatchFactory = (root: string, onChange: (relativePath: string | null) => void) => Watcher;

export interface ConnectorRuntimeOptions {
  connectors: ConnectorService;
  worker: IngestionWorker;
  /** Acknowledge remote content deletion before reporting success. */
  flushMemories?: () => Promise<void>;
  /** Background sync gate (data-control preference). */
  syncEnabled: () => boolean;
  /** Validates a workspace id the connector is bound to. */
  workspaceExists: (id: string) => boolean;
  /** Notified whenever a connector's state changes. */
  emit?: (event: ConnectorView | { id: string; deleted: true }) => void;
  /** Scheduled sweep interval. Default 15 minutes. 0 disables. */
  intervalMs?: number;
  /** Debounce for watcher-triggered syncs. Default 2 s. */
  debounceMs?: number;
  /** File watcher seam. Default: recursive `fs.watch`. Pass null to disable. */
  watchFactory?: WatchFactory | null;
  /** Bound on consecutive batches drained in one sync request. Default 50. */
  maxBatchesPerSync?: number;
  /** Keychain-backed credential storage for account connectors. */
  secrets?: SecretStore;
  /** Records the user's consent for a provider when they connect an account. */
  grantConsent?: (provider: string) => void;
  /** Called after each sync request settles (proactive signals, etc.). */
  onSynced?: (connector: Connector, outcome: SyncOutcome) => void;
}

export interface CreateEmailConnectorInput {
  name: string;
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
  workspaceId?: string;
}

export interface CreateCalendarConnectorInput { name: string; url: string; workspaceId?: string }

export interface CreateSlackConnectorInput { name: string; token: string; channels?: string[]; workspaceId?: string }

export interface CreateFolderConnectorInput {
  name: string;
  rootPath: string;
  workspaceId?: string;
}

const defaultWatchFactory: WatchFactory = (root, onChange) => {
  const watcher = fsWatch(root, { recursive: true, persistent: false }, (_event, filename) => {
    onChange(typeof filename === 'string' ? filename : null);
  });
  // Watch errors (folder removed, permission change) must not crash main.
  watcher.on('error', () => {});
  return watcher;
};

function changeIsRelevant(relativePath: string | null): boolean {
  if (relativePath === null) return true;
  const segments = relativePath.split(/[\\/]/);
  // Ignore churn inside dependency/build/dot folders.
  return !segments.slice(0, -1).some(isIgnoredDirectory) && !segments.at(-1)?.startsWith('.');
}

export class ConnectorRuntime {
  private readonly inFlight = new Map<string, Promise<SyncOutcome>>();
  private readonly watchers = new Map<string, Watcher>();
  private readonly debounces = new Map<string, ReturnType<typeof setTimeout>>();
  private interval: ReturnType<typeof setInterval> | undefined;
  private started = false;
  private readonly intervalMs: number;
  private readonly debounceMs: number;
  private readonly watchFactory: WatchFactory | null;
  private readonly maxBatches: number;

  constructor(private readonly options: ConnectorRuntimeOptions) {
    this.intervalMs = options.intervalMs ?? 15 * 60_000;
    this.debounceMs = options.debounceMs ?? 2_000;
    this.watchFactory = options.watchFactory === undefined ? defaultWatchFactory : options.watchFactory;
    this.maxBatches = options.maxBatchesPerSync ?? 50;
  }

  // ---- lifecycle ----

  /** Start watchers and the scheduled sweep; catch up if background sync is on. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const connector of this.options.connectors.list()) {
      if (connector.authState === 'authorized' && this.options.worker.supports(connector.kind)) {
        this.startWatcher(connector.id);
      }
    }
    if (this.intervalMs > 0) {
      this.interval = setInterval(() => { void this.sweep('scheduled'); }, this.intervalMs);
      this.interval.unref?.();
    }
    void this.sweep('scheduled');
  }

  stop(): void {
    this.started = false;
    if (this.interval !== undefined) clearInterval(this.interval);
    this.interval = undefined;
    for (const id of [...this.watchers.keys()]) this.stopWatcher(id);
  }

  // ---- queries ----

  list(): ConnectorView[] {
    return this.options.connectors.list().map((connector) => this.view(connector.id));
  }

  view(id: string): ConnectorView {
    const connector = this.options.connectors.getOrThrow(id);
    return {
      ...connector,
      itemCount: this.options.connectors.itemCount(id),
      syncing: this.inFlight.has(id),
      supported: this.options.worker.supports(connector.kind),
    };
  }

  items(id: string, limit = 200): IngestedItemView[] {
    return this.options.connectors.listIngestedItems(id).slice(0, limit).map((item) => ({
      id: item.id,
      ...(item.externalId !== undefined ? { externalId: item.externalId } : {}),
      ...(item.provenance.origin !== undefined ? { origin: item.provenance.origin } : {}),
      sourceTimestamp: item.sourceTimestamp,
      ingestedAt: item.ingestedAt,
      ...(item.memoryId !== undefined ? { memoryId: item.memoryId } : {}),
    }));
  }

  // ---- user actions ----

  /**
   * Register, authorize and start indexing a local folder. Fails without
   * leaving a connector behind if the folder cannot be read.
   */
  async createFolder(input: CreateFolderConnectorInput): Promise<ConnectorView> {
    const rootPath = input.rootPath.trim();
    if (!isAbsolute(rootPath)) throw new Error('Choose an absolute folder path.');
    if (input.workspaceId !== undefined && !this.options.workspaceExists(input.workspaceId)) {
      throw new Error('Project not found');
    }
    const config: ConnectorConfig = {
      rootPath,
      ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
    };
    const connector = this.options.connectors.register({ kind: 'files', name: input.name, config });
    try {
      await this.options.worker.authorize(connector.id);
    } catch (error) {
      this.options.connectors.delete(connector.id);
      throw error;
    }
    this.startWatcher(connector.id);
    // Initial indexing is user-initiated; it runs regardless of background sync.
    void this.sync(connector.id, 'event').catch(() => {});
    return this.view(connector.id);
  }

  /** Connect an IMAP mailbox. The password goes to the Keychain. */
  async createEmail(input: CreateEmailConnectorInput): Promise<ConnectorView> {
    const host = input.host.trim().toLowerCase();
    if (!/^[a-z0-9.-]+$/.test(host)) throw new Error('Enter a valid IMAP host name');
    return this.createAccount({
      kind: 'email', name: input.name, workspaceId: input.workspaceId,
      secret: { label: `${input.name} · IMAP password`, value: input.password },
      provider: EmailConnectorLifecycle.provider(host),
      config: (secretId) => ({ email: { host, port: input.port, secure: input.secure, user: input.user.trim(), mailbox: input.mailbox?.trim() || 'INBOX', secretId } }),
    });
  }

  /** Subscribe to an iCalendar feed. The feed URL (a credential) goes to the Keychain. */
  async createCalendar(input: CreateCalendarConnectorInput): Promise<ConnectorView> {
    const url = normalizeFeedUrl(input.url);
    const label = url.hostname.toLowerCase();
    return this.createAccount({
      kind: 'calendar', name: input.name, workspaceId: input.workspaceId,
      secret: { label: `${input.name} · calendar feed URL`, value: url.toString() },
      provider: CalendarConnectorLifecycle.provider(label),
      config: (secretId) => ({ calendar: { label, secretId } }),
    });
  }

  /** Connect a Slack workspace with a user or bot token. */
  async createSlack(input: CreateSlackConnectorInput): Promise<ConnectorView> {
    const token = input.token.trim();
    if (!/^xox[a-z]-[\w-]+$/i.test(token)) throw new Error('Enter a Slack token starting with xoxp- or xoxb-');
    const channels = (input.channels ?? []).map((c) => c.trim().replace(/^#/, '')).filter(Boolean);
    return this.createAccount({
      kind: 'messaging', name: input.name, workspaceId: input.workspaceId,
      secret: { label: `${input.name} · Slack token`, value: token },
      provider: SlackConnectorLifecycle.provider,
      config: (secretId) => ({ messaging: { provider: 'slack' as const, secretId, ...(channels.length > 0 ? { channels } : {}) } }),
    });
  }

  private async createAccount(input: {
    kind: ConnectorKind;
    name: string;
    workspaceId: string | undefined;
    secret: { label: string; value: string };
    provider: string;
    config: (secretId: string) => Partial<ConnectorConfig>;
  }): Promise<ConnectorView> {
    const secrets = this.options.secrets;
    if (secrets === undefined) throw new Error('Secure credential storage is not available');
    if (input.workspaceId !== undefined && !this.options.workspaceExists(input.workspaceId)) throw new Error('Project not found');
    const secret = await secrets.put(input.secret);
    let connector: Connector | undefined;
    try {
      connector = this.options.connectors.register({
        kind: input.kind,
        name: input.name,
        config: { ...input.config(secret.id), ...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}) },
      });
      secrets.setOwner(secret.id, NetworkAccess.subject(connector));
      // Connecting an account is the user's explicit consent for this provider.
      this.options.grantConsent?.(input.provider);
      await this.options.worker.authorize(connector.id);
    } catch (error) {
      if (connector !== undefined) this.options.connectors.delete(connector.id);
      await secrets.delete(secret.id).catch(() => undefined);
      throw error;
    }
    void this.sync(connector.id, 'event').catch(() => {});
    return this.view(connector.id);
  }

  /** Re-authorize (e.g. after revoke) and resume indexing. */
  async authorize(id: string): Promise<ConnectorView> {
    await this.options.worker.authorize(id);
    this.startWatcher(id);
    this.notify(id);
    void this.sync(id, 'event').catch(() => {});
    return this.view(id);
  }

  /**
   * Run a sync now (or join the one in flight). Drains successive batches until
   * the source reports nothing newer, bounded by `maxBatchesPerSync`.
   * `full` clears the cursor first so the whole source is re-read; hash dedup
   * prevents unchanged items from being re-ingested.
   */
  sync(id: string, trigger: SyncTrigger, options: { full?: boolean } = {}): Promise<SyncOutcome> {
    const running = this.inFlight.get(id);
    if (running !== undefined) return running;
    if (options.full === true) this.options.connectors.resetCursor(id);

    const run = (async (): Promise<SyncOutcome> => {
      let cursorBefore = this.options.connectors.getOrThrow(id).syncCursor;
      let outcome = await this.options.worker.sync(id, trigger);
      let ingested = [...outcome.ingested];
      let data = [...outcome.data];
      let batches = 1;
      // A moved cursor means the source may hold more changes than one batch.
      while (
        outcome.succeeded &&
        batches < this.maxBatches &&
        outcome.connector.syncCursor !== undefined &&
        outcome.connector.syncCursor !== cursorBefore
      ) {
        cursorBefore = outcome.connector.syncCursor;
        this.notify(id);
        outcome = await this.options.worker.sync(id, trigger);
        ingested = [...ingested, ...outcome.ingested];
        data = [...data, ...outcome.data];
        batches += 1;
      }
      const settled = { ...outcome, ingested, data };
      try { this.options.onSynced?.(settled.connector, settled); } catch { /* observers never fail a sync */ }
      return settled;
    })();

    this.inFlight.set(id, run);
    this.notify(id);
    return run.finally(() => {
      this.inFlight.delete(id);
      if (this.options.connectors.get(id) !== undefined) this.notify(id);
    });
  }

  /** Stop syncing; ingested content is retained until explicitly deleted. */
  async revoke(id: string): Promise<ConnectorView> {
    this.stopWatcher(id);
    await this.inFlight.get(id)?.catch(() => undefined);
    await this.options.worker.revoke(id);
    this.notify(id);
    return this.view(id);
  }

  /** Remove the connector together with its ingested items and memories. */
  async delete(id: string): Promise<{ removedItems: number; removedMemories: number; memoryCleanupPending?: boolean }> {
    this.stopWatcher(id);
    await this.inFlight.get(id)?.catch(() => undefined);
    const result = this.options.connectors.delete(id);
    await this.options.secrets?.deleteOwnedBy(NetworkAccess.subject({ id })).catch(() => 0);
    this.options.emit?.({ id, deleted: true });
    try { await this.options.flushMemories?.(); }
    catch (error) { if (error instanceof Mem0Error) return { ...result, memoryCleanupPending: true }; throw error; }
    return result;
  }

  // ---- internals ----

  private async sweep(trigger: SyncTrigger): Promise<void> {
    if (!this.options.syncEnabled()) return;
    for (const connector of this.options.connectors.list()) {
      if (connector.authState !== 'authorized' || !this.options.worker.supports(connector.kind)) continue;
      try {
        await this.sync(connector.id, trigger);
      } catch {
        // Failures are recorded on the connector (health/lastError).
      }
    }
  }

  private startWatcher(id: string): void {
    if (this.watchFactory === null || this.watchers.has(id)) return;
    const connector = this.options.connectors.get(id);
    const root = connector?.config.rootPath;
    if (connector?.kind !== 'files' || root === undefined) return;
    try {
      const watcher = this.watchFactory(root, (relativePath) => {
        if (!changeIsRelevant(relativePath)) return;
        this.schedule(id);
      });
      this.watchers.set(id, watcher);
    } catch {
      // The folder may be gone; scheduled/manual sync will surface the error.
    }
  }

  private stopWatcher(id: string): void {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
    const pending = this.debounces.get(id);
    if (pending !== undefined) clearTimeout(pending);
    this.debounces.delete(id);
  }

  private schedule(id: string): void {
    if (!this.options.syncEnabled()) return;
    const pending = this.debounces.get(id);
    if (pending !== undefined) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.debounces.delete(id);
      const connector = this.options.connectors.get(id);
      if (connector?.authState !== 'authorized') return;
      void this.sync(id, 'event').catch(() => {});
    }, this.debounceMs);
    timer.unref?.();
    this.debounces.set(id, timer);
  }

  private notify(id: string): void {
    if (this.options.emit === undefined) return;
    try {
      this.options.emit(this.view(id));
    } catch {
      // Emission is best effort.
    }
  }
}
