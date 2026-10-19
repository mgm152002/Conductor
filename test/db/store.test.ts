import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteStore } from '@main/db/store';
import { MigrationError, RestoreError, type Migration } from '@main/db/types';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'conductor-store-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function dbPath(name = 'app.db'): string {
  return join(workDir, name);
}

const mA: Migration = {
  version: 1,
  name: 'a',
  up: (tx) => tx.db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY)'),
};
const mB: Migration = {
  version: 2,
  name: 'b',
  up: (tx) => tx.db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY)'),
};

describe('SqliteStore migrations', () => {
  it('applies migrations in order and advances schema_version', async () => {
    const store = new SqliteStore(dbPath(), { migrations: [mA, mB] });
    expect(store.schemaVersion()).toBe(0);
    await store.migrate();
    expect(store.schemaVersion()).toBe(2);
    store.close();
  });

  it('is a no-op when re-run at the latest version', async () => {
    const store = new SqliteStore(dbPath(), { migrations: [mA, mB] });
    await store.migrate();
    await store.migrate(); // second run must not throw or change state
    expect(store.schemaVersion()).toBe(2);
    store.close();
  });

  it('rejects gapped/out-of-order migration sets at construction', () => {
    const gapped: Migration = { version: 3, name: 'c', up: () => {} };
    expect(
      () => new SqliteStore(dbPath(), { migrations: [mA, gapped] }),
    ).toThrow(MigrationError);
  });

  it('rolls back a failing step and refuses to run against a partial DB', async () => {
    const bad: Migration = {
      version: 2,
      name: 'bad',
      up: (tx) => {
        tx.db.exec('CREATE TABLE ok (id INTEGER PRIMARY KEY)');
        tx.db.exec('THIS IS NOT SQL'); // forces failure mid-step
      },
    };
    const store = new SqliteStore(dbPath(), { migrations: [mA, bad] });

    await expect(store.migrate()).rejects.toBeInstanceOf(MigrationError);
    // Version 1 applied; version 2 rolled back, so schema_version stays at 1.
    expect(store.schemaVersion()).toBe(1);
    // The failing table must not exist (atomic rollback).
    const tbl = store.db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='ok'`)
      .get();
    expect(tbl).toBeUndefined();

    // A subsequent run refuses because failed_version is recorded.
    await expect(store.migrate()).rejects.toBeInstanceOf(MigrationError);
    store.close();
  });
});

describe('SqliteStore backup/restore', () => {
  it('backs up and restores a consistent database', async () => {
    const store = new SqliteStore(dbPath(), { migrations: [mA] });
    await store.migrate();
    store.db.prepare('INSERT INTO a (id) VALUES (42)').run();

    const backupPath = dbPath('backup.db');
    await store.backup(backupPath);

    // Mutate the live DB, then restore from backup and confirm it reverts.
    store.db.prepare('INSERT INTO a (id) VALUES (99)').run();
    await store.restore(backupPath);

    const rows = store.db.prepare('SELECT id FROM a ORDER BY id').all();
    expect(rows).toEqual([{ id: 42 }]);
    store.close();
  });

  it('rejects restore from a missing source', async () => {
    const store = new SqliteStore(dbPath(), { migrations: [mA] });
    await store.migrate();
    await expect(store.restore(dbPath('nope.db'))).rejects.toBeInstanceOf(
      RestoreError,
    );
    store.close();
  });

  it('rejects restore from an inconsistent/non-SQLite source', async () => {
    const store = new SqliteStore(dbPath(), { migrations: [mA] });
    await store.migrate();
    const junk = dbPath('junk.db');
    writeFileSync(junk, 'this is not a sqlite database');
    await expect(store.restore(junk)).rejects.toBeInstanceOf(RestoreError);
    store.close();
  });
});
