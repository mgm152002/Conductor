import { deflateRawSync } from 'node:zlib';
import { ARTIFACT_KIND_META, artifactFileName, normalizeSpec, type ArtifactImageData, type GeneratedArtifactSpec, type GeneratedArtifactSpecInput, type GeneratedFile } from '@shared/generated-artifacts';

export type ArtifactImages = Readonly<Record<string, ArtifactImageData>>;

function imageBytes(image: ArtifactImageData): { buffer: Buffer; format: 'png' | 'jpeg' } {
  const buffer = Buffer.from(image.dataBase64, 'base64');
  if (buffer.length > 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return { buffer, format: 'jpeg' };
  if (buffer.length > 4 && buffer[0] === 0x89 && buffer[1] === 0x50) return { buffer, format: 'png' };
  throw new Error('Artifact image must be PNG or JPEG data');
}

// Conductor renders deliverable files itself, from an agent-supplied spec.
// No agent CLI, file tool, or external converter is involved, so every agent
// can produce these in both Chat (read-only) and Work modes. PDF is written
// directly; DOCX/PPTX are OOXML zips assembled here (stored entries).

function crc32(buffer: Buffer): number {
  let table = crc32.table;
  if (table === undefined) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = 0xffffffff;
  for (const byte of buffer) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
crc32.table = undefined as Int32Array | undefined;

function zip(entries: { name: string; data: Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const compressed = deflateRawSync(entry.data);
    const crc = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(8, 8); // deflate
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, compressed);
    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(20, 6);
    header.writeUInt16LE(8, 10); header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(compressed.length, 20); header.writeUInt32LE(entry.data.length, 24);
    header.writeUInt16LE(name.length, 28); header.writeUInt32LE(offset, 42);
    central.push(header, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

const xml = (value: string): string => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const utf8 = (value: string): Buffer => Buffer.from(value, 'utf8');

// ---- Markdown-ish block model shared by the PDF and DOCX renderers ----

interface Run { text: string; bold?: boolean; italic?: boolean; code?: boolean }

type Block =
  | { kind: 'heading'; level: number; runs: Run[] }
  | { kind: 'paragraph'; runs: Run[] }
  | { kind: 'bullet'; level: number; runs: Run[] }
  | { kind: 'numbered'; level: number; marker: string; runs: Run[] }
  | { kind: 'code'; lines: string[] }
  | { kind: 'image'; imageId?: string; svg?: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'quote'; runs: Run[] }
  | { kind: 'rule' };

/** Parse **bold**, *italic*, `code`, and [label](url) into styled runs. */
function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  const pattern = /(\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\*[^*\n]+\*|(?<![\w])_[^_\n]+_(?![\w])|\[[^\]]+\]\([^)]*\))/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const at = match.index ?? 0;
    if (at > last) runs.push({ text: text.slice(last, at) });
    const token = match[0];
    if (token.startsWith('**') || token.startsWith('__')) runs.push({ text: token.slice(2, -2), bold: true });
    else if (token.startsWith('`')) runs.push({ text: token.slice(1, -1), code: true });
    else if (token.startsWith('[')) runs.push({ text: /\[([^\]]+)\]/.exec(token)?.[1] ?? token });
    else runs.push({ text: token.slice(1, -1), italic: true });
    last = at + token.length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.filter((r) => r.text !== '');
}

const plainText = (runs: Run[]): string => runs.map((r) => r.text).join('');
export const stripInline = (text: string): string => plainText(parseInline(text));

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => stripInline(cell.trim()));
}

function parseBlocks(spec: GeneratedArtifactSpec): Block[] {
  const blocks: Block[] = [{ kind: 'heading', level: 1, runs: parseInline(spec.title) }];
  const lines = (spec.content ?? '').split('\n');
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ kind: 'paragraph', runs: parseInline(paragraph.join(' ')) });
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    const imageRef = /^\[\[conductor-image:([\w-]+)\]\]$/.exec(trimmed);
    if (imageRef) { flushParagraph(); blocks.push({ kind: 'image', imageId: imageRef[1]! }); continue; }
    if (trimmed.startsWith('```')) {
      flushParagraph();
      const language = trimmed.slice(3).trim().toLowerCase();
      const fenced: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i]!).trim().startsWith('```')) { fenced.push(lines[i]!); i += 1; }
      if (language === 'svg' || language === 'html' || language === 'visual') {
        const joined = fenced.join('\n');
        const svg = /<svg[\s\S]*?<\/svg>/i.exec(joined)?.[0] ?? (joined.trim().startsWith('<svg') ? joined : undefined);
        blocks.push({ kind: 'image', ...(svg !== undefined ? { svg } : {}) });
      } else {
        blocks.push({ kind: 'code', lines: fenced });
      }
      continue;
    }
    if (trimmed === '') { flushParagraph(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) { flushParagraph(); blocks.push({ kind: 'rule' }); continue; }
    const heading = /^(#{1,4})\s+(.+)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      // The document title is already the first heading; don't repeat it.
      if (blocks.length === 1 && stripInline(heading[2]!) === spec.title) continue;
      blocks.push({ kind: 'heading', level: Math.min(3, heading[1]!.length), runs: parseInline(heading[2]!) });
      continue;
    }
    if (trimmed.includes('|') && i + 1 < lines.length && /^\|?[\s:|-]+\|?$/.test(lines[i + 1]!.trim()) && lines[i + 1]!.includes('-')) {
      flushParagraph();
      const header = splitTableRow(trimmed);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().includes('|') && lines[i]!.trim() !== '') {
        rows.push(splitTableRow(lines[i]!));
        i += 1;
      }
      i -= 1;
      blocks.push({ kind: 'table', header, rows });
      continue;
    }
    const bullet = /^(\s*)[-*•]\s+(.+)$/.exec(raw);
    if (bullet) { flushParagraph(); blocks.push({ kind: 'bullet', level: Math.min(2, Math.floor(bullet[1]!.length / 2)), runs: parseInline(bullet[2]!) }); continue; }
    const numbered = /^(\s*)(\d+)[.)]\s+(.+)$/.exec(raw);
    if (numbered) { flushParagraph(); blocks.push({ kind: 'numbered', level: Math.min(2, Math.floor(numbered[1]!.length / 2)), marker: `${numbered[2]}.`, runs: parseInline(numbered[3]!) }); continue; }
    const quote = /^>\s?(.+)$/.exec(trimmed);
    if (quote) { flushParagraph(); blocks.push({ kind: 'quote', runs: parseInline(quote[1]!) }); continue; }
    paragraph.push(trimmed);
  }
  flushParagraph();
  return blocks;
}

// ---- PDF (written directly, Helvetica, wrapped + paginated) ----

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const paragraph of text.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      if (line !== '' && line.length + word.length + 1 > width) { out.push(line); line = word; }
      else line = line === '' ? word : `${line} ${word}`;
    }
    out.push(line);
  }
  return out.length > 0 ? out : [''];
}

const pdfEscape = (value: string): string => value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
  .replace(/[^\x20-\x7e]/g, ' ');

function generatePdf(spec: GeneratedArtifactSpec, images: ArtifactImages): Buffer {
  const blocks = parseBlocks(spec);
  const pages: string[][] = [];
  let page: string[] = [];
  let y = 740;
  const newPage = (): void => { pages.push(page); page = []; y = 740; };
  const ensure = (space: number): void => { if (y - space < 60) newPage(); };
  /** One line of text: font F1 regular, F2 bold, F3 courier, F4 oblique. */
  const emit = (text: string, font: string, size: number, x: number, gap: number): void => {
    ensure(gap);
    page.push(`BT /${font} ${size} Tf ${x} ${y} Td (${pdfEscape(text)}) Tj ET`);
    y -= gap;
  };
  const wrapPlain = (text: string, chars: number): string[] => wrap(text, chars);
  /** Wrap styled runs, keeping the style of each word. */
  const emitRuns = (runs: Run[], size: number, x: number, gap: number, maxChars: number): void => {
    interface Word { text: string; font: string }
    const words: Word[] = [];
    for (const run of runs) {
      const font = run.code ? 'F3' : run.bold ? 'F2' : run.italic ? 'F4' : 'F1';
      for (const word of run.text.split(/\s+/).filter(Boolean)) words.push({ text: word, font });
    }
    if (words.length === 0) return;
    let line: Word[] = [];
    let length = 0;
    const flush = (): void => {
      // Consecutive same-font words are emitted as one text run per font span.
      let cursorX = x;
      let span: Word[] = [];
      const flushSpan = (): void => {
        if (span.length === 0) return;
        const text = span.map((w) => w.text).join(' ');
        ensure(gap);
        page.push(`BT /${span[0]!.font} ${size} Tf ${cursorX} ${y} Td (${pdfEscape(text)}) Tj ET`);
        cursorX += (text.length + 1) * size * 0.5;
        span = [];
      };
      for (const word of line) {
        if (span.length > 0 && span[0]!.font !== word.font) flushSpan();
        span.push(word);
      }
      flushSpan();
      y -= gap;
      line = [];
      length = 0;
    };
    for (const word of words) {
      if (length > 0 && length + word.text.length + 1 > maxChars) flush();
      line.push(word);
      length += word.text.length + 1;
    }
    flush();
  };

  // Raster images referenced by image blocks, embedded as JPEG XObjects.
  const pdfImages = new Map<string, { data: ArtifactImageData; bytes: Buffer }>();
  for (const block of blocks) {
    if (block.kind === 'image' && block.imageId !== undefined && images[block.imageId] !== undefined && !pdfImages.has(block.imageId)) {
      const data = images[block.imageId]!;
      const { buffer, format } = imageBytes(data);
      if (format === 'jpeg') pdfImages.set(block.imageId, { data, bytes: buffer });
    }
  }
  const imageName = (imageId: string): string => `Im${[...pdfImages.keys()].indexOf(imageId) + 1}`;

  for (const block of blocks) {
    if (block.kind === 'image') {
      const found = block.imageId !== undefined ? pdfImages.get(block.imageId) : undefined;
      if (found === undefined) { emit('(diagram)', 'F4', 10, 56, 16); y -= 4; } else {
        const width = Math.min(500, found.data.width);
        const height = Math.min(330, width * (found.data.height / Math.max(1, found.data.width)));
        ensure(height + 10);
        page.push(`q ${width} 0 0 ${height} 56 ${y - height} cm /${imageName(block.imageId!)} Do Q`);
        y -= height + 8;
      }
    } else if (block.kind === 'heading') {
      const size = block.level === 1 ? 20 : block.level === 2 ? 15 : 12.5;
      y -= block.level === 1 ? 2 : 8;
      emitRuns(block.runs.map((r) => ({ ...r, bold: true })), size, 56, size + 8, Math.floor(500 / (size * 0.52)));
      y -= 3;
    } else if (block.kind === 'paragraph') {
      emitRuns(block.runs, 11, 56, 17, 88);
      y -= 5;
    } else if (block.kind === 'bullet' || block.kind === 'numbered') {
      const markerX = 56 + block.level * 18;
      ensure(17);
      page.push(`BT /F1 11 Tf ${markerX} ${y} Td (${block.kind === 'bullet' ? '\\267' : pdfEscape(block.marker)}) Tj ET`);
      emitRuns(block.runs, 11, markerX + 16, 17, 88 - block.level * 3 - 3);
      y -= 2;
    } else if (block.kind === 'quote') {
      emitRuns(block.runs.map((r) => ({ ...r, italic: true })), 11, 72, 17, 82);
      y -= 5;
    } else if (block.kind === 'rule') {
      ensure(14);
      page.push(`0.75 G 56 ${y + 4} m 556 ${y + 4} l S 0 G`);
      y -= 12;
    } else if (block.kind === 'code') {
      for (const line of block.lines) {
        for (const part of wrapPlain(line.replace(/\t/g, '  '), 92)) {
          ensure(13);
          page.push(`0.94 G 52 ${y - 3} 508 13 re f 0 G`);
          emit(part === '' ? ' ' : part, 'F3', 8.5, 58, 13);
        }
      }
      y -= 6;
    } else if (block.kind === 'table') {
      const columns = Math.max(block.header.length, ...block.rows.map((r) => r.length), 1);
      const widths: number[] = Array.from({ length: columns }, (_, c) =>
        Math.max(block.header[c]?.length ?? 0, ...block.rows.map((r) => r[c]?.length ?? 0), 3));
      const total = widths.reduce((a, b) => a + b, 0);
      const chars = widths.map((w) => Math.max(3, Math.floor((w / total) * 96)));
      const drawRow = (cells: string[], font: string): void => {
        const wrapped = cells.map((cell, c) => wrapPlain(cell, chars[c] ?? 10));
        const height = Math.max(1, ...wrapped.map((w) => w.length));
        for (let lineIndex = 0; lineIndex < height; lineIndex += 1) {
          ensure(13);
          let cursorX = 56;
          for (let c = 0; c < columns; c += 1) {
            const text = wrapped[c]?.[lineIndex] ?? '';
            if (text !== '') page.push(`BT /${font} 8 Tf ${cursorX} ${y} Td (${pdfEscape(text)}) Tj ET`);
            cursorX += (chars[c] ?? 10) * 4.8 + 6;
          }
          y -= 13;
        }
        page.push(`0.8 G 56 ${y + 9} m 556 ${y + 9} l S 0 G`);
        y -= 3;
      };
      drawRow(block.header, 'F2');
      for (const row of block.rows) drawRow(row, 'F1');
      y -= 6;
    }
  }
  pages.push(page);
  // ids: 1 catalog, 2 pages, 3-6 fonts, 7.. image XObjects, then page objs
  const bodies: (string | Buffer)[] = ['', '',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique >>'];
  const imageIds = new Map<string, number>();
  for (const [imageId, found] of pdfImages) {
    const objectId = bodies.length + 1;
    imageIds.set(imageId, objectId);
    bodies.push(Buffer.concat([
      utf8(`<< /Type /XObject /Subtype /Image /Width ${found.data.width} /Height ${found.data.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${found.bytes.length} >>\nstream\n`),
      found.bytes,
      utf8('\nendstream'),
    ]));
  }
  const firstPageId = bodies.length + 1;
  const pageIds = pages.map((_, i) => firstPageId + i * 2);
  const xobjects = [...imageIds.entries()].map(([imageId, objectId]) => `/${imageName(imageId)} ${objectId} 0 R`).join(' ');
  pages.forEach((commands, i) => {
    const content = commands.join('\n');
    bodies[pageIds[i]! - 1] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R /F2 4 0 R /F3 5 0 R /F4 6 0 R >>${xobjects !== '' ? ` /XObject << ${xobjects} >>` : ''} >> /Contents ${pageIds[i]! + 1} 0 R >>`;
    bodies[pageIds[i]!] = `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
  });
  bodies[1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  bodies[0] = '<< /Type /Catalog /Pages 2 0 R >>';
  const parts: Buffer[] = [utf8('%PDF-1.4\n')];
  let length = parts[0]!.length;
  const offsets: number[] = [];
  bodies.forEach((body, i) => {
    offsets[i] = length;
    const head = utf8(`${i + 1} 0 obj\n`);
    const tail = utf8('\nendobj\n');
    const data = typeof body === 'string' ? utf8(body) : body;
    parts.push(head, data, tail);
    length += head.length + data.length + tail.length;
  });
  const xref = length;
  parts.push(utf8(`xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${bodies.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`));
  return Buffer.concat(parts);
}

// ---- DOCX ----

function docxRuns(runs: Run[]): string {
  return runs.map((run) => {
    const props = [
      run.bold ? '<w:b/>' : '',
      run.italic ? '<w:i/>' : '',
      run.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="19"/><w:shd w:val="clear" w:fill="F2F2F2"/>' : '',
    ].join('');
    return `<w:r>${props !== '' ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(run.text)}</w:t></w:r>`;
  }).join('');
}

function docxParagraph(runs: Run[], style?: string, extraPr = ''): string {
  return `<w:p><w:pPr>${style !== undefined ? `<w:pStyle w:val="${style}"/>` : ''}<w:spacing w:after="120" w:line="276" w:lineRule="auto"/>${extraPr}</w:pPr>${docxRuns(runs)}</w:p>`;
}

function generateDocx(spec: GeneratedArtifactSpec, images: ArtifactImages): Buffer {
  const parts: string[] = [];
  const media: { name: string; data: Buffer }[] = [];
  const imageRel = new Map<string, string>();
  const docxImage = (imageId: string): string | null => {
    const data = images[imageId];
    if (data === undefined) return null;
    const existing = imageRel.get(imageId);
    if (existing !== undefined) return existing;
    const { buffer } = imageBytes(data);
    const n = media.length + 1;
    media.push({ name: `word/media/image${n}.png`, data: buffer });
    const rel = `rIdImg${n}`;
    imageRel.set(imageId, rel);
    const widthIn = Math.min(6, data.width / 150);
    const cx = Math.round(widthIn * 914_400);
    const cy = Math.round(cx * (data.height / Math.max(1, data.width)));
    return `<w:p><w:pPr><w:spacing w:after="160"/></w:pPr><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Image ${n}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/picture/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${n}" name="image${n}.png"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rel}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
  };
  for (const block of parseBlocks(spec)) {
    if (block.kind === 'image') {
      const drawn = block.imageId !== undefined ? docxImage(block.imageId) : null;
      parts.push(drawn ?? docxParagraph([{ text: '(diagram)', italic: true }], 'Normal'));
      continue;
    }
    if (block.kind === 'heading') {
      const style = block.level === 1 && parts.length === 0 ? 'Title' : block.level === 1 ? 'Heading1' : block.level === 2 ? 'Heading2' : 'Heading3';
      parts.push(docxParagraph(block.runs.map((r) => ({ ...r, bold: true })), style));
    } else if (block.kind === 'paragraph') parts.push(docxParagraph(block.runs, 'Normal'));
    else if (block.kind === 'bullet') parts.push(docxParagraph([{ text: '•  ' }, ...block.runs], block.level > 0 ? 'ListBullet2' : 'ListBullet'));
    else if (block.kind === 'numbered') parts.push(docxParagraph([{ text: `${block.marker} ` }, ...block.runs], block.level > 0 ? 'ListBullet2' : 'ListBullet'));
    else if (block.kind === 'quote') parts.push(docxParagraph(block.runs.map((r) => ({ ...r, italic: true })), 'Quote'));
    else if (block.kind === 'rule') parts.push('<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="BFBFBF"/></w:pBdr><w:spacing w:after="120"/></w:pPr></w:p>');
    else if (block.kind === 'code') {
      for (const line of block.lines) {
        parts.push(`<w:p><w:pPr><w:shd w:val="clear" w:fill="F2F2F2"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/><w:ind w:left="120"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xml(line === '' ? ' ' : line)}</w:t></w:r></w:p>`);
      }
      parts.push('<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>');
    } else if (block.kind === 'table') {
      const cell = (text: string, header: boolean): string =>
        `<w:tc><w:tcPr>${header ? '<w:shd w:val="clear" w:fill="D9E2F3"/>' : ''}<w:tcMar><w:top w:w="40" w:type="dxa"/><w:bottom w:w="40" w:type="dxa"/><w:left w:w="80" w:type="dxa"/><w:right w:w="80" w:type="dxa"/></w:tcMar></w:tcPr>${docxParagraph(parseInline(text).map((r) => (header ? { ...r, bold: true } : r)), 'TableCell')}</w:tc>`;
      const row = (cells: string[], header: boolean): string => `<w:tr>${cells.map((c) => cell(c, header)).join('')}</w:tr>`;
      const borders = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="B4C2D6"/><w:left w:val="single" w:sz="4" w:color="B4C2D6"/><w:bottom w:val="single" w:sz="4" w:color="B4C2D6"/><w:right w:val="single" w:sz="4" w:color="B4C2D6"/><w:insideH w:val="single" w:sz="4" w:color="B4C2D6"/><w:insideV w:val="single" w:sz="4" w:color="B4C2D6"/></w:tblBorders>';
      parts.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/>${borders}</w:tblPr>${row(block.header, true)}${block.rows.map((r) => row(r, false)).join('')}</w:tbl>`);
      parts.push('<w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>');
    }
  }
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><w:body>${parts.join('')}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1134" w:bottom="1134" w:left="1134" w:right="1134"/></w:sectPr></w:body></w:document>`;
  const documentRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>${media.map((_m, i) => `<Relationship Id="rIdImg${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/image${i + 1}.png"/>`).join('')}</Relationships>`;
  const style = (id: string, name: string, rPr: string, pPr = ''): string =>
    `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/>${pPr}<w:rPr>${rPr}</w:rPr></w:style>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">`
    + style('Normal', 'Normal', '<w:sz w:val="22"/>')
    + style('Title', 'Title', '<w:b/><w:sz w:val="44"/><w:color w:val="1F3864"/>')
    + style('Heading1', 'Heading 1', '<w:b/><w:sz w:val="32"/><w:color w:val="1F3864"/>', '<w:pPr><w:spacing w:before="360" w:after="120"/><w:keepNext/></w:pPr>')
    + style('Heading2', 'Heading 2', '<w:b/><w:sz w:val="26"/><w:color w:val="2E5496"/>', '<w:pPr><w:spacing w:before="280" w:after="100"/><w:keepNext/></w:pPr>')
    + style('Heading3', 'Heading 3', '<w:b/><w:sz w:val="23"/><w:color w:val="2E5496"/>', '<w:pPr><w:spacing w:before="220" w:after="80"/><w:keepNext/></w:pPr>')
    + style('ListBullet', 'List Bullet', '<w:sz w:val="22"/>', '<w:pPr><w:ind w:left="420" w:hanging="240"/></w:pPr>')
    + style('ListBullet2', 'List Bullet 2', '<w:sz w:val="22"/>', '<w:pPr><w:ind w:left="840" w:hanging="240"/></w:pPr>')
    + style('Quote', 'Quote', '<w:i/><w:sz w:val="22"/><w:color w:val="595959"/>', '<w:pPr><w:ind w:left="420"/></w:pPr>')
    + style('TableCell', 'Table Cell', '<w:sz w:val="20"/>')
    + '</w:styles>';
  return zip([
    { name: '[Content_Types].xml', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>') },
    { name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>') },
    { name: 'word/document.xml', data: utf8(document) },
    { name: 'word/styles.xml', data: utf8(styles) },
    { name: 'word/_rels/document.xml.rels', data: utf8(documentRels) },
    ...media.map((m) => ({ name: m.name, data: m.data })),
  ]);
}

// ---- PPTX ----

function slideXml(title: string, bullets: string[], body?: string, image?: { rel: string; data: ArtifactImageData }): string {
  const bulletRuns = bullets.map((b) => `<a:p><a:pPr lvl="0"/><a:r><a:rPr lang="en-US" sz="1500"/><a:t>${xml(stripInline(b))}</a:t></a:r></a:p>`).join('');
  const bodyRun = body !== undefined && body.trim() !== '' ? `<a:p><a:r><a:rPr lang="en-US" sz="1400"/><a:t>${xml(stripInline(body.trim()))}</a:t></a:r></a:p>` : '';
  const shape = (id: number, x: number, y: number, cx: number, cy: number, inner: string): string =>
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/>${inner}</p:txBody></p:sp>`;
  const titleShape = shape(2, 457200, 274638, 8229600, 1143000, `<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>${xml(stripInline(title))}</a:t></a:r></a:p>`);
  const bodyShape = shape(3, 457200, 1600200, 8229600, image !== undefined ? 1752600 : 4521200, bulletRuns + bodyRun || '<a:p/>');
  let pic = '';
  if (image !== undefined) {
    const maxCx = 8229600;
    const maxCy = 2900000;
    const scale = Math.min(maxCx / Math.max(1, image.data.width), maxCy / Math.max(1, image.data.height));
    const cx = Math.round(image.data.width * scale);
    const cy = Math.round(image.data.height * scale);
    const x = 457200 + Math.round((maxCx - cx) / 2);
    pic = `<p:pic><p:nvPicPr><p:cNvPr id="4" name="Diagram"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${image.rel}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${x}" y="3505200"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${titleShape}${bodyShape}${pic}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
}

function generatePptx(spec: GeneratedArtifactSpec, images: ArtifactImages): Buffer {
  const slides = spec.slides ?? [];
  const media: { name: string; data: Buffer }[] = [];
  const slideParts = slides.map((slide, i) => {
    const data = slide.imageId !== undefined ? images[slide.imageId] : undefined;
    let image: { rel: string; data: ArtifactImageData } | undefined;
    if (data !== undefined) {
      const { buffer } = imageBytes(data);
      media.push({ name: `ppt/media/image${media.length + 1}.png`, data: buffer });
      image = { rel: 'rIdImg', data };
    }
    return { name: `ppt/slides/slide${i + 1}.xml`, data: utf8(slideXml(slide.title, slide.bullets, slide.body, image)), hasImage: image !== undefined, mediaIndex: media.length };
  });
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>${slides.map((_, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`).join('')}<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`;
  const presentation = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst><p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="9144000" cy="6858000"/></p:presentation>`;
  const presentationRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>${slides.map((_, i) => `<Relationship Id="rId${i + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide${i + 1}.xml"/>`).join('')}</Relationships>`;
  const master = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="3200" b="1"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const theme = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Conductor"><a:themeElements><a:clrScheme name="Conductor"><a:dk1><a:srgbClr val="111111"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="222222"/></a:dk2><a:lt2><a:srgbClr val="EEEEEE"/></a:lt2><a:accent1><a:srgbClr val="4472C4"/></a:accent1><a:accent2><a:srgbClr val="ED7D31"/></a:accent2><a:accent3><a:srgbClr val="A5A5A5"/></a:accent3><a:accent4><a:srgbClr val="FFC000"/></a:accent4><a:accent5><a:srgbClr val="5B9BD5"/></a:accent5><a:accent6><a:srgbClr val="70AD47"/></a:accent6><a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="Conductor"><a:majorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Conductor"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="70000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="70000"/></a:schemeClr></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:tint val="70000"/></a:schemeClr></a:solidFill><a:solidFill><a:schemeClr val="phClr"><a:shade val="70000"/></a:schemeClr></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  return zip([
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/></Relationships>') },
    { name: 'ppt/presentation.xml', data: utf8(presentation) },
    { name: 'ppt/_rels/presentation.xml.rels', data: utf8(presentationRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: utf8(master) },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/></Relationships>') },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: utf8(layout) },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: utf8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/></Relationships>') },
    { name: 'ppt/theme/theme1.xml', data: utf8(theme) },
    ...slideParts.map(({ name, data }) => ({ name, data })),
    ...media.map((m) => ({ name: m.name, data: m.data })),
    ...slideParts.map((part, i) => ({ name: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: utf8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>${part.hasImage ? `<Relationship Id="rIdImg" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${part.mediaIndex}.png"/>` : ''}</Relationships>`) })),
  ]);
}

export function generateArtifactFile(input: GeneratedArtifactSpecInput, images: ArtifactImages = {}): GeneratedFile {
  const spec = normalizeSpec(input);
  if (spec.kind === 'video') throw new Error('Video artifacts are rendered in the app player');
  const bytes = spec.kind === 'pdf' ? generatePdf(spec, images) : spec.kind === 'document' ? generateDocx(spec, images) : generatePptx(spec, images);
  const meta = ARTIFACT_KIND_META[spec.kind];
  return {
    fileName: artifactFileName(spec),
    mimeType: meta.mimeType,
    sizeBytes: bytes.length,
    dataBase64: bytes.toString('base64'),
  };
}
