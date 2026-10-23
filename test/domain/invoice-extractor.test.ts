// test/domain/invoice-extractor.test.ts
//
// Unit tests for Requirement 3.1:
//   WHEN an extraction template and invoice text are available THEN
//   Conductor SHALL extract mapped scalar fields and line items, normalize
//   amounts and identifiers, and report missing or ambiguous fields rather
//   than inventing values.

import { describe, expect, it } from 'vitest';
import {
  extractInvoice,
  normalizeAmount,
  normalizeDate,
  normalizeIdentifier,
} from '@main/domain/invoice-extractor';
import type { InvoiceExtractionTemplate } from '@shared/domain';

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

describe('normalizeAmount', () => {
  it('parses a simple number', () => {
    expect(normalizeAmount('1234.56')).toBe(1234.56);
  });

  it('strips a dollar sign', () => {
    expect(normalizeAmount('$1,234.56')).toBe(1234.56);
  });

  it('strips a euro sign', () => {
    expect(normalizeAmount('€ 99')).toBe(99);
  });

  it('handles EU-style comma decimal separator', () => {
    expect(normalizeAmount('1.234,56')).toBe(1234.56);
  });

  it('handles negative amounts', () => {
    expect(normalizeAmount('-50.00')).toBe(-50);
  });

  it('returns undefined for empty string', () => {
    expect(normalizeAmount('')).toBeUndefined();
  });

  it('returns undefined for non-numeric text', () => {
    expect(normalizeAmount('N/A')).toBeUndefined();
  });

  it('handles amount with no decimal part', () => {
    expect(normalizeAmount('$5,000')).toBe(5000);
  });

  it('handles whitespace', () => {
    expect(normalizeAmount('  123.45  ')).toBe(123.45);
  });
});

describe('normalizeIdentifier', () => {
  it('strips hyphens and upper-cases', () => {
    expect(normalizeIdentifier('AB-1234')).toBe('AB1234');
  });

  it('strips spaces', () => {
    expect(normalizeIdentifier('  us 12345  ')).toBe('US12345');
  });

  it('strips special characters', () => {
    expect(normalizeIdentifier('XX/99#ABC')).toBe('XX99ABC');
  });

  it('returns empty string for all-special input', () => {
    expect(normalizeIdentifier('---')).toBe('');
  });
});

describe('normalizeDate', () => {
  it('passes through ISO-8601 date', () => {
    expect(normalizeDate('2024-03-15')).toBe('2024-03-15');
  });

  it('parses MM/DD/YYYY', () => {
    expect(normalizeDate('03/15/2024')).toBe('2024-03-15');
  });

  it('parses DD-MM-YYYY', () => {
    expect(normalizeDate('15-03-2024')).toBe('2024-03-15');
  });

  it('parses human-readable month name', () => {
    const result = normalizeDate('March 15, 2024');
    expect(result).toBe('2024-03-15');
  });

  it('returns undefined for empty string', () => {
    expect(normalizeDate('')).toBeUndefined();
  });

  it('returns undefined for garbage text', () => {
    expect(normalizeDate('not-a-date-string!!')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Minimal template fixture
// ---------------------------------------------------------------------------

function minimalTemplate(): InvoiceExtractionTemplate {
  return {
    fields: [
      {
        name: 'vendorId',
        labels: ['Vendor ID', 'Vendor No'],
        required: true,
        normalization: 'identifier',
      },
      {
        name: 'total',
        labels: ['Total Due', 'Total Amount', 'Amount Due'],
        required: true,
        normalization: 'amount',
      },
      {
        name: 'invoiceDate',
        labels: ['Invoice Date', 'Date'],
        required: false,
        normalization: 'date',
      },
      {
        name: 'taxId',
        labels: ['Tax ID', 'EIN'],
        required: false,
        normalization: 'identifier',
      },
      {
        name: 'poNumber',
        labels: ['PO Number', 'PO#', 'Purchase Order'],
        required: false,
        normalization: 'text',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// extractInvoice — scalar field extraction
// ---------------------------------------------------------------------------

describe('extractInvoice — scalar fields', () => {
  it('extracts all fields from a well-formed invoice', () => {
    const text = `
      INVOICE
      Vendor ID: AB-1234
      Invoice Date: 2024-03-15
      Tax ID: 12-3456789
      PO Number: PO-9999
      Total Due: $1,234.56
    `;

    const result = extractInvoice(minimalTemplate(), text);

    expect(result.missingFields).toEqual([]);
    expect(result.ambiguousFields).toEqual([]);

    const vendor = result.fields.find((f) => f.name === 'vendorId');
    expect(vendor?.status).toBe('extracted');
    expect(vendor?.value).toBe('AB1234');

    const total = result.fields.find((f) => f.name === 'total');
    expect(total?.status).toBe('extracted');
    expect(total?.value).toBe(1234.56);

    const date = result.fields.find((f) => f.name === 'invoiceDate');
    expect(date?.status).toBe('extracted');
    expect(date?.value).toBe('2024-03-15');

    const taxId = result.fields.find((f) => f.name === 'taxId');
    expect(taxId?.status).toBe('extracted');
    expect(taxId?.value).toBe('123456789');
  });

  it('uses alternative label (Vendor No) when primary label is absent', () => {
    const text = 'Vendor No: XY-9999\nTotal Due: $50.00';
    const result = extractInvoice(minimalTemplate(), text);
    const vendor = result.fields.find((f) => f.name === 'vendorId');
    expect(vendor?.status).toBe('extracted');
    expect(vendor?.value).toBe('XY9999');
  });

  it('reports missing required field without inventing a value', () => {
    const text = 'Invoice Date: 2024-01-01\nTotal Due: $100.00';
    const result = extractInvoice(minimalTemplate(), text);
    expect(result.missingFields).toContain('vendorId');
    const vendor = result.fields.find((f) => f.name === 'vendorId');
    expect(vendor?.status).toBe('missing');
    expect(vendor?.value).toBeUndefined();
  });

  it('reports missing optional field as missing without throwing', () => {
    const text = 'Vendor ID: V1\nTotal Due: $10.00';
    const result = extractInvoice(minimalTemplate(), text);
    expect(result.missingFields).toContain('invoiceDate');
  });

  it('marks field ambiguous when raw value fails normalization', () => {
    const text = 'Total Due: NOT_A_NUMBER\nVendor ID: V1';
    const result = extractInvoice(minimalTemplate(), text);
    expect(result.ambiguousFields).toContain('total');
    const total = result.fields.find((f) => f.name === 'total');
    expect(total?.status).toBe('ambiguous');
    expect(total?.value).toBeUndefined();
    expect(total?.rawValue).toBe('NOT_A_NUMBER');
  });

  it('never throws on empty invoice text', () => {
    expect(() => extractInvoice(minimalTemplate(), '')).not.toThrow();
    const result = extractInvoice(minimalTemplate(), '');
    expect(result.fields.every((f) => f.status === 'missing')).toBe(true);
  });

  it('never throws on empty template fields', () => {
    const emptyTemplate: InvoiceExtractionTemplate = { fields: [] };
    expect(() => extractInvoice(emptyTemplate, 'Some invoice text')).not.toThrow();
    const result = extractInvoice(emptyTemplate, 'Some invoice text');
    expect(result.fields).toHaveLength(0);
    expect(result.lineItems).toHaveLength(0);
  });

  it('uses custom pattern when provided', () => {
    const template: InvoiceExtractionTemplate = {
      fields: [
        {
          name: 'invoiceNumber',
          labels: [],
          required: true,
          normalization: 'text',
          pattern: 'INV-\\d{6}',
        },
      ],
    };
    const text = 'Reference: INV-004512 — please pay within 30 days';
    const result = extractInvoice(template, text);
    const invNum = result.fields.find((f) => f.name === 'invoiceNumber');
    expect(invNum?.status).toBe('extracted');
    expect(invNum?.value).toBe('INV-004512');
  });

  it('ignores invalid custom pattern without throwing', () => {
    const template: InvoiceExtractionTemplate = {
      fields: [
        {
          name: 'ref',
          labels: ['Ref'],
          required: false,
          normalization: 'text',
          pattern: '[invalid(', // will fail to compile
        },
      ],
    };
    expect(() => extractInvoice(template, 'Ref: ABC')).not.toThrow();
  });

  it('handles EU-format currency amounts', () => {
    const text = 'Total Due: 2.500,99€';
    const result = extractInvoice(minimalTemplate(), text);
    const total = result.fields.find((f) => f.name === 'total');
    expect(total?.status).toBe('extracted');
    expect(total?.value).toBe(2500.99);
  });

  it('handles table-style label/value layout', () => {
    const text = `
Vendor ID
AB-5678

Total Due
$789.00
    `;
    const result = extractInvoice(minimalTemplate(), text);
    const vendor = result.fields.find((f) => f.name === 'vendorId');
    expect(vendor?.status).toBe('extracted');
  });
});

// ---------------------------------------------------------------------------
// extractInvoice — line item extraction
// ---------------------------------------------------------------------------

describe('extractInvoice — line items', () => {
  const templateWithLineItems: InvoiceExtractionTemplate = {
    fields: [
      { name: 'total', labels: ['Total'], required: true, normalization: 'amount' },
    ],
    lineItems: {
      columns: [
        { field: 'sku', labels: ['SKU', 'Item#'], required: false },
        { field: 'description', labels: ['Description', 'Item'], required: true },
        { field: 'quantity', labels: ['Qty', 'Quantity'], required: false },
        { field: 'unitPrice', labels: ['Unit Price', 'Price'], required: false },
        { field: 'amount', labels: ['Amount', 'Total'], required: false },
      ],
    },
  };

  it('extracts line items from a structured invoice', () => {
    const text = `
Total: $310.00

SKU: SKU-001 Description: Widget A Qty: 2 Unit Price: $50.00 Amount: $100.00
SKU: SKU-002 Description: Gadget B Qty: 3 Unit Price: $70.00 Amount: $210.00
    `;
    const result = extractInvoice(templateWithLineItems, text);
    expect(result.lineItems.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty line items when template has no lineItems spec', () => {
    const text = 'Total: $100.00\nWidget A x2 $100.00';
    const result = extractInvoice(minimalTemplate(), text);
    expect(result.lineItems).toHaveLength(0);
  });

  it('never throws on invoice text with no matching rows', () => {
    const text = 'Total: $100.00';
    expect(() => extractInvoice(templateWithLineItems, text)).not.toThrow();
  });

  it('uses rowPattern when provided', () => {
    const template: InvoiceExtractionTemplate = {
      fields: [],
      lineItems: {
        columns: [
          { field: 'description', labels: ['Description'], required: true },
          { field: 'amount', labels: ['Amount'], required: false },
        ],
        rowPattern: 'ITEM:.*',
      },
    };
    const text = `
ITEM: Widget A Amount: $50.00
ITEM: Gadget B Amount: $75.00
This line should be ignored
    `;
    const result = extractInvoice(template, text);
    expect(result.lineItems.length).toBe(2);
  });

  it('ignores invalid rowPattern without throwing', () => {
    const template: InvoiceExtractionTemplate = {
      fields: [],
      lineItems: {
        columns: [{ field: 'description', labels: ['Desc'], required: true }],
        rowPattern: '[bad(',
      },
    };
    expect(() => extractInvoice(template, 'Desc: Widget')).not.toThrow();
  });
});
