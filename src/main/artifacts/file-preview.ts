import { extname } from 'node:path';
import type { AttachmentSummary } from '@shared/attachments';
import { MAX_VIEWABLE_BYTES, type ArchiveEntry, type FilePreview } from '@shared/file-preview';
import { detectDocumentFormat, formatDocument } from '../attachments/document-format';
import { hasZipSignature, listZipEntries as readZipDirectory } from '../attachments/zip-reader';

// Renders a file an agent handed back for the in-app viewer. Bytes only —
// never a path — so it serves generated files, task outputs and sandbox
// deliveries alike. PDFs come back as page images, Word and Markdown as
// formatted text, archives as a listing.

const OFFICE_TYPES: Record<string, string> = {
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav',
  '.html': 'text/html', '.htm': 'text/html', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.tsv': 'text/tab-separated-values', '.svg': 'image/svg+xml',
};

/** The media type to download a file as, from its bytes and name. */
export function fileMimeType(fileName: string, bytes: Uint8Array): string {
  const detected = detectDocumentFormat(fileName, bytes);
  if (detected.kind !== 'unsupported' && detected.kind !== 'text') return detected.mimeType;
  return OFFICE_TYPES[extname(fileName).toLowerCase()] ?? detected.mimeType;
}

/** A zip's entries from its central directory, or null when the bytes are not a readable zip. */
export function listZipEntries(bytes: Uint8Array): { entries: ArchiveEntry[]; entryCount: number } | null {
  const listing = readZipDirectory(bytes);
  if (listing === null) return null;
  return { entries: listing.entries.map(({ path, sizeBytes, directory }) => ({ path, sizeBytes, directory })), entryCount: listing.entryCount };
}

export async function previewFile(fileName: string, bytes: Uint8Array): Promise<FilePreview> {
  const detected = detectDocumentFormat(fileName, bytes);
  const attachment: AttachmentSummary = { id: '', name: fileName, kind: detected.kind, mimeType: fileMimeType(fileName, bytes), sizeBytes: bytes.byteLength };
  const unsupported = (message: string): FilePreview => ({ attachment, format: 'unsupported', truncated: false, reason: 'unsupported', message });
  if (bytes.byteLength > MAX_VIEWABLE_BYTES) return unsupported('This file is too large to open here. Download it to view it.');
  // An archive gets its own listing here; as an attachment it is shown as text.
  if (detected.kind === 'unsupported' || detected.kind === 'archive') {
    const extension = extname(fileName).toLowerCase();
    const isZip = hasZipSignature(bytes);
    if (isZip && extension !== '.pptx' && extension !== '.xlsx') {
      const listing = listZipEntries(bytes);
      if (listing !== null) {
        return {
          attachment, format: 'archive', entries: listing.entries, entryCount: listing.entryCount,
          totalBytes: listing.entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
          truncated: listing.entryCount > listing.entries.length,
        };
      }
    }
    return unsupported(`${extension !== '' ? `${extension.slice(1).toUpperCase()} files` : 'Files of this type'} cannot be shown here. Download it to open it in another app.`);
  }
  return formatDocument(bytes, attachment);
}
