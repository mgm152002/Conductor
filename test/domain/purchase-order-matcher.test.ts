// test/domain/purchase-order-matcher.test.ts
//
// Unit tests for Requirement 3.2:
//   WHEN extracted invoice data and a purchase order are available THEN
//   Conductor SHALL compare vendor ID, PO number, total, tax ID, and line
//   items and SHALL return a match status with field-level discrepancies and
//   amount tolerances.

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AMOUNT_TOLERANCE,
  matchPurchaseOrder,
} from '@main/domain/purchase-order-matcher';
import type {
  InvoiceExtractionResult,
  InvoiceLineItem,
  PurchaseOrder,
} from '@shared/domain';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makePO(overrides: Partial<PurchaseOrder> = {}): PurchaseOrder {
  return {
    id: 'po-001',
    vendorId: 'VENDOR-ABC',
    poNumber: 'PO-1234',
    taxId: '12-3456789',
    currency: 'USD',
    total: 500.0,
    lineItems: [],
    ...overrides,
  } as PurchaseOrder;
}

function makeLineItem(overrides: Partial<InvoiceLineItem> = {}): InvoiceLineItem {
  return {
    description: 'Widget A',
    quantity: 2,
    unitPrice: 50.0,
    amount: 100.0,
    ...overrides,
  } as InvoiceLineItem;
}

function makeExtraction(
  overrides: Partial<InvoiceExtractionResult> = {},
): InvoiceExtractionResult {
  return {
    fields: [],
    lineItems: [],
    missingFields: [],
    ambiguousFields: [],
    ...overrides,
  };
}

function extractionWithFields(
  data: Record<string, string | number>,
): InvoiceExtractionResult {
  return makeExtraction({
    fields: Object.entries(data).map(([name, value]) => ({
      name,
      value,
      rawValue: String(value),
      status: 'extracted' as const,
      confidence: 0.9,
    })),
  });
}

// ---------------------------------------------------------------------------
// Unavailable status
// ---------------------------------------------------------------------------

describe('matchPurchaseOrder — unavailable status', () => {
  it('returns unavailable when purchaseOrder is null', () => {
    const result = matchPurchaseOrder(extractionWithFields({ total: 500 }), null);
    expect(result.status).toBe('unavailable');
    expect(result.discrepancies).toHaveLength(0);
  });

  it('returns unavailable when purchaseOrder is undefined', () => {
    const result = matchPurchaseOrder(extractionWithFields({ total: 500 }), undefined);
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when extractionResult is null', () => {
    const result = matchPurchaseOrder(null, makePO());
    expect(result.status).toBe('unavailable');
    expect(result.purchaseOrderId).toBeUndefined();
  });

  it('returns unavailable when extractionResult is undefined', () => {
    const result = matchPurchaseOrder(undefined, makePO());
    expect(result.status).toBe('unavailable');
  });

  it('returns unavailable when extraction has no extracted fields and no line items', () => {
    const emptyExtraction = makeExtraction({
      fields: [{ name: 'total', status: 'missing', confidence: 0 }],
    });
    const result = matchPurchaseOrder(emptyExtraction, makePO());
    expect(result.status).toBe('unavailable');
    expect(result.purchaseOrderId).toBe('po-001');
  });

  it('includes amountTolerance in unavailable response', () => {
    const result = matchPurchaseOrder(null, null, { amountTolerance: 0.5 });
    expect(result.amountTolerance).toBe(0.5);
  });

  it('uses DEFAULT_AMOUNT_TOLERANCE when none specified', () => {
    const result = matchPurchaseOrder(null, null);
    expect(result.amountTolerance).toBe(DEFAULT_AMOUNT_TOLERANCE);
  });
});

// ---------------------------------------------------------------------------
// Matched status
// ---------------------------------------------------------------------------

describe('matchPurchaseOrder — matched status', () => {
  it('returns matched when all fields agree', () => {
    const extraction = extractionWithFields({
      vendorId: 'VENDOR-ABC',
      poNumber: 'PO-1234',
      taxId: '12-3456789',
      total: 500.0,
    });
    const result = matchPurchaseOrder(extraction, makePO());
    expect(result.status).toBe('matched');
    expect(result.discrepancies).toHaveLength(0);
    expect(result.purchaseOrderId).toBe('po-001');
  });

  it('matches vendor IDs case-insensitively and ignores hyphens', () => {
    const extraction = extractionWithFields({ vendorId: 'vendor abc', total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO({ vendorId: 'VENDOR-ABC' }));
    expect(result.status).toBe('matched');
  });

  it('matches PO numbers ignoring punctuation', () => {
    const extraction = extractionWithFields({ poNumber: 'PO/1234', total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO({ poNumber: 'PO-1234' }));
    expect(result.status).toBe('matched');
  });

  it('matches total within default tolerance', () => {
    const extraction = extractionWithFields({ total: 500.005 });
    const result = matchPurchaseOrder(extraction, makePO({ total: 500.0 }));
    expect(result.status).toBe('matched');
  });

  it('matches total within custom tolerance', () => {
    const tol = 0.10;
    // diff = 0.05 which is < tol (0.10), so matched
    const extraction = extractionWithFields({ total: 500.05 });
    const result = matchPurchaseOrder(extraction, makePO({ total: 500.0 }), {
      amountTolerance: tol,
    });
    expect(result.status).toBe('matched');
  });

  it('does not require all optional fields to be extracted', () => {
    // Only total is extracted; optional fields are absent — should still match
    const extraction = extractionWithFields({ total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO());
    expect(result.status).toBe('matched');
  });
});

// ---------------------------------------------------------------------------
// Mismatch status
// ---------------------------------------------------------------------------

describe('matchPurchaseOrder — mismatch status', () => {
  it('reports vendor ID mismatch', () => {
    const extraction = extractionWithFields({ vendorId: 'WRONG-VENDOR', total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO());
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find((d) => d.field === 'vendorId');
    expect(disc).toBeDefined();
    expect(disc?.invoiceValue).toBe('WRONG-VENDOR');
    expect(disc?.purchaseOrderValue).toBe('VENDOR-ABC');
  });

  it('reports PO number mismatch', () => {
    const extraction = extractionWithFields({ poNumber: 'PO-9999', total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO());
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find((d) => d.field === 'poNumber');
    expect(disc).toBeDefined();
  });

  it('reports taxId mismatch when both sides have a taxId', () => {
    const extraction = extractionWithFields({ taxId: '99-9999999', total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO({ taxId: '12-3456789' }));
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find((d) => d.field === 'taxId');
    expect(disc).toBeDefined();
  });

  it('does not report taxId mismatch when PO has no taxId', () => {
    const extraction = extractionWithFields({ taxId: '99-9999999', total: 500.0 });
    const po: PurchaseOrder = { id: 'po-001', vendorId: 'VENDOR-ABC', poNumber: 'PO-1234', currency: 'USD', total: 500.0, lineItems: [] };
    const result = matchPurchaseOrder(extraction, po);
    expect(result.discrepancies.find((d) => d.field === 'taxId')).toBeUndefined();
  });
  it('reports total mismatch above tolerance', () => {
    const extraction = extractionWithFields({ total: 600.0 });
    const result = matchPurchaseOrder(extraction, makePO({ total: 500.0 }));
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find((d) => d.field === 'total');
    expect(disc).toBeDefined();
    expect(disc?.invoiceValue).toBe(600.0);
    expect(disc?.purchaseOrderValue).toBe(500.0);
  });

  it('reports total mismatch just above tolerance boundary', () => {
    const tol = 0.05;
    const extraction = extractionWithFields({ total: 500.051 });
    const result = matchPurchaseOrder(extraction, makePO({ total: 500.0 }), {
      amountTolerance: tol,
    });
    expect(result.status).toBe('mismatch');
  });

  it('includes discrepancy detail text', () => {
    const extraction = extractionWithFields({ total: 999.0 });
    const result = matchPurchaseOrder(extraction, makePO({ total: 500.0 }));
    const disc = result.discrepancies.find((d) => d.field === 'total');
    expect(disc?.detail).toContain('499');
  });

  it('reports multiple discrepancies in one call', () => {
    const extraction = extractionWithFields({
      vendorId: 'WRONG',
      total: 999.0,
      poNumber: 'PO-0000',
    });
    const result = matchPurchaseOrder(extraction, makePO());
    expect(result.discrepancies.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Line-item matching
// ---------------------------------------------------------------------------

describe('matchPurchaseOrder — line items', () => {
  it('matches line items by SKU', () => {
    const invItem = makeLineItem({ sku: 'SKU-001', amount: 100.0 });
    const poItem = makeLineItem({ sku: 'SKU-001', amount: 100.0 });
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 100.0, rawValue: '100', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 100.0, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('matched');
    expect(result.discrepancies).toHaveLength(0);
  });

  it('matches line items by description when no SKU', () => {
    const invItem: InvoiceLineItem = { description: 'Widget A', quantity: 2, unitPrice: 50.0, amount: 100.0 };
    const poItem: InvoiceLineItem = { description: 'Widget A', quantity: 2, unitPrice: 50.0, amount: 100.0 };    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 100.0, rawValue: '100', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 100.0, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('matched');
  });

  it('reports surplus invoice line item not in PO', () => {
    const invItem = makeLineItem({ description: 'Extra Widget', amount: 50.0 });
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 50.0, rawValue: '50', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 50.0, lineItems: [] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find((d) => d.field === 'lineItem');
    expect(disc?.detail).toContain('Extra Widget');
  });

  it('reports PO line item missing from invoice', () => {
    const poItem = makeLineItem({ description: 'Missing Widget', amount: 50.0 });
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 0, rawValue: '0', status: 'extracted', confidence: 0.9 }],
      lineItems: [],
    });
    const po = makePO({ total: 0, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find(
      (d) => d.field === 'lineItem' && d.detail.includes('Missing Widget'),
    );
    expect(disc).toBeDefined();
    expect(disc?.purchaseOrderValue).toBeDefined();
  });

  it('reports line item quantity difference', () => {
    const invItem = makeLineItem({ sku: 'SKU-A', quantity: 5, amount: 250.0 });
    const poItem = makeLineItem({ sku: 'SKU-A', quantity: 2, amount: 100.0 });
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 250, rawValue: '250', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 100, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('mismatch');
    const disc = result.discrepancies.find((d) => d.field === 'lineItem.quantity');
    expect(disc).toBeDefined();
  });

  it('tolerates small line-item amount differences', () => {
    const tol = 0.05;
    const invItem = makeLineItem({ sku: 'SKU-B', amount: 100.04 });
    const poItem = makeLineItem({ sku: 'SKU-B', amount: 100.0 });
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 100.04, rawValue: '100.04', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 100, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po, { amountTolerance: tol });
    expect(result.discrepancies.filter((d) => d.field === 'lineItem.amount')).toHaveLength(0);
  });

  it('handles empty invoice and PO line items without discrepancy', () => {
    const extraction = extractionWithFields({ total: 0 });
    const po = makePO({ total: 0, lineItems: [] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('matched');
    expect(result.discrepancies).toHaveLength(0);
  });

  it('matches SKUs case-insensitively after normalization', () => {
    const invItem = makeLineItem({ sku: 'sku-001', amount: 100.0 });
    const poItem = makeLineItem({ sku: 'SKU-001', amount: 100.0 });
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 100.0, rawValue: '100', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 100.0, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('matched');
  });

  it('matches description case-insensitively', () => {
    const invItem: InvoiceLineItem = { description: 'widget a', quantity: 2, unitPrice: 50.0, amount: 100.0 };
    const poItem: InvoiceLineItem = { description: 'Widget A', quantity: 2, unitPrice: 50.0, amount: 100.0 };
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 100.0, rawValue: '100', status: 'extracted', confidence: 0.9 }],
      lineItems: [invItem],
    });
    const po = makePO({ total: 100.0, lineItems: [poItem] });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('matched');
  });
});

// ---------------------------------------------------------------------------
// Edge cases and empty inputs
// ---------------------------------------------------------------------------

describe('matchPurchaseOrder — edge cases', () => {
  it('never throws on completely empty inputs (both null)', () => {
    expect(() => matchPurchaseOrder(null, null)).not.toThrow();
  });

  it('returns unavailable (not mismatch) for empty extraction + valid PO', () => {
    const result = matchPurchaseOrder(makeExtraction(), makePO());
    expect(result.status).toBe('unavailable');
  });

  it('sets purchaseOrderId in matched result', () => {
    const extraction = extractionWithFields({ total: 500.0 });
    const result = matchPurchaseOrder(extraction, makePO({ id: 'po-xyz' }));
    expect(result.purchaseOrderId).toBe('po-xyz');
  });

  it('sets amountTolerance in all result statuses', () => {
    const tol = 0.25;

    const unavailable = matchPurchaseOrder(null, null, { amountTolerance: tol });
    expect(unavailable.amountTolerance).toBe(tol);

    const matched = matchPurchaseOrder(
      extractionWithFields({ total: 500.0 }),
      makePO(),
      { amountTolerance: tol },
    );
    expect(matched.amountTolerance).toBe(tol);
  });

  it('handles multiple line items with mixed matched/mismatched', () => {
    const invItems: InvoiceLineItem[] = [
      makeLineItem({ sku: 'SKU-1', amount: 100.0 }),
      makeLineItem({ sku: 'SKU-2', amount: 999.0 }), // mismatch
    ];
    const poItems: InvoiceLineItem[] = [
      makeLineItem({ sku: 'SKU-1', amount: 100.0 }),
      makeLineItem({ sku: 'SKU-2', amount: 50.0 }),
    ];
    const extraction = makeExtraction({
      fields: [{ name: 'total', value: 1099, rawValue: '1099', status: 'extracted', confidence: 0.9 }],
      lineItems: invItems,
    });
    const po = makePO({ total: 150, lineItems: poItems });
    const result = matchPurchaseOrder(extraction, po);
    expect(result.status).toBe('mismatch');
    const lineAmountDiscs = result.discrepancies.filter(
      (d) => d.field === 'lineItem.amount',
    );
    expect(lineAmountDiscs.length).toBeGreaterThanOrEqual(1);
  });
});
