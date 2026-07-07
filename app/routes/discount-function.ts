/**
 * Called by the Shopify Function (fetch phase) at checkout.
 * Queries only the variants in the customer's cart — never loads the full catalog.
 *
 * POST body: { customerId: string, cartItems: [{ variantId, productId, quantity }] }
 * Response:  { discounts, defaultPct, defaultLabel, fixedPrice, fixedPriceLabel }
 */

import { json } from "@remix-run/node";
import db from "../db.server";

const NUMERIC_ID_RE = /^\d{1,20}$/;

export const loader = async () => json({ error: "Use POST" }, { status: 405 });

export const action = async ({ request }: any) => {
  try {
    const body = await request.json();
    const { customerId, cartItems } = body;

    if (!customerId || !Array.isArray(cartItems) || !cartItems.length) {
      return json({ discounts: [] });
    }

    const numericId = customerId.includes("/")
      ? (customerId.split("/").pop() ?? customerId)
      : customerId;

    if (!NUMERIC_ID_RE.test(numericId)) return json({ discounts: [] });

    const customer = await db.customers.findFirst({
      where: { id: numericId },
      select: { applicationStatus: true, catalogId: true },
    });

    if (!customer || customer.applicationStatus !== "ACCEPTED") {
      return json({ discounts: [] });
    }

    // Resolve all catalog IDs: junction table first, legacy FK fallback
    const junctionRows = await db.$queryRaw<{ catalogId: number }[]>`
      SELECT "catalogId" FROM customer_catalogs WHERE "customerId" = ${numericId}
    `;
    let catalogIds = junctionRows.map((r) => Number(r.catalogId));
    if (catalogIds.length === 0 && customer.catalogId) {
      catalogIds = [customer.catalogId];
    }

    if (!catalogIds.length) return json({ discounts: [] });

    const catalogs = await db.catalog.findMany({
      where: { id: { in: catalogIds }, status: "active" },
      select: {
        id: true,
        discountType: true,
        defaultDiscountPercent: true,
        fixedDiscountCents: true,
        fixedPriceCents: true,
        discountTitle: true,
      },
    }) as any[];

    if (!catalogs.length) return json({ discounts: [] });

    // Normalise cart variant IDs
    const variantNumericIds: string[] = [];
    const variantGids: string[] = [];
    for (const item of cartItems) {
      const vid = String(item.variantId ?? "");
      if (!vid) continue;
      const numeric = vid.includes("/") ? (vid.split("/").pop() ?? "") : vid;
      if (NUMERIC_ID_RE.test(numeric)) {
        if (!variantNumericIds.includes(numeric)) {
          variantNumericIds.push(numeric);
          variantGids.push(`gid://shopify/ProductVariant/${numeric}`);
        }
      }
    }

    if (!variantNumericIds.length) return json({ discounts: [] });

    // Load catalog items for only the cart variants — O(cart size), not O(catalog size)
    const allItems = await db.catalogItem.findMany({
      where: {
        catalogId: { in: catalogIds },
        variantId: { in: [...variantGids, ...variantNumericIds] },
      },
      select: { variantId: true, catalogId: true, customPriceCents: true, customDiscountPercent: true },
    }) as any[];

    const catalogMap = new Map(catalogs.map((c: any) => [Number(c.id), c]));

    // Build price map — lowest wholesale price across all catalogs wins
    const priceMap = new Map<string, { wholesalePriceCents: number; label: string }>();

    for (const item of allItems) {
      const catalog = catalogMap.get(Number(item.catalogId));
      if (!catalog) continue;

      const perItem    = Number(item.customDiscountPercent) || 0;
      const base       = Number(item.customPriceCents) || 0;
      const dtype      = String(catalog.discountType ?? "PERCENT");

      let wholesaleCents: number;
      if (perItem > 0) {
        // Explicit per-item wholesale price stored in cents
        wholesaleCents = perItem;
      } else if (dtype === "FIXED_AMOUNT") {
        const off = Number(catalog.fixedDiscountCents) || 0;
        if (off <= 0 || base <= 0) continue;
        wholesaleCents = Math.max(1, base - off);
      } else if (dtype === "FIXED_PRICE") {
        const fp = Number(catalog.fixedPriceCents) || 0;
        if (fp <= 0) continue;
        wholesaleCents = fp;
      } else {
        // PERCENT — base price needed to compute; if missing, defaultPct covers it
        const pct = Number(catalog.defaultDiscountPercent) || 0;
        if (pct <= 0 || base <= 0) continue;
        wholesaleCents = Math.round(base * (1 - pct / 100));
      }

      if (wholesaleCents <= 0) continue;

      const numId = (item.variantId as string ?? "").startsWith("gid://")
        ? (item.variantId as string).split("/").pop()!
        : String(item.variantId);

      const existing = priceMap.get(numId);
      if (!existing || wholesaleCents < existing.wholesalePriceCents) {
        priceMap.set(numId, {
          wholesalePriceCents: wholesaleCents,
          label: catalog.discountTitle ?? "",
        });
      }
    }

    // Best catalog-level defaults for variants not covered by per-item entries
    let defaultPct        = 0;
    let defaultLabel      = "";
    let fixedPrice        = 0;
    let fixedPriceLabel   = "";

    for (const c of catalogs) {
      const dtype = String(c.discountType ?? "PERCENT");
      if (dtype === "PERCENT") {
        const pct = Number(c.defaultDiscountPercent) || 0;
        if (pct > defaultPct) { defaultPct = pct; defaultLabel = c.discountTitle ?? ""; }
      } else if (dtype === "FIXED_PRICE") {
        const fp = Number(c.fixedPriceCents) || 0;
        if (fp > 0 && (fixedPrice === 0 || fp < fixedPrice)) {
          fixedPrice = fp; fixedPriceLabel = c.discountTitle ?? "";
        }
      }
    }

    // Build response
    const discounts: Array<{ variantId: string; wholesalePriceCents: number; label?: string }> = [];
    for (const item of cartItems) {
      const vid = String(item.variantId ?? "");
      if (!vid) continue;
      const numeric = vid.includes("/") ? (vid.split("/").pop() ?? "") : vid;
      const entry = priceMap.get(numeric);
      if (entry) {
        discounts.push({
          variantId: `gid://shopify/ProductVariant/${numeric}`,
          wholesalePriceCents: entry.wholesalePriceCents,
          label: entry.label || undefined,
        });
      }
    }

    const response: Record<string, any> = { discounts };
    if (defaultPct   > 0) { response.defaultPct   = defaultPct;   response.defaultLabel   = defaultLabel;   }
    if (fixedPrice   > 0) { response.fixedPrice    = fixedPrice;   response.fixedPriceLabel = fixedPriceLabel; }

    return json(response);
  } catch (err) {
    console.error("[discount-function] error:", err);
    return json({ discounts: [] }, { status: 500 });
  }
};
