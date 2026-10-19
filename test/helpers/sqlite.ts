import Database from 'better-sqlite3';

/**
 * Open an in-memory SQLite database for a single test. FTS5 ships compiled
 * into better-sqlite3, so full-text search tables work without extra setup.
 * Callers should {@link Database.close} the handle in an `afterEach` (or rely
 * on process teardown for throwaway cases).
 */
export function openMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** True when the linked SQLite build exposes the FTS5 module. */
export function hasFts5(db: Database.Database): boolean {
  try {
    db.exec('CREATE VIRTUAL TABLE _fts5_probe USING fts5(content);');
    db.exec('DROP TABLE _fts5_probe;');
    return true;
  } catch {
    return false;
  }
}
