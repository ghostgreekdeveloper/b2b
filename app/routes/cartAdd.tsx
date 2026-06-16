/**
 * Public API consumed by the Shopify storefront theme.
 *
 * POST /cartAdd
 * Body: { customerId: string, items: [{ id: variantId, quantity: number }] }
 *
 * Returns each item with correct wholesale pricing.
 * Looks up the customer in our own DB — no sessions, no metafields, no Shopify writes.
 *
 * The theme should pass {{ customer.id }} (Shopify numeric ID) from Liquid.
 */

import { json } from "@remix-run/node";
import db from "../db.server";
import { getDiscountMapForCustomer } from "../customerserver.server";
import { getCorsHeaders, optionsResponse } from "../cors.server";

export const loader = async ({ request }: any) => {
  const corsHeaders = await getCorsHeaders(request);
  if (request.method === "OPTIONS") return optionsResponse(corsHeaders);
  return json({ error: "Use POST" }, { status: 405, headers: corsHeaders });
};

export const action = async ({ request }: any) => {
  const corsHeaders = await getCorsHeaders(request);
  if (request.method === "OPTIONS") return optionsResponse(corsHeaders);

  let body: { customerId?: string; items: Array<{ id: string | number; quantity: number }> };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, { status: 400, headers: corsHeaders });
  }

  if (!Array.isArray(body?.items)) {
    return json({ error: "items must be an array" }, { status: 400, headers: corsHeaders });
  }

  // Look up wholesale prices for this customer from our DB
  const discountMap = body.customerId
    ? await getDiscountMapForCustomer(body.customerId)
    : {};

  const itemsWithDiscount = body.items.map((item) => {
    const variantId = String(item.id);

    // Try GID format and numeric format — the DB may store either
    const gidVariantId = variantId.startsWith("gid://")
      ? variantId
      : `gid://shopify/ProductVariant/${variantId}`;
    const entry = discountMap[variantId] ?? discountMap[gidVariantId];

    const originalCents = entry?.originalPriceCents ?? 0;
    const wholesaleCents = entry?.wholesalePriceCents ?? originalCents;
    const discountPercent = entry?.discountPercent ?? 0;
    const discountCents = (originalCents - wholesaleCents) * item.quantity;

    return {
      id: Number(item.id),
      quantity: item.quantity,
      original_price: originalCents,
      price: wholesaleCents,
      discounted_price: wholesaleCents,
      original_line_price: originalCents * item.quantity,
      final_line_price: wholesaleCents * item.quantity,
      total_discount: discountCents,
      discount_percent: discountPercent,
      line_level_discount_allocations:
        discountCents > 0
          ? [
              {
                amount: discountCents,
                amount_set: {
                  shop_money: {
                    amount: (discountCents / 100).toFixed(2),
                    currency_code: "EUR",
                  },
                },
              },
            ]
          : [],
      properties: {
        _wholesale_price: (wholesaleCents / 100).toFixed(2),
        _discount_percent: discountPercent > 0 ? `${discountPercent}%` : null,
      },
    };
  });

  return json({ items: itemsWithDiscount }, { headers: corsHeaders });
};
