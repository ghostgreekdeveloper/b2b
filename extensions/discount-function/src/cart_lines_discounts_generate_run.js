// @ts-check
import { ProductDiscountSelectionStrategy } from "../generated/api";

/**
 * @typedef {import("../generated/api").Input} CartInput
 * @typedef {import("../generated/api").CartLinesDiscountsGenerateRunResult} CartLinesDiscountsGenerateRunResult
 */

/**
 * Reads the customer discount metafield and applies wholesale prices at checkout.
 *
 * Metafield format (current):
 *   { "v": { "<numericVariantId>": wholesalePriceCents }, "pct": 20, "t": "label" }
 *   "v"   — explicit per-variant prices (exceptions to the default)
 *   "pct" — default discount percent applied to all variants NOT in "v"
 *
 * Legacy format (also supported — no "pct", "v" contains every variant):
 *   { "v": { "<numericVariantId>": wholesalePriceCents }, "t": "label" }
 *
 * Both formats are backward-compatible: if "pct" is absent, unspecified variants get no discount.
 *
 * @param {CartInput} input
 * @returns {CartLinesDiscountsGenerateRunResult}
 */
export function cartLinesDiscountsGenerateRun(input) {
  const metafieldValue = input.cart.buyerIdentity?.customer?.discountData?.value;
  if (!metafieldValue) return { operations: [] };

  let data;
  try {
    data = JSON.parse(metafieldValue);
  } catch {
    return { operations: [] };
  }

  /** @type {Record<string, number>} */
  const priceMap = {};
  let defaultDiscountPct = 0;
  let discountLabel = "";

  if (data.v && typeof data.v === "object") {
    Object.assign(priceMap, data.v);
    defaultDiscountPct = Number(data.pct) || 0;
    discountLabel = data.t || "";
  } else if (Array.isArray(data.discounts)) {
    // Legacy format
    for (const d of data.discounts) {
      if (!d.variantId || d.wholesalePriceCents == null) continue;
      const numericId = String(d.variantId).split("/").pop();
      if (numericId) priceMap[numericId] = d.wholesalePriceCents;
    }
  }

  if (!Object.keys(priceMap).length && !defaultDiscountPct) return { operations: [] };

  /** @type {any[]} */
  const candidates = [];

  for (const line of input.cart.lines) {
    if (line.merchandise.__typename !== "ProductVariant") continue;

    const numericId = line.merchandise.id.split("/").pop();
    const shopifyPriceCents = Math.round(
      parseFloat(line.cost.amountPerQuantity.amount) * 100
    );

    const wholesalePriceCents = priceMap[numericId];
    let totalDiscountCents;

    if (wholesalePriceCents != null) {
      // Explicit per-variant price override
      const discountPerUnit = shopifyPriceCents - wholesalePriceCents;
      if (discountPerUnit <= 0) continue;
      totalDiscountCents = discountPerUnit * line.quantity;
    } else if (defaultDiscountPct > 0) {
      // Catalog-wide default discount for variants not in the "v" map
      const discountPerUnit = Math.round(shopifyPriceCents * defaultDiscountPct / 100);
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

  if (candidates.length === 0) return { operations: [] };

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
