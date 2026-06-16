/**
 * In-process TTL cache with singleflight + stale-while-revalidate.
 *
 * Singleflight:          when N concurrent requests miss the same key,
 *                        exactly ONE compute() fires; the other N-1 join that promise.
 *
 * Stale-while-revalidate: when a cached entry has expired, the FIRST request
 *                         that notices returns the stale value immediately and
 *                         kicks off ONE background refresh. Zero latency spike on TTL expiry.
 *
 * Not shared across multiple processes — use Redis for multi-instance deployments.
 */

interface Entry<V> {
  value: V;
  exp: number;
}

export class TtlCache<V> {
  private store   = new Map<string, Entry<V>>();
  private pending = new Map<string, Promise<V>>(); // singleflight registry

  constructor(
    private readonly max: number,
    private readonly defaultTtlMs: number
  ) {}

  /** Returns the value if fresh, undefined if expired or absent. */
  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.store.delete(key); return undefined; }
    return e.value;
  }

  set(key: string, value: V, ttlMs?: number): void {
    if (this.store.size >= this.max) this._evict();
    this.store.set(key, { value, exp: Date.now() + (ttlMs ?? this.defaultTtlMs) });
  }

  has(key: string): boolean { return this.get(key) !== undefined; }

  del(key: string): void {
    this.store.delete(key);
    this.pending.delete(key); // cancel any in-flight compute for this key
  }

  delPrefix(prefix: string): void {
    for (const k of this.store.keys())  if (k.startsWith(prefix)) this.store.delete(k);
    for (const k of this.pending.keys()) if (k.startsWith(prefix)) this.pending.delete(k);
  }

  get size() { return this.store.size; }

  /**
   * Singleflight + stale-while-revalidate get-or-compute.
   *
   * ① Fresh hit  → return immediately (zero async overhead)
   * ② Stale hit  → return old value immediately; ONE background refresh fires
   * ③ Cold miss  → first caller awaits compute(); concurrent callers join that same promise
   */
  async getOrCompute(
    key: string,
    compute: () => Promise<V>,
    ttlMs?: number,
  ): Promise<V> {
    const e   = this.store.get(key);
    const now = Date.now();

    if (e && now <= e.exp) return e.value; // ① fresh

    if (e && now > e.exp) {
      // ② stale — serve immediately, refresh once in background
      if (!this.pending.has(key)) {
        const p = compute()
          .then(v => { this.set(key, v, ttlMs); return v; })
          .catch(() => { /* keep stale, next request retries */ })
          .finally(() => this.pending.delete(key)) as Promise<V>;
        this.pending.set(key, p);
      }
      return e.value;
    }

    // ③ cold miss — singleflight
    const inflight = this.pending.get(key);
    if (inflight) return inflight;

    const p = compute()
      .then(v => { this.set(key, v, ttlMs); return v; })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, p);
    return p;
  }

  private _evict(): void {
    const now = Date.now();
    for (const [k, e] of this.store) if (now > e.exp) this.store.delete(k);
    if (this.store.size >= this.max) {
      const toDelete = Math.ceil(this.max * 0.2);
      let n = 0;
      for (const k of this.store.keys()) { if (n++ >= toDelete) break; this.store.delete(k); }
    }
  }
}

// ── Shared singletons ────────────────────────────────────────────────────────

export const customerStateCache = new TtlCache<{
  accepted: false;
} | {
  accepted: true;
  minimumOrderCents: number;
  legacyCatalogId: number | null;
} | null>(
  100_000,
  2 * 60_000  // 2 min
);

export const catalogIdsCache = new TtlCache<{
  catalogIds: number[];
  minimumOrderMessage: string | null;
  priceDisplay: string;
}>(
  100_000,
  30_000  // 30 sec
);

/**
 * Per-catalog item data.  Key: `cdata:<catalogId>`
 *
 * Items stored as a Map<variantId, entry> so lookup is O(1) per requested variant
 * instead of O(n) scan through all items.  Each Map entry has both the raw DB key
 * AND its alternate format (GID ↔ numeric) so callers never need to normalise.
 *
 * Memory: 20k items × ~150 bytes/entry × 2 (dual-keyed) ≈ 6 MB per catalog.
 * max=500 → ~3 GB worst-case; in practice most shops have far fewer items.
 * Lower this if your Railway instance has < 4 GB RAM.
 */
export type CatalogItemEntry = {
  productId:             string;
  customPriceCents:      number | null;
  customDiscountPercent: number | null;
};

export type CatalogData = {
  /** Dual-keyed: both GID and numeric string for each variant */
  itemMap:               Map<string, CatalogItemEntry>;
  discountType:          string;
  defaultDiscountPercent: number | null;
  fixedDiscountCents:    number | null;
  fixedPriceCents:       number | null;
  priceDisplay:          string;
} | null;

export const catalogDataCache = new TtlCache<CatalogData>(
  500,        // 500 catalogs × ~6 MB ≈ 3 GB max; tune to your RAM
  5 * 60_000  // 5 min, stale-while-revalidate keeps latency flat at expiry
);

export const syncSessionCache = new TtlCache<{
  catalogId:       number;
  autoInclude:     boolean;
  existingMap:     Record<string, { id: number; discount: bigint | null }>;
  seenVariantGids: string[];
  added:           number;
  updated:         number;
}>(
  50,
  15 * 60_000
);

export const formCache = new TtlCache<{ minimumOrderCents: number | null } | null>(
  200,
  2 * 60_000
);

/**
 * Per-catalog cacheVersion counter.  Key: `cv:<catalogId>`
 *
 * Used to build versioned catalogDataCache keys (`cdata:<id>:v<version>`).
 * When a catalog changes, its version is incremented in the DB and this cache
 * entry is deleted — the next request re-reads the new version and uses a fresh
 * key, leaving old versioned entries to expire naturally.
 *
 * 30 s TTL: worst-case staleness after invalidation before new version is visible.
 */
export const catalogVersionCache = new TtlCache<number>(10_000, 30_000);
