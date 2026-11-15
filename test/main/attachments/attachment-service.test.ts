import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

describe('zip attachments', () => {
  it('accepts a zip, keeps it as an archive, and delivers its contents as text with the file itself', async () => {
    const service = await setup();
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('data/rows.csv', 'id,name\n1,Ada\n');
    const dir = roots[roots.length - 1]!;
    const path = join(dir, 'export.zip');
    writeFileSync(path, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));

    const result = await service.ingest([path]);
    expect(result.rejected).toEqual([]);
    expect(result.attachments).toEqual([expect.objectContaining({ name: 'export.zip', kind: 'archive', mimeType: 'application/zip' })]);
    const id = result.attachments[0]!.id;
    expect(service.validate([id])[0]!.kind).toBe('archive');
    expect(await service.preview(id)).toMatchObject({ format: 'markdown' });

    // Other zip-based files that cannot be read stay refused.
    const deck = join(dir, 'deck.pptx');
    writeFileSync(deck, Buffer.from('PK\x03\x04not a deck'));
    expect((await service.ingest([deck])).rejected[0]).toMatchObject({ code: 'unsupported' });
  });
});
