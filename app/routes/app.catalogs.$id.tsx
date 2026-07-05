import React, { useState, useMemo } from "react";
import { json, type LoaderArgs, type ActionArgs } from "@remix-run/node";
import { useLoaderData, useFetcher, useNavigate } from "@remix-run/react";
import {
  Page, Card, BlockStack, InlineStack, InlineGrid, Divider,
  Text, TextField, Checkbox, Select, Button, Banner,
} from "@shopify/polaris";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import { customerStateCache, catalogIdsCache, syncSessionCache, productMetaCache } from "../cache.server";
import { invalidateCatalogCache } from "../catalogInvalidate.server";
import {
  refreshCatalogCustomerMetafields,
  clearCatalogCustomerMetafields,
} from "../writeCustomerMetafield.server";

const PAGE_SIZE = 50;

async function _autoEnrollBySegment(
  admin: any, shop: string, catalogId: number, segmentId: string
): Promise<void> {
  const segment = await db.segment.findUnique({
    where: { id: segmentId }, select: { customercondition: true },
  });
  const cond = (segment?.customercondition as string | null) ?? "";
  if (!cond || cond.startsWith("domain:") || cond.startsWith("customers:") || cond.startsWith("shopify_segment:")) return;
  const tagName = cond.startsWith("tag:") ? cond.slice(4) : cond;
  if (!tagName) return;

  // ── Path 1: Shopify-first — find customers who already have the tag ────────
  const tagRes = await admin.graphql(
    `query AutoEnroll($q: String!) { customers(first: 250, query: $q) { nodes { id } } }`,
    { variables: { q: `tag:${tagName}` } }
  );
  const taggedShopifyIds: string[] = ((await tagRes.json())?.data?.customers?.nodes ?? [])
    .map((n: any) => (n.id as string).replace("gid://shopify/Customer/", ""));

  // ── Path 2: DB-first — find ACCEPTED customers who don't have the tag yet ──
  // These are customers approved in the B2B app but never tagged in Shopify.
  // Push the segment tag to them so future queries also find them correctly.
  const allAccepted = await db.customers.findMany({
    where: { applicationStatus: "ACCEPTED", shopDomain: shop },
    select: { id: true },
  });
  const taggedSet = new Set(taggedShopifyIds);
  const needsTag = allAccepted.filter((c) => !taggedSet.has(c.id));

  if (needsTag.length > 0) {
    // Add tag in Shopify for each untagged ACCEPTED customer (batched, fire-and-forget errors)
    await Promise.allSettled(
      needsTag.map((c) =>
        admin.graphql(
          `mutation TagAdd($id: ID!, $tags: [String!]!) { tagsAdd(id: $id, tags: $tags) { userErrors { message } } }`,
          { variables: { id: `gid://shopify/Customer/${c.id}`, tags: [tagName] } }
        )
      )
    );
    console.log(`[B2B] pushed tag "${tagName}" to ${needsTag.length} untagged ACCEPTED customer(s)`);
  }

  // Union: everyone who has (or just got) the tag AND is ACCEPTED in DB
  const allCandidateIds = [...new Set([...taggedShopifyIds, ...needsTag.map((c) => c.id)])];
  const accepted = await db.customers.findMany({
    where: { id: { in: allCandidateIds }, applicationStatus: "ACCEPTED", shopDomain: shop },
    select: { id: true },
  });
  if (!accepted.length) return;

  const existing = await db.$queryRaw<{ customerId: string }[]>`
    SELECT "customerId" FROM customer_catalogs WHERE "catalogId" = ${catalogId}
  `;
  const existingSet = new Set(existing.map((r) => String(r.customerId)));
  const toAdd = accepted.filter((c) => !existingSet.has(c.id));
  if (!toAdd.length) return;

  for (const c of toAdd) {
    await db.$executeRaw`
      INSERT INTO customer_catalogs ("customerId", "catalogId")
      VALUES (${c.id}, ${catalogId}) ON CONFLICT DO NOTHING
    `;
    await db.customers.updateMany({
      where: { id: c.id, catalogId: null },
      data: { catalogId },
    });
  }

  refreshCatalogCustomerMetafields(admin, catalogId);
  console.log(`[B2B] auto-enrolled ${toAdd.length} customer(s) into catalog ${catalogId} via tag "${tagName}"`);
}

// ── Loader ────────────────────────────────────────────────────────────────────
export const loader = async ({ params, request }: LoaderArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop = session.shop;
  const catalogId = Number(params.id);

  const catalog = await db.catalog.findFirst({
    where: { id: catalogId, shopDomain: shop },
    include: { items: true },
  });
  if (!catalog) throw new Response("Catalog not found", { status: 404 });

  const segments = await db.segment.findMany({
    where: { shopDomain: { in: [shop, ""] } },
    select: { id: true, title: true },
    orderBy: { title: "asc" },
  });

  const countResult = await db.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(DISTINCT c.id) as count FROM "Customers" c
    WHERE c."applicationStatus" = 'ACCEPTED' AND c."shopDomain" = ${shop}
      AND (
        c."catalogId" = ${catalogId}
        OR EXISTS (SELECT 1 FROM customer_catalogs cc WHERE cc."customerId" = c.id AND cc."catalogId" = ${catalogId})
      )
  `;
  const assignedCustomerCount = Number(countResult[0]?.count ?? 0);

  // Fetch Shopify status + collections — cached per catalog, parallel batches of 250
  const uniqueProductIds = [
    ...new Set(catalog.items.map((i) => i.productId.toString())),
  ];

  type ProductMeta = { status: string; collections: string[] };

  const metaCacheKey = `meta:${shop}:${catalogId}`;
  const cached = productMetaCache.get(metaCacheKey);

  let productMeta: Record<string, ProductMeta>;
  let allCollections: string[];

  if (cached) {
    productMeta   = cached.meta;
    allCollections = cached.collections;
  } else {
    const merged: Record<string, ProductMeta> = {};

    // Build batches of 250 and run ALL of them in parallel
    const batches: string[][] = [];
    for (let i = 0; i < uniqueProductIds.length; i += 250) {
      batches.push(uniqueProductIds.slice(i, i + 250));
    }

    await Promise.all(batches.map(async (batch) => {
      const ids = batch.map((id) =>
        id.startsWith("gid://") ? id : `gid://shopify/Product/${id}`
      );
      try {
        const res = await admin.graphql(
          `query ProductMeta($ids: [ID!]!) {
            nodes(ids: $ids) {
              ... on Product {
                id
                status
                collections(first: 10) { nodes { title } }
              }
            }
          }`,
          { variables: { ids } }
        );
        const data = await res.json();
        for (const node of (data.data?.nodes ?? []) as any[]) {
          if (!node?.id) continue;
          const numId = node.id.split("/").pop()!;
          merged[numId] = {
            status: node.status ?? "ACTIVE",
            collections: node.collections?.nodes?.map((c: any) => c.title) ?? [],
          };
        }
      } catch (e) {
        console.error("[B2B] product meta fetch failed:", e);
      }
    }));

    const cols = [...new Set(Object.values(merged).flatMap((m) => m.collections))].sort();
    productMeta    = merged;
    allCollections = cols;
    productMetaCache.set(metaCacheKey, { meta: merged, collections: cols });
  }

  const items = catalog.items.map((item) => {
    const pid = item.productId.toString();
    return {
      id: item.id.toString(),
      name: item.name ?? "Untitled",
      sku: item.sku ?? "",
      img: item.img,
      basePrice: item.customPriceCents != null ? Number(item.customPriceCents) / 100 : 0,
      wholesaleCents: item.customDiscountPercent != null ? Number(item.customDiscountPercent) : 0,
      productId: pid,
      variantId: item.variantId?.toString(),
      shopifyStatus: productMeta[pid]?.status ?? "ACTIVE",
      collections: productMeta[pid]?.collections ?? [],
    };
  });

  const uniqueProducts = new Set(items.map((i) => i.productId)).size;
  const variantsCount  = items.filter((i) => i.variantId).length;

  // Raw query for fields not in the generated Prisma client (pending prisma generate)
  const rawExtra = await db.$queryRaw<{
    discountType: string; fixedDiscountCents: number | null;
    fixedPriceCents: number | null; priceDisplay: string;
  }[]>`SELECT "discountType", "fixedDiscountCents", "fixedPriceCents", "priceDisplay" FROM "Catalog" WHERE id = ${catalogId}`;
  const extra = rawExtra[0] ?? { discountType: "PERCENT", fixedDiscountCents: null, fixedPriceCents: null, priceDisplay: "REPLACED" };

  // Fire-and-forget: auto-enroll existing ACCEPTED customers who match the segment tag.
  // Runs every page load; ON CONFLICT DO NOTHING makes it idempotent.
  if (catalog.segmentId) {
    _autoEnrollBySegment(admin, shop, catalogId, catalog.segmentId).catch((e) =>
      console.error("[B2B] autoEnroll error:", e)
    );
  }

  return json({
    catalog: {
      id: catalog.id,
      title: catalog.title,
      status: catalog.status ?? "active",
      segmentId: catalog.segmentId ?? "",
      discountTitle: catalog.discountTitle ?? "",
      minimumOrderMessage: catalog.minimumOrderMessage ?? "",
      autoIncludeProducts: catalog.autoIncludeProducts,
      defaultDiscountPercent: catalog.defaultDiscountPercent ?? 0,
      discountType: extra.discountType,
      fixedDiscountCents: extra.fixedDiscountCents,
      fixedPriceCents: extra.fixedPriceCents,
      priceDisplay: extra.priceDisplay,
      productCount: uniqueProducts,
      variantCount: variantsCount,
      items,
    },
    segments,
    assignedCustomerCount,
    allCollections,
  });
};

// ── Action ────────────────────────────────────────────────────────────────────
export const action = async ({ request, params }: ActionArgs) => {
  const { admin, session } = await authenticate.admin(request);
  const shop      = session.shop;
  const catalogId = Number(params.id);
  const formData  = await request.formData();

  // Verify this catalog belongs to the current shop
  const ownedCheck = await db.catalog.findFirst({
    where: { id: catalogId, shopDomain: shop },
    select: { id: true },
  });
  if (!ownedCheck) return json({ success: false, error: "Not found" }, { status: 404 });
  const intent    = formData.get("_action")?.toString();

  // ── Manually add products via resource picker ──────────────────────────────
  if (intent === "addItems") {
    const itemsJson = formData.get("items")?.toString() ?? "[]";
    const newItems: Array<{
      productId: string; variantId: string; name: string;
      sku: string; img: string; priceCents: number | null;
    }> = JSON.parse(itemsJson);

    if (newItems.length > 0) {
      const existingRows = await db.catalogItem.findMany({
        where: { catalogId, variantId: { in: newItems.map((i) => i.variantId) } },
        select: { variantId: true },
      });
      const existingSet = new Set(existingRows.map((r) => r.variantId));
      const toAdd = newItems.filter((i) => !existingSet.has(i.variantId));

      if (toAdd.length > 0) {
        await db.catalogItem.createMany({
          data: toAdd.map((item) => ({
            catalogId,
            productId: item.productId,
            variantId: item.variantId,
            name: item.name || "Unnamed",
            sku: item.sku || null,
            img: item.img || null,
            customPriceCents: item.priceCents ? BigInt(item.priceCents) : null,
          })),
        });
      }
    }

    await invalidateCatalogCache(catalogId);
    refreshCatalogCustomerMetafields(admin, catalogId);
    return json({ success: true, intent: "addItems" });
  }

  // ── Remove items ────────────────────────────────────────────────────────────
  if (intent === "removeItems") {
    const idsRaw = formData.get("itemIds")?.toString() ?? "";
    const ids = idsRaw.split(",").map(Number).filter(Boolean);
    if (ids.length > 0) {
      await db.catalogItem.deleteMany({ where: { catalogId, id: { in: ids } } });
      await invalidateCatalogCache(catalogId);
      refreshCatalogCustomerMetafields(admin, catalogId);
    }
    return json({ success: true, intent: "removeItems", count: ids.length });
  }

  // ── Per-item fixed price ────────────────────────────────────────────────────
  if (intent === "setItemPrice") {
    const itemId    = Number(formData.get("itemId"));
    const priceCents = Math.round(parseFloat(formData.get("priceCents")?.toString() || "0") * 100);
    await db.catalogItem.update({
      where: { id: itemId },
      data: { customDiscountPercent: priceCents > 0 ? priceCents : null },
    });
    await invalidateCatalogCache(catalogId);
    refreshCatalogCustomerMetafields(admin, catalogId);
    return json({ success: true, intent: "setItemPrice" });
  }

  if (intent === "resetItemPrice") {
    const itemId = Number(formData.get("itemId"));

    // Calculate the catalog's default discounted price and store it explicitly
    // so the product shows its correct price (not blank/null) after reset.
    const [item, catalog] = await Promise.all([
      db.catalogItem.findUnique({ where: { id: itemId }, select: { customPriceCents: true } }),
      db.catalog.findUnique({ where: { id: catalogId }, select: { defaultDiscountPercent: true } }),
    ]);

    const pct   = catalog?.defaultDiscountPercent ?? 0;
    const base  = item?.customPriceCents != null ? Number(item.customPriceCents) : 0;
    const resetCents = pct > 0 && base > 0
      ? Math.round(base * (1 - pct / 100))
      : null;

    await db.catalogItem.update({
      where: { id: itemId },
      data: { customDiscountPercent: resetCents },
    });
    await invalidateCatalogCache(catalogId);
    refreshCatalogCustomerMetafields(admin, catalogId);
    return json({ success: true, intent: "resetItemPrice" });
  }

  // ── Chunked sync ─────────────────────────────────────────────────────────────
  // Three-phase: syncStart → syncPage (×N) → syncFinalize
  // Each syncPage fetches 250 Shopify products, upserts in parallel batches,
  // and returns progress so the frontend can display a live progress bar.

  if (intent === "syncStart") {
    const catalog = await db.catalog.findUnique({
      where: { id: catalogId },
      include: { items: true },
    });
    if (!catalog) return json({ success: false, error: "Catalog not found" });

    // Get total product count for the progress bar
    let total = 0;
    try {
      const cRes  = await admin.graphql(`query { productsCount { count } }`);
      const cData = await cRes.json();
      total = cData.data?.productsCount?.count ?? 0;
    } catch {}

    // Build existing GID → { id, discount } map (loaded once, stored in session)
    const existingMap: Record<string, { id: number; discount: bigint | null }> = {};
    for (const item of catalog.items) {
      if (!item.variantId) continue;
      const vid = String(item.variantId);
      const gid = vid.startsWith("gid://") ? vid : `gid://shopify/ProductVariant/${vid}`;
      existingMap[gid] = {
        id:       item.id,
        discount: item.customDiscountPercent ?? null,
      };
    }

    const syncStatusesRaw = formData.get("syncStatuses")?.toString() ?? "ACTIVE,DRAFT";
    const syncStatuses = syncStatusesRaw.split(",").filter(Boolean);

    const sessionId = `sync_${catalogId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    syncSessionCache.set(sessionId, {
      catalogId,
      autoInclude:     catalog.autoIncludeProducts ?? false,
      existingMap,
      seenVariantGids: [],
      added:           0,
      updated:         0,
      syncStatuses,
    });

    return json({ success: true, intent: "syncStart", sessionId, total });
  }

  if (intent === "syncPage") {
    const sessionId  = formData.get("sessionId")?.toString() ?? "";
    const cursor     = formData.get("cursor")?.toString() || null;
    const syncSess   = syncSessionCache.get(sessionId);
    if (!syncSess || syncSess.catalogId !== catalogId) {
      return json({ success: false, error: "Sync session expired — please restart." });
    }

    // Build Shopify status filter query string
    const statuses = syncSess.syncStatuses ?? ["ACTIVE", "DRAFT"];
    const wantActive = statuses.includes("ACTIVE");
    const wantDraft  = statuses.includes("DRAFT");
    const statusQuery =
      wantActive && wantDraft ? null
      : wantDraft  ? "status:draft"
      : "status:active";

    // Fetch one page of 250 products from Shopify
    let pageData: any;
    try {
      const res = await admin.graphql(
        `query SyncPage($cursor: String, $query: String) {
          products(first: 250, after: $cursor, query: $query) {
            pageInfo { hasNextPage endCursor }
            nodes {
              id title status
              featuredImage { url }
              variants(first: 100) {
                nodes { id sku price image { url } }
              }
            }
          }
        }`,
        { variables: { cursor, query: statusQuery } }
      );
      pageData = await res.json();
    } catch (e: any) {
      return json({ success: false, error: `Shopify API error: ${e?.message ?? e}` });
    }

    const page = pageData.data?.products;
    if (!page) return json({ success: false, error: "No data returned from Shopify." });

    // Shopify rate-limit headroom — tell client to slow down if budget is low
    const throttle   = pageData.extensions?.cost?.throttleStatus;
    const delayMs    = throttle && throttle.currentlyAvailable < 500 ? 1500 : 0;

    const toCreate: any[] = [];
    const toUpdate: { id: number; name: string; sku: string; img: string | null; priceCents: bigint }[] = [];

    for (const product of page.nodes) {
      const numericProductId = product.id.split("/").pop()!;
      for (const variant of product.variants.nodes) {
        const rawGid   = variant.id;
        const gid      = rawGid.startsWith("gid://") ? rawGid : `gid://shopify/ProductVariant/${rawGid}`;
        const numId    = rawGid.split("/").pop()!;
        const price    = Math.round(parseFloat(variant.price) * 100);
        const img      = variant.image?.url ?? product.featuredImage?.url ?? null;

        syncSess.seenVariantGids.push(gid);

        const ex = syncSess.existingMap[gid];
        if (ex) {
          // Sync only refreshes metadata + base price; never overwrites manual discounts
          toUpdate.push({ id: ex.id, name: product.title, sku: variant.sku ?? "", img, priceCents: BigInt(price) });
        } else if (syncSess.autoInclude) {
          toCreate.push({
            catalogId,
            productId:             numericProductId,
            variantId:             numId,
            name:                  product.title,
            sku:                   variant.sku ?? "",
            img,
            customPriceCents:      BigInt(price),
            customDiscountPercent: null,
          });
        }
      }
    }

    // Batch create (single INSERT … VALUES …)
    if (toCreate.length > 0) {
      await db.catalogItem.createMany({ data: toCreate });
      syncSess.added += toCreate.length;
    }

    // Batch update: parallel chunks of 50
    const CHUNK = 50;
    for (let i = 0; i < toUpdate.length; i += CHUNK) {
      await Promise.all(
        toUpdate.slice(i, i + CHUNK).map(({ id, name, sku, img, priceCents }) =>
          db.catalogItem.update({
            where: { id },
            data:  { name, sku, img, customPriceCents: priceCents },
          })
        )
      );
    }
    syncSess.updated += toUpdate.length;

    // Persist rolling counters back to cache
    syncSessionCache.set(sessionId, syncSess);

    return json({
      success:      true,
      intent:       "syncPage",
      sessionId,
      hasNextPage:  page.pageInfo.hasNextPage,
      nextCursor:   page.pageInfo.endCursor,
      processed:    syncSess.seenVariantGids.length,
      added:        syncSess.added,
      updated:      syncSess.updated,
      delayMs,
    });
  }

  if (intent === "syncFinalize") {
    const sessionId = formData.get("sessionId")?.toString() ?? "";
    const syncSessF = syncSessionCache.get(sessionId);
    if (!syncSessF || syncSessF.catalogId !== catalogId) {
      return json({ success: false, error: "Sync session expired — please restart." });
    }

    // Delete catalog items whose Shopify variant no longer exists
    const seenSet = new Set(syncSessF.seenVariantGids);
    const orphanIds = Object.entries(syncSessF.existingMap)
      .filter(([gid]) => !seenSet.has(gid))
      .map(([, item]) => item.id);

    let removed = 0;
    if (orphanIds.length > 0) {
      await db.catalogItem.deleteMany({ where: { id: { in: orphanIds } } });
      removed = orphanIds.length;
    }

    syncSessionCache.del(sessionId);
    productMetaCache.del(`meta:${shop}:${catalogId}`);
    await invalidateCatalogCache(catalogId);
    refreshCatalogCustomerMetafields(admin, catalogId);

    return json({
      success:  true,
      intent:   "syncFinalize",
      added:    syncSessF.added,
      updated:  syncSessF.updated,
      removed,
      total:    syncSessF.seenVariantGids.length,
    });
  }

  // ── Save settings ─────────────────────────────────────────────────────────
  const prevCatalog = await db.catalog.findUnique({
    where: { id: catalogId },
    select: { status: true, shopDomain: true, segmentId: true },
  });

  const newStatus            = formData.get("status")?.toString()               ?? null;
  const segmentId            = formData.get("segmentId")?.toString()            ?? null;
  const discountTitle        = formData.get("discountTitle")?.toString()        ?? null;
  const minimumOrderMessage  = formData.get("minimumOrderMessage")?.toString()  ?? null;
  const priceDisplay         = formData.get("priceDisplay")?.toString()         ?? null;
  const rawDiscount          = formData.get("globalDiscount")?.toString();
  const applyToAll           = formData.get("applyToAll") === "1";

  // Always read discountType from DB — the Prisma client may not have been regenerated
  // after the new fields were added, causing catalog.discountType to be undefined on the
  // frontend and default to "PERCENT" in the form submission.
  const dbType = await db.$queryRaw<{ discountType: string }[]>`
    SELECT "discountType" FROM "Catalog" WHERE id = ${catalogId}
  `;
  const catalogDiscountType = dbType[0]?.discountType ?? "PERCENT";

  const updateData: any = {};
  if (newStatus            !== null) updateData.status               = newStatus;
  if (segmentId            !== null) updateData.segmentId            = segmentId || null;
  if (discountTitle        !== null) updateData.discountTitle        = discountTitle || null;
  if (minimumOrderMessage  !== null) updateData.minimumOrderMessage  = minimumOrderMessage || null;
  if (priceDisplay         !== null) updateData.priceDisplay         = priceDisplay;

  // For non-PERCENT catalogs, always clear defaultDiscountPercent to fix any stale data
  if (catalogDiscountType !== "PERCENT") updateData.defaultDiscountPercent = null;

  if (rawDiscount != null) {
    const discount = parseFloat(rawDiscount) || 0;

    if (catalogDiscountType === "PERCENT") {
      updateData.defaultDiscountPercent = discount;
      if (applyToAll && discount > 0) {
        // Store computed wholesale cents for items that have a base price.
        // Items with null customPriceCents (never synced) keep null — they fall
        // back to the proxy's defaultPct field which the JS applies via DOM price.
        const factor = (100 - discount) / 100;
        await db.$executeRaw`
          UPDATE "CatalogItem"
          SET "customDiscountPercent" = CASE
            WHEN "customPriceCents" IS NOT NULL AND "customPriceCents" > 0
              THEN ROUND("customPriceCents"::numeric * ${factor}::numeric)
            ELSE NULL
          END
          WHERE "catalogId" = ${catalogId}
        `;
      } else if (applyToAll) {
        await db.catalogItem.updateMany({ where: { catalogId }, data: { customDiscountPercent: null } });
      }
    } else if (catalogDiscountType === "FIXED_AMOUNT") {
      const fixedCents = Math.round(discount * 100);
      // Always persist the catalog-level amount so the proxy can compute prices dynamically
      await db.$executeRaw`UPDATE "Catalog" SET "fixedDiscountCents" = ${fixedCents}, "fixedPriceCents" = NULL WHERE id = ${catalogId}`;
      if (applyToAll) {
        // Single SQL pass: compute base-minus-fixed for every item at once
        await db.$executeRaw`
          UPDATE "CatalogItem"
          SET "customDiscountPercent" = CASE
            WHEN "customPriceCents" IS NOT NULL AND "customPriceCents" > ${fixedCents}
              THEN "customPriceCents" - ${fixedCents}
            ELSE NULL
          END
          WHERE catalogId = ${catalogId}
        `;
      }
    } else if (catalogDiscountType === "FIXED_PRICE") {
      const priceCents = Math.round(discount * 100);
      // Always persist so the proxy can use it as a flat-rate fallback
      await db.$executeRaw`UPDATE "Catalog" SET "fixedPriceCents" = ${priceCents}, "fixedDiscountCents" = NULL WHERE id = ${catalogId}`;
      if (applyToAll && priceCents > 0) {
        await db.catalogItem.updateMany({
          where: { catalogId },
          data: { customDiscountPercent: priceCents },
        });
      }
    }
  }

  // Always bump cacheVersion so the versioned cache key changes, orphaning any
  // in-flight computes that might write back stale data after this save completes.
  updateData.cacheVersion = { increment: 1 };
  await db.catalog.update({ where: { id: catalogId }, data: updateData });

  // If the segment was removed or changed, wipe stale junction-table rows so the
  // customer count reflects reality immediately.
  const newSegmentId = segmentId !== null ? (segmentId || null) : prevCatalog?.segmentId ?? null;
  if (prevCatalog?.segmentId && prevCatalog.segmentId !== newSegmentId) {
    await db.$executeRaw`DELETE FROM customer_catalogs WHERE "catalogId" = ${catalogId}`;
    // Also clear the legacy FK for customers whose only catalog was this one
    await db.$executeRaw`
      UPDATE "Customers" SET "catalogId" = NULL
      WHERE "catalogId" = ${catalogId}
        AND NOT EXISTS (
          SELECT 1 FROM customer_catalogs cc WHERE cc."customerId" = "Customers".id
        )
    `;
    clearCatalogCustomerMetafields(admin, catalogId);
    // Immediately enroll customers that match the new segment tag
    if (newSegmentId) {
      _autoEnrollBySegment(admin, shop, catalogId, newSegmentId).catch((e) =>
        console.error("[B2B] autoEnroll on segment change error:", e)
      );
    }
  }

  // Batch price changes submitted alongside settings save
  const priceChangesJson = formData.get("priceChanges")?.toString();
  if (priceChangesJson) {
    try {
      const changes: Record<string, number | null> = JSON.parse(priceChangesJson);
      const entries = Object.entries(changes);
      if (entries.length > 0) {
        await Promise.all(
          entries.map(([itemIdStr, value]) =>
            db.catalogItem.update({
              where: { id: Number(itemIdStr) },
              data: { customDiscountPercent: value },
            })
          )
        );
      }
    } catch (e) {
      console.error("[B2B] priceChanges error:", e);
    }
  }

  const deactivated =
    newStatus !== null && newStatus !== "active" && prevCatalog?.status === "active";
  const segmentRemoved = !!(prevCatalog?.segmentId && prevCatalog.segmentId !== newSegmentId);
  if (deactivated || segmentRemoved) {
    // metafields already cleared above for segment removal; clear again on deactivation
    if (deactivated) clearCatalogCustomerMetafields(admin, catalogId);
  } else {
    refreshCatalogCustomerMetafields(admin, catalogId);
  }

  // Evict the version cache so the next storefront request picks up the new version
  // from DB and uses a fresh cache key.  The DB version was already bumped above.
  const { catalogVersionCache } = await import("../cache.server");
  catalogVersionCache.del(`cv:${catalogId}`);

  // Bust per-customer caches for the whole shop — segmentId/status/pricing change
  // may alter which catalogs every customer resolves to.
  if (prevCatalog?.shopDomain) {
    customerStateCache.delPrefix(`cs:${prevCatalog.shopDomain}:`);
    catalogIdsCache.delPrefix(`cids:${prevCatalog.shopDomain}:`);
  }

  return json({ success: true, intent: "save" });
};

// ── Shopify status styles ─────────────────────────────────────────────────────
const SHOPIFY_STATUS: Record<string, { bg: string; border: string; color: string; dot: string; label: string }> = {
  ACTIVE:   { bg: "#f0fdf4", border: "#bbf7d0", color: "#15803d", dot: "#22c55e", label: "Active" },
  DRAFT:    { bg: "#fefce8", border: "#fef08a", color: "#854d0e", dot: "#facc15", label: "Draft" },
  ARCHIVED: { bg: "#f8fafc", border: "#e2e8f0", color: "#64748b", dot: "#94a3b8", label: "Archived" },
  UNLISTED: { bg: "#faf5ff", border: "#e9d5ff", color: "#7c3aed", dot: "#a855f7", label: "Unlisted" },
};

// ── Component ─────────────────────────────────────────────────────────────────
export default function CatalogDetailPage() {
  const { catalog, segments, assignedCustomerCount, allCollections } =
    useLoaderData<typeof loader>();

  const navigate    = useNavigate();
  const fetcher     = useFetcher<{ success?: boolean; intent?: string }>();
  const syncFetcher = useFetcher<any>();

  // ── Chunked sync state machine ───────────────────────────────────────────────
  type SyncPhase = "idle" | "starting" | "paging" | "finalizing" | "done" | "error" | "cancelled";
  const [syncPhase,   setSyncPhase]   = useState<SyncPhase>("idle");
  const [syncCurrent, setSyncCurrent] = useState(0);
  const [syncTotal,   setSyncTotal]   = useState(0);
  const [syncAdded,   setSyncAdded]   = useState(0);
  const [syncUpdated, setSyncUpdated] = useState(0);
  const [syncRemoved, setSyncRemoved] = useState(0);
  const [syncError,   setSyncError]   = useState<string | null>(null);
  const syncCancelRef    = React.useRef(false);
  const syncSessionIdRef = React.useRef<string | null>(null);

  // Per-item inline price editing
  const [editingId, setEditingId]   = useState<string | null>(null);
  const [editValue, setEditValue]   = useState("");
  // Display overrides (optimistic): itemId → priceCents (null = show default)
  const [localPrices, setLocalPrices] = useState<Record<string, number | null>>({});
  // Staged changes not yet sent to server: itemId → priceCents (null = reset to default)
  const [dirtyPrices, setDirtyPrices] = useState<Record<string, number | null>>({});

  // Settings state
  const [catalogStatus, setCatalogStatus]             = useState(catalog.status);
  const [segmentId, setSegmentId]                     = useState(catalog.segmentId);
  const [discountTitle, setDiscountTitle]             = useState(catalog.discountTitle);
  const [minimumOrderMessage, setMinimumOrderMessage] = useState(catalog.minimumOrderMessage ?? "");
  const [checked, setChecked]                         = useState(catalog.autoIncludeProducts ?? false);
  const [globalDiscount, setGlobalDiscount]           = useState(() => {
    if (catalog.discountType === "FIXED_AMOUNT") return catalog.fixedDiscountCents ? catalog.fixedDiscountCents / 100 : 0;
    if (catalog.discountType === "FIXED_PRICE")  return catalog.fixedPriceCents    ? catalog.fixedPriceCents    / 100 : 0;
    return catalog.defaultDiscountPercent ?? 0;
  });
  const [priceDisplay, setPriceDisplay]               = useState(catalog.priceDisplay ?? "REPLACED");
  const [unsaved, setUnsaved]                         = useState(false);

  // Filter + pagination state
  const [search, setSearch]                 = useState("");
  const [filterCollection, setFilterCollection] = useState("");
  const [filterStatus, setFilterStatus]     = useState<"" | "ACTIVE" | "DRAFT">("");
  const [page, setPage]                     = useState(0);

  // Sync status filter (which Shopify product statuses to pull in during sync)
  const [syncStatuses, setSyncStatuses] = useState<{ ACTIVE: boolean; DRAFT: boolean }>({ ACTIVE: true, DRAFT: true });

  const mark = () => setUnsaved(true);

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return catalog.items.filter((item) => {
      const matchSearch =
        !q ||
        item.name.toLowerCase().includes(q) ||
        item.sku.toLowerCase().includes(q);
      const matchCol =
        !filterCollection || item.collections.includes(filterCollection);
      const matchStatus =
        !filterStatus || item.shopifyStatus === filterStatus;
      return matchSearch && matchCol && matchStatus;
    });
  }, [catalog.items, search, filterCollection, filterStatus]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const pageItems  = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const onSearch     = (v: string) => { setSearch(v); setPage(0); };
  const onCollection = (v: string) => { setFilterCollection(v); setPage(0); };
  const onStatus     = (v: string) => { setFilterStatus(v as "" | "ACTIVE" | "DRAFT"); setPage(0); };

  // Per-item price helpers
  const openEdit = (id: string, currentCents: number) => {
    setEditingId(id);
    setEditValue((currentCents / 100).toFixed(2));
  };

  const confirmEdit = (id: string) => {
    const priceCents = Math.round(parseFloat(editValue || "0") * 100);
    setLocalPrices((p) => ({ ...p, [id]: priceCents > 0 ? priceCents : null }));
    setDirtyPrices((p) => ({ ...p, [id]: priceCents > 0 ? priceCents : null }));
    mark();
    setEditingId(null);
    setEditValue("");
  };

  const resetItemPrice = (id: string, basePrice: number) => {
    let calculatedCents = 0;
    if (catalog.discountType === "FIXED_PRICE" && globalDiscount > 0) {
      calculatedCents = Math.round(globalDiscount * 100);
    } else if (catalog.discountType === "FIXED_AMOUNT" && globalDiscount > 0 && basePrice > 0) {
      calculatedCents = Math.max(0, Math.round(basePrice * 100 - globalDiscount * 100));
    } else if (catalog.discountType === "PERCENT" && globalDiscount > 0 && basePrice > 0) {
      calculatedCents = Math.round(basePrice * 100 * (1 - globalDiscount / 100));
    }
    setLocalPrices((p) => ({ ...p, [id]: calculatedCents > 0 ? calculatedCents : null }));
    setDirtyPrices((p) => ({ ...p, [id]: null }));
    mark();
  };

  const cancel = () => {
    setCatalogStatus(catalog.status);
    setSegmentId(catalog.segmentId);
    setDiscountTitle(catalog.discountTitle);
    setMinimumOrderMessage(catalog.minimumOrderMessage ?? "");
    setGlobalDiscount(
      catalog.discountType === "FIXED_AMOUNT" ? (catalog.fixedDiscountCents ? catalog.fixedDiscountCents / 100 : 0)
      : catalog.discountType === "FIXED_PRICE"  ? (catalog.fixedPriceCents    ? catalog.fixedPriceCents    / 100 : 0)
      : catalog.defaultDiscountPercent ?? 0
    );
    setPriceDisplay(catalog.priceDisplay ?? "REPLACED");
    setDirtyPrices({});
    setLocalPrices({});
    setUnsaved(false);
  };

  const submitSettings = (extra: Record<string, string> = {}) => {
    const fd = new FormData();
    fd.append("globalDiscount", globalDiscount.toString());
    fd.append("catalogDiscountType", catalog.discountType);
    fd.append("status", catalogStatus);
    fd.append("segmentId", segmentId);
    fd.append("discountTitle", discountTitle);
    fd.append("minimumOrderMessage", minimumOrderMessage);
    fd.append("priceDisplay", priceDisplay);
    if (Object.keys(dirtyPrices).length > 0) {
      fd.append("priceChanges", JSON.stringify(dirtyPrices));
    }
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    fetcher.submit(fd, { method: "post", action: window.location.pathname });
  };

  // ── Sync state machine driven by useFetcher (handles Shopify auth automatically) ──
  // useFetcher.submit injects the App Bridge session token that raw fetch cannot.
  const _syncSubmit = (fd: FormData) => {
    syncFetcher.submit(fd, { method: "post", action: window.location.pathname });
  };

  React.useEffect(() => {
    const data = syncFetcher.data;
    if (!data) return;

    if (!data.success) {
      setSyncError(data.error ?? "Sync failed");
      setSyncPhase("error");
      return;
    }

    if (data.intent === "syncStart") {
      syncSessionIdRef.current = data.sessionId;
      setSyncTotal(data.total ?? 0);
      setSyncPhase("paging");
      // Submit first page immediately
      const fd = new FormData();
      fd.append("_action", "syncPage");
      fd.append("sessionId", data.sessionId);
      _syncSubmit(fd);
    }

    if (data.intent === "syncPage") {
      setSyncCurrent(data.processed ?? 0);
      setSyncAdded(data.added ?? 0);
      setSyncUpdated(data.updated ?? 0);

      if (data.hasNextPage) {
        const nextCursor  = data.nextCursor;
        const delayMs     = data.delayMs ?? 0;
        const sessionId   = syncSessionIdRef.current!;
        const doNext = () => {
          if (syncCancelRef.current) { setSyncPhase("cancelled"); return; }
          const fd = new FormData();
          fd.append("_action", "syncPage");
          fd.append("sessionId", sessionId);
          if (nextCursor) fd.append("cursor", nextCursor);
          _syncSubmit(fd);
        };
        if (delayMs > 0) setTimeout(doNext, delayMs); else doNext();
      } else {
        // All pages done — finalize
        setSyncPhase("finalizing");
        const fd = new FormData();
        fd.append("_action", "syncFinalize");
        fd.append("sessionId", syncSessionIdRef.current!);
        _syncSubmit(fd);
      }
    }

    if (data.intent === "syncFinalize") {
      setSyncAdded(data.added ?? 0);
      setSyncUpdated(data.updated ?? 0);
      setSyncRemoved(data.removed ?? 0);
      setSyncCurrent(data.total ?? 0);
      setSyncPhase("done");
      if ((data.added ?? 0) > 0 || (data.removed ?? 0) > 0) {
        setTimeout(() => navigate(window.location.pathname, { replace: true }), 1800);
      }
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncFetcher.data]);

  const triggerSync = () => {
    if (isSyncing) {
      syncCancelRef.current = true;
      return;
    }
    syncCancelRef.current = false;
    syncSessionIdRef.current = null;
    setSyncPhase("starting");
    setSyncCurrent(0); setSyncTotal(0);
    setSyncAdded(0);   setSyncUpdated(0); setSyncRemoved(0);
    setSyncError(null);
    const fd = new FormData();
    fd.append("_action", "syncStart");
    const statusList = Object.entries(syncStatuses).filter(([, v]) => v).map(([k]) => k).join(",");
    fd.append("syncStatuses", statusList || "ACTIVE");
    _syncSubmit(fd);
  };

  const openProductPicker = async () => {
    try {
      const shopify = (window as any).shopify;
      if (!shopify?.resourcePicker) return;
      const selected: any[] = await shopify.resourcePicker({ type: "product", multiple: true });
      if (!selected?.length) return;

      const items = selected.flatMap((product: any) =>
        (product.variants ?? []).map((variant: any) => ({
          productId: product.id.includes("/") ? product.id.split("/").pop() : product.id,
          variantId: `gid://shopify/ProductVariant/${variant.id.includes("/") ? variant.id.split("/").pop() : variant.id}`,
          name: product.title ?? "Unnamed",
          sku: variant.sku ?? "",
          img: variant.image?.originalSrc ?? product.images?.[0]?.originalSrc ?? "",
          priceCents: variant.price ? Math.round(parseFloat(variant.price) * 100) : null,
        }))
      );

      const fd = new FormData();
      fd.append("_action", "addItems");
      fd.append("items", JSON.stringify(items));
      fetcher.submit(fd, { method: "post", action: window.location.pathname });
    } catch (e) {
      console.warn("[B2B] resourcePicker error:", e);
    }
  };

  React.useEffect(() => {
    if (fetcher.data?.success && fetcher.data.intent === "save") {
      setUnsaved(false);
      setDirtyPrices({});
    }
  }, [fetcher.data]);

  const isSyncing = syncPhase === "starting" || syncPhase === "paging" || syncPhase === "finalizing";

  const fmtEuro = (n: number) =>
    new Intl.NumberFormat("de-DE", { style: "currency", currency: "EUR" }).format(n);

  const accentColor =
    catalogStatus === "active" ? "#16a34a" : catalogStatus === "draft" ? "#d97706" : "#6b7280";

  const statusOptions = [
    { label: "Active",   value: "active" },
    { label: "Draft",    value: "draft" },
    { label: "Inactive", value: "inactive" },
  ];
  const segmentOptions = [
    { label: "— No segment —", value: "" },
    ...segments.map((s: any) => ({ label: s.title, value: s.id })),
  ];
  const collectionOptions = [
    { label: "All collections", value: "" },
    ...allCollections.map((c) => ({ label: c, value: c })),
  ];

  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const toggleSelect = (id: string) =>
    setSelectedItems((prev) => { const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s; });

  const toggleSelectAll = () =>
    setSelectedItems((prev) =>
      prev.size === pageItems.length ? new Set() : new Set(pageItems.map((i) => i.id))
    );

  const removeSelected = () => {
    if (selectedItems.size === 0) return;
    const fd = new FormData();
    fd.append("_action", "removeItems");
    fd.append("itemIds", Array.from(selectedItems).join(","));
    fetcher.submit(fd, { method: "post", action: window.location.pathname });
    setSelectedItems(new Set());
  };

  // Grid: checkbox | img | title+sku | status | original | wholesale | %
  const COL = "32px 64px minmax(0,1fr) 88px 104px 175px 60px";

  const btnBase: React.CSSProperties = {
    border: "none", cursor: "pointer", fontFamily: "inherit",
    transition: "background 0.15s, transform 0.1s",
  };

  return (
    <>
      {/* ── Unsaved toast bar ── */}
      {unsaved && (
        <div style={{
          position: "fixed", top: 0, left: 0, right: 0, zIndex: 1000,
          background: "rgba(15,23,42,0.97)",
          backdropFilter: "blur(12px)",
          color: "#f8fafc", padding: "0 28px",
          display: "flex", alignItems: "center", justifyContent: "space-between",
          height: 52, boxShadow: "0 4px 24px rgba(0,0,0,0.25)",
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#facc15", flexShrink: 0 }} />
            <span style={{ fontSize: 13.5, fontWeight: 500, letterSpacing: "-0.01em" }}>
              You have unsaved changes
            </span>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={cancel} style={{
              ...btnBase, background: "rgba(255,255,255,0.08)",
              border: "1px solid rgba(255,255,255,0.12)", color: "#cbd5e1",
              padding: "6px 16px", borderRadius: 8, fontSize: 13,
            }}>Discard</button>
            <button onClick={() => submitSettings()} style={{
              ...btnBase, background: "#fff", color: "#0f172a",
              padding: "6px 18px", borderRadius: 8, fontSize: 13, fontWeight: 650,
            }}>
              {fetcher.state === "submitting" ? "Saving…" : "Save changes"}
            </button>
          </div>
        </div>
      )}

      <Page backAction={{ content: "Catalogs", url: "/app/catalogs" }} title="">
        <BlockStack gap="600">

          {/* ── Hero banner ── */}
          <div style={{
            position: "relative", overflow: "hidden",
            borderRadius: 16,
            background: "linear-gradient(135deg, #0f172a 0%, #1e293b 60%, #0f172a 100%)",
            padding: "32px 36px",
            boxShadow: "0 20px 60px rgba(15,23,42,0.18)",
          }}>
            {/* Decorative glow */}
            <div style={{
              position: "absolute", top: -60, right: -60,
              width: 260, height: 260, borderRadius: "50%",
              background: `radial-gradient(circle, ${accentColor}30 0%, transparent 70%)`,
              pointerEvents: "none",
            }} />
            <div style={{
              position: "absolute", bottom: -80, left: 80,
              width: 200, height: 200, borderRadius: "50%",
              background: "radial-gradient(circle, #6366f130 0%, transparent 70%)",
              pointerEvents: "none",
            }} />

            <div style={{ position: "relative", zIndex: 1 }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
                <div>
                  <div style={{
                    display: "inline-flex", alignItems: "center", gap: 7,
                    background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.1)",
                    borderRadius: 20, padding: "3px 12px", marginBottom: 12,
                  }}>
                    <div style={{ width: 6, height: 6, borderRadius: "50%", background: accentColor }} />
                    <span style={{ fontSize: 11.5, color: "#94a3b8", fontWeight: 600, letterSpacing: "0.04em", textTransform: "uppercase" }}>
                      Wholesale catalog
                    </span>
                  </div>
                  <h1 style={{
                    margin: 0, fontSize: 30, fontWeight: 750, color: "#f8fafc",
                    letterSpacing: "-0.03em", lineHeight: 1.15,
                  }}>
                    {catalog.title}
                  </h1>
                </div>

                <div style={{
                  display: "flex", alignItems: "center", gap: 8,
                  background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: 10, padding: "8px 14px",
                }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: accentColor, boxShadow: `0 0 6px ${accentColor}` }} />
                  <span style={{ fontSize: 13, fontWeight: 600, color: "#e2e8f0" }}>
                    {catalogStatus.charAt(0).toUpperCase() + catalogStatus.slice(1)}
                  </span>
                </div>
              </div>

              {/* Stats row */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginTop: 28 }}>
                {[
                  { label: "Products",  value: catalog.productCount, icon: "▦" },
                  { label: "Variants",  value: catalog.variantCount,  icon: "◈" },
                  { label: "Customers", value: assignedCustomerCount, icon: "◉" },
                  { label: "Discount",
                    value: catalog.discountType === "FIXED_AMOUNT" && catalog.fixedDiscountCents
                      ? `−€${(catalog.fixedDiscountCents / 100).toFixed(2)}`
                      : catalog.discountType === "FIXED_PRICE" && catalog.fixedPriceCents
                      ? `€${(catalog.fixedPriceCents / 100).toFixed(2)}`
                      : globalDiscount ? `-${globalDiscount}%` : "—",
                    icon: "◎" },
                ].map((s) => (
                  <div key={s.label} style={{
                    background: "rgba(255,255,255,0.055)",
                    border: "1px solid rgba(255,255,255,0.09)",
                    borderRadius: 12, padding: "14px 16px",
                  }}>
                    <div style={{ fontSize: 10, color: "#64748b", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 6 }}>
                      {s.icon} {s.label}
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 750, color: "#f1f5f9", letterSpacing: "-0.02em" }}>
                      {s.value}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* ── Toasts ── */}
          {fetcher.data?.success && fetcher.data.intent === "addItems" && (
            <div style={{
              background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10,
              padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: "#15803d",
            }}>
              <span style={{ fontSize: 16 }}>✓</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>Products added to catalog.</span>
            </div>
          )}
          {fetcher.data?.success && fetcher.data.intent === "removeItems" && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10,
              padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: "#991b1b",
            }}>
              <span style={{ fontSize: 16 }}>✓</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>{(fetcher.data as any).count} product(s) removed from catalog.</span>
            </div>
          )}
          {fetcher.data?.success && fetcher.data.intent === "save" && (
            <div style={{
              background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10,
              padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: "#15803d",
            }}>
              <span style={{ fontSize: 16 }}>✓</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>Catalog saved. Customer pricing updated instantly.</span>
            </div>
          )}
          {/* ── Background import notice (just created with auto-include) ── */}
          {!isSyncing && catalog.autoIncludeProducts && catalog.items.length === 0 && (
            <div style={{
              background: "#fefce8", border: "1px solid #fde047", borderRadius: 10,
              padding: "12px 16px", color: "#854d0e", fontSize: 13,
            }}>
              <strong>Products are being imported in the background.</strong>
              {" "}This catalog was created with auto-include — your Shopify products are loading now.
              Refresh the page in a moment to see them, or click <strong>Sync</strong> below to run a fresh import.
            </div>
          )}
          {/* ── Sync progress banner ───────────────────────────────────── */}
          {isSyncing && (
            <div style={{
              background: "#eff6ff", border: "1px solid #a5b4fc", borderRadius: 10,
              padding: "14px 18px", color: "#3730a3",
            }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                <span style={{ fontWeight: 600, fontSize: 13.5 }}>
                  {syncPhase === "starting"   ? "Starting sync…"   :
                   syncPhase === "finalizing" ? "Finalizing…"      :
                   `Syncing products… ${syncCurrent.toLocaleString()} / ${syncTotal > 0 ? syncTotal.toLocaleString() : "…"}`}
                </span>
                <button
                  onClick={() => { syncCancelRef.current = true; }}
                  style={{
                    background: "none", border: "1px solid #a5b4fc", borderRadius: 6,
                    color: "#4f46e5", fontSize: 12, fontWeight: 600, padding: "3px 10px", cursor: "pointer",
                  }}
                >
                  Cancel
                </button>
              </div>
              {syncTotal > 0 && (
                <div style={{ background: "#c7d2fe", borderRadius: 4, height: 6, overflow: "hidden" }}>
                  <div style={{
                    background: "#4f46e5", height: "100%", borderRadius: 4,
                    width: `${Math.min(100, Math.round((syncCurrent / syncTotal) * 100))}%`,
                    transition: "width 0.3s ease",
                  }} />
                </div>
              )}
              <div style={{ fontSize: 12, marginTop: 6, opacity: 0.8 }}>
                Added {syncAdded} · Updated {syncUpdated}
              </div>
            </div>
          )}

          {syncPhase === "done" && (
            <div style={{
              background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 10,
              padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: "#15803d",
            }}>
              <span style={{ fontSize: 16 }}>✓</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>
                Sync complete — {syncAdded} added, {syncUpdated} updated, {syncRemoved} removed
                {(syncAdded > 0 || syncRemoved > 0) ? ". Reloading…" : "."}
              </span>
            </div>
          )}

          {syncPhase === "error" && syncError && (
            <div style={{
              background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 10,
              padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: "#b91c1c",
            }}>
              <span style={{ fontSize: 16 }}>✗</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>Sync failed: {syncError}</span>
            </div>
          )}

          {syncPhase === "cancelled" && (
            <div style={{
              background: "#fffbeb", border: "1px solid #fcd34d", borderRadius: 10,
              padding: "12px 18px", display: "flex", alignItems: "center", gap: 10, color: "#92400e",
            }}>
              <span style={{ fontSize: 16 }}>⚠</span>
              <span style={{ fontSize: 13.5, fontWeight: 500 }}>Sync cancelled.</span>
            </div>
          )}

          <InlineGrid columns={{ xs: 1, md: "3fr 1fr" }} gap="600">

            {/* ── Left column ── */}
            <BlockStack gap="500">

              {/* Audience card */}
              <div style={{
                background: "#fff", borderRadius: 14,
                border: "1px solid #e5e7eb",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                overflow: "hidden",
              }}>
                <div style={{ padding: "18px 22px 0" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 8, background: "#ede9fe", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>◎</div>
                    <span style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>Audience</span>
                  </div>
                  <p style={{ margin: "6px 0 16px", fontSize: 13, color: "#64748b", lineHeight: 1.55 }}>
                    Assign a segment — every approved customer in it gets these wholesale prices automatically.
                  </p>
                  <div style={{ borderTop: "1px solid #f1f5f9", paddingTop: 16, paddingBottom: 18 }}>
                    <Select
                      label="Customer segment"
                      options={segmentOptions}
                      value={segmentId}
                      onChange={(v) => { setSegmentId(v); mark(); }}
                      helpText="Manage segments under the Segments menu."
                    />
                  </div>
                </div>
              </div>

              {/* Products table */}
              <div style={{
                background: "#fff", borderRadius: 14,
                border: "1px solid #e5e7eb",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                overflow: "hidden",
              }}>
                {/* Toolbar row 1 */}
                <div style={{
                  padding: "16px 22px",
                  background: "#fafafa",
                  borderBottom: "1px solid #f1f5f9",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  gap: 12, flexWrap: "wrap",
                }}>
                  <div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: "#0f172a" }}>
                      Products &amp; Pricing
                    </div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                      {filtered.length === catalog.items.length
                        ? `${catalog.items.length} variants`
                        : `${filtered.length} of ${catalog.items.length} variants`}
                      {totalPages > 1 && ` · p.${page + 1}/${totalPages}`}
                    </div>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <button
                      onClick={openProductPicker}
                      disabled={fetcher.state === "submitting"}
                      style={{
                        ...btnBase,
                        padding: "7px 15px", borderRadius: 8,
                        border: "1px solid #86efac",
                        background: "#f0fdf4",
                        color: "#15803d", fontSize: 13, fontWeight: 600,
                        display: "flex", alignItems: "center", gap: 6,
                      }}
                    >
                      <span>+</span> Add products
                    </button>

                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <button
                        onClick={isSyncing ? () => { syncCancelRef.current = true; } : triggerSync}
                        disabled={syncPhase === "finalizing"}
                        title={isSyncing ? "Cancel sync" : "Sync products from Shopify"}
                        style={{
                          ...btnBase,
                          padding: "7px 15px", borderRadius: 8,
                          border: `1px solid ${isSyncing ? "#fca5a5" : "#c7d2fe"}`,
                          background: isSyncing ? "#fef2f2" : "#fff",
                          color: isSyncing ? "#b91c1c" : "#4f46e5",
                          fontSize: 13, fontWeight: 600,
                          display: "flex", alignItems: "center", gap: 6,
                          opacity: syncPhase === "finalizing" ? 0.5 : 1,
                        }}
                      >
                        <span style={{ display: "inline-block", animation: isSyncing ? "spin 0.8s linear infinite" : "none" }}>⟳</span>
                        {isSyncing
                          ? (syncPhase === "finalizing" ? "Finalizing…" : `${syncCurrent.toLocaleString()}/${syncTotal > 0 ? syncTotal.toLocaleString() : "…"} ✕`)
                          : "Sync"}
                      </button>
                      {/* Sync status filter — which Shopify statuses to include */}
                      {!isSyncing && (
                        <div style={{ display: "flex", gap: 4 }}>
                          {(["ACTIVE", "DRAFT"] as const).map((s) => (
                            <button
                              key={s}
                              onClick={() => setSyncStatuses((prev) => ({ ...prev, [s]: !prev[s] }))}
                              title={`${syncStatuses[s] ? "Exclude" : "Include"} ${s.toLowerCase()} products in sync`}
                              style={{
                                ...btnBase,
                                padding: "4px 9px", borderRadius: 6, fontSize: 11, fontWeight: 700,
                                border: `1px solid ${syncStatuses[s] ? (s === "ACTIVE" ? "#86efac" : "#fef08a") : "#e2e8f0"}`,
                                background: syncStatuses[s] ? (s === "ACTIVE" ? "#f0fdf4" : "#fefce8") : "#f8fafc",
                                color: syncStatuses[s] ? (s === "ACTIVE" ? "#15803d" : "#854d0e") : "#94a3b8",
                              }}
                            >{s === "ACTIVE" ? "Active" : "Draft"}</button>
                          ))}
                        </div>
                      )}
                    </div>

                    {catalog.discountType === "PERCENT" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6,
                        background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "4px 4px 4px 12px" }}>
                        <input
                          type="number" min={0} max={100}
                          value={globalDiscount || ""}
                          onChange={(e) => { setGlobalDiscount(parseFloat(e.target.value) || 0); mark(); }}
                          placeholder="0"
                          style={{ width: 48, border: "none", outline: "none", fontSize: 14, fontWeight: 600, color: "#0f172a", background: "transparent", fontFamily: "inherit" }}
                        />
                        <span style={{ fontSize: 13, color: "#94a3b8", marginRight: 4 }}>%</span>
                        <button
                          onClick={() => submitSettings({ applyToAll: "1" })}
                          disabled={!globalDiscount || fetcher.state === "submitting"}
                          style={{ ...btnBase, background: globalDiscount ? "#0f172a" : "#f1f5f9", color: globalDiscount ? "#fff" : "#94a3b8", padding: "6px 14px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}
                        >
                          {fetcher.state === "submitting" ? "Applying…" : "Apply to all"}
                        </button>
                      </div>
                    )}

                    {catalog.discountType === "FIXED_AMOUNT" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6,
                        background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "4px 4px 4px 10px" }}>
                        <span style={{ fontSize: 13, color: "#64748b", fontWeight: 600 }}>€</span>
                        <input
                          type="number" min={0} step={0.01}
                          value={globalDiscount || ""}
                          onChange={(e) => { setGlobalDiscount(parseFloat(e.target.value) || 0); }}
                          placeholder="0.00"
                          style={{ width: 60, border: "none", outline: "none", fontSize: 14, fontWeight: 600, color: "#0f172a", background: "transparent", fontFamily: "inherit" }}
                        />
                        <span style={{ fontSize: 11, color: "#94a3b8", marginRight: 4 }}>off each</span>
                        <button
                          onClick={() => submitSettings({ applyToAll: "1" })}
                          disabled={!globalDiscount || fetcher.state === "submitting"}
                          style={{ ...btnBase, background: globalDiscount ? "#0f172a" : "#f1f5f9", color: globalDiscount ? "#fff" : "#94a3b8", padding: "6px 14px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}
                        >
                          {fetcher.state === "submitting" ? "Applying…" : "Apply to all"}
                        </button>
                      </div>
                    )}

                    {catalog.discountType === "FIXED_PRICE" && (
                      <div style={{ display: "flex", alignItems: "center", gap: 6,
                        background: "#fff", border: "1px solid #e2e8f0", borderRadius: 8, padding: "4px 4px 4px 10px" }}>
                        <span style={{ fontSize: 13, color: "#64748b", fontWeight: 600 }}>€</span>
                        <input
                          type="number" min={0} step={0.01}
                          value={globalDiscount || ""}
                          onChange={(e) => { setGlobalDiscount(parseFloat(e.target.value) || 0); }}
                          placeholder="0.00"
                          style={{ width: 72, border: "none", outline: "none", fontSize: 14, fontWeight: 600, color: "#0f172a", background: "transparent", fontFamily: "inherit" }}
                        />
                        <button
                          onClick={() => submitSettings({ applyToAll: "1" })}
                          disabled={!globalDiscount || fetcher.state === "submitting"}
                          style={{ ...btnBase, background: globalDiscount ? "#0f172a" : "#f1f5f9", color: globalDiscount ? "#fff" : "#94a3b8", padding: "6px 14px", borderRadius: 6, fontSize: 12.5, fontWeight: 600, whiteSpace: "nowrap" }}
                        >
                          {fetcher.state === "submitting" ? "Applying…" : "Set price for all"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Toolbar row 2: search + filter */}
                <div style={{
                  padding: "10px 22px", borderBottom: "1px solid #f1f5f9",
                  display: "flex", gap: 10, flexWrap: "wrap", background: "#fafafa",
                }}>
                  <div style={{ flex: "1 1 180px", position: "relative" }}>
                    <div style={{
                      position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)",
                      fontSize: 14, color: "#94a3b8", pointerEvents: "none",
                    }}>⌕</div>
                    <input
                      type="text"
                      placeholder="Search title or SKU…"
                      value={search}
                      onChange={(e) => onSearch(e.target.value)}
                      style={{
                        width: "100%", boxSizing: "border-box",
                        padding: "8px 12px 8px 32px",
                        border: "1px solid #e2e8f0", borderRadius: 8,
                        fontSize: 13, color: "#0f172a", background: "#fff",
                        outline: "none", fontFamily: "inherit",
                      }}
                    />
                  </div>
                  {allCollections.length > 0 && (
                    <div style={{ flex: "0 0 180px" }}>
                      <Select
                        label="" labelHidden
                        options={collectionOptions}
                        value={filterCollection}
                        onChange={onCollection}
                      />
                    </div>
                  )}
                  <div style={{ flex: "0 0 160px" }}>
                    <Select
                      label="" labelHidden
                      options={[
                        { label: "All statuses", value: "" },
                        { label: "Active only",  value: "ACTIVE" },
                        { label: "Draft only",   value: "DRAFT" },
                      ]}
                      value={filterStatus}
                      onChange={onStatus}
                    />
                  </div>
                  {(search || filterCollection || filterStatus) && (
                    <button
                      onClick={() => { onSearch(""); onCollection(""); onStatus(""); }}
                      style={{ ...btnBase, background: "none", color: "#94a3b8", fontSize: 13, padding: "0 4px" }}
                    >✕ Clear</button>
                  )}
                </div>

                {/* Remove selected bar */}
                {selectedItems.size > 0 && (
                  <div style={{
                    display: "flex", alignItems: "center", gap: 12,
                    padding: "10px 22px",
                    background: "#fef2f2", borderBottom: "1px solid #fecaca",
                  }}>
                    <span style={{ fontSize: 13, color: "#991b1b", fontWeight: 600 }}>
                      {selectedItems.size} selected
                    </span>
                    <button
                      onClick={removeSelected}
                      style={{
                        background: "#ef4444", color: "#fff", border: "none",
                        borderRadius: 6, padding: "5px 14px", fontSize: 12.5,
                        fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
                      }}
                    >
                      Remove from catalog
                    </button>
                    <button
                      onClick={() => setSelectedItems(new Set())}
                      style={{
                        background: "transparent", color: "#6b7280", border: "none",
                        fontSize: 12, cursor: "pointer", fontFamily: "inherit",
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {/* Column headers */}
                <div style={{
                  display: "grid", gridTemplateColumns: COL, columnGap: 14,
                  padding: "0 22px", borderBottom: "1px solid #f1f5f9",
                }}>
                  <div style={{ display: "flex", alignItems: "center", padding: "10px 0" }}>
                    <input
                      type="checkbox"
                      checked={pageItems.length > 0 && selectedItems.size === pageItems.length}
                      onChange={toggleSelectAll}
                      style={{ cursor: "pointer", accentColor: "#6366f1", width: 15, height: 15 }}
                    />
                  </div>
                  {["", "Product / SKU", "Status", "Original", "Wholesale", "%"].map((h, i) => (
                    <div key={i} style={{
                      fontSize: 10.5, fontWeight: 700, color: "#94a3b8",
                      textTransform: "uppercase", letterSpacing: "0.07em",
                      padding: "10px 0",
                      textAlign: i === 5 ? "center" : "left",
                    }}>
                      {h}
                    </div>
                  ))}
                </div>

                {/* Product rows */}
                {pageItems.map((item, idx) => {
                  const st = SHOPIFY_STATUS[item.shopifyStatus] ?? SHOPIFY_STATUS.ACTIVE;
                  const isEditing = editingId === item.id;

                  // Effective wholesale: prefer local override, then stored, then global %
                  const localOverride = item.id in localPrices ? localPrices[item.id] : undefined;
                  const effectiveCents =
                    localOverride !== undefined
                      ? (localOverride ?? 0)
                      : item.wholesaleCents > 0
                      ? item.wholesaleCents
                      : globalDiscount > 0 && item.basePrice > 0
                      ? Math.round(item.basePrice * 100 * (1 - globalDiscount / 100))
                      : 0;

                  const wholesaleEuros = effectiveCents / 100;
                  // FIXED = stored price exists AND differs from the catalog default %.
                  // After reset, stored == calculated so FIXED disappears.
                  const defaultCents =
                    globalDiscount > 0 && item.basePrice > 0
                      ? Math.round(item.basePrice * 100 * (1 - globalDiscount / 100))
                      : 0;
                  const hasCustomPrice =
                    localOverride !== undefined
                      ? localOverride !== null && localOverride > 0 && localOverride !== defaultCents
                      : item.wholesaleCents > 0 && item.wholesaleCents !== defaultCents;

                  const savingPct =
                    item.basePrice > 0 && wholesaleEuros > 0
                      ? Math.round((1 - wholesaleEuros / item.basePrice) * 100)
                      : 0;

                  const stepBtn: React.CSSProperties = {
                    width: 26, height: 26, borderRadius: 6, border: "1px solid #e2e8f0",
                    background: "#f8fafc", cursor: "pointer", fontSize: 14, fontWeight: 700,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    color: "#374151", flexShrink: 0, fontFamily: "inherit",
                  };

                  return (
                    <div
                      key={item.id}
                      style={{
                        display: "grid", gridTemplateColumns: COL, columnGap: 14,
                        padding: "13px 22px", alignItems: "center",
                        borderBottom: idx < pageItems.length - 1 ? "1px solid #f8fafc" : "none",
                        transition: "background 0.12s",
                      }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f8fafc")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                    >
                      {/* Checkbox */}
                      <div style={{ display: "flex", alignItems: "center" }}>
                        <input
                          type="checkbox"
                          checked={selectedItems.has(item.id)}
                          onChange={() => toggleSelect(item.id)}
                          style={{ cursor: "pointer", accentColor: "#6366f1", width: 15, height: 15 }}
                        />
                      </div>

                      {/* Image */}
                      <div style={{
                        width: 60, height: 60, borderRadius: 10, flexShrink: 0,
                        border: "1px solid #e5e7eb", overflow: "hidden",
                        background: "#f8fafc",
                        boxShadow: "0 1px 4px rgba(0,0,0,0.06)",
                        display: "flex", alignItems: "center", justifyContent: "center",
                      }}>
                        {item.img ? (
                          <img src={item.img} alt={item.name} style={{
                            width: "100%", height: "100%",
                            objectFit: "cover", display: "block",
                          }} />
                        ) : (
                          <span style={{ color: "#cbd5e1", fontSize: 22 }}>▦</span>
                        )}
                      </div>

                      {/* Title + SKU */}
                      <div style={{ minWidth: 0 }}>
                        <div
                          title={item.name}
                          style={{
                            fontWeight: 600, fontSize: 13.5, color: "#0f172a",
                            lineHeight: 1.4,
                            display: "-webkit-box",
                            WebkitLineClamp: 3,
                            WebkitBoxOrient: "vertical" as const,
                            overflow: "hidden",
                            wordBreak: "break-word",
                            cursor: "default",
                          }}
                        >
                          {item.name}
                        </div>
                        {item.sku && (
                          <div style={{
                            marginTop: 3, fontSize: 11, color: "#94a3b8", fontWeight: 500,
                            fontFamily: "monospace", letterSpacing: "0.02em",
                          }}>
                            {item.sku}
                          </div>
                        )}
                      </div>

                      {/* Shopify status badge */}
                      <div>
                        <span style={{
                          display: "inline-flex", alignItems: "center", gap: 5,
                          background: st.bg, border: `1px solid ${st.border}`,
                          color: st.color, borderRadius: 20, padding: "4px 10px",
                          fontSize: 11.5, fontWeight: 600, whiteSpace: "nowrap",
                        }}>
                          <span style={{
                            width: 6, height: 6, borderRadius: "50%",
                            background: st.dot, flexShrink: 0,
                            boxShadow: `0 0 4px ${st.dot}80`,
                          }} />
                          {st.label}
                        </span>
                      </div>

                      {/* Original price */}
                      <div style={{ fontSize: 13.5, color: "#64748b", fontWeight: 500 }}>
                        {item.basePrice > 0
                          ? <span style={{ textDecoration: wholesaleEuros > 0 ? "line-through" : "none", opacity: wholesaleEuros > 0 ? 0.6 : 1 }}>{fmtEuro(item.basePrice)}</span>
                          : <span style={{ color: "#cbd5e1" }}>—</span>}
                      </div>

                      {/* Wholesale price — bordered clickable field */}
                      <div>
                        {isEditing ? (
                          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                            <div style={{
                              display: "flex", alignItems: "center",
                              border: "1.5px solid #6366f1", borderRadius: 7,
                              background: "#fff", overflow: "hidden",
                            }}>
                              <span style={{ fontSize: 11, padding: "0 6px", color: "#64748b", userSelect: "none" as const, flexShrink: 0 }}>€</span>
                              <input
                                type="number" min={0} step={0.01}
                                value={editValue}
                                onChange={(e) => setEditValue(e.target.value)}
                                onBlur={() => confirmEdit(item.id)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter") { e.currentTarget.blur(); }
                                  if (e.key === "Escape") { setEditingId(null); setEditValue(""); }
                                }}
                                style={{
                                  width: 100, border: "none", outline: "none",
                                  fontSize: 13, fontWeight: 700, padding: "6px 6px 6px 0",
                                  color: "#0f172a", fontFamily: "inherit", background: "transparent",
                                }}
                                autoFocus
                              />
                            </div>
                            <button
                              onMouseDown={(e) => e.preventDefault()}
                              onClick={() => { resetItemPrice(item.id, item.basePrice); setEditingId(null); setEditValue(""); }}
                              style={{ ...stepBtn as any, borderColor: "#fca5a5", color: "#ef4444", fontSize: 13 }}
                              title={
                                catalog.discountType === "FIXED_PRICE"  ? `Reset to €${globalDiscount.toFixed(2)}` :
                                catalog.discountType === "FIXED_AMOUNT" ? `Reset to base − €${globalDiscount.toFixed(2)}` :
                                `Reset to ${globalDiscount}% default`
                              }
                            >↺</button>
                          </div>
                        ) : (
                          <div
                            onClick={() => openEdit(item.id, effectiveCents || Math.round(item.basePrice * 100))}
                            style={{
                              display: "inline-flex", alignItems: "center", gap: 5,
                              border: "1.5px solid #e2e8f0", borderRadius: 8,
                              padding: "5px 10px", cursor: "pointer",
                              background: "#fff", transition: "border-color 0.15s",
                            }}
                            onMouseEnter={(e) => (e.currentTarget.style.borderColor = "#a5b4fc")}
                            onMouseLeave={(e) => (e.currentTarget.style.borderColor = "#e2e8f0")}
                            title="Click to edit price"
                          >
                            <span style={{ fontSize: 13.5, color: "#0f172a", fontWeight: 700, whiteSpace: "nowrap" as const }}>
                              {wholesaleEuros > 0 ? fmtEuro(wholesaleEuros) : <span style={{ color: "#94a3b8", fontSize: 12 }}>Set price…</span>}
                            </span>
                            {hasCustomPrice && (
                              <span style={{
                                fontSize: 9, padding: "2px 6px",
                                background: "#fef3c7", color: "#92400e",
                                border: "1px solid #fde68a",
                                borderRadius: 10, fontWeight: 700, letterSpacing: "0.04em",
                                flexShrink: 0,
                              }}>FIXED</span>
                            )}
                          </div>
                        )}
                      </div>

                      {/* Discount % badge */}
                      <div style={{ textAlign: "center" }}>
                        {savingPct > 0 ? (
                          <span style={{
                            display: "inline-block",
                            background: "linear-gradient(135deg, #dcfce7, #bbf7d0)",
                            color: "#15803d", border: "1px solid #86efac",
                            borderRadius: 20, padding: "3px 10px",
                            fontSize: 12, fontWeight: 700, letterSpacing: "-0.01em",
                          }}>
                            -{savingPct}%
                          </span>
                        ) : (
                          <span style={{ color: "#e2e8f0", fontSize: 14 }}>—</span>
                        )}
                      </div>
                    </div>
                  );
                })}

                {pageItems.length === 0 && (
                  <div style={{ padding: "56px 24px", textAlign: "center" }}>
                    <div style={{ fontSize: 36, marginBottom: 12 }}>
                      {catalog.items.length === 0 ? "▦" : "⌕"}
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: "#475569", marginBottom: 4 }}>
                      {catalog.items.length === 0 ? "No products yet" : "No matches found"}
                    </div>
                    <div style={{ fontSize: 13, color: "#94a3b8" }}>
                      {catalog.items.length === 0
                        ? "Enable auto-include and click Sync to pull in products from your store."
                        : "Try a different search or clear the collection filter."}
                    </div>
                  </div>
                )}

                {/* Pagination — numbered pages */}
                {totalPages > 1 && (() => {
                  // Show up to 7 page buttons; collapse middle if many pages
                  const MAX_VISIBLE = 7;
                  const pages: (number | "…")[] = [];
                  if (totalPages <= MAX_VISIBLE) {
                    for (let i = 0; i < totalPages; i++) pages.push(i);
                  } else {
                    pages.push(0);
                    if (page > 3) pages.push("…");
                    for (let i = Math.max(1, page - 1); i <= Math.min(totalPages - 2, page + 1); i++) pages.push(i);
                    if (page < totalPages - 4) pages.push("…");
                    pages.push(totalPages - 1);
                  }
                  const pgBtn: React.CSSProperties = {
                    ...btnBase,
                    minWidth: 34, height: 34, borderRadius: 8,
                    border: "1px solid #e2e8f0",
                    fontSize: 13, fontWeight: 600,
                    display: "flex", alignItems: "center", justifyContent: "center",
                  };
                  return (
                    <div style={{
                      padding: "12px 22px", borderTop: "1px solid #f1f5f9",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      gap: 4, background: "#fafafa", flexWrap: "wrap",
                    }}>
                      <button
                        onClick={() => setPage((p) => Math.max(0, p - 1))}
                        disabled={page === 0}
                        style={{ ...pgBtn, background: page === 0 ? "#f8fafc" : "#fff", color: page === 0 ? "#cbd5e1" : "#374151", padding: "0 12px" }}
                      >←</button>
                      {pages.map((p, i) =>
                        p === "…" ? (
                          <span key={`ellipsis-${i}`} style={{ fontSize: 13, color: "#94a3b8", padding: "0 4px" }}>…</span>
                        ) : (
                          <button
                            key={p}
                            onClick={() => setPage(p as number)}
                            style={{
                              ...pgBtn,
                              background: page === p ? "#6366f1" : "#fff",
                              color: page === p ? "#fff" : "#374151",
                              border: page === p ? "1px solid #6366f1" : "1px solid #e2e8f0",
                              boxShadow: page === p ? "0 1px 4px rgba(99,102,241,0.3)" : "none",
                            }}
                          >{(p as number) + 1}</button>
                        )
                      )}
                      <button
                        onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                        disabled={page >= totalPages - 1}
                        style={{ ...pgBtn, background: page >= totalPages - 1 ? "#f8fafc" : "#fff", color: page >= totalPages - 1 ? "#cbd5e1" : "#374151", padding: "0 12px" }}
                      >→</button>
                    </div>
                  );
                })()}
              </div>
            </BlockStack>

            {/* ── Right column ── */}
            <BlockStack gap="500">

              {/* Settings */}
              <div style={{
                background: "#fff", borderRadius: 14,
                border: "1px solid #e5e7eb",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                overflow: "hidden",
              }}>
                <div style={{
                  padding: "16px 20px", borderBottom: "1px solid #f1f5f9",
                  background: "#fafafa",
                  display: "flex", alignItems: "center", gap: 10,
                }}>
                  <div style={{ width: 28, height: 28, borderRadius: 8, background: "#f0f9ff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 14 }}>⚙</div>
                  <span style={{ fontWeight: 700, fontSize: 15, color: "#0f172a" }}>Settings</span>
                </div>

                <div style={{ padding: "18px 20px" }}>
                  <BlockStack gap="400">

                    {/* Discount type — locked read-only */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
                        Discount type
                        <span style={{ marginLeft: 8, fontSize: 10, background: "#fef3c7", color: "#92400e", border: "1px solid #fde68a", borderRadius: 10, padding: "2px 8px", fontWeight: 700 }}>
                          Locked
                        </span>
                      </div>
                      <div style={{
                        background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 10,
                        padding: "10px 14px", display: "flex", alignItems: "center", gap: 10,
                      }}>
                        <span style={{ fontSize: 20 }}>
                          {catalog.discountType === "FIXED_AMOUNT" ? "−$" : catalog.discountType === "FIXED_PRICE" ? "=$" : "%"}
                        </span>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: "#0f172a" }}>
                            {catalog.discountType === "FIXED_AMOUNT" ? "Fixed amount off"
                              : catalog.discountType === "FIXED_PRICE" ? "One price for all"
                              : "Discounted % for all"}
                          </div>
                          {catalog.discountType === "FIXED_AMOUNT" && catalog.fixedDiscountCents != null && (
                            <div style={{ fontSize: 12, color: "#64748b" }}>€{(catalog.fixedDiscountCents / 100).toFixed(2)} off each product</div>
                          )}
                          {catalog.discountType === "FIXED_PRICE" && catalog.fixedPriceCents != null && (
                            <div style={{ fontSize: 12, color: "#64748b" }}>€{(catalog.fixedPriceCents / 100).toFixed(2)} for all products</div>
                          )}
                          {catalog.discountType === "PERCENT" && (
                            <div style={{ fontSize: 12, color: "#64748b" }}>Set per-product or use the global % above</div>
                          )}
                        </div>
                      </div>
                      <p style={{ margin: "6px 0 0", fontSize: 11, color: "#94a3b8", lineHeight: 1.4 }}>
                        To change discount type, create a new catalog.
                      </p>
                    </div>

                    {/* Price display — always editable */}
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 }}>
                        Price display for non-wholesale visitors
                      </div>
                      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                        {[
                          { value: "REPLACED",               label: "Price replaced",           desc: "Show wholesale price only",           icon: "⇄" },
                          { value: "ORIGINAL_AND_DISCOUNTED", label: "Original + discounted",    desc: "Strikethrough + discounted price",    icon: "⊘" },
                        ].map((opt) => (
                          <button
                            key={opt.value}
                            onClick={() => { setPriceDisplay(opt.value); mark(); }}
                            style={{
                              display: "flex", alignItems: "center", gap: 10,
                              padding: "10px 12px", borderRadius: 8, cursor: "pointer",
                              border: priceDisplay === opt.value ? "2px solid #6366f1" : "1px solid #e2e8f0",
                              background: priceDisplay === opt.value ? "#f8f7ff" : "#fafafa",
                              textAlign: "left", fontFamily: "inherit",
                              transition: "all 0.12s",
                            }}
                          >
                            <span style={{ fontSize: 16, flexShrink: 0 }}>{opt.icon}</span>
                            <div>
                              <div style={{ fontSize: 12, fontWeight: 700, color: priceDisplay === opt.value ? "#4f46e5" : "#0f172a" }}>{opt.label}</div>
                              <div style={{ fontSize: 11, color: "#94a3b8" }}>{opt.desc}</div>
                            </div>
                            {priceDisplay === opt.value && (
                              <span style={{ marginLeft: "auto", fontSize: 14, color: "#6366f1" }}>✓</span>
                            )}
                          </button>
                        ))}
                      </div>
                    </div>

                    <Select
                      label="Catalog status"
                      options={statusOptions}
                      value={catalogStatus}
                      onChange={(v) => { setCatalogStatus(v); mark(); }}
                      helpText={
                        catalogStatus !== "active"
                          ? "Deactivating removes all wholesale pricing from customers immediately."
                          : undefined
                      }
                    />
                    <TextField
                      label="Discount label"
                      value={discountTitle}
                      onChange={(v) => { setDiscountTitle(v); mark(); }}
                      autoComplete="off"
                      placeholder="e.g. VIP Pricing"
                      helpText="Displayed at checkout. Leave empty to hide."
                    />
                    <TextField
                      label="Minimum order message"
                      value={minimumOrderMessage}
                      onChange={(v) => { setMinimumOrderMessage(v); mark(); }}
                      autoComplete="off"
                      multiline={2}
                      placeholder="Minimum order is {min}. Add {required} more to proceed to checkout."
                      helpText="Use {min} for the minimum amount and {required} for how much more is needed."
                    />

                    <div style={{
                      background: "#f8fafc", borderRadius: 10, padding: "14px",
                      border: "1px solid #e2e8f0",
                    }}>
                      <Checkbox
                        label="Auto-include new products"
                        checked={checked}
                        onChange={(v) => { setChecked(v); mark(); }}
                      />
                      <p style={{ margin: "8px 0 0 28px", fontSize: 12, color: "#64748b", lineHeight: 1.5 }}>
                        New and updated products are added automatically via Shopify webhooks. Use <strong>Sync</strong> for a full manual refresh.
                      </p>
                    </div>
                  </BlockStack>
                </div>
              </div>

              {/* Save actions */}
              <div style={{
                background: "#fff", borderRadius: 14,
                border: "1px solid #e5e7eb",
                boxShadow: "0 1px 3px rgba(0,0,0,0.04)",
                padding: "16px 20px",
              }}>
                <BlockStack gap="300">
                  <button
                    onClick={() => submitSettings()}
                    disabled={!unsaved || fetcher.state === "submitting"}
                    style={{
                      ...btnBase,
                      width: "100%", padding: "11px",
                      borderRadius: 10, fontSize: 14, fontWeight: 650,
                      background: unsaved ? "#0f172a" : "#f1f5f9",
                      color: unsaved ? "#fff" : "#94a3b8",
                      boxShadow: unsaved ? "0 4px 14px rgba(15,23,42,0.2)" : "none",
                      transition: "all 0.15s",
                    }}
                  >
                    {fetcher.state === "submitting" ? "Saving…" : "Save catalog"}
                  </button>
                  {unsaved && (
                    <button
                      onClick={cancel}
                      style={{
                        ...btnBase,
                        width: "100%", padding: "9px",
                        borderRadius: 10, fontSize: 13, fontWeight: 500,
                        background: "none", color: "#64748b",
                      }}
                    >
                      Discard changes
                    </button>
                  )}
                </BlockStack>
              </div>

            </BlockStack>
          </InlineGrid>
        </BlockStack>
      </Page>

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        input[type=number]::-webkit-inner-spin-button,
        input[type=number]::-webkit-outer-spin-button { -webkit-appearance: none; margin: 0; }
        input[type=number] { -moz-appearance: textfield; }
      `}</style>
    </>
  );
}
