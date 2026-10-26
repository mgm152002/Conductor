import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, mkdirSync, openSync, readSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { dialog, nativeImage } from 'electron';
import {
  AttachmentIdSchema, AttachmentIdsSchema, attachmentBatchError, attachmentSizeError,
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_NAME_LENGTH,
  type AttachmentIngestResult, type AttachmentPickResult, type AttachmentPreview,
  type AttachmentIngestBytesInput, type AttachmentRef, type AttachmentSummary, type MaterializedAttachment,
} from '../../shared/attachments';
import type { Store } from '../db/types';
import type { ManagedStorage } from '../storage/managed-storage';
import { redact } from '../ipc/redaction';
import { detectDocumentFormat, formatDocument, hasImageSignature } from './document-format';

interface Row {
  id: string; name: string; kind: AttachmentRef['kind']; mime_type: string;
  size_bytes: number; sha256: string; blob_id: string; thumbnail_blob_id: string | null; created_at: string;
}
type Owner = { taskId: string } | { messageId: string };
const safeName = (path: string): string => ((redact(basename(path.replace(/\\/g, '/'))) as string)
  .replace(/[\x00-\x1f\x7f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, '_')
  .replace(/^\.+/, '').trim().slice(0, MAX_ATTACHMENT_NAME_LENGTH) || 'attachment');
const copyName = (name: string): string => {
  let result = '';
  for (const char of safeName(name)) {
    if (Buffer.byteLength(result + char) > 170) break;
    result += char;
  }
  return result;
};
const summary = (r: Row): AttachmentSummary => ({ id: r.id, name: safeName(r.name), kind: r.kind, mimeType: r.mime_type, sizeBytes: r.size_bytes });
const ref = (r: Row): AttachmentRef => ({ ...summary(r), sha256: r.sha256, createdAt: r.created_at });
const location = (owner: Owner) => 'taskId' in owner
  ? { table: 'task_attachments', key: 'task_id', id: owner.taskId }
  : { table: 'chat_message_attachments', key: 'message_id', id: owner.messageId };

/** Main-process byte authority. No public preview API accepts a filesystem path. */
export class AttachmentService {
  constructor(private readonly store: Store, private readonly storage: ManagedStorage) {}

  async pick(): Promise<AttachmentPickResult> {
    const result = await dialog.showOpenDialog({ title: 'Attach files', properties: ['openFile', 'multiSelections'] });
    return { cancelled: result.canceled, ...(result.canceled ? { attachments: [], rejected: [] } : await this.ingest(result.filePaths)) };
  }

  async ingest(paths: readonly string[]): Promise<AttachmentIngestResult> {
    const attachments: AttachmentSummary[] = [];
    const rejected: AttachmentIngestResult['rejected'][number][] = [];
    const batchError = attachmentBatchError(paths.length);
    if (batchError) return { attachments, rejected: [{ fileName: 'Selection', code: 'limit_exceeded', message: batchError }] };
    let total = 0;
    for (const path of paths) {
      const name = safeName(path);
      let fd: number | undefined;
      try {
        if (!isAbsolute(path)) throw new Error('Invalid path');
        // No symlinks, devices or unbounded readFile allocations. Validate the opened inode.
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        const stat = fstatSync(fd);
        if (!stat.isFile()) throw new Error('Not a regular file');
        const error = attachmentSizeError(stat.size) ?? attachmentBatchError(paths.length, total + stat.size);
        if (error) {
          rejected.push({ fileName: name, code: stat.size === 0 ? 'empty' : stat.size > MAX_ATTACHMENT_BYTES ? 'too_large' : 'limit_exceeded', message: error });
          continue;
        }
        const buffer = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < buffer.length) {
          const count = readSync(fd, buffer, length, buffer.length - length, null);
          if (!count) break;
          length += count;
        }
        if (length !== stat.size) throw new Error('File changed during ingestion');
        const bytes = buffer.subarray(0, length);
        const format = detectDocumentFormat(name, bytes);
        if (format.kind === 'unsupported') {
          rejected.push({ fileName: name, code: 'unsupported', message: 'This file type is not supported.' });
          continue;
        }
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const existing = this.store.db.prepare('SELECT * FROM attachments WHERE sha256=? LIMIT 1').get(sha256) as Row | undefined;
        const blobId = existing?.blob_id ?? this.storage.put(bytes, format.mimeType).id;
        const id = randomUUID();
        try {
          this.store.db.prepare('INSERT INTO attachments (id,name,kind,mime_type,size_bytes,sha256,blob_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
            .run(id, name, format.kind, format.mimeType, length, sha256, blobId, new Date().toISOString());
        } catch (error) { if (!existing) this.storage.delete(blobId); throw error; }
        total += length;
        attachments.push(summary(this.row(id)));
      } catch {
        rejected.push({ fileName: name, code: 'unreadable', message: 'The file could not be read. Choose a readable local file and try again.' });
      } finally { if (fd !== undefined) closeSync(fd); }
    }
    return { attachments, rejected };
  }

  /** Ingest a sandboxed clipboard image without accepting a renderer filesystem path. */
  async ingestBytes(input: AttachmentIngestBytesInput): Promise<AttachmentIngestResult> {
    const name = safeName(input.name);
    const bytes = Buffer.from(input.bytes);
    const sizeError = attachmentSizeError(bytes.byteLength) ?? attachmentBatchError(1, bytes.byteLength);
    if (sizeError) return { attachments: [], rejected: [{ fileName: name, code: bytes.byteLength === 0 ? 'empty' : bytes.byteLength > MAX_ATTACHMENT_BYTES ? 'too_large' : 'limit_exceeded', message: sizeError }] };
    const format = detectDocumentFormat(name, bytes);
    // Clipboard byte ingress is intentionally image-only. The claimed MIME
    // type is renderer metadata; signature detection remains authoritative.
    if (format.kind !== 'image' || !hasImageSignature(bytes)) return { attachments: [], rejected: [{ fileName: name, code: 'unsupported', message: 'Only image data can be pasted directly. Use Attach files for documents.' }] };
    try {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const existing = this.store.db.prepare('SELECT * FROM attachments WHERE sha256=? LIMIT 1').get(sha256) as Row | undefined;
      const blobId = existing?.blob_id ?? this.storage.put(bytes, format.mimeType).id;
      const id = randomUUID();
      try {
        this.store.db.prepare('INSERT INTO attachments (id,name,kind,mime_type,size_bytes,sha256,blob_id,created_at) VALUES (?,?,?,?,?,?,?,?)')
          .run(id, name, format.kind, format.mimeType, bytes.byteLength, sha256, blobId, new Date().toISOString());
      } catch (error) { if (!existing) this.storage.delete(blobId); throw error; }
      return { attachments: [summary(this.row(id))], rejected: [] };
    } catch {
      return { attachments: [], rejected: [{ fileName: name, code: 'unreadable', message: 'The pasted image could not be stored. Please try again.' }] };
    }
  }

  private row(id: string): Row {
    if (!AttachmentIdSchema.safeParse(id).success) throw new Error('Invalid attachment id.');
    const row = this.store.db.prepare('SELECT * FROM attachments WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('Attachment not found.');
    return row;
  }

  validate(ids: readonly string[]): AttachmentRef[] {
    AttachmentIdsSchema.parse(ids);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate attachment ids.');
    const refs = ids.map((id) => ref(this.row(id)));
    const error = attachmentBatchError(refs.length, refs.reduce((sum, item) => sum + item.sizeBytes, 0));
    if (error) throw new Error(error);
    for (const item of refs) { const error = attachmentSizeError(item.sizeBytes); if (error) throw new Error(error); }
    return refs;
  }

  async preview(id: string): Promise<AttachmentPreview> {
    const row = this.row(id);
    try { return await formatDocument(this.storage.get(row.blob_id), summary(row)); }
    catch { return { attachment: summary(row), format: 'unsupported', reason: 'unreadable', message: 'The stored attachment could not be read.', truncated: false }; }
  }

  async thumbnail(id: string): Promise<string | null> {
    const row = this.row(id);
    if (row.kind !== 'image') return null;
    if (row.thumbnail_blob_id && this.storage.has(row.thumbnail_blob_id)) return `data:image/png;base64,${this.storage.get(row.thumbnail_blob_id).toString('base64')}`;
    const preview = await this.preview(id);
    if (preview.format !== 'image') return null;
    const image = nativeImage.createFromDataURL(preview.dataUrl);
    const { width, height } = image.getSize();
    if (!width || !height) return null;
    const ratio = Math.min(1, 320 / Math.max(width, height));
    const bytes = image.resize({ width: Math.max(1, Math.round(width * ratio)), height: Math.max(1, Math.round(height * ratio)) }).toPNG();
    // An async preview may have raced with discard or another thumbnail request.
    const current = this.row(id);
    if (current.thumbnail_blob_id) return `data:image/png;base64,${this.storage.get(current.thumbnail_blob_id).toString('base64')}`;
    const blob = this.storage.put(bytes, 'image/png');
    this.store.db.prepare('UPDATE attachments SET thumbnail_blob_id=?,width=?,height=? WHERE id=?').run(blob.id, width, height, id);
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }

  listTask(taskId: string): AttachmentRef[] { return this.list({ taskId }); }
  listChat(messageId: string): AttachmentRef[] { return this.list({ messageId }); }
  private list(owner: Owner): AttachmentRef[] {
    const { table, key, id } = location(owner);
    return (this.store.db.prepare(`SELECT a.* FROM attachments a JOIN ${table} l ON l.attachment_id=a.id WHERE l.${key}=? ORDER BY l.ordinal`).all(id) as Row[]).map(ref);
  }
  linkTask(taskId: string, ids: readonly string[]): AttachmentRef[] { return this.link({ taskId }, ids); }
  linkChat(messageId: string, ids: readonly string[]): AttachmentRef[] { return this.link({ messageId }, ids); }
  private link(owner: Owner, ids: readonly string[]): AttachmentRef[] {
    const { table, key, id } = location(owner);
    return this.store.transaction(() => {
      const all = [...new Set([...this.list(owner).map((item) => item.id), ...ids])];
      this.validate(ids);
      const refs = this.validate(all);
      refs.forEach((item, ordinal) => this.store.db.prepare(`INSERT OR IGNORE INTO ${table} (${key},attachment_id,ordinal,created_at) VALUES (?,?,?,?)`).run(id, item.id, ordinal, new Date().toISOString()));
      return refs;
    });
  }

  /** destination and owner come from main only; call after linking. */
  async materialize(ids: readonly string[], destination: string, owner: Owner): Promise<MaterializedAttachment[]> {
    const refs = this.validate(ids);
    const { table, key, id } = location(owner);
    const linked = new Set(this.list(owner).map((item) => item.id));
    if (refs.some((item) => !linked.has(item.id))) throw new Error('Attachment is not linked to this owner.');
    mkdirSync(destination, { recursive: true, mode: 0o700 });
    const directory = realpathSync(destination);
    const result: MaterializedAttachment[] = [];
    for (const item of refs) {
      // Delivery happens once per current turn, so it may request local OCR for
      // images. Interactive previews deliberately remain fast and do not OCR.
      const row = this.row(item.id);
      const bytes = this.storage.get(row.blob_id);
      const preview = await formatDocument(bytes, summary(row), { recognizeImages: true });
      // Recheck the owner after asynchronous conversion (deletion may have occurred).
      if (!this.list(owner).some((entry) => entry.id === item.id)) throw new Error('Attachment owner no longer exists.');
      const path = join(directory, `${item.id}-${randomUUID()}-${copyName(item.name)}`);
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); }
      catch (error) { rmSync(path, { force: true }); throw error; }
      finally { closeSync(fd); }
      const previous = this.store.db.prepare(`SELECT materialized_path FROM ${table} WHERE ${key}=? AND attachment_id=?`).get(id, item.id) as { materialized_path: string | null };
      this.store.db.prepare(`UPDATE ${table} SET materialized_path=? WHERE ${key}=? AND attachment_id=?`).run(path, id, item.id);
      if (previous.materialized_path && previous.materialized_path !== path) rmSync(previous.materialized_path, { force: true });
      const text = preview.format === 'markdown' ? preview.markdown
        : preview.format === 'text' ? preview.text
          : preview.format === 'pdf' ? preview.pages.map((page) => page.text).join('\n\n')
            : preview.format === 'image' ? preview.recognizedText
              : undefined;
      result.push({ ...item, path, ...(text !== undefined ? { extractedText: text, truncated: preview.truncated } : {}), ...(preview.format === 'pdf' ? { pageCount: preview.pageCount } : {}) });
    }
    return result;
  }

  discard(id: string): void {
    this.row(id);
    if (this.store.db.prepare('SELECT 1 FROM task_attachments WHERE attachment_id=? UNION ALL SELECT 1 FROM chat_message_attachments WHERE attachment_id=? LIMIT 1').get(id, id)) return;
    const row = this.row(id);
    this.store.db.prepare('DELETE FROM attachments WHERE id=?').run(id);
    for (const blob of [row.blob_id, row.thumbnail_blob_id]) {
      if (blob && !this.store.db.prepare('SELECT 1 FROM attachments WHERE blob_id=? OR thumbnail_blob_id=? LIMIT 1').get(blob, blob)) this.storage.delete(blob);
    }
  }

  /** Call before deleting an owner so cascade deletion cannot erase copy paths. */
  cleanup(owner: Owner): void {
    const { table, key, id } = location(owner);
    const links = this.store.db.prepare(`SELECT attachment_id,materialized_path FROM ${table} WHERE ${key}=?`).all(id) as { attachment_id: string; materialized_path: string | null }[];
    for (const link of links) if (link.materialized_path) rmSync(resolve(link.materialized_path), { force: true });
    this.store.db.prepare(`DELETE FROM ${table} WHERE ${key}=?`).run(id);
    for (const link of links) this.discard(link.attachment_id);
  }
}
