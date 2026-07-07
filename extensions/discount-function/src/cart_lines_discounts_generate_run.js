// @ts-check
import { ProductDiscountSelectionStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").Input} CartInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Applies wholesale discounts at checkout.
 *
 * Primary source: fetch result from /discount-function backend (real-time DB lookup
 * for only the cart items — no 64 KB metafield size problem, always current).
 *
 * Fallback: customer metafield b2b_wholesale.discount_data (written at approval time).
 * Used when the cart had no _b2b_url attribute so the fetch phase returned nothing.
 *
 * Metafield format:
 *   { "v": { "<numericVariantId>": wholesalePriceCents }, "pct": 20, "t": "label" }
 *
 * Fetch result format (from discount-function.ts):
 *   { discounts: [{ variantId, wholesalePriceCents }], defaultPct, fixedPrice }
 *
 * @param {CartInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  /** @type {Record<string, number>} variantNumericId → wholesalePriceCents */
  const priceMap = {};
  let defaultDiscountPct = 0;
  let fixedPriceCents    = 0;
  let discountLabel      = "";

  // ── Primary: fetch result (real-time, per-cart pricing from DB) ──────────────
  const fetchResult = /** @type {any} */ (input).fetchResult;
  if (fetchResult && Array.isArray(fetchResult.discounts) && fetchResult.discounts.length > 0) {
    for (const d of fetchResult.discounts) {
      if (!d.variantId || !(d.wholesalePriceCents > 0)) continue;
      const numericId = String(d.variantId).split("/").pop();
      if (numericId) priceMap[numericId] = d.wholesalePriceCents;
      if (!discountLabel && d.label) discountLabel = d.label;
    }
    defaultDiscountPct = Number(fetchResult.defaultPct)   || 0;
    fixedPriceCents    = Number(fetchResult.fixedPrice)   || 0;
    if (!discountLabel) discountLabel = fetchResult.defaultLabel || fetchResult.fixedPriceLabel || "";
  }

  // ── Fallback: customer metafield (written at approval, used when fetch skipped) ──
  if (!Object.keys(priceMap).length && !defaultDiscountPct && !fixedPriceCents) {
    const metafieldValue = input.cart.buyerIdentity?.customer?.discountData?.value;
    if (metafieldValue) {
      let data;
      try { data = JSON.parse(metafieldValue); } catch { /* ignore */ }
      if (data && data.v && typeof data.v === "object") {
        Object.assign(priceMap, data.v);
        defaultDiscountPct = Number(data.pct) || 0;
        discountLabel      = data.t || "";
      } else if (data && Array.isArray(data.discounts)) {
        // Legacy format
        for (const d of data.discounts) {
          if (!d.variantId || d.wholesalePriceCents == null) continue;
          const numericId = String(d.variantId).split("/").pop();
          if (numericId) priceMap[numericId] = d.wholesalePriceCents;
        }
      }
    }
  }

  if (!Object.keys(priceMap).length && !defaultDiscountPct && !fixedPriceCents) {
    return { operations: [] };
  }

  /** @type {any[]} */
  const candidates = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const numericId = line.merchandise.id.split("/").pop();
    const shopifyPriceCents = Math.round(
      parseFloat(line.cost.amountPerQuantity.amount) * 100
    );
    if (shopifyPriceCents <= 0) continue;

    let totalDiscountCents = 0;

    if (priceMap[numericId] != null) {
      // Explicit per-variant wholesale price (PERCENT per-item, FIXED_AMOUNT, or FIXED_PRICE)
      const discountPerUnit = shopifyPriceCents - priceMap[numericId];
      if (discountPerUnit <= 0) continue;
      totalDiscountCents = discountPerUnit * line.quantity;
    } else if (defaultDiscountPct > 0) {
      // Catalog-wide % discount — computed against Shopify's live price (always accurate)
      const discountPerUnit = Math.round(shopifyPriceCents * defaultDiscountPct / 100);
      if (discountPerUnit <= 0) continue;
      totalDiscountCents = discountPerUnit * line.quantity;
    } else if (fixedPriceCents > 0) {
      // Catalog-wide fixed price — every item costs this amount
      const discountPerUnit = shopifyPriceCents - fixedPriceCents;
      if (discountPerUnit <= 0) continue;
      totalDiscountCents = discountPerUnit * line.quantity;
    } else {
      continue;
    }

    /** @type {any} */
    const candidate = {
      targets: [{ cartLine: { id: line.id } }],
      value: {
        fixedAmount: {
          amount: String((totalDiscountCents / 100).toFixed(2)),
        },
      },
    };
    if (discountLabel) candidate.message = discountLabel;
    candidates.push(candidate);
  }

  if (!candidates.length) return { operations: [] };

  return {
    operations: [
      {
        productDiscountsAdd: {
          candidates,
          selectionStrategy: ProductDiscountSelectionStrategy.All,
        },
      },
    ],
  };
}
