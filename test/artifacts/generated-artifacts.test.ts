import { describe, expect, it } from 'vitest';
import {
  GeneratedArtifactSpecSchema, hasArtifactBlock, parseArtifactSpec, requestedArtifactKind, splitArtifactBlocks, synthesizeSpec,
} from '@shared/generated-artifacts';
import { generateArtifactFile } from '@main/artifacts/generate-artifact';

describe('artifact specs (any agent, both modes)', () => {
  it('parses an artifact block out of a reply and keeps the prose', () => {
    const reply = 'Here you go.\n```artifact\n{"kind":"pdf","title":"Expense Report","content":"# Totals\\n- Taxi 40"}\n```';
    const segments = splitArtifactBlocks(reply);
    expect(hasArtifactBlock(reply)).toBe(true);
    expect(segments[0]).toMatchObject({ type: 'markdown' });
    expect(segments[1]).toMatchObject({ type: 'artifact', complete: true, spec: { kind: 'pdf', title: 'Expense Report' } });
  });

  it('repairs artifact JSON with literal newlines inside the content string', () => {
    // The screenshot failure: agents emit real newlines in "content",
    // which strict JSON.parse rejects.
    const reply = 'Here is the document.\n```artifact\n{"kind":"document","title":"Architecture","content":"# Overview\n\n## 8. Operations\n- Dev: npm run dev\n- Gates: npm test"}\n```';
    const segment = splitArtifactBlocks(reply)[1];
    expect(segment).toMatchObject({ type: 'artifact', complete: true });
    if (segment?.type !== 'artifact') throw new Error('expected artifact');
    expect(segment.spec).toMatchObject({ kind: 'document', title: 'Architecture' });
    expect(segment.spec?.content).toContain('## 8. Operations');
    expect(generateArtifactFile(segment.spec!).fileName).toBe('architecture.docx');
  });

  it('handles JSON on the fence line, longer fences, and trailing commas', () => {
    const sameLine = splitArtifactBlocks('```artifact {"kind":"pdf","title":"One Line","content":"# Hi",}\n```');
    expect(sameLine[0]).toMatchObject({ type: 'artifact', complete: true, spec: { kind: 'pdf', title: 'One Line' } });
    const longer = splitArtifactBlocks('````artifact\n{"kind":"pdf","title":"Fenced","content":"```\ncode\n```"}\n````');
    expect(longer[0]).toMatchObject({ type: 'artifact', complete: true, spec: { title: 'Fenced' } });
    const oneLine = splitArtifactBlocks('```artifact {"kind":"pdf","title":"Single","content":"# Hi"} ```\nAfter the file.');
    expect(oneLine[0]).toMatchObject({ type: 'artifact', complete: true, spec: { title: 'Single' } });
    expect(oneLine[1]).toMatchObject({ type: 'markdown', text: 'After the file.' });
  });

  it('salvages a spec from an artifact block that is not valid JSON at all', () => {
    const reply = '```artifact\n{"kind": "pdf", "title": "Notes", "content": "He said "hello" and left"}\n```';
    const segment = splitArtifactBlocks(reply)[0];
    if (segment?.type !== 'artifact') throw new Error('expected artifact');
    expect(segment.spec).not.toBeNull();
    expect(segment.spec?.kind).toBe('pdf');
    expect(segment.spec?.content ?? '').toContain('hello');
    expect(generateArtifactFile(segment.spec!).fileName).toBe('notes.pdf');
  });

  it('salvages an unclosed block (agent output cut off) once the turn ends', () => {
    const reply = 'Full document below.\n```artifact\n{"kind":"document","title":"Architecture","content":"# Overview\nFull text here';
    const segment = splitArtifactBlocks(reply)[1];
    if (segment?.type !== 'artifact') throw new Error('expected artifact');
    expect(segment.complete).toBe(false);
    // The renderer treats a finished turn's unclosed block as complete and
    // generates from this salvaged spec instead of spinning forever.
    expect(segment.spec).toMatchObject({ kind: 'document', title: 'Architecture' });
    expect(generateArtifactFile(segment.spec!).fileName).toBe('architecture.docx');
  });

  it('marks a still-streaming block incomplete and rejects invalid specs', () => {
    expect(splitArtifactBlocks('```artifact\n{"kind":"pdf"')[0]).toMatchObject({ type: 'artifact', complete: false, spec: null });
    expect(parseArtifactSpec('{"kind":"exe","title":"x"}')).toBeNull();
    expect(parseArtifactSpec('not json')).toBeNull();
  });

  it('clamps a long real-world reply so the synthesized spec always passes IPC validation', () => {
    // Regression: an architecture explanation converted to a document failed
    // with "Payload failed validation" — long bullets/body/content overshot
    // the schema caps.
    const longBullet = `- ${'a very detailed component description '.repeat(120)}`;
    const longBody = Array.from({ length: 60 }, (_, i) => `Paragraph ${i} ${'explaining a subsystem in depth '.repeat(30)}`).join('\n');
    const reply = `# ${'Architecture '.repeat(30)}\n${longBullet}\n${longBody}`;
    const spec = synthesizeSpec('document', 'convert the previous architecture diagram into a document', reply);
    expect(GeneratedArtifactSpecSchema.safeParse(spec).success).toBe(true);
    const file = generateArtifactFile(spec);
    expect(Buffer.from(file.dataBase64, 'base64').subarray(0, 2).toString()).toBe('PK');
  });

  it('coerces agent specs with extra keys or oversized fields instead of discarding them', () => {
    const spec = parseArtifactSpec(JSON.stringify({
      kind: 'document', title: 'Conductor Architecture', filename: 'extra-key.docx',
      slides: [{ title: 'Overview', bullets: ['x'.repeat(5_000), ''], body: 'y'.repeat(20_000) }],
    }));
    expect(spec).not.toBeNull();
    expect(GeneratedArtifactSpecSchema.safeParse(spec).success).toBe(true);
  });

  it('detects the requested deliverable and synthesizes a spec from plain replies', () => {
    expect(requestedArtifactKind('create a pdf of this')).toBe('pdf');
    expect(requestedArtifactKind('make me a presentation about bees')).toBe('presentation');
    expect(requestedArtifactKind('generate a video explaining tides')).toBe('video');
    expect(requestedArtifactKind('write a report as a document')).toBe('document');
    expect(requestedArtifactKind('what is the capital of France?')).toBeNull();
    const spec = synthesizeSpec('presentation', 'make a presentation about bees', '# Bees\n- They pollinate');
    expect(spec.slides?.[0]).toMatchObject({ title: 'Bees', bullets: ['They pollinate'] });
  });
});

describe('generateArtifactFile', () => {
  it('renders a real PDF', () => {
    const file = generateArtifactFile({ kind: 'pdf', title: 'Expense Report', content: '# Totals\n- Taxi 40\n- Hotel 120' });
    expect(file.fileName).toBe('expense-report.pdf');
    expect(file.mimeType).toBe('application/pdf');
    const bytes = Buffer.from(file.dataBase64, 'base64');
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString('latin1')).toContain('Expense Report');
    expect(file.sizeBytes).toBe(bytes.length);
  });

  it('renders a DOCX (OOXML zip with the document text)', () => {
    const file = generateArtifactFile({ kind: 'document', title: 'Memo', content: '# Hi\nBody text here' });
    expect(file.fileName).toBe('memo.docx');
    const bytes = Buffer.from(file.dataBase64, 'base64');
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    // Entries are deflated, but part names stay readable in the zip listing.
    expect(bytes.toString('latin1')).toContain('word/document.xml');
  });

  it('renders a PPTX with one slide part per slide', () => {
    const file = generateArtifactFile({
      kind: 'presentation', title: 'Bees',
      slides: [{ title: 'Intro', bullets: ['One'] }, { title: 'End', bullets: ['Two'] }],
    });
    expect(file.fileName).toBe('bees.pptx');
    const bytes = Buffer.from(file.dataBase64, 'base64');
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.toString('latin1')).toContain('ppt/slides/slide2.xml');
  });

  it('formats markdown in PDFs: styled fonts, no raw markdown markers', () => {
    const file = generateArtifactFile({
      kind: 'pdf', title: 'Report',
      content: '# Report\nIntro with **bold** and `code`.\n## Findings\n- First **key** point\n```\nconst x = 1;\n```\n| Name | Value |\n|---|---|\n| Alpha | 10 |',
    });
    const text = Buffer.from(file.dataBase64, 'base64').toString('latin1');
    expect(text).toContain('/Helvetica-Bold');
    expect(text).toContain('/Courier');
    expect(text).toContain('Findings');
    expect(text).toContain('Alpha');
    expect(text).not.toContain('**bold**');
    expect(text).not.toContain('|---|');
  });

  it('embeds raster images in PDF, DOCX, and PPTX', () => {
    const png = { dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', width: 1, height: 1 };
    const jpeg = { dataBase64: '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AvwEf/9k=', width: 1, height: 1 };
    const pdf = generateArtifactFile(
      { kind: 'pdf', title: 'With Diagram', content: '# With Diagram\nBefore\n[[conductor-image:img-0]]\nAfter' },
      { 'img-0': jpeg },
    );
    const pdfBytes = Buffer.from(pdf.dataBase64, 'base64');
    expect(pdfBytes.toString('latin1')).toContain('/DCTDecode');
    expect(pdfBytes.toString('latin1')).toContain('/XObject');

    const docx = generateArtifactFile(
      { kind: 'document', title: 'With Diagram', content: '# With Diagram\n[[conductor-image:img-0]]' },
      { 'img-0': png },
    );
    expect(Buffer.from(docx.dataBase64, 'base64').toString('latin1')).toContain('word/media/image1.png');

    const pptx = generateArtifactFile(
      { kind: 'presentation', title: 'Deck', slides: [{ title: 'Flow', bullets: ['One'], svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' , imageId: 'slide-0' }] },
      { 'slide-0': png },
    );
    expect(Buffer.from(pptx.dataBase64, 'base64').toString('latin1')).toContain('ppt/media/image1.png');
  });

  it('keeps slide SVGs in the parsed spec for the renderer to rasterize', () => {
    const spec = parseArtifactSpec('{"kind":"presentation","title":"Deck","slides":[{"title":"Flow","bullets":[],"svg":"<svg xmlns=\\"http://www.w3.org/2000/svg\\"><rect/></svg>"}]}');
    expect(spec?.slides?.[0]?.svg).toContain('<rect/>');
  });

  it('refuses video (rendered by the in-chat player, not the file service)', () => {
    expect(() => generateArtifactFile({ kind: 'video', title: 'Tides', slides: [{ title: 'Moon', bullets: [] }] }))
      .toThrow(/player/);
  });
});
