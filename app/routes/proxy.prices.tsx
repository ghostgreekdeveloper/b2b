/**
 * Storefront price API — served through Shopify's App Proxy.
 *
 * Performance profile (warm cache, 20k-item catalog):
 *   DB queries : 0  (pure in-process memory)
 *   Filter cost: O(k)  where k = requested variant IDs (≤ 150)
 *                previously O(n×k) = up to 3 M comparisons per request
 *
 * Singleflight + stale-while-revalidate (in TtlCache.getOrCompute):
 *   - Cache stampede on TTL expiry: 20 concurrent users → 1 DB query, not 20
 *   - Zero latency spike: stale value served immediately while refresh runs in bg
 */

import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  customerStateCache,
  catalogIdsCache,
  catalogDataCache,
  catalogVersionCache,
  formCache,
  type CatalogData,
  type CatalogItemEntry,
} from "../cache.server";
import { rateLimit } from "../rateLimit.server";

const NUMERIC_ID_RE = /^\d{1,20}$/;
const MAX_IDS = 150;
const EMPTY = { products: [], minimumOrderCents: 0, minimumOrderMessage: null } as const;

export const loader = async ({ request }: any) => {
  await authenticate.public.appProxy(request);

  const url                = new URL(request.url);
  const shopDomain         = url.searchParams.get("shop") ?? "";
  const loggedInCustomerId = url.searchParams.get("logged_in_customer_id") ?? "";

  const variantIds = (url.searchParams.get("v") ?? "")
    .split(",").map((s) => s.trim()).filter((s) => NUMERIC_ID_RE.test(s)).slice(0, MAX_IDS);

  if (!shopDomain || !loggedInCustomerId || !NUMERIC_ID_RE.test(loggedInCustomerId)) {
    return json(EMPTY);
  }

  // ── 1. Customer state (singleflight + stale-while-revalidate) ────────────────
  const csKey = `cs:${shopDomain}:${loggedInCustomerId}`;
  const cs = await customerStateCache.getOrCompute(csKey, async () => {
    const [row, globalForm] = await Promise.all([
      db.customers.findFirst({
        where: { id: loggedInCustomerId, shopDomain },
        select: { applicationStatus: true, minimumOrderCents: true, catalogId: true },
      }),
      getCachedForm(shopDomain),
    ]);
    if (!row || row.applicationStatus !== "ACCEPTED") return null;
    const customerMin = row.minimumOrderCents ?? 0;
    const globalMin   = (globalForm as any)?.minimumOrderCents ?? 0;
    return {
      accepted:          true as const,
      minimumOrderCents: Math.max(customerMin, globalMin),
      legacyCatalogId:   row.catalogId ?? null,
    };
  });

  if (!cs || !cs.accepted) return json(EMPTY);

  // Rate limit: 120 req/min per customer (2/s — generous for any browsing pattern)
  // Return EMPTY rather than 429 so the storefront JS silently degrades without errors.
  if (!rateLimit(`px:${shopDomain}:${loggedInCustomerId}`, 120, 60_000)) {
    return json(EMPTY);
  }

  const { minimumOrderCents, legacyCatalogId } = cs;

  // ── 2. Catalog IDs (singleflight + stale-while-revalidate) ──────────────────
  const cidsKey = `cids:${shopDomain}:${loggedInCustomerId}`;
  const cidsEntry = await catalogIdsCache.getOrCompute(cidsKey, async () => {
    const junctionRows = await db.$queryRaw<{ catalogId: number }[]>`
      SELECT "catalogId" FROM customer_catalogs WHERE "customerId" = ${loggedInCustomerId}
    `;
    let candidateIds = junctionRows.map((r) => Number(r.catalogId));
    if (candidateIds.length === 0 && legacyCatalogId) candidateIds = [legacyCatalogId];

    if (candidateIds.length === 0) {
      return { catalogIds: [], minimumOrderMessage: null, priceDisplay: "REPLACED" };
    }

    // Self-heal: expand via segment siblings so newly-linked catalogs propagate
    const seedCatalogs = await db.catalog.findMany({
      where: { id: { in: candidateIds } },
      select: { id: true, segmentId: true },
    }) as any[];
    const segmentIds = [...new Set(
      seedCatalogs.map((c: any) => c.segmentId as string | null).filter((s): s is string => !!s)
    )];

    if (segmentIds.length > 0) {
      const siblings = await db.catalog.findMany({
        where: { segmentId: { in: segmentIds }, status: "active" },
        select: { id: true },
      }) as any[];
      const newIds: number[] = [];
      for (const c of siblings) {
        const id = Number(c.id);
        if (!candidateIds.includes(id)) { candidateIds.push(id); newIds.push(id); }
      }
      for (const newId of newIds) {
        await db.$executeRaw`
          INSERT INTO customer_catalogs ("customerId", "catalogId") 
          VALUES (${loggedInCustomerId}, ${newId}) ON CONFLICT DO NOTHING
        `;
      }
    }

    const activeCatalogs = await db.catalog.findMany({
      where: { id: { in: candidateIds }, status: "active" },
      select: { id: true, minimumOrderMessage: true, priceDisplay: true },
    }) as any[];

    if (activeCatalogs.length === 0) {
      return { catalogIds: [], minimumOrderMessage: null, priceDisplay: "REPLACED" };
    }

    return {
      catalogIds:          activeCatalogs.map((c: any) => Number(c.id)),
      minimumOrderMessage: activeCatalogs[0].minimumOrderMessage ?? null,
      priceDisplay:        activeCatalogs[0].priceDisplay ?? "REPLACED",
    };
  });

  const { catalogIds, minimumOrderMessage, priceDisplay } = cidsEntry;
  if (!catalogIds.length) return json({ ...EMPTY, minimumOrderCents });

  if (!variantIds.length) {
    return json({ products: [], minimumOrderCents, minimumOrderMessage });
  }

  // ── 3. Catalog data — versioned Map-based O(1) lookup per variant ────────────
  // Cache key includes the catalog's cacheVersion so invalidation is version-stamp
  // (bumps the version, orphans old key) rather than deletion (prevents the race
  // where a slow in-flight compute writes stale data back after a cache.del()).
  //
  // catalogVersionCache TTL = 30 s: worst-case staleness window after invalidation.
  // catalogDataCache TTL = 5 min: full load only happens on cold miss or version bump.
  const catalogEntries = await Promise.all(
    catalogIds.map(async (cid) => {
      // Resolve current version — cheap indexed query, cached 30 s
      const version = await catalogVersionCache.getOrCompute(
        `cv:${cid}`,
        async () => {
          const rows = await db.$queryRaw<{ cacheVersion: number }[]>`
            SELECT "cacheVersion" FROM "Catalog" WHERE id = ${cid}
          `;
          return Number(rows[0]?.cacheVersion ?? 1);
        },
        30_000,
      );

      return catalogDataCache.getOrCompute(`cdata:${cid}:v${version}`, async (): Promise<CatalogData> => {
        const [settingRows, rawItems] = await Promise.all([
          db.$queryRaw<any[]>`
           SELECT "discountType", "defaultDiscountPercent", "fixedDiscountCents",
           "fixedPriceCents", "priceDisplay"
            FROM "Catalog" WHERE id = ${cid} AND status = 'active'
          `,
          db.catalogItem.findMany({
            where:  { catalogId: cid },
            select: { variantId: true, productId: true, customPriceCents: true, customDiscountPercent: true },
          }),
        ]);

        const s = settingRows[0];
        if (!s) return null;

        // Dual-key the Map so callers never need to normalise GID ↔ numeric
        const itemMap = new Map<string, CatalogItemEntry>();
        for (const i of rawItems) {
          const vid = i.variantId as string | null;
          if (!vid) continue;
          const entry: CatalogItemEntry = {
            productId:             i.productId as string,
            customPriceCents:      i.customPriceCents     != null ? Number(i.customPriceCents)     : null,
            customDiscountPercent: i.customDiscountPercent != null ? Number(i.customDiscountPercent) : null,
          };
          itemMap.set(vid, entry);
          if (vid.startsWith("gid://shopify/ProductVariant/")) {
            itemMap.set(vid.split("/").pop()!, entry); // add numeric alias
          } else {
            itemMap.set(`gid://shopify/ProductVariant/${vid}`, entry); // add GID alias
          }
        }

        return {
          itemMap,
          discountType:           String(s.discountType           ?? "PERCENT"),
          defaultDiscountPercent: s.defaultDiscountPercent != null ? Number(s.defaultDiscountPercent) : null,
          fixedDiscountCents:     s.fixedDiscountCents     != null ? Number(s.fixedDiscountCents)     : null,
          fixedPriceCents:        s.fixedPriceCents        != null ? Number(s.fixedPriceCents)        : null,
          priceDisplay:           String(s.priceDisplay           ?? "REPLACED"),
        };
      });  // closes catalogDataCache.getOrCompute
    }),    // closes async (cid) => { ... }
  );

  // ── 4. Build price map — O(k) where k = requested variants (≤ 150) ──────────
  const productMap = new Map<string, {
    variantId: string; productId: string;
    wholesalePriceCents: number; originalPriceCents: number;
    discountPercent: number; priceDisplay: string;
  }>();

  const fixedOffVariants: Record<string, { fixedOff: number; priceDisplay: string }> = {};
  let globalFixedOff          = 0;
  let globalFixedOffDisplay   = "REPLACED";
  let globalFixedPrice        = 0;
  let globalFixedPriceDisplay = "REPLACED";

  for (let ci = 0; ci < catalogEntries.length; ci++) {
    const entry = catalogEntries[ci];
    if (!entry) continue;

    // Guard against stale cache entries written in the old `items: Array` format
    // (can happen after a hot-reload in dev mode without a full server restart).
    // Bust ALL versioned slots for this catalog + evict the version cache so the
    // next request cold-loads fresh data under the current version key.
    if (!(entry.itemMap instanceof Map)) {
      catalogDataCache.delPrefix(`cdata:${catalogIds[ci]}:`);
      catalogVersionCache.del(`cv:${catalogIds[ci]}`);
      continue;
    }

    if (entry.discountType === "FIXED_AMOUNT") {
      const off = entry.fixedDiscountCents ?? 0;
      if (off > globalFixedOff) { globalFixedOff = off; globalFixedOffDisplay = entry.priceDisplay; }
    }
    if (entry.discountType === "FIXED_PRICE") {
      const fp = entry.fixedPriceCents ?? 0;
      if (fp > 0 && (globalFixedPrice === 0 || fp < globalFixedPrice)) {
        globalFixedPrice = fp; globalFixedPriceDisplay = entry.priceDisplay;
      }
    }

    // O(k) — iterate the requested IDs, not the catalog
    for (const numId of variantIds) {
      const item = entry.itemMap.get(numId)
                ?? entry.itemMap.get(`gid://shopify/ProductVariant/${numId}`);
      if (!item) continue;

      const wholesaleCents = resolveWholesalePrice(item, entry);

      if (wholesaleCents > 0) {
        const originalCents   = item.customPriceCents ?? 0;
        const discountPercent = originalCents > 0
          ? Math.max(0, Math.round(((originalCents - wholesaleCents) / originalCents) * 100))
          : 0;
        const existing = productMap.get(numId);
        if (!existing || wholesaleCents < existing.wholesalePriceCents) {
          productMap.set(numId, {
            variantId: numId, productId: item.productId,
            wholesalePriceCents: wholesaleCents, originalPriceCents: originalCents,
            discountPercent, priceDisplay: entry.priceDisplay,
          });
        }
      } else if (entry.discountType === "FIXED_AMOUNT" && !productMap.has(numId)) {
        const off = entry.fixedDiscountCents ?? 0;
        if (off > 0) {
          const ex = fixedOffVariants[numId];
          if (!ex || off < ex.fixedOff) {
            fixedOffVariants[numId] = { fixedOff: off, priceDisplay: entry.priceDisplay };
          }
        }
      }
    }
  }

  return json({
    products:            Array.from(productMap.values()),
    minimumOrderCents,
    minimumOrderMessage,
    priceDisplay:        priceDisplay ?? "REPLACED",
    ...(Object.keys(fixedOffVariants).length > 0 ? { fixedOffVariants }                                                        : {}),
    ...(globalFixedOff   > 0 ? { fixedOff:    globalFixedOff,   fixedOffPriceDisplay:   globalFixedOffDisplay }   : {}),
    ...(globalFixedPrice > 0 ? { fixedPrice:  globalFixedPrice, fixedPricePriceDisplay: globalFixedPriceDisplay } : {}),
  });
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveWholesalePrice(
  item: { customDiscountPercent: number | null; customPriceCents: number | null },
  s: { discountType: string; defaultDiscountPercent: number | null; fixedDiscountCents: number | null; fixedPriceCents: number | null }
): number {
  if (item.customDiscountPercent != null && item.customDiscountPercent > 0) {
    return item.customDiscountPercent;
  }
  const base = item.customPriceCents ?? 0;
  if (s.discountType === "FIXED_AMOUNT") {
    const off = s.fixedDiscountCents ?? 0;
    if (off <= 0 || base <= 0) return 0;
    return Math.max(1, base - off);
  }
  if (s.discountType === "FIXED_PRICE") {
    return s.fixedPriceCents ?? 0;
  }
  const pct = s.defaultDiscountPercent ?? 0;
  if (pct <= 0 || base <= 0) return 0;
  return Math.round(base * (1 - pct / 100));
}

async function getCachedForm(shopDomain: string) {
  return formCache.getOrCompute(`form:${shopDomain}`, async () => {
    const row = await db.form.findFirst({
      where: { shopDomain },
      select: { minimumOrderCents: true },
    });
    return row ? { minimumOrderCents: row.minimumOrderCents } : null;
  });
}
