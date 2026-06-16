import { ActionFunctionArgs, json } from "@remix-run/node";
import { createHmac, timingSafeEqual } from "crypto";
import db from "../db.server";
import { invalidateCatalogCacheMany } from "../catalogInvalidate.server";
import { rateLimit } from "../rateLimit.server";

const SHOPIFY_API_SECRET = process.env.SHOPIFY_API_SECRET ?? "";

export const loader = async () =>
  json({ message: "Use POST for Shopify webhooks" }, { status: 404 });

export const action = async ({ request }: ActionFunctionArgs) => {
  // Read raw body first — must happen before any other parsing
  const bodyText  = await request.text();

  const hmacHeader = request.headers.get("X-Shopify-Hmac-Sha256") ?? "";
  const shop       = request.headers.get("X-Shopify-Shop-Domain") ?? "";
  const topic      = request.headers.get("X-Shopify-Topic") ?? "unknown";
  const webhookId  = request.headers.get("X-Shopify-Webhook-Id") ?? "";

  // ── 1. HMAC verification — reject any request that isn't from Shopify ─────
  if (!verifyHmac(bodyText, hmacHeader, SHOPIFY_API_SECRET)) {
    console.warn(`[webhook] HMAC mismatch — shop=${shop} topic=${topic}`);
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!shop) return json({ error: "Missing shop header" }, { status: 400 });

  // ── 2. Rate limit — 300 deliveries per shop per minute ───────────────────
  // Shopify typically sends at most a few dozen/min; 300 gives ample headroom
  // while blocking runaway retries or spoofed-but-valid requests.
  if (!rateLimit(`wh:${shop}`, 300, 60_000)) {
    console.warn(`[webhook] rate limited — shop=${shop}`);
    return json({ error: "Rate limited" }, { status: 429 });
  }

  // ── 3. Idempotency — skip already-processed deliveries ───────────────────
  // Shopify guarantees at-least-once delivery; retries share the same webhookId.
  // We INSERT before processing so a crash during processing causes a retry
  // (the record is only kept on success via the catch-ignore pattern below).
  // Concurrent duplicate deliveries: first INSERT wins; second gets P2002 → skip.
  if (webhookId) {
    try {
      await db.webhookEvent.create({ data: { webhookId, shop, topic } });
    } catch (e: any) {
      if (e?.code === "P2002") {
        // Already processed (or currently processing in a concurrent request)
        return json({ ok: true });
      }
      throw e;
    }
  }

  try {
    const payload = JSON.parse(bodyText);

    switch (topic) {
      case "products/create":
      case "products/update":
        await handleProductUpdate(payload, shop);
        break;
      case "products/delete":
        await handleProductDelete(payload, shop);
        break;
      default:
        break;
    }

    return json({ success: true });
  } catch (err) {
    // If processing fails, delete the idempotency record so Shopify's retry
    // gets another chance to process this webhook.
    if (webhookId) {
      await db.webhookEvent.delete({ where: { webhookId } }).catch(() => {});
    }
    console.error("[webhook] processing error:", err);
    return json({ error: "Webhook processing failed" }, { status: 500 });
  }
};

// ── HMAC verification ─────────────────────────────────────────────────────────

function verifyHmac(rawBody: string, hmacHeader: string, secret: string): boolean {
  if (!hmacHeader || !secret) return false;
  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(computed);
  const b = Buffer.from(hmacHeader);
  // Length mismatch means different hashes — timingSafeEqual requires equal length
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ── Product update/create ─────────────────────────────────────────────────────

async function handleProductUpdate(payload: any, shop: string) {
  const productId = String(payload.id);
  const title     = payload.title as string;
  const variants  = (payload.variants ?? []) as any[];
  const images    = (payload.images ?? []) as any[];

  // Only this shop's catalogs — never cross-shop contamination
  const catalogs = await db.catalog.findMany({ where: { shopDomain: shop } });
  if (!catalogs.length) return;

  const catalogIds = catalogs.map((c) => c.id);
  const existingItems = await db.catalogItem.findMany({
    where: { catalogId: { in: catalogIds }, productId },
  });

  // Wrap all item writes in a transaction — either all update or none
  await db.$transaction(async (tx) => {
    for (const catalog of catalogs) {
      for (const v of variants) {
        const variantId          = String(v.id);
        const priceCents         = Math.round(parseFloat(v.price || "0") * 100);
        const defaultWholesale   = catalog.defaultDiscountPercent
          ? Math.round(priceCents * (1 - catalog.defaultDiscountPercent / 100))
          : priceCents;
        const imageUrl           = resolveImage(v, images);
        const item               = existingItems.find(
          (ci) => ci.catalogId === catalog.id && ci.variantId === variantId,
        );

        if (item) {
          // Preserve manually-set wholesale prices — only recalculate if the
          // stored value matches what the auto-compute would have produced.
          let newWholesale: number | null =
            item.customDiscountPercent !== null ? Number(item.customDiscountPercent) : null;

          if (catalog.defaultDiscountPercent && catalog.defaultDiscountPercent > 0) {
            const oldBase     = Number(item.customPriceCents ?? 0);
            const expectedOld = oldBase > 0
              ? Math.round(oldBase * (1 - catalog.defaultDiscountPercent / 100))
              : 0;
            if (
              item.customDiscountPercent === null ||
              Number(item.customDiscountPercent) === 0 ||
              Number(item.customDiscountPercent) === expectedOld
            ) {
              newWholesale = defaultWholesale;
            }
          }

          await tx.catalogItem.update({
            where: { id: item.id },
            data: {
              name:                  title,
              img:                   imageUrl ?? item.img,
              sku:                   v.sku,
              customPriceCents:      BigInt(priceCents),
              customDiscountPercent: newWholesale !== null ? BigInt(newWholesale) : null,
            },
          });
        } else if (catalog.autoIncludeProducts) {
          await tx.catalogItem.create({
            data: {
              catalogId:        catalog.id,
              productId,
              variantId,
              name:             title,
              img:              imageUrl,
              sku:              v.sku,
              customPriceCents: BigInt(priceCents),
            },
          });
        }
      }
    }
  });

  // Bust versioned cache for every affected catalog (outside the transaction —
  // cache ops should not be rolled back if the transaction succeeds)
  await invalidateCatalogCacheMany(catalogIds);
}

// ── Product delete ────────────────────────────────────────────────────────────

async function handleProductDelete(payload: any, shop: string) {
  const productId = String(payload.id);

  const catalogIds = (
    await db.catalog.findMany({ where: { shopDomain: shop }, select: { id: true } })
  ).map((c) => c.id);

  if (!catalogIds.length) return;

  await db.catalogItem.deleteMany({ where: { catalogId: { in: catalogIds }, productId } });

  // Bump versions + evict version cache (outside transaction — cache is not transactional)
  await invalidateCatalogCacheMany(catalogIds);

  console.log(
    `[webhook] deleted product ${productId} from ${catalogIds.length} catalog(s) for ${shop}`,
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveImage(variant: any, images: any[]): string | null {
  if (variant.image_id) {
    const img = images.find((i: any) => i.id === variant.image_id);
    if (img) return img.src;
  }
  return images[0]?.src ?? null;
}
