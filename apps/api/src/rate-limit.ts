type Bucket = number[];

const buckets = new Map<string, Bucket>();

export type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  retryAfterSec: number;
};

/**
 * Simple fixed-window-ish limiter: allow `limit` timestamps in the last `windowMs`.
 * In-memory only — fine for a single api instance.
 */
export function takeRateLimit(
  key: string,
  limit: number,
  windowMs = 60_000,
  now = Date.now(),
): RateLimitResult {
  const prev = buckets.get(key) ?? [];
  const recent = prev.filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    buckets.set(key, recent);
    const oldest = recent[0] ?? now;
    const retryAfterSec = Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
    return { allowed: false, remaining: 0, retryAfterSec };
  }
  recent.push(now);
  buckets.set(key, recent);
  return {
    allowed: true,
    remaining: Math.max(0, limit - recent.length),
    retryAfterSec: 0,
  };
}

/** Client IP from common proxy headers (first X-Forwarded-For hop). */
export function clientIpFromHeaders(headers: {
  get(name: string): string | undefined;
}): string {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) {
      return first;
    }
  }
  const real = headers.get("x-real-ip")?.trim();
  if (real) {
    return real;
  }
  return "unknown";
}

/** Test helper. */
export function resetRateLimitStore(): void {
  buckets.clear();
}
