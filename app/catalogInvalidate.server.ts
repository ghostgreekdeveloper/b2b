/**
 * Catalog cache invalidation.
 *
 * Strategy: version-stamp invalidation instead of cache deletion.
 *   - Increment cacheVersion in the DB (atomic SQL UPDATE).
 *   - Evict the version cache entry so the next request re-reads the new version.
 *   - Old versioned data entries (cdata:<id>:v<old>) expire naturally via TTL.
 *
 * This prevents the stale-data race condition where a slow in-flight compute
 * finishes after a cache deletion and writes stale data back under the same key.
 * With versioned keys, the slow compute writes to the old version key that
 * nobody reads, while new requests use the bumped version key.
 */

import db from "./db.server";
import { catalogVersionCache } from "./cache.server";

export async function invalidateCatalogCache(catalogId: number): Promise<void> {
  await db.$executeRaw`UPDATE "Catalog" SET "cacheVersion" = "cacheVersion" + 1 WHERE id = ${catalogId}`;
  catalogVersionCache.del(`cv:${catalogId}`);
}

export async function invalidateCatalogCacheMany(catalogIds: number[]): Promise<void> {
  if (!catalogIds.length) return;
  await Promise.all(
    catalogIds.map((id) =>
      db.$executeRaw`UPDATE "Catalog" SET "cacheVersion" = "cacheVersion" + 1 WHERE id = ${id}`,
    ),
  );
  for (const id of catalogIds) catalogVersionCache.del(`cv:${id}`);
}
