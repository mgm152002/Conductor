// invoice-extractor.ts
//
// Applies an InvoiceExtractionTemplate to raw invoice text, normalizing scalar
// fields and line items, and returning diagnostics for missing or ambiguous
// fields.  This module never throws: all errors surface as field-level status
// values (Requirement 3.1).
//
// Normalization rules:
//   amount      — strip currency symbols/commas, parse as float (2 d.p.)
//   identifier  — strip non-alphanumeric runs, upper-case
//   date        — try ISO-8601, then common locale formats; return ISO string
//   text        — trim surrounding whitespace only

import type {
  InvoiceExtractionResult,
  InvoiceExtractionTemplate,
  InvoiceExtractedField,
  InvoiceLineItem,
  InvoiceLineItemColumn,
  InvoiceLineItemField,
  InvoiceTemplateField,
} from '@shared/domain';

// ---------------------------------------------------------------------------
// Scalar normalization helpers
// ---------------------------------------------------------------------------

/** Strip currency symbols and thousands-separators then parse as float. */
export function normalizeAmount(raw: string): number | undefined {
  // Remove everything that is not a digit, dot, or minus.
  // Handles formats like "$1,234.56", "1.234,56" (EU), "€ 99"
  const cleaned = raw.replace(/[^\d.,-]/g, '').trim();
  if (!cleaned) return undefined;

  // Detect EU-style: ends with ,XX (comma as decimal separator)
  const euStyle = /^-?[\d.]*,\d{1,2}$/.test(cleaned);
  const normalised = euStyle
    ? cleaned.replace(/\./g, '').replace(',', '.')
    : cleaned.replace(/,/g, '');

  const value = parseFloat(normalised);
  return isNaN(value) ? undefined : value;
}

/** Strip non-alphanumeric characters and upper-case the result. */
export function normalizeIdentifier(raw: string): string {
  return raw.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/** Parse a date string into an ISO-8601 date string (YYYY-MM-DD). */
export function normalizeDate(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;

  // ISO-8601 already
  if (/^\d{4}-\d{2}-\d{2}(T.*)?$/.test(trimmed)) {
    const d = new Date(trimmed);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }

  // MM/DD/YYYY or DD/MM/YYYY (try both, prefer valid date)
  const slashMatch = trimmed.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (slashMatch) {
    const a = slashMatch[1] ?? '';
    const b = slashMatch[2] ?? '';
    const year = slashMatch[3] ?? '';
    // Try MM/DD/YYYY
    const mdy = new Date(`${year}-${a.padStart(2, '0')}-${b.padStart(2, '0')}`);
    if (!isNaN(mdy.getTime())) return mdy.toISOString().slice(0, 10);
    // Try DD/MM/YYYY
    const dmy = new Date(`${year}-${b.padStart(2, '0')}-${a.padStart(2, '0')}`);
    if (!isNaN(dmy.getTime())) return dmy.toISOString().slice(0, 10);
  }

  // Month-name formats: "Jan 15, 2024", "15 January 2024"
  const d = new Date(trimmed);
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);

  return undefined;
}

// ---------------------------------------------------------------------------
// Field extraction
// ---------------------------------------------------------------------------

/**
 * Search `text` for a label from `field.labels` followed by the value.
 * Returns the raw matched string, or undefined if no label was found.
 *
 * Supports both inline ("Total Due: $1,234.56") and table-style formats where
 * the label appears on one line and the value on the next.
 */
function extractRawValue(text: string, field: InvoiceTemplateField): string | undefined {
  for (const label of field.labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // Inline: "Label: value" — capture to end of line (non-greedy)
    const inlineRe = new RegExp(`${escapedLabel}\\s*[:\\-]?\\s*(.+?)\\s*$`, 'im');
    const inlineMatch = text.match(inlineRe);
    if (inlineMatch?.[1]) {
      const candidate = inlineMatch[1].trim();
      if (candidate) return candidate;
    }

    // Table-style: label on one line, value on the next
    const tableRe = new RegExp(`${escapedLabel}\\s*\\n+\\s*(.+?)\\s*$`, 'im');
    const tableMatch = text.match(tableRe);
    if (tableMatch?.[1]) {
      const candidate = tableMatch[1].trim();
      if (candidate) return candidate;
    }
  }

  // Custom pattern supplied by the template (e.g. a regex for a structured ID)
  if (field.pattern) {
    try {
      const patternRe = new RegExp(field.pattern, 'i');
      const patternMatch = text.match(patternRe);
      if (patternMatch?.[0]) return patternMatch[0].trim();
    } catch {
      // Invalid regex in template — ignore silently
    }
  }

  return undefined;
}

/** Apply normalization appropriate for the field's declared type. */
function applyNormalization(
  raw: string,
  field: InvoiceTemplateField,
): string | number | undefined {
  switch (field.normalization) {
    case 'amount': {
      return normalizeAmount(raw);
    }
    case 'identifier': {
      const id = normalizeIdentifier(raw);
      return id || undefined;
    }
    case 'date': {
      return normalizeDate(raw);
    }
    case 'text': {
      return raw.trim() || undefined;
    }
  }
}

function extractScalarField(
  text: string,
  field: InvoiceTemplateField,
): InvoiceExtractedField {
  const raw = extractRawValue(text, field);

  if (raw === undefined) {
    return {
      name: field.name,
      status: field.required ? 'missing' : 'missing',
      confidence: 0,
    };
  }

  const value = applyNormalization(raw, field);

  if (value === undefined) {
    // Raw value found but normalization failed → ambiguous
    return {
      name: field.name,
      rawValue: raw,
      status: 'ambiguous',
      confidence: 0.3,
    };
  }

  return {
    name: field.name,
    value,
    rawValue: raw,
    status: 'extracted',
    confidence: 0.9,
  };
}

// ---------------------------------------------------------------------------
// Line-item extraction
// ---------------------------------------------------------------------------

/**
 * Split invoice text into candidate line-item rows.
 *
 * Strategy: when a rowPattern is supplied, use it; otherwise fall back to
 * splitting on newlines and keeping lines that have multiple whitespace-
 * separated tokens (likely table rows, not headings or blank lines).
 */
function candidateRows(text: string, rowPattern: string | undefined): string[] {
  if (rowPattern) {
    try {
      const re = new RegExp(rowPattern, 'gim');
      const matches: string[] = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(text)) !== null) {
        matches.push(m[0]);
      }
      return matches;
    } catch {
      // Fall through to default split
    }
  }

  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && /\S+\s+\S+/.test(l)); // at least two tokens
}

function parseLineItemField(
  row: string,
  col: InvoiceLineItemColumn,
): string | number | undefined {
  for (const label of col.labels) {
    const escapedLabel = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`${escapedLabel}\\s*[:\\-]?\\s*([\\w.,\\-$€£¥]+)`, 'i');
    const m = row.match(re);
    if (m?.[1]) {
      const raw = m[1].trim();
      if (col.field === 'quantity' || col.field === 'unitPrice' || col.field === 'amount') {
        const n = normalizeAmount(raw);
        return n !== undefined ? n : raw;
      }
      return raw;
    }
  }
  return undefined;
}

/**
 * Extract structured line items from `text`.
 *
 * For each candidate row, parse each declared column.  Rows where no column
 * yields a value are skipped.
 */
function extractLineItems(
  text: string,
  lineItemSpec: NonNullable<InvoiceExtractionTemplate['lineItems']>,
): InvoiceLineItem[] {
  const rows = candidateRows(text, lineItemSpec.rowPattern);
  const items: InvoiceLineItem[] = [];

  // Identify a "description" column for fallback
  const descCol = lineItemSpec.columns.find((c) => c.field === 'description');

  for (const row of rows) {
    const item: Partial<Record<InvoiceLineItemField, string | number>> = {};

    for (const col of lineItemSpec.columns) {
      const val = parseLineItemField(row, col);
      if (val !== undefined) {
        (item as Record<string, string | number>)[col.field] = val;
      }
    }

    // Skip rows that produced no data at all
    if (Object.keys(item).length === 0) continue;

    // If there's no description but we have other fields, use the raw row as description
    if (!item['description'] && !descCol) {
      item['description'] = row.trim();
    }

    items.push({
      sku: typeof item['sku'] === 'string' ? item['sku'] : undefined,
      description: String(item['description'] ?? row.trim()),
      quantity: typeof item['quantity'] === 'number' ? item['quantity'] : undefined,
      unitPrice: typeof item['unitPrice'] === 'number' ? item['unitPrice'] : undefined,
      amount: typeof item['amount'] === 'number' ? item['amount'] : undefined,
    } as InvoiceLineItem);  }

  return items;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface InvoiceExtractorOptions {
  /** Minimum confidence threshold below which a field is treated as ambiguous. */
  minConfidence?: number;
}

/**
 * Apply `template` to `invoiceText` and return a fully populated
 * {@link InvoiceExtractionResult}.
 *
 * This function never throws.  Parsing failures are surfaced in the
 * `missingFields` and `ambiguousFields` arrays and in each field's `status`.
 * (Requirement 3.1)
 */
export function extractInvoice(
  template: InvoiceExtractionTemplate,
  invoiceText: string,
  _opts: InvoiceExtractorOptions = {},
): InvoiceExtractionResult {
  const fields: InvoiceExtractedField[] = [];
  const missingFields: string[] = [];
  const ambiguousFields: string[] = [];

  for (const fieldDef of template.fields) {
    const result = extractScalarField(invoiceText, fieldDef);
    fields.push(result);

    if (result.status === 'missing') {
      missingFields.push(fieldDef.name);
    } else if (result.status === 'ambiguous') {
      ambiguousFields.push(fieldDef.name);
    }
  }

  const lineItems: InvoiceLineItem[] =
    template.lineItems ? extractLineItems(invoiceText, template.lineItems) : [];

  return { fields, lineItems, missingFields, ambiguousFields };
}
