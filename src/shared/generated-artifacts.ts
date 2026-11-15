import { z } from 'zod';

// Agent-agnostic deliverables. Any agent (OpenCode, Codex, Claude Code,
// Kiro, Antigravity, …) hands Conductor ONE fenced ```artifact block with a
// JSON spec; Conductor — not the agent — renders the real file. That is why
// this works in casual Chat (read-only, no file tools) as well as in Work,
// and for every CLI: the agent only has to write text.

export const ARTIFACT_KINDS = ['pdf', 'document', 'presentation', 'video', 'markdown', 'zip', 'file'] as const;
export type GeneratedArtifactKind = (typeof ARTIFACT_KINDS)[number];

/** One entry of a zip archive: a relative path and its text content. */
export interface ArtifactFileEntry {
  path: string;
  content: string;
}

export interface ArtifactSlide {
  title: string;
  bullets: string[];
  body?: string;
  /** Seconds this slide/scene stays on screen (video only). */
  durationSeconds?: number;
  /** Inline SVG diagram/image for this slide (no external resources). */
  svg?: string;
  /** Rasterized copy of `svg`, set by the renderer before file generation. */
  imageId?: string;
}

/** A rasterized SVG, handed to the file generators alongside the spec. */
export interface ArtifactImageData {
  /** PNG bytes (docx/pptx) or JPEG bytes (pdf), base64-encoded. */
  dataBase64: string;
  width: number;
  height: number;
}

export interface GeneratedArtifactSpec {
  kind: GeneratedArtifactKind;
  title: string;
  /** Markdown-ish plain text for pdf/document; ignored when slides carry the content. */
  content?: string;
  slides?: ArtifactSlide[];
  /** The archive's entries (zip only). */
  files?: ArtifactFileEntry[];
  /** File name with extension, e.g. "data.csv" (file only). */
  fileName?: string;
}

export interface GeneratedFile {
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  /** Base64 file bytes (pdf/document/presentation). Video is rendered in the renderer. */
  dataBase64: string;
}

/** Hard caps every spec is clamped to before it crosses IPC validation. */
export const SPEC_LIMITS = { title: 200, content: 120_000, slides: 24, bullets: 12, bullet: 2_000, body: 10_000, files: 60, filePath: 200, fileContent: 200_000, fileName: 120 } as const;

const SlideSchema = z.object({
  title: z.string().trim().min(1).max(SPEC_LIMITS.title),
  bullets: z.array(z.string().trim().min(1).max(SPEC_LIMITS.bullet)).max(SPEC_LIMITS.bullets).default([]),
  body: z.string().max(SPEC_LIMITS.body).optional(),
  durationSeconds: z.number().min(1).max(10).optional(),
  svg: z.string().max(48_000).optional(),
  imageId: z.string().max(64).optional(),
}).strict();

export const ArtifactImageDataSchema = z.object({
  dataBase64: z.string().max(5_500_000),
  width: z.number().int().min(1).max(4_096),
  height: z.number().int().min(1).max(4_096),
}).strict();

export const GeneratedArtifactSpecSchema = z.object({
  kind: z.enum(ARTIFACT_KINDS),
  title: z.string().trim().min(1).max(SPEC_LIMITS.title),
  content: z.string().max(SPEC_LIMITS.content).optional(),
  slides: z.array(SlideSchema).max(SPEC_LIMITS.slides).optional(),
  files: z.array(z.object({
    path: z.string().trim().min(1).max(SPEC_LIMITS.filePath),
    content: z.string().max(SPEC_LIMITS.fileContent),
  }).strict()).max(SPEC_LIMITS.files).optional(),
  fileName: z.string().trim().min(1).max(SPEC_LIMITS.fileName).optional(),
}).strict();

export const ARTIFACT_KIND_META: Record<GeneratedArtifactKind, { label: string; extension: string; mimeType: string }> = {
  pdf: { label: 'PDF', extension: 'pdf', mimeType: 'application/pdf' },
  document: { label: 'Document', extension: 'docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  presentation: { label: 'Presentation', extension: 'pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
  video: { label: 'Video', extension: 'webm', mimeType: 'video/webm' },
  markdown: { label: 'Markdown', extension: 'md', mimeType: 'text/markdown' },
  zip: { label: 'Zip archive', extension: 'zip', mimeType: 'application/zip' },
  file: { label: 'File', extension: 'txt', mimeType: 'text/plain' },
};

/** Media types for the text formats an agent can hand back as a plain file. */
const TEXT_FILE_TYPES: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', markdown: 'text/markdown', csv: 'text/csv', tsv: 'text/tab-separated-values',
  json: 'application/json', xml: 'application/xml', yaml: 'application/yaml', yml: 'application/yaml', html: 'text/html',
  htm: 'text/html', css: 'text/css', js: 'text/javascript', ts: 'text/plain', py: 'text/x-python', sh: 'text/x-shellscript',
  sql: 'application/sql', svg: 'image/svg+xml', log: 'text/plain', ini: 'text/plain', toml: 'text/plain', rtf: 'application/rtf',
};

/** A bare, safe file name: no directories, no control or reserved characters. */
export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? '';
  return base.replace(/[\x00-\x1f<>:"|?*]+/g, '').replace(/^\.+/, '').trim().slice(0, SPEC_LIMITS.fileName);
}

/** A relative archive path: forward slashes, no "..", no leading slash or drive. */
export function safeArchivePath(path: string): string {
  return path.replace(/\\/g, '/').split('/')
    .map((part) => part.replace(/[\x00-\x1f<>:"|?*]+/g, '').trim())
    .filter((part) => part !== '' && part !== '.' && part !== '..')
    .join('/').slice(0, SPEC_LIMITS.filePath);
}

export function artifactFileName(spec: Pick<GeneratedArtifactSpec, 'kind' | 'title' | 'fileName'>): string {
  if (spec.kind === 'file' && spec.fileName !== undefined) {
    const safe = safeFileName(spec.fileName);
    if (safe !== '') return /\.[A-Za-z0-9]{1,8}$/.test(safe) ? safe : `${safe}.txt`;
  }
  const base = spec.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'artifact';
  return `${base}.${ARTIFACT_KIND_META[spec.kind].extension}`;
}

export function artifactMimeType(spec: Pick<GeneratedArtifactSpec, 'kind' | 'title' | 'fileName'>): string {
  if (spec.kind !== 'file') return ARTIFACT_KIND_META[spec.kind].mimeType;
  const extension = /\.([A-Za-z0-9]+)$/.exec(artifactFileName(spec))?.[1]?.toLowerCase() ?? 'txt';
  return TEXT_FILE_TYPES[extension] ?? 'text/plain';
}

/** What to call the artifact on its card: "CSV file" for data.csv, else the kind's label. */
export function artifactLabel(spec: Pick<GeneratedArtifactSpec, 'kind' | 'title' | 'fileName'>): string {
  if (spec.kind !== 'file') return ARTIFACT_KIND_META[spec.kind].label;
  const extension = /\.([A-Za-z0-9]+)$/.exec(artifactFileName(spec))?.[1];
  return extension !== undefined ? `${extension.toUpperCase()} file` : 'File';
}

/** Instruction appended to every agent prompt, in both Chat and Work modes. */
export const ARTIFACT_OUTPUT_INSTRUCTION =
  ' When the user asks for a file — a PDF, document/Word/doc, presentation/slides/deck, video, Markdown (.md) file, zip archive, or any other text file such as CSV, JSON, TXT, HTML or source code — do NOT say you cannot create files and do NOT ask them to copy text elsewhere. Conductor creates the real downloadable file for you, in this chat, whichever agent you are, and the user can open it right here. EXCEPTION: if an MCP tool available to you can produce the real result (for example a video- or image-generation MCP server the user installed, or a data tool that can answer directly), call that tool and return its output instead of an artifact block. If a media-generation MCP tool call fails for any reason, including output validation, do not retry it and do not ask the user for an answer or configuration; immediately use the artifact block fallback. The artifact block is also the fallback when no connected tool can do it. End your reply with one fenced code block with language "artifact" per file (usually exactly ONE), each containing only JSON of the form {"kind":"pdf"|"document"|"presentation"|"video"|"markdown"|"zip"|"file","title":"Short title","content":"full markdown-ish text (pdf/document/markdown) or the exact file text (file)","fileName":"name.ext (file only)","files":[{"path":"folder/name.ext","content":"file text"}],"slides":[{"title":"Slide title","bullets":["point"],"body":"optional paragraph","durationSeconds":3,"svg":"<svg …>…</svg>"}]}. For pdf/document/markdown put the complete text in "content" (use "# " headings and "- " bullets). For zip fill "files" with every file of the archive (relative paths, text content). For any other single text file use kind "file" with "fileName" including its extension and the exact file text in "content". For presentation/video fill "slides" (video: each slide is one scene, durationSeconds 2-5). IMAGES AND DIAGRAMS: pdf, document and presentation files are not text-only — whenever the document/deck should contain a diagram, chart, or image (and always when the user asks to include visuals, or you drew a visual earlier in this conversation), embed it as inline SVG: in a slide via its "svg" field, in document/pdf content via a fenced ```svg block at the place it belongs. Reuse the same SVG you would show in chat; inline SVG only, no external image URLs. Put a short explanation in prose before the block and keep the JSON valid: no trailing commas, no comments.';

export type ArtifactSegment =
  | { type: 'markdown'; text: string }
  | { type: 'artifact'; spec: GeneratedArtifactSpec | null; raw: string; complete: boolean };

/** Escape literal control characters inside JSON strings (agents often emit
 *  real newlines inside the "content" value) and drop trailing commas. */
function repairJson(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) { out += char; escaped = false; continue; }
      if (char === '\\') { out += char; escaped = true; continue; }
      if (char === '"') { out += char; inString = false; continue; }
      if (char === '\n') { out += '\\n'; continue; }
      if (char === '\r') { out += '\\n'; continue; }
      if (char === '\t') { out += '\\t'; continue; }
      if (char < ' ') { out += ' '; continue; }
      out += char;
      continue;
    }
    if (char === '"') inString = true;
    out += char;
  }
  return out.replace(/,\s*([}\]])/g, '$1');
}

function parseJsonLoose(text: string): unknown {
  try { return JSON.parse(text); } catch { return JSON.parse(repairJson(text)); }
}

function decodeJsonString(value: string): string {
  return value
    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\n')
    .replace(/\\"/g, '"').replace(/\\\//g, '/').replace(/\\\\/g, '\\');
}

/**
 * Last resort for a block that is not valid JSON at all (unescaped quotes,
 * a fence closed early, …): pull kind/title/content out by pattern and
 * build the file from what is there rather than creating nothing.
 */
export function salvageArtifactSpec(raw: string): GeneratedArtifactSpec | null {
  const text = raw.trim().replace(/`+\s*$/, '');
  if (text === '') return null;
  const kindMatch = /"kind"\s*:\s*"(pdf|document|presentation|video|markdown|zip|file)"/.exec(text);
  const kind = (kindMatch?.[1] ?? 'pdf') as GeneratedArtifactKind;
  const titleMatch = /"title"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const title = titleMatch ? decodeJsonString(titleMatch[1]!) : 'Artifact';
  // An archive is only its entries; there is no prose to rebuild one from.
  if (kind === 'zip') return null;
  const fileNameMatch = /"fileName"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  const contentMatch = /"content"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"slides"|,\s*"files"|,\s*"fileName"|,\s*"duration|\}\s*$)/.exec(text);
  const content = contentMatch
    ? decodeJsonString(contentMatch[1]!)
    : decodeJsonString(text.replace(/^\{/, '').replace(/\}\s*$/, ''))
      .replace(/^\s*"kind"\s*:\s*"[^"]*"\s*,?/, '').replace(/^\s*"title"\s*:\s*"[^"]*"\s*,?/, '')
      .replace(/^\s*"content"\s*:\s*"?/, '').replace(/"\s*$/, '').trim();
  if (content === '') return null;
  return normalizeSpec({ kind, title, content, ...(kind === 'file' && fileNameMatch ? { fileName: decodeJsonString(fileNameMatch[1]!) } : {}) });
}

export function parseArtifactSpec(raw: string): GeneratedArtifactSpec | null {
  try {
    const json: unknown = parseJsonLoose(raw.trim().replace(/`+\s*$/, ''));
    const parsed = GeneratedArtifactSpecSchema.safeParse(json);
    if (parsed.success) return normalizeSpec(parsed.data);
    // Agents add extra keys or overshoot a cap: coerce what is recognizably a
    // spec instead of discarding the whole deliverable, then re-validate.
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null;
    const record = json as Record<string, unknown>;
    const str = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;
    const candidate = {
      kind: record['kind'],
      title: str(record['title']) ?? 'Artifact',
      ...(str(record['content']) !== undefined ? { content: str(record['content']) } : {}),
      ...(Array.isArray(record['slides']) ? {
        slides: record['slides'].filter((s): s is Record<string, unknown> => s !== null && typeof s === 'object')
          .map((s) => ({
            title: str(s['title']) ?? 'Untitled',
            bullets: Array.isArray(s['bullets']) ? s['bullets'].filter((b): b is string => typeof b === 'string') : [],
            ...(str(s['body']) !== undefined ? { body: str(s['body']) } : {}),
            ...(typeof s['durationSeconds'] === 'number' ? { durationSeconds: s['durationSeconds'] } : {}),
            ...(str(s['svg']) !== undefined ? { svg: str(s['svg']) } : {}),
          })),
      } : {}),
      ...(Array.isArray(record['files']) ? {
        files: record['files'].filter((f): f is Record<string, unknown> => f !== null && typeof f === 'object')
          .map((f) => ({ path: str(f['path']) ?? str(f['name']) ?? '', content: str(f['content']) ?? '' })),
      } : {}),
      ...(str(record['fileName']) !== undefined ? { fileName: str(record['fileName']) } : {}),
    };
    // normalizeSpec clamps to the schema caps; validate the clamped result.
    if (!(ARTIFACT_KINDS as readonly string[]).includes(String(candidate.kind))) return null;
    const normalized = normalizeSpec(candidate as GeneratedArtifactSpecInput);
    return GeneratedArtifactSpecSchema.safeParse(normalized).success ? normalized : null;
  } catch { return null; }
}

/**
 * Split a reply into prose and artifact blocks. Line-based so it also
 * handles JSON starting on the fence line and longer (````) fences an
 * agent uses when the content itself contains code fences. A block with
 * no closing fence is still streaming in. A completed block that is not
 * valid JSON is salvaged into a spec instead of producing nothing.
 */
export function splitArtifactBlocks(text: string): ArtifactSegment[] {
  const segments: ArtifactSegment[] = [];
  const lines = text.split('\n');
  let markdown: string[] = [];
  const flushMarkdown = (): void => {
    const joined = markdown.join('\n');
    if (joined.trim() !== '') segments.push({ type: 'markdown', text: joined });
    markdown = [];
  };
  let i = 0;
  while (i < lines.length) {
    const open = /^\s*(`{3,})artifact[ \t]*(.*)$/.exec(lines[i]!);
    if (open === null) { markdown.push(lines[i]!); i += 1; continue; }
    flushMarkdown();
    const fenceLength = open[1]!.length;
    const rawLines: string[] = open[2] !== undefined && open[2] !== '' ? [open[2]] : [];
    i += 1;
    // One-line block: ```artifact {…} ``` — the closing fence is on the
    // opening line itself, so nothing more belongs to the block.
    let complete = false;
    if (rawLines.length === 1) {
      const sameLine = /^(.*?)(`{3,})[ \t]*$/.exec(rawLines[0]!);
      if (sameLine !== null && sameLine[2]!.length >= fenceLength && sameLine[1]!.trim() !== '') {
        rawLines[0] = sameLine[1]!;
        complete = true;
      }
    }
    while (!complete && i < lines.length) {
      const close = /^\s*(`{3,})[ \t]*$/.exec(lines[i]!);
      if (close !== null && close[1]!.length >= fenceLength) { complete = true; i += 1; break; }
      // Closing fence on the same line as the JSON tail: `…"} ``` `
      const inlineClose = /^(.*?)(`{3,})[ \t]*$/.exec(lines[i]!);
      if (inlineClose !== null && inlineClose[2]!.length >= fenceLength && inlineClose[1]!.trim() !== '') {
        rawLines.push(inlineClose[1]!);
        complete = true;
        i += 1;
        break;
      }
      rawLines.push(lines[i]!);
      i += 1;
    }
    const raw = rawLines.join('\n');
    // Salvage even while streaming/unclosed: the renderer only generates
    // once the turn is finished, at which point an agent whose output was
    // cut off mid-block must still produce its file from what arrived.
    const spec = parseArtifactSpec(raw) ?? salvageArtifactSpec(raw);
    segments.push({ type: 'artifact', spec, raw, complete });
  }
  flushMarkdown();
  return segments;
}

export function hasArtifactBlock(text: string): boolean {
  return text.includes('```artifact');
}

/** The agent already produced the file itself (e.g. via an MCP tool) and linked to it. */
export function hasDeliveredFileLink(text: string): boolean {
  return /\]\(https?:\/\/[^)\s]+\)|https?:\/\/\S+\.(?:pptx?|pdf|docx?|xlsx?|mp4|webm|mov)\b/i.test(text)
    && /download|\.(?:pptx?|pdf|docx?|xlsx?|mp4|webm|mov)\b/i.test(text);
}

export type GeneratedArtifactSpecInput = z.infer<typeof GeneratedArtifactSpecSchema>;

type SpecSlideInput = NonNullable<GeneratedArtifactSpecInput['slides']>[number];
const clampSlide = (slide: SpecSlideInput): ArtifactSlide => ({
  title: slide.title.trim().slice(0, SPEC_LIMITS.title) || 'Untitled',
  bullets: slide.bullets.map((b) => b.trim()).filter((b) => b !== '').slice(0, SPEC_LIMITS.bullets)
    .map((b) => b.slice(0, SPEC_LIMITS.bullet)),
  ...(slide.body !== undefined && slide.body.trim() !== '' ? { body: slide.body.slice(0, SPEC_LIMITS.body) } : {}),
  ...(slide.durationSeconds !== undefined ? { durationSeconds: Math.min(10, Math.max(1, slide.durationSeconds)) } : {}),
  ...(slide.svg !== undefined && slide.svg.includes('<svg') ? { svg: slide.svg.slice(0, 48_000) } : {}),
  ...(slide.imageId !== undefined ? { imageId: slide.imageId } : {}),
});

/**
 * Derive slides from content when an agent gave text only (or vice versa),
 * and clamp every field to SPEC_LIMITS so the result always passes
 * GeneratedArtifactSpecSchema — a long real-world reply (the fallback path
 * synthesizes specs from arbitrary prose) must never fail IPC validation.
 */
export function normalizeSpec(spec: GeneratedArtifactSpecInput): GeneratedArtifactSpec {
  const title = spec.title.trim().slice(0, SPEC_LIMITS.title) || 'Artifact';
  if (spec.kind === 'zip') {
    // Entries are the whole archive: safe relative paths, no duplicates.
    const taken = new Set<string>();
    const files: ArtifactFileEntry[] = [];
    for (const entry of spec.files ?? []) {
      const path = safeArchivePath(entry.path);
      if (path === '' || taken.has(path)) continue;
      taken.add(path);
      files.push({ path, content: entry.content.slice(0, SPEC_LIMITS.fileContent) });
      if (files.length >= SPEC_LIMITS.files) break;
    }
    // An agent that gave only text still gets an archive holding it.
    if (files.length === 0 && spec.content !== undefined && spec.content.trim() !== '') {
      files.push({ path: 'README.md', content: spec.content.slice(0, SPEC_LIMITS.fileContent) });
    }
    return { kind: 'zip', title, files };
  }
  if (spec.kind === 'markdown' || spec.kind === 'file') {
    // Text files are delivered exactly as written: no slides, no reflow.
    const content = (spec.content ?? '').slice(0, SPEC_LIMITS.content);
    const fileName = spec.kind === 'file' && spec.fileName !== undefined ? safeFileName(spec.fileName) : '';
    return { kind: spec.kind, title, content, ...(fileName !== '' ? { fileName } : {}) };
  }
  const given = spec.slides?.filter((s) => s.title.trim() !== '').map(clampSlide);
  const slides = (given !== undefined && given.length > 0
    ? given
    : spec.content !== undefined && spec.content.trim() !== ''
      ? slidesFromContent(spec.content, title).map(clampSlide)
      : [{ title, bullets: [] }]).slice(0, SPEC_LIMITS.slides);
  const content = (spec.content ?? slides.map((s) => `# ${s.title}\n${s.body ?? ''}\n${s.bullets.map((b) => `- ${b}`).join('\n')}`).join('\n\n'))
    .slice(0, SPEC_LIMITS.content);
  return { kind: spec.kind, title, content, slides };
}

export function slidesFromContent(content: string, fallbackTitle: string): ArtifactSlide[] {
  const slides: ArtifactSlide[] = [];
  let current: ArtifactSlide = { title: fallbackTitle, bullets: [] };
  const flush = (): void => { if (current.bullets.length > 0 || current.body || (current.title.trim() !== '' && current.title !== fallbackTitle)) slides.push(current); };
  for (const line of content.split('\n')) {
    const heading = /^#{1,3}\s+(.+)$/.exec(line.trim());
    const bullet = /^[-*•]\s+(.+)$/.exec(line.trim());
    if (heading) { flush(); current = { title: heading[1]!.trim(), bullets: [] }; }
    else if (bullet) current.bullets.push(bullet[1]!.trim());
    else if (line.trim() !== '') current.body = current.body === undefined ? line.trim() : `${current.body}\n${line.trim()}`;
  }
  flush();
  return slides.length > 0 ? slides.slice(0, 24) : [{ title: fallbackTitle, bullets: [] }];
}

/** Which deliverable a user request asks for, if any — the fallback trigger. */
export function requestedArtifactKind(objective: string): GeneratedArtifactKind | null {
  const text = objective.toLowerCase();
  if (/\b(video|mp4|webm|movie|animation|animated|reel|clip|screencast)\b/.test(text)) return 'video';
  if (/\b(presentation|slides?|slide deck|deck|powerpoint|pptx?|keynote)\b/.test(text)) return 'presentation';
  if (/\b(pdf)\b|\.pdf\b/.test(text)) return 'pdf';
  if (/\bmarkdown (file|document|doc)\b|\b(an?|as|in) \.?md\b|\.md\b|\bmd file\b/.test(text)) return 'markdown';
  if (/\b(word|docx?|document|doc|memo|letter|report|resume|cv|essay|write[- ]?up)\b/.test(text)
    && /\b(create|make|generate|write|draft|prepare|give|send|export|produce|build|as|in)\b/.test(text)) return 'document';
  return null;
}

/**
 * Fallback for agents that ignored the artifact format: Conductor still
 * delivers a file, built from the reply text itself, whenever the user
 * plainly asked for one.
 */
export function synthesizeSpec(kind: GeneratedArtifactKind, objective: string, reply: string): GeneratedArtifactSpec {
  const title = objective.replace(/\s+/g, ' ').trim().slice(0, 80) || ARTIFACT_KIND_META[kind].label;
  const content = reply.trim();
  return normalizeSpec({ kind, title, content, slides: slidesFromContent(content, title) });
}
