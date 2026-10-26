import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { promisify } from 'node:util';
import mammoth from 'mammoth';
import TurndownService from 'turndown';
import {
  MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_EXTRACTED_CHARS, MAX_ATTACHMENT_PDF_PAGES,
  type AttachmentKind, type AttachmentPreview, type AttachmentPreviewFailure,
  type AttachmentSummary, type PdfAttachmentPage,
} from '../../shared/attachments';
import { redact } from '../ipc/redaction';
import { formatPdfWithMacos, recognizeImageWithMacos } from './macos-vision';

const run = promisify(execFile);
export interface DetectedDocumentFormat { kind: AttachmentKind; mimeType: string }
const types: Record<string, DetectedDocumentFormat> = {
  '.md': { kind: 'markdown', mimeType: 'text/markdown' },
  '.markdown': { kind: 'markdown', mimeType: 'text/markdown' },
  '.txt': { kind: 'text', mimeType: 'text/plain' },
  '.csv': { kind: 'text', mimeType: 'text/csv' },
  '.json': { kind: 'text', mimeType: 'application/json' },
  '.log': { kind: 'text', mimeType: 'text/plain' },
  '.pdf': { kind: 'pdf', mimeType: 'application/pdf' },
  '.doc': { kind: 'doc', mimeType: 'application/msword' },
  '.docx': { kind: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
};
const images: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.heic': 'image/heic', '.heif': 'image/heif', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.avif': 'image/avif',
};
const unsupported: DetectedDocumentFormat = { kind: 'unsupported', mimeType: 'application/octet-stream' };

/** Strong signatures take precedence over misleading extensions. SVG is deliberately not served. */
export function detectDocumentFormat(name: string, bytes: Uint8Array): DetectedDocumentFormat {
  const b = Buffer.from(bytes);
  const starts = (hex: string): boolean => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  const image = (mimeType: string): DetectedDocumentFormat => ({ kind: 'image', mimeType });
  if (starts('89504e470d0a1a0a')) return image('image/png');
  if (starts('ffd8ff')) return image('image/jpeg');
  if (/^GIF8[79]a/.test(b.subarray(0, 6).toString('ascii'))) return image('image/gif');
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return image('image/webp');
  if (starts('49492a00') || starts('4d4d002a')) return image('image/tiff');
  if (starts('424d')) return image('image/bmp');
  if (starts('00000100')) return image('image/x-icon');
  if (b.toString('ascii', 4, 8) === 'ftyp') {
    const brand = b.toString('ascii', 8, 12);
    if (/^(heic|heix|hevc|hevx|mif1|msf1)$/.test(brand)) return image('image/heic');
    if (/^(avif|avis)$/.test(brand)) return image('image/avif');
  }
  if (b.subarray(0, 1024).includes(Buffer.from('%PDF-'))) return types['.pdf']!;
  const ext = extname(name).toLowerCase();
  if (starts('d0cf11e0a1b11ae1')) return ext === '.docx' ? types['.docx']! : types['.doc']!;
  if (starts('504b0304')) {
    // ZIP entries retain their names even when their contents are compressed.
    return ext === '.docx' || b.includes(Buffer.from('word/document.xml')) ? types['.docx']! : unsupported;
  }
  if (images[ext]) return image(images[ext]);
  if (types[ext]) return types[ext];
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(b);
    if (text.trim() && !/[\x00-\x08\x0e-\x1f]/.test(text)) return { kind: 'text', mimeType: 'text/plain' };
  } catch { /* Binary data has no text fallback. */ }
  return unsupported;
}

/** Redact before slicing so a credential crossing the cap cannot leak its prefix. */
export function boundExtractedText(text: string): { text: string; truncated: boolean } {
  const safe = redact(text) as string;
  return { text: safe.slice(0, MAX_ATTACHMENT_EXTRACTED_CHARS), truncated: safe.length > MAX_ATTACHMENT_EXTRACTED_CHARS };
}

/** No raw HTML, remote images or active link destinations are carried into converted documents. */
export function htmlToSafeMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
  td.remove(['script', 'style', 'iframe', 'object', 'embed']);
  td.addRule('noImages', { filter: 'img', replacement: () => '' });
  const escape = td.escape.bind(td);
  td.escape = (text) => escape(redact(text) as string);
  td.addRule('inertLinks', { filter: 'a', replacement: (content) => content });
  td.addRule('tables', {
    filter: 'table',
    replacement: (_content, node) => {
      // Turndown supplies a DOM implementation in Node; avoid adding browser globals to main.
      type TableNode = { innerHTML: string; querySelectorAll(selector: string): ArrayLike<TableNode> };
      const table = node as unknown as TableNode;
      const rows = Array.from(table.querySelectorAll('tr')).map((row) =>
        Array.from(row.querySelectorAll('th,td')).map((cell) =>
          td.turndown(cell.innerHTML).replace(/\|/g, '\\|').replace(/\n+/g, ' ')));
      const width = Math.max(0, ...rows.map((row) => row.length));
      if (!width) return '';
      const line = (row: string[]): string => `| ${Array.from({ length: width }, (_, i) => row[i] ?? '').join(' | ')} |`;
      return `\n\n${line(rows[0]!)}\n${line(Array<string>(width).fill('---'))}\n${rows.slice(1).map(line).join('\n')}\n\n`;
    },
  });
  return td.turndown(html);
}

async function temporary<T>(action: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'conductor-preview-'));
  try { return await action(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** Accept bytes from the trusted attachment service, never a renderer-supplied path. */
export async function formatDocument(bytes: Uint8Array, attachment: AttachmentSummary, options: { recognizeImages?: boolean } = {}): Promise<AttachmentPreview> {
  const fail = (reason: AttachmentPreviewFailure, message: string): AttachmentPreview =>
    ({ attachment, format: 'unsupported', truncated: false, reason, message });
  if (!bytes.byteLength) return fail('empty', 'The file is empty.');
  if (bytes.byteLength > MAX_ATTACHMENT_BYTES) return fail('error', 'The file exceeds the 25 MiB preview limit.');
  const detected = detectDocumentFormat(attachment.name, bytes);
  const buffer = Buffer.from(bytes);
  const textPreview = (text: string, format: 'text' | 'markdown'): AttachmentPreview => {
    if (!text.trim()) return fail('empty', 'The document contains no readable text.');
    const bounded = boundExtractedText(text);
    return format === 'markdown'
      ? { attachment, format, markdown: bounded.text, truncated: bounded.truncated }
      : { attachment, format, ...bounded };
  };
  try {
    switch (detected.kind) {
      case 'markdown': case 'text': {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
        if (/[\x00-\x08\x0e-\x1f]/.test(text)) return fail('error', 'The file is not valid UTF-8 text.');
        return textPreview(text, detected.kind);
      }
      case 'docx': {
        if (buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) {
          return fail('encrypted', 'Encrypted Word documents cannot be previewed.');
        }
        const result = await mammoth.convertToHtml({ buffer }, { externalFileAccess: false });
        return textPreview(htmlToSafeMarkdown(result.value), 'markdown');
      }
      case 'doc': {
        if (process.platform !== 'darwin') return fail('unsupported', 'Legacy Word preview requires macOS textutil.');
        // Require the OLE signature: textutil otherwise happily treats arbitrary bytes as text.
        if (!buffer.subarray(0, 8).equals(Buffer.from('d0cf11e0a1b11ae1', 'hex'))) return fail('error', 'The Word document is corrupt.');
        const html = await temporary(async (dir) => {
          const source = join(dir, 'document.doc');
          await writeFile(source, buffer, { mode: 0o600 });
          const result = await run('/usr/bin/textutil', ['-convert', 'html', '-stdout', source], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
          return result.stdout;
        });
        return textPreview(htmlToSafeMarkdown(html), 'markdown');
      }
      case 'pdf': {
        const native = await formatPdfWithMacos(buffer);
        if (native !== null) return { attachment, format: 'pdf', ...native };
        const { getDocument } = await import('pdfjs-dist/legacy/build/pdf.mjs');
        const loading = getDocument({ data: new Uint8Array(buffer), useSystemFonts: false, useWorkerFetch: false });
        try {
          const pdf = await loading.promise;
          const pages: PdfAttachmentPage[] = [];
          let remaining = MAX_ATTACHMENT_EXTRACTED_CHARS;
          let truncated = pdf.numPages > MAX_ATTACHMENT_PDF_PAGES;
          for (let pageNumber = 1; pageNumber <= Math.min(pdf.numPages, MAX_ATTACHMENT_PDF_PAGES); pageNumber++) {
            const page = await pdf.getPage(pageNumber);
            try {
              const content = await page.getTextContent();
              const raw = content.items.map((item) => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('').trim();
              const safe = redact(raw) as string;
              pages.push({ pageNumber, text: safe.slice(0, remaining) });
              truncated ||= safe.length > remaining;
              remaining -= Math.min(safe.length, remaining);
            } finally { page.cleanup(); }
            if (remaining === 0) { truncated ||= pageNumber < pdf.numPages; break; }
          }
          if (!pages.some((page) => page.text.trim())) return fail('empty', 'The PDF contains no extractable text (it may require OCR).');
          return { attachment, format: 'pdf', pages, pageCount: pdf.numPages, truncated };
        } finally { await loading.destroy(); }
      }
      case 'image': {
        let imageBytes = buffer;
        if (detected.mimeType === 'image/heic' || detected.mimeType === 'image/heif' || detected.mimeType === 'image/tiff') {
          if (process.platform === 'darwin') imageBytes = await temporary(async (dir) => {
            const source = join(dir, 'source');
            const dest = join(dir, 'preview.png');
            await writeFile(source, buffer, { mode: 0o600 });
            await run('/usr/bin/sips', ['-s', 'format', 'png', source, '--out', dest], { timeout: 30_000, maxBuffer: 1024 * 1024 });
            return readFile(dest);
          });
        }
        const { nativeImage } = await import('electron');
        const image = nativeImage.createFromBuffer(imageBytes);
        if (image.isEmpty()) return fail('error', 'The image is corrupt or its format is not supported.');
        const { width, height } = image.getSize();
        let recognizedText: string | undefined;
        if (options.recognizeImages === true) {
          try { recognizedText = await recognizeImageWithMacos(imageBytes, detected.mimeType); }
          catch { /* The visual preview remains useful when native OCR is unavailable. */ }
        }
        return { attachment, format: 'image', dataUrl: image.toDataURL(), width, height, truncated: false, ...(recognizedText ? { recognizedText } : {}) };
      }
      default: return fail('unsupported', 'This file type does not support a preview.');
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'PasswordException') return fail('encrypted', 'The document is encrypted and requires a password.');
    if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return fail('unsupported', 'The document conversion tool is unavailable.');
    return fail('error', 'The file could not be previewed. It may be corrupt or use an unsupported format.');
  }
}
