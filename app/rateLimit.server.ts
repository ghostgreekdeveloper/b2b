/**
 * In-process sliding-window rate limiter.
 *
 * Not shared across processes — use Redis for multi-instance deployments.
 * Each window resets after `windowMs` from the first request in that window.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/**
 * Returns true if the request is allowed, false if rate-limited.
 *
 * @param key       Unique identifier for the rate-limit bucket (e.g. "px:shop.myshopify.com:123456")
 * @param max       Maximum requests allowed per window
 * @param windowMs  Window duration in milliseconds (default: 60 000 = 1 minute)
 */
export function rateLimit(key: string, max: number, windowMs = 60_000): boolean {
  const now = Date.now();
  const w = windows.get(key);

  if (!w || now > w.resetAt) {
    windows.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (w.count >= max) return false;
  w.count++;
  return true;
}
