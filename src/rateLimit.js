'use strict';

/**
 * A small sliding-window rate limiter kept in memory (one server, as on Render).
 *
 *   const limit = createRateLimiter({ windowMs: 10 * 60e3, max: 5 });
 *   const r = limit.hit(key);   // { ok, remaining, retryAfterSec, limit }
 *
 * Every hit counts, including refused ones, so a script that keeps hammering
 * stays blocked instead of getting a fresh request each time the oldest expires.
 * Old keys are swept every minute so the map cannot grow without end.
 */
function createRateLimiter({ windowMs, max, maxKeys = 50000 }) {
  const hits = new Map(); // key -> array of timestamps (oldest first)

  function prune(list, now) {
    let i = 0;
    while (i < list.length && now - list[i] >= windowMs) i += 1;
    if (i) list.splice(0, i);
  }

  function hit(key, now = Date.now()) {
    let list = hits.get(key);
    if (!list) {
      // A flood of different addresses must not use all the memory: drop the oldest keys.
      if (hits.size >= maxKeys) hits.delete(hits.keys().next().value);
      list = [];
      hits.set(key, list);
    }
    prune(list, now);
    // Cap what one key can store at twice the limit; the window decides anyway.
    if (list.length < max * 2) list.push(now);
    else list[list.length - 1] = now;
    const ok = list.length <= max;
    const retryAfterSec = ok ? 0 : Math.max(1, Math.ceil((list[list.length - max] + windowMs - now) / 1000));
    return { ok, limit: max, remaining: Math.max(0, max - list.length), retryAfterSec, resetSec: Math.ceil((list[0] + windowMs - now) / 1000) };
  }

  /** Undo the last hit (used when a request turned out not to count, e.g. a correct admin key). */
  function forgive(key) {
    const list = hits.get(key);
    if (list) list.pop();
  }

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [k, list] of hits) {
      prune(list, now);
      if (!list.length) hits.delete(k);
    }
  }, 60000);
  sweep.unref?.();

  return { hit, forgive, size: () => hits.size, reset: () => hits.clear() };
}

/** Express middleware: answers 429 with Retry-After once a key is over its limit. */
function rateLimit(limiter, { key = (req) => req.ip, message = 'Too many requests. Please try again later.' } = {}) {
  return (req, res, next) => {
    const r = limiter.hit(key(req));
    res.set('RateLimit-Limit', String(r.limit));
    res.set('RateLimit-Remaining', String(r.remaining));
    res.set('RateLimit-Reset', String(r.resetSec));
    if (r.ok) return next();
    res.set('Retry-After', String(r.retryAfterSec));
    res.status(429).json({ error: message, retryAfterSec: r.retryAfterSec });
  };
}

module.exports = { createRateLimiter, rateLimit };
