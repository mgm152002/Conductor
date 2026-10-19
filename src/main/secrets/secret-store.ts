import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { Store } from '../db/types';
import type { AuditLog } from '../domain/audit-log';
import type { PermissionGate } from './secrets-proxy';
import { DEFAULT_KEYCHAIN_SERVICE, encodeKeychainValue, type KeychainQuery } from './keychain-resolver';

// Write side of Conductor's secrets: values go to the macOS Keychain (service
// "Conductor", account = secret id) and only metadata (id, label, owner) is
// stored in SQLite. Values are read back exclusively by the SecretsProxy at
// egress, after its permission gate, so connectors and integrations only ever
// hold `{{SECRET:id}}` placeholders.

export interface SecretMetadata {
  id: string;
  label: string;
  /** The integration allowed to use this secret, e.g. `connector:<id>`. */
  owner?: string;
  createdAt: string;
}

export interface KeychainWriter {
  write(query: KeychainQuery, value: string): Promise<void>;
  remove(query: KeychainQuery): Promise<void>;
}

/**
 * Default writer using `/usr/bin/security`. The value is sent hex-encoded on
 * the stdin of an interactive `security -i` session, so it never appears in a
 * process argument list.
 */
export const defaultKeychainWriter: KeychainWriter = {
  write({ service, account }, value) {
    if (!/^[\w.:-]+$/.test(service) || !/^[\w.:-]+$/.test(account)) {
      return Promise.reject(new Error('Invalid keychain item name'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0 && !/error|fail/i.test(stderr)) resolve();
        else reject(new Error(`Keychain write failed${stderr.trim() ? `: ${stderr.trim().slice(0, 200)}` : ''}`));
      });
      // `security -w` prints non-ASCII values as hex on read, so store an
      // ASCII envelope the reader decodes (see decodeKeychainValue).
      const hex = Buffer.from(encodeKeychainValue(value), 'utf8').toString('hex');
      child.stdin.end(`add-generic-password -U -s ${service} -a ${account} -X ${hex}\n`);
    });
  },
  remove({ service, account }) {
    return new Promise((resolve, reject) => {
      execFile('/usr/bin/security', ['delete-generic-password', '-s', service, '-a', account], (error, _stdout, stderr) => {
        if (error === null || /could not be found/i.test(stderr)) resolve();
        else reject(new Error(`Keychain delete failed: ${stderr.trim() || error.message}`));
      });
    });
  },
};

interface SecretRow { id: string; label: string; owner: string | null; created_at: string }

function rowToMeta(row: SecretRow): SecretMetadata {
  return { id: row.id, label: row.label, ...(row.owner !== null ? { owner: row.owner } : {}), createdAt: row.created_at };
}

export class SecretStore {
  constructor(
    private readonly store: Store,
    private readonly audit: AuditLog,
    private readonly writer: KeychainWriter = defaultKeychainWriter,
    private readonly service: string = DEFAULT_KEYCHAIN_SERVICE,
  ) {}

  /** Store a value in the Keychain and record its metadata. Returns the placeholder-able id. */
  async put(input: { label: string; value: string; owner?: string }): Promise<SecretMetadata> {
    const label = input.label.trim();
    if (label === '' || label.length > 255) throw new Error('Secret label must be 1–255 characters');
    if (input.value.length === 0 || input.value.length > 64 * 1024) throw new Error('Secret value must be 1 byte to 64 KiB');
    const id = `sec_${randomUUID().replace(/-/g, '')}`;
    await this.writer.write({ service: this.service, account: id }, input.value);
    const createdAt = new Date().toISOString();
    this.store.db.prepare('INSERT INTO secrets (id, label, owner, created_at) VALUES (?, ?, ?, ?)')
      .run(id, label, input.owner ?? null, createdAt);
    this.audit.append({ actor: 'user', action: 'secret.stored', target: id, redactedPayload: { label, owner: input.owner ?? null } });
    return { id, label, ...(input.owner !== undefined ? { owner: input.owner } : {}), createdAt };
  }

  /** Assign (or reassign) the integration allowed to use a secret. */
  setOwner(id: string, owner: string): void {
    this.store.db.prepare('UPDATE secrets SET owner = ? WHERE id = ?').run(owner, id);
  }

  get(id: string): SecretMetadata | undefined {
    const row = this.store.db.prepare('SELECT * FROM secrets WHERE id = ?').get(id) as SecretRow | undefined;
    return row === undefined ? undefined : rowToMeta(row);
  }

  list(): SecretMetadata[] {
    return (this.store.db.prepare('SELECT * FROM secrets ORDER BY created_at DESC, rowid DESC').all() as SecretRow[]).map(rowToMeta);
  }

  /** Remove the Keychain item and its metadata. */
  async delete(id: string): Promise<void> {
    if (this.get(id) === undefined) return;
    await this.writer.remove({ service: this.service, account: id });
    this.store.db.prepare('DELETE FROM secrets WHERE id = ?').run(id);
    this.audit.append({ actor: 'user', action: 'secret.deleted', target: id });
  }

  /** Delete every secret owned by an integration (used when it is removed). */
  async deleteOwnedBy(owner: string): Promise<number> {
    const owned = this.list().filter((secret) => secret.owner === owner);
    for (const secret of owned) await this.delete(secret.id);
    return owned.length;
  }
}

/**
 * Permission gate for the SecretsProxy: a secret may only be substituted into
 * a request made by the integration that owns it. Unowned secrets are never
 * released.
 */
export function ownershipGate(secrets: SecretStore): PermissionGate {
  return { allows: ({ adapterId, secretId }) => secrets.get(secretId)?.owner === adapterId };
}
