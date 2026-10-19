import { describe, expect, it } from 'vitest';
import { fc } from './helpers/fast-check';
import { hasFts5, openMemoryDb } from './helpers/sqlite';

describe('test harness', () => {
  it('runs vitest assertions', () => {
    expect(1 + 1).toBe(2);
  });

  it('exposes fast-check for property tests', () => {
    fc.assert(
      fc.property(fc.integer(), fc.integer(), (a, b) => a + b === b + a),
    );
  });

  it('opens an in-memory SQLite database with FTS5 available', () => {
    const db = openMemoryDb();
    try {
      expect(hasFts5(db)).toBe(true);
      const row = db.prepare('SELECT 1 AS ok').get() as { ok: number };
      expect(row.ok).toBe(1);
    } finally {
      db.close();
    }
  });
});
