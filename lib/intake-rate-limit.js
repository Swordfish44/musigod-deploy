'use strict';
// lib/intake-rate-limit.js
// In-memory sliding-window rate limiter for intake API endpoints.
// State resets on Vercel cold start — use in combination with token auth,
// not as a sole anti-abuse control.

// Store: Map<key, { count, windowStart }>
const _store = new Map();

// Check and increment the rate limit for a key.
// Returns { allowed: boolean, remaining: number, retryAfterSecs: number }
function checkRateLimit(key, { windowSecs = 3600, maxRequests = 20 } = {}) {
  if (!key) return { allowed: false, remaining: 0, retryAfterSecs: windowSecs };
  const now = Date.now();
  const windowMs = windowSecs * 1000;
  const entry = _store.get(key);

  if (!entry || (now - entry.windowStart) >= windowMs) {
    _store.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: maxRequests - 1, retryAfterSecs: 0 };
  }

  if (entry.count >= maxRequests) {
    const retryAfterSecs = Math.ceil((entry.windowStart + windowMs - now) / 1000);
    return { allowed: false, remaining: 0, retryAfterSecs };
  }

  entry.count++;
  return { allowed: true, remaining: maxRequests - entry.count, retryAfterSecs: 0 };
}

// For tests only
function _clearStore() { _store.clear(); }

module.exports = { checkRateLimit, _clearStore };
