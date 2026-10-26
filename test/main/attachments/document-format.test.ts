import { describe, expect, it, vi, beforeEach } from 'vitest';
import { boundExtractedText, detectDocumentFormat, formatDocument, htmlToSafeMarkdown } from '../../../src/main/attachments/document-format';
import type { AttachmentSummary } from '../../../src/shared/attachments';

const mocks = vi.hoisted(() => ({ convert: vi.fn(), getDocument: vi.fn(), image: vi.fn(), nativePdf: vi.fn(), nativeImageText: vi.fn() }));
vi.mock('mammoth', () => ({ default: { convertToHtml: mocks.convert } }));
vi.mock('pdfjs-dist/legacy/build/pdf.mjs', () => ({ getDocument: mocks.getDocument }));
vi.mock('electron', () => ({ nativeImage: { createFromBuffer: mocks.image } }));
vi.mock('../../../src/main/attachments/macos-vision', () => ({
  formatPdfWithMacos: mocks.nativePdf,
  recognizeImageWithMacos: mocks.nativeImageText,
}));
const metadata = (name: string): AttachmentSummary => ({ id: 'test', name, kind: 'unsupported', mimeType: 'application/octet-stream', sizeBytes: 10 });
const preview = (name: string, data: string | Buffer) => formatDocument(Buffer.from(data), metadata(name));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.nativePdf.mockResolvedValue(null);
  mocks.nativeImageText.mockResolvedValue(undefined);
});

describe('document detection', () => {
  it.each([
    ['photo.txt', '89504e470d0a1a0a', 'image', 'image/png'],
    ['photo', 'ffd8ff', 'image', 'image/jpeg'],
    ['photo', '49492a00', 'image', 'image/tiff'],
    ['photo', '000000186674797068656963', 'image', 'image/heic'],
    ['wrong.md', '255044462d312e37', 'pdf', 'application/pdf'],
    ['old.doc', 'd0cf11e0a1b11ae1', 'doc', 'application/msword'],
    ['archive.zip', '504b0304', 'unsupported', 'application/octet-stream'],
  ])('detects %s by magic', (name, hex, kind, mimeType) => {
    expect(detectDocumentFormat(name, Buffer.from(hex, 'hex'))).toEqual({ kind, mimeType });
  });
  it('detects Markdown, plain UTF-8, DOCX entries and binary fallback', () => {
    expect(detectDocumentFormat('README.MD', Buffer.from('# Hi')).kind).toBe('markdown');
    expect(detectDocumentFormat('notes', Buffer.from('hello')).kind).toBe('text');
    expect(detectDocumentFormat('document', Buffer.from('PK\x03\x04word/document.xml')).kind).toBe('docx');
    expect(detectDocumentFormat('binary', Buffer.from([0, 255, 0])).kind).toBe('unsupported');
  });
});

describe('safe text and Word extraction', () => {
  it('preserves raw Markdown and UTF-8 without pre-rendering HTML', async () => {
    const markdown = '# Café\n\n- [x] done\n\n| A | B |\n| - | - |\n\n```ts\nlet x = 1;\n```';
    expect(await preview('notes.md', markdown)).toMatchObject({ format: 'markdown', markdown, truncated: false });
  });
  it('redacts whole secrets before capping text to 40k characters', async () => {
    const text = 'x'.repeat(39_980) + '\nAPI_KEY=' + 'a'.repeat(200);
    const result = boundExtractedText(text);
    expect(result.text).not.toContain('aaaa');
    expect(boundExtractedText('x'.repeat(40_001))).toEqual({ text: 'x'.repeat(40_000), truncated: true });
    expect(await preview('note.txt', 'x'.repeat(40_001))).toMatchObject({ format: 'text', truncated: true });
    expect(boundExtractedText('x'.repeat(40_000)).truncated).toBe(false);
  });
  it('preserves headings, lists and tables, discarding active HTML and remote images', () => {
    const result = htmlToSafeMarkdown('<h1>Title</h1><ul><li>Item</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>one</td><td>two</td></tr></table><script>evil()</script><a href="javascript:evil()">link</a><img src="https://tracker/">');
    expect(result).toContain('# Title');
    expect(result).toMatch(/-\s+Item/);
    expect(result).toContain('| A | B |\n| --- | --- |\n| one | two |');
    expect(result).not.toMatch(/evil|javascript|tracker|<script/);
  });
  it('uses mammoth with external file access disabled then converts to Markdown', async () => {
    mocks.convert.mockResolvedValue({ value: '<h2>Heading</h2><p>API_KEY=secretvalue</p>' });
    const result = await preview('document.docx', 'PK\x03\x04');
    expect(result).toMatchObject({ format: 'markdown' });
    expect(JSON.stringify(result)).toContain('REDACTED');
    expect(JSON.stringify(result)).not.toContain('secretvalue');
    expect(mocks.convert).toHaveBeenCalledWith({ buffer: expect.any(Buffer) }, { externalFileAccess: false });
  });
  it('returns explicit empty, unsupported, corrupt and encrypted outcomes with metadata', async () => {
    expect(await preview('empty.md', '')).toMatchObject({ format: 'unsupported', reason: 'empty', attachment: metadata('empty.md') });
    expect(await preview('blank.txt', '  \n')).toMatchObject({ reason: 'empty' });
    expect(await preview('bad.txt', Buffer.from([0xff]))).toMatchObject({ reason: 'error' });
    expect(await preview('file.bin', Buffer.from([0xff]))).toMatchObject({ reason: 'unsupported' });
    mocks.convert.mockRejectedValue(new Error('/private/path PASSWORD=leak'));
    const result = await preview('broken.docx', 'broken');
    expect(result).toMatchObject({ reason: 'error' });
    expect(JSON.stringify(result)).not.toMatch(/private\/path|leak/);
    expect(await preview('encrypted.docx', Buffer.from('d0cf11e0a1b11ae1', 'hex'))).toMatchObject({ reason: 'encrypted' });
  });
});

function pdfFixture(pageCount: number, text: string) {
  const cleanup = vi.fn();
  const destroy = vi.fn().mockResolvedValue(undefined);
  const getPage = vi.fn().mockResolvedValue({ getTextContent: async () => ({ items: [{ str: text, hasEOL: true }] }), cleanup });
  mocks.getDocument.mockReturnValue({ promise: Promise.resolve({ numPages: pageCount, getPage }), destroy });
  return { cleanup, destroy, getPage };
}

describe('PDF page extraction', () => {
  it('uses native rendered pages and text when macOS formatting succeeds', async () => {
    mocks.nativePdf.mockResolvedValue({
      pageCount: 2,
      pages: [{ pageNumber: 1, text: 'Native text', dataUrl: 'data:image/png;base64,AAAA' }],
      truncated: true,
    });

    const result = await preview('native.pdf', '%PDF-1.7');

    expect(result).toMatchObject({
      format: 'pdf', pageCount: 2, truncated: true,
      pages: [{ pageNumber: 1, text: 'Native text', dataUrl: 'data:image/png;base64,AAAA' }],
    });
    expect(mocks.getDocument).not.toHaveBeenCalled();
  });

  it('preserves page numbers, redacts and stops at 100 pages', async () => {
    const fixture = pdfFixture(101, 'API_KEY=secret');
    const result = await preview('pages.pdf', '%PDF-1.7');
    expect(result).toMatchObject({ format: 'pdf', pageCount: 101, truncated: true });
    if (result.format !== 'pdf') throw new Error('Expected PDF');
    expect(result.pages).toHaveLength(100);
    expect(result.pages[99]).toEqual({ pageNumber: 100, text: 'API_KEY=[REDACTED]' });
    expect(fixture.getPage).toHaveBeenCalledTimes(100);
    expect(fixture.cleanup).toHaveBeenCalledTimes(100);
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });
  it('shares the 40k character budget across pages and cleans up', async () => {
    const fixture = pdfFixture(3, 'x'.repeat(25_000));
    const result = await preview('pages.pdf', '%PDF-1.7');
    if (result.format !== 'pdf') throw new Error('Expected PDF');
    expect(result.pages.map((p) => p.text.length)).toEqual([25_000, 15_000]);
    expect(result.truncated).toBe(true);
    expect(fixture.getPage).toHaveBeenCalledTimes(2);
    expect(fixture.destroy).toHaveBeenCalledOnce();
  });
  it('reports textless PDFs and password failures, releasing resources', async () => {
    pdfFixture(1, '');
    expect(await preview('scan.pdf', '%PDF-1.7')).toMatchObject({ reason: 'empty' });
    const destroy = vi.fn().mockResolvedValue(undefined);
    mocks.getDocument.mockReturnValue({ promise: Promise.reject(Object.assign(new Error('secret'), { name: 'PasswordException' })), destroy });
    expect(await preview('locked.pdf', '%PDF-1.7')).toMatchObject({ reason: 'encrypted' });
    expect(destroy).toHaveBeenCalledOnce();
  });
});

describe('image previews', () => {
  it('validates decoded bytes and returns a data URL with dimensions', async () => {
    mocks.image.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 10, height: 20 }), toDataURL: () => 'data:image/png;base64,AAAA' });
    expect(await preview('photo.png', Buffer.from('89504e470d0a1a0a', 'hex'))).toMatchObject({ format: 'image', width: 10, height: 20, dataUrl: 'data:image/png;base64,AAAA' });
  });
  it('returns a clear failure for corrupt image data', async () => {
    mocks.image.mockReturnValue({ isEmpty: () => true });
    expect(await preview('broken.png', 'broken')).toMatchObject({ format: 'unsupported', reason: 'error' });
  });
  it('keeps the image preview when optional local OCR fails', async () => {
    mocks.image.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 10, height: 20 }), toDataURL: () => 'data:image/png;base64,AAAA' });
    mocks.nativeImageText.mockRejectedValue(new Error('native unavailable'));

    const result = await formatDocument(Buffer.from('89504e470d0a1a0a', 'hex'), metadata('photo.png'), { recognizeImages: true });

    expect(result).toMatchObject({ format: 'image', dataUrl: 'data:image/png;base64,AAAA' });
    expect(result).not.toHaveProperty('recognizedText');
  });

  it('adds bounded recognized text when image OCR is requested', async () => {
    mocks.image.mockReturnValue({ isEmpty: () => false, getSize: () => ({ width: 10, height: 20 }), toDataURL: () => 'data:image/png;base64,AAAA' });
    mocks.nativeImageText.mockResolvedValue('Recognized words');

    expect(await formatDocument(Buffer.from('89504e470d0a1a0a', 'hex'), metadata('photo.png'), { recognizeImages: true }))
      .toMatchObject({ format: 'image', recognizedText: 'Recognized words' });
  });
});

describe('installed parser smoke checks', () => {
  it('extracts a real PDF with the installed pdfjs build', async () => {
    const actual = await vi.importActual<typeof import('pdfjs-dist/legacy/build/pdf.mjs')>('pdfjs-dist/legacy/build/pdf.mjs');
    mocks.getDocument.mockImplementation(actual.getDocument);
    const stream = 'BT /F1 12 Tf 50 100 Td (Hello PDF) Tj ET';
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
      `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    ];
    let pdf = '%PDF-1.4\n';
    const offsets = [0];
    for (const [index, object] of objects.entries()) {
      offsets.push(Buffer.byteLength(pdf));
      pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    expect(await preview('real.pdf', pdf)).toMatchObject({ format: 'pdf', pageCount: 1, truncated: false, pages: [{ pageNumber: 1, text: 'Hello PDF' }] });
    expect(await preview('corrupt.pdf', '%PDF-1.7\nbroken')).toMatchObject({ reason: 'error' });
  });

  it('converts a real DOCX ZIP and rejects a corrupt ZIP', async () => {
    const actual = await vi.importActual<typeof import('mammoth')>('mammoth');
    mocks.convert.mockImplementation(actual.convertToHtml);
    const { default: JSZip } = await import('jszip');
    const zip = new JSZip();
    zip.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
    zip.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello Word</w:t></w:r></w:p></w:body></w:document>');
    expect(await preview('real.docx', await zip.generateAsync({ type: 'nodebuffer' }))).toMatchObject({ format: 'markdown', markdown: 'Hello Word' });
    expect(await preview('broken.docx', 'PK\x03\x04broken')).toMatchObject({ reason: 'error' });
  });
});
