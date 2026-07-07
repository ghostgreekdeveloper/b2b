import db from "./db.server";
import { customerStateCache, catalogIdsCache, formCache } from "./cache.server";

async function inBatches<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    await Promise.allSettled(items.slice(i, i + batchSize).map(fn));
  }
}

/**
 * Writes the compact discount metafield for a customer.
 *
 * Reads ALL catalogs the customer is enrolled in (junction table + legacy FK +
 * segment siblings) and merges their per-item prices into a single metafield.
 *
 * "v" contains per-variant wholesale prices (lowest across all catalogs wins).
 * "pct" is the highest default discount percent across all active catalogs,
 *       applied to any variant NOT covered by an explicit "v" entry.
 */
export async function writeCustomerDiscountMetafield(
  admin: any,
  customerId: string,
  shopDomain: string
): Promise<void> {
  const numericId = customerId.includes("/")
    ? (customerId.split("/").pop() ?? customerId)
    : customerId;

  const customerGid = `gid://shopify/Customer/${numericId}`;

  const [customer, globalSettings] = await Promise.all([
    db.customers.findFirst({
      where: { id: numericId, shopDomain },
      select: { applicationStatus: true, minimumOrderCents: true, catalogId: true },
    }),
    db.form.findFirst({ where: { shopDomain }, select: { minimumOrderCents: true } }),
  ]);

  // Invalidate caches so the next storefront request re-resolves everything
  customerStateCache.del(`cs:${shopDomain}:${numericId}`);
  catalogIdsCache.del(`cids:${shopDomain}:${numericId}`);
  formCache.del(`form:${shopDomain}`);

  if (!customer || customer.applicationStatus !== "ACCEPTED") {
    await _writeMetafield(admin, customerGid, '{"v":{}}');
    return;
  }

  // ── Resolve all catalog IDs for this customer ──────────────────────────────
  // 1. Junction table
  const junctionRows = await db.$queryRaw<{ catalogId: number }[]>`
    SELECT "catalogId" FROM customer_catalogs WHERE "customerId" = ${numericId}
  `;
  let catalogIds = junctionRows.map((r) => Number(r.catalogId));

  // 2. Legacy FK fallback
  if (catalogIds.length === 0 && customer.catalogId) {
    catalogIds = [customer.catalogId];
  }

  if (catalogIds.length === 0) {
    await _writeMetafield(admin, customerGid, '{"v":{}}');
    return;
  }

  // 3. Expand by segment siblings (picks up newly linked catalogs)
  const seedCatalogs = await db.catalog.findMany({
    where: { id: { in: catalogIds } },
    select: { segmentId: true },
  }) as any[];
  const segmentIds = [
    ...new Set(seedCatalogs.map((c: any) => c.segmentId as string | null).filter(Boolean)),
  ] as string[];
  if (segmentIds.length > 0) {
    const siblings = await db.catalog.findMany({
      where: { segmentId: { in: segmentIds }, status: "active" },
      select: { id: true },
    }) as any[];
    for (const s of siblings) {
      const id = Number(s.id);
      if (!catalogIds.includes(id)) catalogIds.push(id);
    }
  }

  // ── Load all active catalogs + their items ────────────────────────────────
  // Include discountType/fixedDiscountCents/fixedPriceCents so FIXED_AMOUNT and
  // FIXED_PRICE catalogs can compute per-variant wholesale prices.  Previously
  // the items filter was `customDiscountPercent > 0` which silently dropped every
  // item in a FIXED_AMOUNT catalog (they only have customPriceCents set).
  const catalogs = await db.catalog.findMany({
    where: { id: { in: catalogIds }, status: "active" },
    select: {
      id: true,
      discountType: true,
      defaultDiscountPercent: true,
      fixedDiscountCents: true,
      fixedPriceCents: true,
      discountTitle: true,
      minimumOrderMessage: true,
      items: {
        where: {
          OR: [
            { customDiscountPercent: { gt: 0 } }, // explicit per-item price (cents)
            { customPriceCents:      { gt: 0 } }, // base price needed for catalog-level rules
          ],
        },
        select: { variantId: true, productId: true, customDiscountPercent: true, customPriceCents: true },
      },
    },
  }) as any[];

  if (!catalogs.length) {
    await _writeMetafield(admin, customerGid, '{"v":{}}');
    console.log(`[B2B] all catalogs inactive → metafield cleared for ${customerGid}`);
    return;
  }

  // ── Merge per-item prices (lowest price across catalogs wins) ───────────────
  const v: Record<string, number> = {};
  for (const catalog of catalogs) {
    const discountType = String(catalog.discountType ?? "PERCENT");
    const fixedOff     = Number(catalog.fixedDiscountCents) || 0;
    const fixedPrice   = Number(catalog.fixedPriceCents)    || 0;

    for (const item of (catalog.items as any[])) {
      const key = item.variantId ?? item.productId;
      if (!key) continue;

      const perItem = Number(item.customDiscountPercent) || 0;
      const base    = Number(item.customPriceCents)      || 0;

      let price: number;
      if (perItem > 0) {
        // Stored per-item wholesale price (cents) — highest priority
        price = perItem;
      } else if (discountType === "FIXED_AMOUNT") {
        if (fixedOff <= 0 || base <= 0) continue;
        price = Math.max(1, base - fixedOff);
      } else if (discountType === "FIXED_PRICE") {
        if (fixedPrice <= 0) continue;
        price = fixedPrice;
      } else {
        // PERCENT — covered by the global `pct` field in the metafield payload
        continue;
      }

      if (price <= 0) continue;

      // For PERCENT catalogs: skip entries where the per-item price is identical
      // to what the default pct would produce — the function applies pct to those
      // variants anyway, so storing them in v{} would only bloat the metafield.
      if (discountType === "PERCENT" && perItem > 0 && base > 0) {
        const catPct = Number(catalog.defaultDiscountPercent) || 0;
        if (catPct > 0 && price === Math.round(base * (1 - catPct / 100))) continue;
      }

      let numId: string;
      if (key.startsWith("gid://shopify/ProductVariant/")) {
        numId = key.split("/").pop()!;
      } else if (key.startsWith("gid://")) {
        continue;
      } else {
        numId = key;
      }
      // Lowest wholesale price wins across all catalogs
      if (v[numId] == null || price < v[numId]) {
        v[numId] = price;
      }
    }
  }

  // Default pct = highest discount percent across all active catalogs
  // (variants not in v get the best available default discount)
  const defaultPct = catalogs.reduce((best: number, c: any) => {
    const pct = Number(c.defaultDiscountPercent) || 0;
    return pct > best ? pct : best;
  }, 0);

  const customerMin = customer.minimumOrderCents ?? 0;
  const globalMin   = globalSettings?.minimumOrderCents ?? 0;
  const minimumOrderCents = Math.max(customerMin, globalMin);

  const firstCatalog = catalogs[0];
  const payload: Record<string, unknown> = { v };
  if (defaultPct > 0)                    payload.pct = defaultPct;
  if (firstCatalog.discountTitle)        payload.t   = firstCatalog.discountTitle;
  if (minimumOrderCents > 0)             payload.m   = minimumOrderCents;
  if (firstCatalog.minimumOrderMessage)  payload.msg = firstCatalog.minimumOrderMessage;

  const value = JSON.stringify(payload);
  await _writeMetafield(admin, customerGid, value);
}

export async function clearCustomerDiscountMetafield(
  admin: any,
  customerId: string,
  shopDomain: string
): Promise<void> {
  const numericId = customerId.includes("/")
    ? (customerId.split("/").pop() ?? customerId)
    : customerId;

  customerStateCache.del(`cs:${shopDomain}:${numericId}`);
  const customerGid = `gid://shopify/Customer/${numericId}`;
  await _writeMetafield(admin, customerGid, '{"v":{}}');
  console.log(`[B2B] metafield cleared → ${customerGid}`);
}

/** Clears metafields for every ACCEPTED customer in a catalog (fire-and-forget). */
export function clearCatalogCustomerMetafields(admin: any, catalogId: number): void {
  _getCustomersForCatalog(catalogId)
    .then(({ shop, customers }) => {
      if (!customers.length) return;
      return inBatches(customers, 5, (c) => clearCustomerDiscountMetafield(admin, c.id, shop));
    })
    .catch((err: unknown) => console.error(`[B2B] clearCatalogCustomerMetafields error:`, err));
}

/** Rewrites metafields for ALL accepted customers in a shop (fire-and-forget).
 *  Call when a shop's global minimum order amount changes. */
export function refreshAllAcceptedCustomerMetafields(admin: any, shopDomain: string): void {
  formCache.del(`form:${shopDomain}`);
  db.customers
    .findMany({
      where: { applicationStatus: "ACCEPTED", shopDomain },
      select: { id: true },
    })
    .then((customers: Array<{ id: string }>) => {
      if (!customers.length) return;
      console.log(`[B2B] refreshing metafields for ${customers.length} customer(s) in ${shopDomain}`);
      inBatches(customers, 5, (c) => writeCustomerDiscountMetafield(admin, c.id, shopDomain))
        .then(() => console.log(`[B2B] refreshAllAcceptedCustomerMetafields done for ${shopDomain}`))
        .catch((err: unknown) => console.error(`[B2B] refreshAllAcceptedCustomerMetafields error:`, err));
    })
    .catch((err: unknown) => console.error("[B2B] refreshAllAcceptedCustomerMetafields DB error:", err));
}

/** Rewrites metafields for every ACCEPTED customer in a catalog (fire-and-forget). */
export function refreshCatalogCustomerMetafields(admin: any, catalogId: number): void {
  _getCustomersForCatalog(catalogId)
    .then(({ shop, customers }) => {
      if (!customers.length) return;
      console.log(`[B2B] refreshing metafields for ${customers.length} customer(s) in catalog ${catalogId}`);
      return inBatches(customers, 5, (c) => writeCustomerDiscountMetafield(admin, c.id, shop))
        .then(() => console.log(`[B2B] refreshCatalogCustomerMetafields done for catalog ${catalogId}`));
    })
    .catch((err: unknown) => console.error("[B2B] refreshCatalogCustomerMetafields error:", err));
}

/**
 * Finds all ACCEPTED customers for a catalog.
 * Checks both the legacy catalogId FK and the junction table so customers
 * enrolled via segments are always included.
 */
async function _getCustomersForCatalog(
  catalogId: number
): Promise<{ shop: string; customers: Array<{ id: string }> }> {
  const cat = await db.catalog.findUnique({
    where: { id: catalogId },
    select: { shopDomain: true },
  });
  if (!cat) return { shop: "", customers: [] };

  const shop = cat.shopDomain;

  const [legacy, junctionRows] = await Promise.all([
    // Legacy FK path
    db.customers.findMany({
      where: { catalogId, applicationStatus: "ACCEPTED", shopDomain: shop },
      select: { id: true },
    }),
    // Junction table path
    db.$queryRaw<{ customerId: string }[]>`
      SELECT "customerId" FROM customer_catalogs WHERE "catalogId" = ${catalogId}
    `,
  ]);

  const junctionIds = junctionRows.map((r) => String(r.customerId));
  const junctionCustomers = junctionIds.length > 0
    ? await db.customers.findMany({
        where: { id: { in: junctionIds }, applicationStatus: "ACCEPTED", shopDomain: shop },
        select: { id: true },
      })
    : [];

  // Deduplicate
  const seen = new Set<string>();
  const customers: Array<{ id: string }> = [];
  for (const c of [...legacy, ...junctionCustomers]) {
    if (!seen.has(c.id)) { seen.add(c.id); customers.push(c); }
  }

  return { shop, customers };
}

async function _writeMetafield(admin: any, customerGid: string, value: string): Promise<void> {
  const res = await admin.graphql(
    `mutation WriteDiscountMetafield($customerId: ID!, $value: String!) {
      customerUpdate(input: {
        id: $customerId
        metafields: [{
          namespace: "b2b_wholesale"
          key: "discount_data"
          value: $value
          type: "json"
        }]
      }) {
        customer { id }
        userErrors { field message }
      }
    }`,
    { variables: { customerId: customerGid, value } }
  );
  const data = await res.json();
  const errors = data.data?.customerUpdate?.userErrors ?? [];
  if (errors.length) throw new Error(errors.map((e: any) => e.message).join("; "));
}
