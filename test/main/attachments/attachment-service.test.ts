import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteStore } from '@main/db/store';
import { DiskManagedStorage } from '@main/storage/managed-storage';
import { AttachmentService } from '@main/attachments/attachment-service';

const roots: string[] = [];
const stores: SqliteStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<AttachmentService> {
  const root = mkdtempSync(join(tmpdir(), 'conductor-attachment-bytes-'));
  roots.push(root);
  const store = new SqliteStore(join(root, 'conductor.db'));
  stores.push(store);
  await store.migrate();
  return new AttachmentService(store, new DiskManagedStorage(join(root, 'blobs')));
}

describe('clipboard attachment ingestion', () => {
  it('stores pathless image bytes using detected content rather than claimed metadata', async () => {
    const service = await setup();
    const result = await service.ingestBytes({
      name: 'misleading.txt',
      mimeType: 'image/jpeg',
      bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    });

    expect(result.rejected).toEqual([]);
    expect(result.attachments).toEqual([
      expect.objectContaining({ name: 'misleading.txt', kind: 'image', mimeType: 'image/png', sizeBytes: 8 }),
    ]);
  });

  it('rejects bytes that are not actually an image', async () => {
    const service = await setup();
    const result = await service.ingestBytes({
      name: 'pretend.png', mimeType: 'image/png', bytes: new TextEncoder().encode('plain text'),
    });

    expect(result.attachments).toEqual([]);
    expect(result.rejected[0]).toMatchObject({ fileName: 'pretend.png', code: 'unsupported' });
  });
});
