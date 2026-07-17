// Best-effort in-memory rate limiter for the public API endpoints.
//
// SCOPE HONESTY: serverless functions are stateless across cold starts and
// scale horizontally, so this bucket lives per warm instance — it throttles a
// naive hammer from one source but is NOT a hard global limit. It exists to
// blunt brute-force / usage-inflation / Stripe-quota-exhaustion attempts
// cheaply and with no new dependency. The robust version is a shared store
// (Vercel KV / Upstash Redis) keyed the same way; swap `hit()` for a KV call
// when that's warranted.

const buckets = new Map(); // key -> { count, resetAt }

// Returns true if the request is ALLOWED, false if it should be rejected (429).
export function allow(key, { limit = 30, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    // Opportunistic sweep so the Map can't grow unbounded on a warm instance.
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    }
    return true;
  }
  b.count += 1;
  return b.count <= limit;
}

// Client IP from Vercel/proxy headers, falling back to the socket address.
export function clientIp(req) {
  const headers = req.headers || {};
  const xff = headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

// Guard a handler: enforce per-IP and (when present) per-license-key limits.
// Returns true if the request was rejected (caller should stop). Sets 429.
export function rateLimited(req, res, { ipLimit = 60, keyLimit = 30, windowMs = 60_000, tag = 'api' } = {}) {
  const ip = clientIp(req);
  if (!allow(`${tag}:ip:${ip}`, { limit: ipLimit, windowMs })) {
    res.status(429).json({ error: 'Too many requests. Slow down and try again shortly.' });
    return true;
  }
  const licenseKey = req.body?.licenseKey;
  if (licenseKey && !allow(`${tag}:key:${licenseKey}`, { limit: keyLimit, windowMs })) {
    res.status(429).json({ error: 'Too many requests for this license. Slow down and try again shortly.' });
    return true;
  }
  return false;
}
