// purchase-order-matcher.ts
//
// Compares the result of invoice extraction against a PurchaseOrder and
// returns a structured match report with field-level discrepancies
// (Requirement 3.2).
//
// The function:
//   - Returns status `unavailable` when the purchase order is absent or the
//     extraction result contains no usable data, rather than reporting a false
//     mismatch.
//   - Compares vendorId, poNumber, total, taxId, and line items.
//   - Applies a configurable amount tolerance (absolute value of difference).
//   - Matches line items deterministically by SKU when both sides carry one,
//     then by description similarity when SKU is absent.

import type {
  InvoiceExtractionResult,
  InvoiceLineItem,
  PurchaseOrder,
  PurchaseOrderDiscrepancy,
  PurchaseOrderMatch,
} from '@shared/domain';
import { normalizeIdentifier } from './invoice-extractor';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MatcherOptions {
  /**
   * Maximum absolute difference between invoice total and PO total that is
   * still considered a match.  Defaults to {@link DEFAULT_AMOUNT_TOLERANCE}.
   */
  amountTolerance?: number;
}

/** Default tolerance: one cent. */
export const DEFAULT_AMOUNT_TOLERANCE = 0.01;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractedStringValue(
  result: InvoiceExtractionResult,
  fieldName: string,
): string | undefined {
  const field = result.fields.find((f) => f.name === fieldName);
  if (!field || field.status !== 'extracted') return undefined;
  return field.value !== undefined ? String(field.value) : undefined;
}

function extractedNumberValue(
  result: InvoiceExtractionResult,
  fieldName: string,
): number | undefined {
  const field = result.fields.find((f) => f.name === fieldName);
  if (!field || field.status !== 'extracted') return undefined;
  return typeof field.value === 'number' ? field.value : undefined;
}

/** Normalised description for fuzzy-matching: lower-case, collapsed whitespace. */
function descKey(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Deterministically match `invoiceItems` against `poItems`.
 *
 * Matching priority:
 *   1. Exact SKU match (both sides non-empty after normalization)
 *   2. Exact normalized description match
 *   3. Remaining unmatched invoice items are reported as surplus
 *
 * For each matched pair, compare quantity, unitPrice, and amount within the
 * given tolerance.
 */
function matchLineItems(
  invoiceItems: InvoiceLineItem[],
  poItems: InvoiceLineItem[],
  tolerance: number,
): PurchaseOrderDiscrepancy[] {
  const discrepancies: PurchaseOrderDiscrepancy[] = [];
  const usedPoIndices = new Set<number>();

  for (const inv of invoiceItems) {
    const normInvSku = inv.sku ? normalizeIdentifier(inv.sku) : '';
    const invDescKey = descKey(inv.description);

    // 1. Try SKU match
    let poIdx = -1;
    if (normInvSku) {
      poIdx = poItems.findIndex((p, i) => {
        if (usedPoIndices.has(i)) return false;
        return p.sku ? normalizeIdentifier(p.sku) === normInvSku : false;
      });
    }

    // 2. Fallback to description match
    if (poIdx === -1) {
      poIdx = poItems.findIndex((p, i) => {
        if (usedPoIndices.has(i)) return false;
        return descKey(p.description) === invDescKey;
      });
    }

    if (poIdx === -1) {
      // Invoice item not found in PO
      discrepancies.push({
        field: 'lineItem',
        invoiceValue: inv.sku ?? inv.description,
        detail: `Invoice line item "${inv.description}" not found in purchase order`,
      });
      continue;
    }

    usedPoIndices.add(poIdx);
    // poIdx is verified to exist by findIndex returning >= 0
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    const po = poItems[poIdx]!;

    // Compare numeric fields within tolerance
    const numChecks: Array<{
      key: keyof InvoiceLineItem;
      label: string;
    }> = [
      { key: 'quantity', label: 'quantity' },
      { key: 'unitPrice', label: 'unit price' },
      { key: 'amount', label: 'line amount' },
    ];

    for (const { key, label } of numChecks) {
      const invVal = inv[key] as number | undefined;
      const poVal = po[key] as number | undefined;

      if (invVal === undefined || poVal === undefined) continue; // can't compare

      const diff = Math.abs(invVal - poVal);
      if (diff > tolerance) {
        discrepancies.push({
          field: `lineItem.${key}`,
          invoiceValue: invVal,
          purchaseOrderValue: poVal,
          detail: `Line item "${inv.description}" ${label} differs by ${diff.toFixed(4)} (tolerance: ${tolerance})`,
        });
      }
    }
  }

  // Report PO items that have no matching invoice item
  for (let i = 0; i < poItems.length; i++) {
    if (!usedPoIndices.has(i)) {
      const poItem = poItems[i]!;
      discrepancies.push({
        field: 'lineItem',
        purchaseOrderValue: poItem.sku ?? poItem.description,
        detail: `Purchase order line item "${poItem.description}" not present on invoice`,
      });
    }
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compare `extractionResult` against `purchaseOrder` and return a
 * {@link PurchaseOrderMatch} with field-level discrepancies.
 *
 * Status meanings:
 *   - `matched`     — all compared fields agree within tolerance.
 *   - `mismatch`    — one or more fields differ.
 *   - `unavailable` — `purchaseOrder` is absent OR the extraction result has
 *                     no usable extracted fields (Requirement 3.2 explicit
 *                     unavailable status).
 *
 * This function never throws.
 */
export function matchPurchaseOrder(
  extractionResult: InvoiceExtractionResult | null | undefined,
  purchaseOrder: PurchaseOrder | null | undefined,
  opts: MatcherOptions = {},
): PurchaseOrderMatch {
  const tolerance = opts.amountTolerance ?? DEFAULT_AMOUNT_TOLERANCE;

  // --- Unavailable gate ---
  if (!purchaseOrder) {
    return { status: 'unavailable', discrepancies: [], amountTolerance: tolerance };
  }

  if (!extractionResult) {
    return { status: 'unavailable', discrepancies: [], amountTolerance: tolerance };
  }

  // If there are no extracted fields at all (no template applied or empty invoice)
  const hasAnyExtracted = extractionResult.fields.some((f) => f.status === 'extracted');
  const hasLineItems = extractionResult.lineItems.length > 0;
  if (!hasAnyExtracted && !hasLineItems) {
    return {
      status: 'unavailable',
      purchaseOrderId: purchaseOrder.id,
      discrepancies: [],
      amountTolerance: tolerance,
    };
  }

  // --- Build discrepancy list ---
  const discrepancies: PurchaseOrderDiscrepancy[] = [];

  // vendorId
  const invVendor = extractedStringValue(extractionResult, 'vendorId');
  if (invVendor !== undefined) {
    const normInv = normalizeIdentifier(invVendor);
    const normPo = normalizeIdentifier(purchaseOrder.vendorId);
    if (normInv !== normPo) {
      discrepancies.push({
        field: 'vendorId',
        invoiceValue: invVendor,
        purchaseOrderValue: purchaseOrder.vendorId,
        detail: `Vendor IDs do not match: "${invVendor}" vs "${purchaseOrder.vendorId}"`,
      });
    }
  }

  // poNumber
  const invPoNumber = extractedStringValue(extractionResult, 'poNumber');
  if (invPoNumber !== undefined) {
    const normInv = normalizeIdentifier(invPoNumber);
    const normPo = normalizeIdentifier(purchaseOrder.poNumber);
    if (normInv !== normPo) {
      discrepancies.push({
        field: 'poNumber',
        invoiceValue: invPoNumber,
        purchaseOrderValue: purchaseOrder.poNumber,
        detail: `PO numbers do not match: "${invPoNumber}" vs "${purchaseOrder.poNumber}"`,
      });
    }
  }

  // taxId
  const invTaxId = extractedStringValue(extractionResult, 'taxId');
  if (invTaxId !== undefined && purchaseOrder.taxId !== undefined) {
    const normInv = normalizeIdentifier(invTaxId);
    const normPo = normalizeIdentifier(purchaseOrder.taxId);
    if (normInv !== normPo) {
      discrepancies.push({
        field: 'taxId',
        invoiceValue: invTaxId,
        purchaseOrderValue: purchaseOrder.taxId,
        detail: `Tax IDs do not match: "${invTaxId}" vs "${purchaseOrder.taxId}"`,
      });
    }
  }

  // total
  const invTotal = extractedNumberValue(extractionResult, 'total');
  if (invTotal !== undefined) {
    const diff = Math.abs(invTotal - purchaseOrder.total);
    if (diff > tolerance) {
      discrepancies.push({
        field: 'total',
        invoiceValue: invTotal,
        purchaseOrderValue: purchaseOrder.total,
        detail: `Total amount differs by ${diff.toFixed(4)} (tolerance: ${tolerance})`,
      });
    }
  }

  // line items
  const lineItemDiscrepancies = matchLineItems(
    extractionResult.lineItems,
    purchaseOrder.lineItems,
    tolerance,
  );
  discrepancies.push(...lineItemDiscrepancies);

  return {
    status: discrepancies.length === 0 ? 'matched' : 'mismatch',
    purchaseOrderId: purchaseOrder.id,
    discrepancies,
    amountTolerance: tolerance,
  };
}
