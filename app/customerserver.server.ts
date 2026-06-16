import db from "./db.server";

export type DiscountEntry = {
  wholesalePriceCents: number;
  originalPriceCents: number;
  discountPercent: number;
};

export type DiscountMap = Record<string, DiscountEntry>;

export async function getDiscountMapForCustomer(shopifyCustomerId: string): Promise<DiscountMap> {
  const numericId = shopifyCustomerId.includes("/")
    ? (shopifyCustomerId.split("/").pop() ?? shopifyCustomerId)
    : shopifyCustomerId;

  const customer = await db.customers.findUnique({
    where: { id: numericId },
    include: {
      catalog: { include: { items: true } },
    },
  });

  if (!customer) {
    console.log(`[discountMap] customer not found in DB for id="${numericId}"`);
    return {};
  }
  if (customer.applicationStatus !== "ACCEPTED") {
    console.log(`[discountMap] customer ${numericId} status="${customer.applicationStatus}" (not ACCEPTED)`);
    return {};
  }
  if (!customer.catalog) {
    console.log(`[discountMap] customer ${numericId} has no catalog assigned (catalogId=${customer.catalogId})`);
    return {};
  }

  const rawItems = (customer.catalog as any).items as Array<{
    variantId: string | null;
    productId: string;
    customPriceCents: bigint | null;
    customDiscountPercent: bigint | null;
  }>;
  const items = rawItems.map(i => ({
    variantId: i.variantId,
    productId: i.productId,
    customPriceCents: i.customPriceCents !== null ? Number(i.customPriceCents) : null,
    customDiscountPercent: i.customDiscountPercent !== null ? Number(i.customDiscountPercent) : null,
  }));

  const priced = items.filter(i => (i.customDiscountPercent ?? 0) > 0).length;
  const defaultPct = (customer.catalog as any).defaultDiscountPercent ?? 0;
  console.log(
    `[discountMap] customer ${numericId} → catalog "${(customer.catalog as any).title}" ` +
    `(${items.length} items, ${priced} with customDiscountPercent>0, defaultDiscountPercent=${defaultPct}%)`
  );

  return buildDiscountMapFromCatalog({
    defaultDiscountPercent: (customer.catalog as any).defaultDiscountPercent,
    items,
  });
}

/** Public alias used by products.tsx — same logic, no DB call needed. */
export function buildDiscountMapFromItems(catalog: {
  defaultDiscountPercent: number | null | undefined;
  items: Array<{
    variantId: string | null;
    productId: string;
    customPriceCents: number | null;
    customDiscountPercent: number | null;
  }>;
}): DiscountMap {
  return buildDiscountMapFromCatalog({
    ...catalog,
    defaultDiscountPercent: catalog.defaultDiscountPercent ?? null,
  });
}

function buildDiscountMapFromCatalog(catalog: {
  defaultDiscountPercent: number | null;
  items: Array<{
    variantId: string | null;
    productId: string;
    customPriceCents: number | null;
    customDiscountPercent: number | null; // already converted to number before this is called
  }>;
}): DiscountMap {
  const discountMap: DiscountMap = {};
  const defaultPct = catalog.defaultDiscountPercent ?? 0;

  for (const item of catalog.items) {
    const key = item.variantId ?? item.productId;
    if (!key) continue;

    const originalCents = item.customPriceCents ?? 0;

    if (item.customDiscountPercent != null && item.customDiscountPercent > 0) {
      // customDiscountPercent stores the WHOLESALE price in cents (field naming is legacy)
      const wholesaleCents = item.customDiscountPercent;
      const pct =
        originalCents > 0
          ? Math.round(((originalCents - wholesaleCents) / originalCents) * 100)
          : 0;
      discountMap[key] = {
        wholesalePriceCents: wholesaleCents,
        originalPriceCents: originalCents,
        discountPercent: pct,
      };
    } else if (defaultPct > 0 && originalCents > 0) {
      const wholesaleCents = Math.round(originalCents * (1 - defaultPct / 100));
      discountMap[key] = {
        wholesalePriceCents: wholesaleCents,
        originalPriceCents: originalCents,
        discountPercent: defaultPct,
      };
    }
  }

  return discountMap;
}
