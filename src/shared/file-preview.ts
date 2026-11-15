import type { AttachmentPreview, AttachmentPreviewBase } from './attachments';

// What the in-app viewer shows for a file an agent handed back: the same
// rendered formats attachments use (PDF pages, Word/Markdown as formatted
// text, images, plain text) plus a listing for archives.

export interface ArchiveEntry {
  /** Path inside the archive, forward slashes. */
  path: string;
  /** Uncompressed size; 0 for folders. */
  sizeBytes: number;
  directory: boolean;
}

export interface ArchiveFilePreview extends AttachmentPreviewBase {
  readonly format: 'archive';
  readonly entries: readonly ArchiveEntry[];
  /** Entries in the archive, including any beyond the listed ones. */
  readonly entryCount: number;
  /** Combined uncompressed size of the listed entries. */
  readonly totalBytes: number;
}

export type FilePreview = AttachmentPreview | ArchiveFilePreview;

/** The bytes of a stored file, for viewing and downloading. */
export interface FileBytes {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  dataBase64: string;
}

/** Largest file the viewer accepts (matches the attachment limit). */
export const MAX_VIEWABLE_BYTES = 25 * 1024 * 1024;
