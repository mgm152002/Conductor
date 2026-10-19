import { existsSync } from 'node:fs';
import Database from 'better-sqlite3';
import { MIGRATIONS } from './migrations/index';
import {
  BackupError,
  MigrationError,
  RestoreError,
  type Database as Db,
  type Migration,
  type Store,
  type Tx,
} from './types';

// SqliteStore owns relational data and workflow state. It opens SQLite,
// runs forward-only versioned migrations atomically per step, and
// supports consistency-checked backup/restore. The migration runner is the
// subtle part: each step runs in its own transaction and bumps schema_version
// in the same transaction, so a failing step leaves schema_version untouched
// and the app can refuse to run against a partially-migrated DB.

export interface SqliteStoreOptions {
  /** Migration set to apply. Defaults to the built-in MIGRATIONS. */
  migrations?: readonly Migration[];
}

export class SqliteStore implements Store {
  readonly db: Db;
  private readonly migrations: readonly Migration[];

  constructor(dbPath: string, options: SqliteStoreOptions = {}) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrations = [...(options.migrations ?? MIGRATIONS)].sort(
      (a, b) => a.version - b.version,
    );
    this.assertContiguousMigrations();
    this.ensureVersionTable();
  }

  /** Guard against gapped or duplicate migration versions at construction. */
  private assertContiguousMigrations(): void {
    this.migrations.forEach((migration, index) => {
      const expected = index + 1;
      if (migration.version !== expected) {
        throw new MigrationError(
          `Migrations must be a gapless 1..N sequence; expected version ${expected} but found ${migration.version} ("${migration.name}")`,
          migration.version,
        );
      }
    });
  }

  private ensureVersionTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_version (
        id              INTEGER PRIMARY KEY CHECK (id = 1),
        version         INTEGER NOT NULL,
        failed_version  INTEGER,
        updated_at      TEXT NOT NULL
      );
    `);
    const row = this.db
      .prepare('SELECT version FROM schema_version WHERE id = 1')
      .get() as { version: number } | undefined;
    if (row === undefined) {
      this.db
        .prepare(
          'INSERT INTO schema_version (id, version, failed_version, updated_at) VALUES (1, 0, NULL, ?)',
        )
        .run(new Date().toISOString());
    }
  }

  schemaVersion(): number {
    const row = this.db
      .prepare('SELECT version FROM schema_version WHERE id = 1')
      .get() as { version: number };
    return row.version;
  }

  private failedVersion(): number | null {
    const row = this.db
      .prepare('SELECT failed_version FROM schema_version WHERE id = 1')
      .get() as { failed_version: number | null };
    return row.failed_version;
  }

  transaction<T>(fn: (tx: Tx) => T): T {
    const runner = this.db.transaction((tx: Tx) => fn(tx));
    return runner({ db: this.db });
  }

  async migrate(): Promise<void> {
    // Refuse to run against a DB whose last migration attempt failed.
    const failed = this.failedVersion();
    if (failed !== null) {
      throw new MigrationError(
        `Database is partially migrated: migration version ${failed} previously failed. Restore from backup before continuing.`,
        failed,
      );
    }

    const latest = this.migrations.length;
    let current = this.schemaVersion();

    if (current === latest) {
      return; // no-op when already current
    }
    if (current > latest) {
      throw new MigrationError(
        `Database schema version ${current} is newer than the known latest ${latest}; refusing to run.`,
      );
    }

    for (const migration of this.migrations) {
      if (migration.version <= current) {
        continue;
      }
      // Each step is atomic: run up() and bump the version in one transaction.
      try {
        const step = this.db.transaction(() => {
          migration.up({ db: this.db });
          this.db
            .prepare(
              'UPDATE schema_version SET version = ?, updated_at = ? WHERE id = 1',
            )
            .run(migration.version, new Date().toISOString());
        });
        step();
        current = migration.version;
      } catch (err) {
        // Transaction already rolled back; record the failing version so a
        // subsequent run refuses to proceed against a partial DB.
        this.db
          .prepare(
            'UPDATE schema_version SET failed_version = ?, updated_at = ? WHERE id = 1',
          )
          .run(migration.version, new Date().toISOString());
        const detail = err instanceof Error ? err.message : String(err);
        throw new MigrationError(
          `Migration ${migration.version} ("${migration.name}") failed and was rolled back: ${detail}`,
          migration.version,
        );
      }
    }
  }

  async backup(destPath: string): Promise<void> {
    if (destPath.trim() === '') {
      throw new BackupError('Backup destination path is empty');
    }
    try {
      await this.db.backup(destPath);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new BackupError(
        `Backup to "${destPath}" failed: ${detail}`,
      );
    }
  }

  async restore(srcPath: string): Promise<void> {
    if (!existsSync(srcPath)) {
      throw new RestoreError(`Restore source "${srcPath}" does not exist`);
    }

    // Verify the source is a consistent SQLite DB before touching the active
    // one. We open it read-only and run integrity_check; only on success do we
    // replace the active DB contents.
    let source: Db | undefined;
    try {
      source = new Database(srcPath, { readonly: true, fileMustExist: true });
      const result = source.pragma('integrity_check') as { integrity_check: string }[];
      const ok = result.length === 1 && result[0]?.integrity_check === 'ok';
      if (!ok) {
        throw new RestoreError(
          `Restore source "${srcPath}" failed integrity check`,
        );
      }
    } catch (err) {
      source?.close();
      if (err instanceof RestoreError) {
        throw err;
      }
      const detail = err instanceof Error ? err.message : String(err);
      throw new RestoreError(
        `Restore source "${srcPath}" is unreadable or inconsistent: ${detail}`,
      );
    } finally {
      source?.close();
    }

    // Source is consistent — replace the active DB. Close the active handle,
    // copy source pages into the active path via SQLite's online backup, then
    // reopen. Using backup() (not a raw file copy) produces a clean, fully
    // checkpointed DB without stray WAL/SHM sidecars.
    const activePath = this.db.name;
    if (activePath === ':memory:') {
      throw new RestoreError('Cannot restore over an in-memory database');
    }
    try {
      this.db.close();
      const src = new Database(srcPath, { readonly: true, fileMustExist: true });
      try {
        await src.backup(activePath);
      } finally {
        src.close();
      }
      (this as { db: Db }).db = new Database(activePath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new RestoreError(`Restore failed while replacing active DB: ${detail}`);
    }
  }

  close(): void {
    this.db.close();
  }
}
