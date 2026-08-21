export interface SoftRateLimitConfig {
  /** Maximum burst and the number of tokens replenished over this window. */
  capacity: number;
  windowMs: number;
}

export interface SoftRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

interface Bucket {
  tokens: number;
  lastRefillAt: number;
}

const MAX_BUCKETS = 8_192;
const IDLE_BUCKET_TTL_MS = 15 * 60_000;
const buckets = new Map<string, Bucket>();

function clientIp(request: Request): string | null {
  // Only Cloudflare's edge-populated identity is used. Do not trust a
  // user-supplied X-Forwarded-For value at the application boundary.
  const value = request.headers.get("CF-Connecting-IP")?.trim() ?? "";
  return value.length > 0 && value.length <= 64 && /^[\x21-\x7e]+$/u.test(value)
    ? value
    : null;
}

function prune(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.lastRefillAt > IDLE_BUCKET_TTL_MS) buckets.delete(key);
  }
  // This is bounded eviction of the oldest entries, never a threshold-triggered
  // clear. The map is only an edge-isolate second layer; Cloudflare WAF/rules
  // remain the distributed rate-limit boundary and the strong security control.
  while (buckets.size >= MAX_BUCKETS) {
    const oldest = buckets.keys().next().value;
    if (typeof oldest !== "string") break;
    buckets.delete(oldest);
  }
}

function touch(key: string, bucket: Bucket): void {
  // Moving the key to the end makes the insertion order an approximate LRU.
  if (!buckets.has(key)) {
    while (buckets.size >= MAX_BUCKETS) {
      const oldest = buckets.keys().next().value;
      if (typeof oldest !== "string") break;
      buckets.delete(oldest);
    }
  }
  buckets.delete(key);
  buckets.set(key, bucket);
}

function bucketFor(key: string, config: SoftRateLimitConfig, now: number): Bucket {
  const existing = buckets.get(key);
  if (existing === undefined) {
    return { tokens: config.capacity, lastRefillAt: now };
  }
  const elapsed = Math.max(0, now - existing.lastRefillAt);
  return {
    tokens: Math.min(
      config.capacity,
      existing.tokens + (elapsed / config.windowMs) * config.capacity,
    ),
    lastRefillAt: now,
  };
}

function retryAfterSeconds(
  tokens: number,
  config: SoftRateLimitConfig,
): number {
  const refillPerSecond = config.capacity / (config.windowMs / 1_000);
  return Math.max(1, Math.ceil((1 - tokens) / refillPerSecond));
}

/**
 * Best-effort Guest/IP token buckets for abuse friction. Workers isolates are
 * ephemeral and independent, so this must always be treated as a soft second
 * layer after edge rate rules, never as a globally strong security boundary.
 */
export function checkSoftRateLimit(
  request: Request,
  scope: string,
  guestId: string | undefined,
  config: SoftRateLimitConfig,
): SoftRateLimitDecision {
  const now = Date.now();
  prune(now);
  const ip = clientIp(request);
  const keys = [
    ...(guestId ? [`${scope}:guest:${guestId}`] : []),
    ...(ip ? [`${scope}:ip:${ip}`] : []),
  ];
  if (keys.length === 0) return { allowed: true, retryAfterSeconds: 0 };

  const current = keys.map((key) => ({ key, bucket: bucketFor(key, config, now) }));
  const blocked = current.filter(({ bucket }) => bucket.tokens < 1);
  if (blocked.length > 0) {
    for (const { key, bucket } of current) touch(key, bucket);
    return {
      allowed: false,
      retryAfterSeconds: Math.max(
        ...blocked.map(({ bucket }) => retryAfterSeconds(bucket.tokens, config)),
      ),
    };
  }

  for (const { key, bucket } of current) {
    bucket.tokens -= 1;
    touch(key, bucket);
  }
  return { allowed: true, retryAfterSeconds: 0 };
}
