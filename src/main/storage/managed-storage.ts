import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// Managed_Local_Storage keeps large artifacts, logs, and documents as blobs on
// disk and returns stable ids. DB rows reference blobs by id (metadata only),
// keeping SQLite small and page-friendly. Blobs are sharded by the first two
// hex characters of their id to avoid giant flat directories.

export interface BlobMetadata {
  id: string;
  byteLength: number;
  sha256: string;
  contentType?: string;
  createdAt: string;
}

export interface ManagedStorage {
  put(data: Buffer | string, contentType?: string): BlobMetadata;
  get(id: string): Buffer;
  has(id: string): boolean;
  delete(id: string): void;
}

export class DiskManagedStorage implements ManagedStorage {
  constructor(private readonly rootDir: string) {
    mkdirSync(this.rootDir, { recursive: true });
  }

  private pathFor(id: string): { dir: string; file: string } {
    const shard = id.slice(0, 2);
    const dir = join(this.rootDir, shard);
    return { dir, file: join(dir, id) };
  }

  put(data: Buffer | string, contentType?: string): BlobMetadata {
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
    const id = randomUUID();
    const { dir, file } = this.pathFor(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, buffer);
    const sha256 = createHash('sha256').update(buffer).digest('hex');
    return {
      id,
      byteLength: buffer.byteLength,
      sha256,
      ...(contentType !== undefined ? { contentType } : {}),
      createdAt: new Date().toISOString(),
    };
  }

  get(id: string): Buffer {
    const { file } = this.pathFor(id);
    if (!existsSync(file)) {
      throw new Error(`Blob ${id} not found`);
    }
    return readFileSync(file);
  }

  has(id: string): boolean {
    return existsSync(this.pathFor(id).file);
  }

  delete(id: string): void {
    const { file } = this.pathFor(id);
    if (existsSync(file)) {
      rmSync(file);
    }
  }
}
