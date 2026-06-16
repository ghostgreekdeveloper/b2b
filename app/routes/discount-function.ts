/**
 * Called by the Shopify Function (fetch phase) at checkout.
 * Receives only the variants in the customer's cart — loads ONLY those rows
 * from the DB instead of the entire catalog.
 *
 * POST body: { customerId: string, cartItems: [{ variantId, productId, quantity }] }
 */

import { json } from "@remix-run/node";
import db from "../db.server";
import { buildDiscountMapFromItems } from "../customerserver.server";

const NUMERIC_ID_RE = /^\d{1,20}$/;

export const loader = async () => {
  return json({ error: "Use POST" }, { status: 405 });
};

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

    const customer = await db.customers.findUnique({
      where: { id: numericId },
      select: {
        applicationStatus: true,
        catalog: {
          select: { id: true, defaultDiscountPercent: true, status: true },
        },
      },
    });

    if (
      !customer ||
      customer.applicationStatus !== "ACCEPTED" ||
      !customer.catalog ||
      (customer.catalog as any).status !== "active"
    ) {
      return json({ discounts: [] });
    }

    const catalog = customer.catalog as any;

    // Extract variant IDs from the cart — only load these from DB, not the full catalog
    const variantIds: string[] = [];
    const variantGids: string[] = [];
    for (const item of cartItems) {
      const vid = String(item.variantId ?? "");
      if (!vid) continue;
      const numeric = vid.includes("/") ? (vid.split("/").pop() ?? "") : vid;
      if (NUMERIC_ID_RE.test(numeric)) {
        variantIds.push(numeric);
        variantGids.push(`gid://shopify/ProductVariant/${numeric}`);
      }
    }

    if (!variantIds.length) return json({ discounts: [] });

    const items = await db.catalogItem.findMany({
      where: {
        catalogId: catalog.id,
        variantId: { in: [...variantGids, ...variantIds] },
      },
      select: { variantId: true, productId: true, customPriceCents: true, customDiscountPercent: true },
    });

    const rawItems = (items as any[]).map((i) => ({
      variantId: i.variantId as string | null,
      productId: i.productId as string,
      customPriceCents: i.customPriceCents !== null ? Number(i.customPriceCents) : null,
      customDiscountPercent: i.customDiscountPercent !== null ? Number(i.customDiscountPercent) : null,
    }));

    const discountMap = buildDiscountMapFromItems({
      defaultDiscountPercent: catalog.defaultDiscountPercent,
      items: rawItems,
    });

    const discounts: Array<{
      variantId: string;
      wholesalePriceCents: number;
      originalPriceCents: number;
      discountPercent: number;
    }> = [];

    for (const item of cartItems) {
      const variantId = String(item.variantId ?? "");
      if (!variantId) continue;

      const numId = variantId.includes("/") ? (variantId.split("/").pop() ?? variantId) : variantId;
      const gidId = variantId.startsWith("gid://")
        ? variantId
        : `gid://shopify/ProductVariant/${variantId}`;

      const entry = discountMap[variantId] ?? discountMap[gidId] ?? discountMap[numId];
      if (!entry) continue;

      discounts.push({
        variantId: gidId,
        wholesalePriceCents: entry.wholesalePriceCents,
        originalPriceCents: entry.originalPriceCents,
        discountPercent: entry.discountPercent,
      });
    }

    console.log(`[discount-function] customerId=${numericId} | ${cartItems.length} cart items → ${discounts.length} discounts`);
    return json({ discounts });
  } catch (err) {
    console.error("[discount-function] error:", err);
    return json({ discounts: [] }, { status: 500 });
  }
};
