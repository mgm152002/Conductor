import { z } from 'zod';

// Attachment contracts shared by the main process, the sandboxed preload and
// the renderer. Three rules shape this module:
//
//  1. The renderer never learns a filesystem path. `AttachmentSummary`,
//     `AttachmentRef` and every preview variant carry an id and metadata only;
//     the main process owns the bytes and serves them by id.
//  2. Limits are declared here once. The renderer may pre-check them for a
//     friendly message, but the main process re-enforces them against the
//     actual file size and message count (Requirement 5.3).
//  3. Text extracted from an attachment is untrusted reference data. It is
//     returned only as preview/delivery content, never as instructions.

/** Every file class the attachment pipeline understands. */
export const ATTACHMENT_KINDS = [
  'image',
  'markdown',
  'text',
  'pdf',
  'docx',
  'doc',
  'unsupported',
] as const;

export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

/** Human labels for attachment chips and metadata fallbacks. */
export const ATTACHMENT_KIND_LABELS: Readonly<Record<AttachmentKind, string>> = {
  image: 'Image',
  markdown: 'Markdown',
  text: 'Text',
  pdf: 'PDF',
  docx: 'Word document',
  doc: 'Word document',
  unsupported: 'Unsupported file',
};

/** How a preview is rendered in the UI. DOCX/DOC previews as Markdown. */
export const ATTACHMENT_PREVIEW_FORMATS = [
  'image',
  'markdown',
  'pdf',
  'text',
  'unsupported',
] as const;

export type AttachmentPreviewFormat = (typeof ATTACHMENT_PREVIEW_FORMATS)[number];

// ---- Limits (single source of truth) ----

/** Maximum size of a single attached file: 25 MiB. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** Maximum number of attachments on one task message or chat message. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 10;

/** Maximum combined attachment bytes accepted for one message (250 MiB). */
export const MAX_ATTACHMENT_TOTAL_BYTES = MAX_ATTACHMENT_BYTES * MAX_ATTACHMENTS_PER_MESSAGE;

/** Bounded text extracted from a document for previews and agent prompts. */
export const MAX_ATTACHMENT_EXTRACTED_CHARS = 40_000;

/** Bounded pages rendered from a PDF; later pages are reported as truncated. */
export const MAX_ATTACHMENT_PDF_PAGES = 100;

/** A display name is bounded so a hostile filename cannot flood the UI. */
export const MAX_ATTACHMENT_NAME_LENGTH = 255;

// ---- Validation helpers (UI pre-checks; main re-enforces) ----

/** Returns an actionable error for a file that is too large, else null. */
export function attachmentSizeError(sizeBytes: number): string | null {
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) return 'The file size could not be read.';
  if (sizeBytes === 0) return 'The file is empty.';
  if (sizeBytes > MAX_ATTACHMENT_BYTES) {
    return `The file is larger than the ${formatAttachmentSize(MAX_ATTACHMENT_BYTES)} limit.`;
  }
  return null;
}

/** Returns an actionable error for an over-count or over-budget selection. */
export function attachmentBatchError(count: number, totalBytes = 0): string | null {
  if (count > MAX_ATTACHMENTS_PER_MESSAGE) {
    return `Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message.`;
  }
  if (totalBytes > MAX_ATTACHMENT_TOTAL_BYTES) {
    return `The attachments exceed the ${formatAttachmentSize(MAX_ATTACHMENT_TOTAL_BYTES)} per-message limit.`;
  }
  return null;
}

/** Compact byte label used by attachment chips (e.g. `2.4 MB`). */
export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[unit]}`;
}

// ---- Durable references ----

/**
 * The chip-shaped metadata for one stored attachment. Safe to cross IPC: it
 * contains no path, no bytes and no secret material.
 */
export interface AttachmentSummary {
  readonly id: string;
  /** Sanitized display name (basename only). */
  readonly name: string;
  readonly kind: AttachmentKind;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/**
 * A durable attachment reference used by task details, chat history and agent
 * manifests. Extends the chip metadata with content identity and age. It still
 * carries no filesystem path.
 */
export interface AttachmentRef extends AttachmentSummary {
  /** Lowercase hex SHA-256 of the stored bytes, for deduplication. */
  readonly sha256: string;
  readonly createdAt: string;
}

/**
 * Main-process-only delivery view. `path` is the absolute path of the
 * materialized copy handed to an agent; it must never be serialized into a
 * renderer response, event or persisted task/chat view.
 */
export interface MaterializedAttachment extends AttachmentRef {
  readonly path: string;
  /** Bounded, secret-redacted text extracted from a document. */
  readonly extractedText?: string | undefined;
  /** True when `extractedText` hit the extraction cap. */
  readonly truncated?: boolean | undefined;
  /** Total page count for a PDF, when known. */
  readonly pageCount?: number | undefined;
}

// ---- Preview contract ----

export interface PdfAttachmentPage {
  /** 1-based page number in the original document. */
  readonly pageNumber: number;
  readonly text: string;
}

export interface AttachmentPreviewBase {
  /** Metadata for the attachment being previewed. */
  readonly attachment: AttachmentSummary;
  /** True when the document text or page set was capped. */
  readonly truncated: boolean;
}

export interface ImageAttachmentPreview extends AttachmentPreviewBase {
  readonly format: 'image';
  /**
   * A `data:` URL produced by the main process from a recorded attachment id.
   * The renderer never receives a filesystem path or a `file://` URL.
   */
  readonly dataUrl: string;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface MarkdownAttachmentPreview extends AttachmentPreviewBase {
  readonly format: 'markdown';
  /** Markdown converted by the main process (GFM-compatible, HTML inert). */
  readonly markdown: string;
}

export interface PdfAttachmentPreview extends AttachmentPreviewBase {
  readonly format: 'pdf';
  /** Total pages in the source PDF (before truncation). */
  readonly pageCount: number;
  /** Rendered pages, in order, capped at MAX_ATTACHMENT_PDF_PAGES. */
  readonly pages: readonly PdfAttachmentPage[];
}

export interface TextAttachmentPreview extends AttachmentPreviewBase {
  readonly format: 'text';
  readonly text: string;
}

/** Why the main process could not produce a formatted preview. */
export type AttachmentPreviewFailure =
  | 'unsupported'
  | 'unreadable'
  | 'encrypted'
  | 'empty'
  | 'error';

export interface UnsupportedAttachmentPreview extends AttachmentPreviewBase {
  readonly format: 'unsupported';
  readonly reason: AttachmentPreviewFailure;
  /** A short, user-facing explanation; never a raw stack trace. */
  readonly message: string;
}

export type AttachmentPreview =
  | ImageAttachmentPreview
  | MarkdownAttachmentPreview
  | PdfAttachmentPreview
  | TextAttachmentPreview
  | UnsupportedAttachmentPreview;

// ---- Ingest results ----

export type AttachmentIngestFailureCode =
  | 'unsupported'
  | 'too_large'
  | 'empty'
  | 'unreadable'
  | 'limit_exceeded'
  | 'secret';

/** One refused file. The rest of a batch may still have been accepted. */
export interface AttachmentIngestFailure {
  /** Display name or the last path segment the renderer supplied. */
  readonly fileName: string;
  readonly code: AttachmentIngestFailureCode;
  readonly message: string;
}

export interface AttachmentIngestResult {
  readonly attachments: readonly AttachmentSummary[];
  readonly rejected: readonly AttachmentIngestFailure[];
}

/** Native picker outcome. `cancelled` is true when the user dismissed it. */
export interface AttachmentPickResult extends AttachmentIngestResult {
  readonly cancelled: boolean;
}

// ---- Namespaced IPC bridge ----

export const AttachmentIdSchema = z.string().uuid();

/** Ids accepted by `task.create` and `chat.send`; capped in both processes. */
export const AttachmentIdsSchema = z
  .array(AttachmentIdSchema)
  .max(MAX_ATTACHMENTS_PER_MESSAGE, {
    message: `Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`,
  });

const AttachmentPathSchema = z.string().trim().min(1).max(4096);

/**
 * Attachment invoke schemas, keyed by the exact IPC channel names.
 *
 * - `pick` opens the native multi-file dialog in the main process; the
 *   renderer never supplies a path.
 * - `ingestPaths` receives drag-and-drop paths from Electron's `File` bridge
 *   and caps the batch before the handler runs.
 * - `preview` and `discard` accept only an attachment id already recorded by
 *   the main process (Requirement 5.1).
 */
export const ATTACHMENT_SCHEMAS = {
  'attachment.pick': z.void(),
  'attachment.ingestPaths': z
    .object({
      paths: z
        .array(AttachmentPathSchema)
        .min(1)
        .max(MAX_ATTACHMENTS_PER_MESSAGE, {
          message: `Attach at most ${MAX_ATTACHMENTS_PER_MESSAGE} files per message`,
        }),
    })
    .strict(),
  'attachment.preview': z.object({ id: AttachmentIdSchema }).strict(),
  'attachment.discard': z.object({ id: AttachmentIdSchema }).strict(),
} as const;

export type AttachmentPickRequest = z.infer<(typeof ATTACHMENT_SCHEMAS)['attachment.pick']>;
export type AttachmentIngestPathsInput = z.infer<
  (typeof ATTACHMENT_SCHEMAS)['attachment.ingestPaths']
>;
export type AttachmentPreviewInput = z.infer<(typeof ATTACHMENT_SCHEMAS)['attachment.preview']>;
export type AttachmentDiscardInput = z.infer<(typeof ATTACHMENT_SCHEMAS)['attachment.discard']>;

/**
 * Type-only surface for `window.conductor.attachment`. The preload implements
 * it with validated `invoke` wrappers; the renderer never receives a Node
 * handle or an arbitrary filesystem path.
 */
export interface AttachmentBridge {
  /** Open the native picker and ingest the chosen files. */
  pick(): Promise<AttachmentPickResult>;
  /** Ingest files the user dropped onto the composer. */
  ingest(input: AttachmentIngestPathsInput): Promise<AttachmentIngestResult>;
  /** Render a preview by id; refuses ids the main process did not record. */
  preview(id: string): Promise<AttachmentPreview>;
  /** Remove an unbound draft attachment; linked attachments are kept. */
  discard(id: string): Promise<void>;
}
