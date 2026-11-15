import { inflateRawSync } from 'node:zlib';
import type { ArchiveEntry } from '../../shared/file-preview';

// A read-only zip reader over bytes in memory. Nothing is ever written to
// disk, entry names are only reported (never used as paths), and every read
// is capped, so a hostile archive can neither escape a folder nor expand
// without bound.

const MAX_LISTED_ENTRIES = 500;

export interface ZipEntry extends ArchiveEntry {
  /** 0 = stored, 8 = deflate; anything else cannot be read here. */
  method: number;
  compressedBytes: number;
  encrypted: boolean;
  /** Where the entry's local header starts. */
  offset: number;
}

const view = (bytes: Uint8Array): Buffer => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

/** Whether the bytes start like a zip (including an empty one). */
export function hasZipSignature(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06));
}

/**
 * List a zip's entries from its central directory. Returns null when the
 * bytes are not a readable zip. Nothing is decompressed.
 */
export function listZipEntries(bytes: Uint8Array, limit = MAX_LISTED_ENTRIES): { entries: ZipEntry[]; entryCount: number } | null {
  const buffer = view(bytes);
  if (buffer.length < 22) return null;
  // The end-of-central-directory record sits in the last 64 KiB + 22 bytes.
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const entryCount = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  for (let n = 0; n < entryCount && entries.length < limit; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedBytes = buffer.readUInt32LE(offset + 20);
    const sizeBytes = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const path = buffer.toString('utf8', offset + 46, Math.min(buffer.length, offset + 46 + nameLength)).replace(/\\/g, '/');
    if (path !== '') entries.push({ path, sizeBytes, directory: path.endsWith('/'), method, compressedBytes, encrypted: (flags & 1) === 1, offset: local });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return { entries, entryCount };
}

/**
 * One entry's bytes, or null when it cannot be read here: a folder, an
 * encrypted or zip64 entry, an unknown compression method, a corrupt record,
 * or more than `maxBytes` once unpacked.
 */
export function readZipEntry(bytes: Uint8Array, entry: ZipEntry, maxBytes: number): Buffer | null {
  if (entry.directory || entry.encrypted || entry.sizeBytes > maxBytes || entry.sizeBytes === 0xffffffff || entry.compressedBytes === 0xffffffff) return null;
  const buffer = view(bytes);
  const at = entry.offset;
  if (at + 30 > buffer.length || buffer.readUInt32LE(at) !== 0x04034b50) return null;
  const start = at + 30 + buffer.readUInt16LE(at + 26) + buffer.readUInt16LE(at + 28);
  const data = buffer.subarray(start, start + entry.compressedBytes);
  if (data.length !== entry.compressedBytes) return null;
  try {
    if (entry.method === 0) return data.length <= maxBytes ? Buffer.from(data) : null;
    // The declared size is the archive's own claim; the cap is what holds.
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  } catch { /* corrupt, or larger than it claimed */ }
  return null;
}
