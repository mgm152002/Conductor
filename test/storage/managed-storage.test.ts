import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DiskManagedStorage } from '@main/storage/managed-storage';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'conductor-blob-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('DiskManagedStorage', () => {
  it('stores and retrieves a blob by id', () => {
    const storage = new DiskManagedStorage(root);
    const meta = storage.put('hello artifact', 'text/plain');

    expect(meta.byteLength).toBe(Buffer.byteLength('hello artifact'));
    expect(meta.contentType).toBe('text/plain');
    expect(storage.has(meta.id)).toBe(true);
    expect(storage.get(meta.id).toString('utf8')).toBe('hello artifact');
  });

  it('returns distinct ids and content hashes for distinct blobs', () => {
    const storage = new DiskManagedStorage(root);
    const a = storage.put('one');
    const b = storage.put('two');
    expect(a.id).not.toBe(b.id);
    expect(a.sha256).not.toBe(b.sha256);
  });

  it('deletes a blob', () => {
    const storage = new DiskManagedStorage(root);
    const meta = storage.put(Buffer.from([1, 2, 3]));
    storage.delete(meta.id);
    expect(storage.has(meta.id)).toBe(false);
    expect(() => storage.get(meta.id)).toThrow();
  });
});
