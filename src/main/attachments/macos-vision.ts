import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  MAX_ATTACHMENT_EXTRACTED_CHARS,
  MAX_ATTACHMENT_OCR_PAGES,
  MAX_ATTACHMENT_PDF_PAGES,
  MAX_ATTACHMENT_PDF_RENDERED_PAGES,
  type PdfAttachmentPage,
} from '../../shared/attachments';
import { redact } from '../ipc/redaction';

const NATIVE_TIMEOUT_MS = 90_000;
const MAX_PAGE_IMAGE_BYTES = 5 * 1024 * 1024;

export interface NativePdfResult {
  pageCount: number;
  pages: PdfAttachmentPage[];
  truncated: boolean;
}

export interface NativeVisionInvocation {
  mode: 'pdf' | 'image';
  directory: string;
  inputPath: string;
  manifestPath: string;
}

export type NativeVisionRunner = (invocation: NativeVisionInvocation) => Promise<void>;

const JXA_SOURCE = String.raw`
ObjC.import('Foundation');
ObjC.import('AppKit');
ObjC.import('PDFKit');
ObjC.import('Vision');

function value(name) {
  return ObjC.unwrap($.NSProcessInfo.processInfo.environment.objectForKey(name));
}

function writeJson(path, value) {
  $(JSON.stringify(value)).writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
}

function render(page, path) {
  var bounds = page.boundsForBox(0);
  var ratio = Number(bounds.size.width) / Math.max(1, Number(bounds.size.height));
  var height = 1800;
  var width = Math.max(1, Math.round(height * ratio));
  if (width > 1400) { height = Math.max(1, Math.round(height * 1400 / width)); width = 1400; }
  var image = page.thumbnailOfSizeForBox($.NSMakeSize(width, height), 0);
  var rep = $.NSBitmapImageRep.imageRepWithData(image.TIFFRepresentation);
  var data = rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!data.writeToFileAtomically(path, true)) throw new Error('Could not render PDF page');
}

function recognize(path) {
  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = $.VNRequestTextRecognitionLevelAccurate;
  request.usesLanguageCorrection = true;
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(path), $({}));
  handler.performRequestsError($([request]), null);
  var lines = [];
  var results = request.results;
  for (var i = 0; i < results.count; i++) {
    var candidates = results.objectAtIndex(i).topCandidates(1);
    if (candidates.count) lines.push(ObjC.unwrap(candidates.objectAtIndex(0).string));
  }
  return lines.join('\n').trim();
}

var mode = value('CONDUCTOR_VISION_MODE');
var input = value('CONDUCTOR_VISION_INPUT');
var output = value('CONDUCTOR_VISION_OUTPUT');
var manifest = value('CONDUCTOR_VISION_MANIFEST');
try {
  if (mode === 'image') {
    writeJson(manifest, { text: recognize(input) });
  } else {
    var document = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(input));
    if (!document) throw new Error('Could not open PDF');
    var pageCount = Number(document.pageCount);
    var limit = Math.min(pageCount, ${MAX_ATTACHMENT_PDF_PAGES});
    var pages = [];
    var usedOcr = false;
    for (var index = 0; index < limit; index++) {
      var page = document.pageAtIndex(index);
      if (!page) continue;
      var text = ObjC.unwrap(page.string || '').trim();
      var needsVisual = index < ${MAX_ATTACHMENT_PDF_RENDERED_PAGES};
      var needsOcr = !text && index < ${MAX_ATTACHMENT_OCR_PAGES};
      var imageFile = null;
      if (needsVisual || needsOcr) {
        imageFile = 'page-' + (index + 1) + '.png';
        render(page, output + '/' + imageFile);
      }
      if (needsOcr && imageFile) { text = recognize(output + '/' + imageFile); usedOcr = true; }
      var item = { pageNumber: index + 1, text: text };
      if (needsVisual && imageFile) item.imageFile = imageFile;
      pages.push(item);
    }
    writeJson(manifest, { pageCount: pageCount, pages: pages, truncated: pageCount > limit, usedOcr: usedOcr });
  }
} catch (error) {
  writeJson(manifest, { error: 'native_processing_failed' });
  throw error;
}
`;

const defaultRunner: NativeVisionRunner = (invocation) => new Promise((resolve, reject) => {
  execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', JXA_SOURCE], {
    timeout: NATIVE_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: {
      ...process.env,
      CONDUCTOR_VISION_MODE: invocation.mode,
      CONDUCTOR_VISION_INPUT: invocation.inputPath,
      CONDUCTOR_VISION_OUTPUT: invocation.directory,
      CONDUCTOR_VISION_MANIFEST: invocation.manifestPath,
    },
  }, (error) => { if (error) reject(error); else resolve(); });
});

async function withNativeFiles<T>(
  mode: NativeVisionInvocation['mode'],
  bytes: Uint8Array,
  runner: NativeVisionRunner,
  read: (directory: string, manifest: unknown) => Promise<T>,
): Promise<T | null> {
  const directory = await mkdtemp(join(tmpdir(), 'conductor-native-preview-'));
  const inputPath = join(directory, mode === 'pdf' ? 'source.pdf' : 'source-image');
  const manifestPath = join(directory, 'manifest.json');
  try {
    await writeFile(inputPath, bytes, { mode: 0o600 });
    await runner({ mode, directory, inputPath, manifestPath });
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as unknown;
    return await read(directory, manifest);
  } catch {
    return null;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function safeText(value: unknown): string {
  return typeof value === 'string' ? redact(value) as string : '';
}

export async function formatPdfWithMacos(bytes: Uint8Array, runner: NativeVisionRunner = defaultRunner): Promise<NativePdfResult | null> {
  return withNativeFiles('pdf', bytes, runner, async (directory, raw) => {
    const manifest = record(raw);
    if (!manifest || manifest['error'] !== undefined || !Number.isInteger(manifest['pageCount']) || !Array.isArray(manifest['pages'])) throw new Error('Invalid native PDF result');
    const pageCount = manifest['pageCount'] as number;
    if (pageCount < 1) throw new Error('Invalid native PDF page count');
    let remaining = MAX_ATTACHMENT_EXTRACTED_CHARS;
    let truncated = manifest['truncated'] === true || pageCount > MAX_ATTACHMENT_PDF_PAGES;
    const pages: PdfAttachmentPage[] = [];
    for (const rawPage of manifest['pages'].slice(0, MAX_ATTACHMENT_PDF_PAGES)) {
      const page = record(rawPage);
      if (!page || !Number.isInteger(page['pageNumber'])) continue;
      const fullText = safeText(page['text']);
      const text = fullText.slice(0, remaining);
      truncated ||= fullText.length > remaining;
      remaining -= text.length;
      const imageFile = typeof page['imageFile'] === 'string' ? basename(page['imageFile']) : undefined;
      let dataUrl: string | undefined;
      if (imageFile && /^page-[1-9]\d*\.png$/.test(imageFile)) {
        const image = await readFile(join(directory, imageFile));
        if (image.byteLength <= MAX_PAGE_IMAGE_BYTES) dataUrl = `data:image/png;base64,${image.toString('base64')}`;
      }
      pages.push({ pageNumber: page['pageNumber'] as number, text, ...(dataUrl ? { dataUrl } : {}) });
      if (remaining === 0) { truncated ||= pages.length < pageCount; break; }
    }
    if (pages.length === 0) throw new Error('Native PDF returned no pages');
    return { pageCount, pages, truncated };
  });
}

export async function recognizeImageWithMacos(bytes: Uint8Array, _mimeType: string, runner: NativeVisionRunner = defaultRunner): Promise<string | undefined> {
  const result = await withNativeFiles('image', bytes, runner, async (_directory, raw) => {
    const manifest = record(raw);
    if (!manifest || manifest['error'] !== undefined) throw new Error('Invalid native OCR result');
    const text = safeText(manifest['text']);
    return text.slice(0, MAX_ATTACHMENT_EXTRACTED_CHARS);
  });
  return result?.trim() || undefined;
}
