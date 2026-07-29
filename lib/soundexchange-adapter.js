// lib/soundexchange-adapter.js
//
// Feature-flagged client for SoundExchange's *documented* Repertoire Search
// API — recording / ISRC matching only. See docs/SOUNDEXCHANGE_API_ACCESS_REQUEST.md
// for the access request sent to repertoire@soundexchange.com and the
// contract questions still open.
//
// Hard boundaries (do not expand without re-reading CLAUDE.md):
//   - No SXDirect. No scraping of authenticated pages. No guessed endpoints.
//   - Recording/ISRC matching only. Private royalty balances, payments,
//     claims, and adjustments stay on the CSV/XLSX import workflow
//     (see docs/SOUNDEXCHANGE_API_ACCESS_REQUEST.md) unless SoundExchange
//     separately documents and authorizes an account-data API.
//   - Disabled by default. Every matcher below is a fail-closed no-op until
//     SOUNDEXCHANGE_API_ENABLED=true AND a base URL + search path + API key
//     are configured — which can only happen after SoundExchange approves
//     access and discloses the real request/response contract. Nothing here
//     hardcodes a SoundExchange URL.

const TIMEOUT_MS     = Number(process.env.SOUNDEXCHANGE_API_TIMEOUT_MS)         || 8000;
const MAX_RETRIES    = Number(process.env.SOUNDEXCHANGE_API_MAX_RETRIES)        || 2;
const RATE_LIMIT_MIN = Number(process.env.SOUNDEXCHANGE_API_RATE_LIMIT_PER_MIN) || 30;
const RETRY_BASE_MS  = 500;

function config() {
  return {
    enabled:    String(process.env.SOUNDEXCHANGE_API_ENABLED || '').toLowerCase() === 'true',
    baseUrl:    process.env.SOUNDEXCHANGE_API_BASE_URL || '',
    searchPath: process.env.SOUNDEXCHANGE_API_SEARCH_PATH || '',
    apiKey:     process.env.SOUNDEXCHANGE_API_KEY || '',
  };
}

// Fully configured AND explicitly enabled — never partially armed.
function isEnabled() {
  const c = config();
  return c.enabled && !!c.baseUrl && !!c.searchPath && !!c.apiKey;
}

// ── Redaction ────────────────────────────────────────────────────────────────
// The API key must never reach a log line, thrown error, or returned payload.
function redact(str) {
  const c = config();
  if (!str) return str;
  let out = String(str);
  if (c.apiKey) out = out.split(c.apiKey).join('[REDACTED]');
  return out;
}

function redactError(err) {
  const wrapped = new Error(redact(err.message));
  wrapped.name = err.name;
  return wrapped;
}

// ── Rate limit (in-process sliding window; resets on cold start) ────────────
const callTimestamps = [];
function checkRateLimit() {
  const now = Date.now();
  const windowMs = 60_000;
  while (callTimestamps.length && now - callTimestamps[0] > windowMs) callTimestamps.shift();
  if (callTimestamps.length >= RATE_LIMIT_MIN) return false;
  callTimestamps.push(now);
  return true;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function newRequestId() {
  return `sx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ── HTTP: timeout + bounded retry on transient failures only ────────────────
// Retries 429/5xx/timeout with exponential backoff. Never retries other 4xx
// (bad request / bad auth) — retrying those just burns rate limit for no gain.
async function requestWithRetry(params) {
  const c = config();
  const url = `${c.baseUrl.replace(/\/+$/, '')}${c.searchPath}?${new URLSearchParams(params).toString()}`;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          'Accept':        'application/json',
          'Authorization': `Bearer ${c.apiKey}`,
          'User-Agent':    'MusiGod-SoundExchangeAdapter/1.0 +https://musigod.com',
        },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`SoundExchange API ${res.status}`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * 2 ** attempt); continue; }
        throw lastErr;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`SoundExchange API ${res.status}: ${redact(text).slice(0, 300)}`);
      }
      return { status: res.status, body: await res.json() };
    } catch (err) {
      clearTimeout(timer);
      if (err.name === 'AbortError') {
        lastErr = new Error(`SoundExchange API timeout after ${TIMEOUT_MS}ms`);
        if (attempt < MAX_RETRIES) { await sleep(RETRY_BASE_MS * 2 ** attempt); continue; }
        throw lastErr;
      }
      throw redactError(err);
    }
  }
  throw redactError(lastErr || new Error('SoundExchange API request failed'));
}

// Accepts the common REST list shapes without assuming SoundExchange's exact
// envelope (unconfirmed until the contract is disclosed post-approval).
function extractCandidates(body) {
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.results)) return body.results;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function normalizeIsrc(isrc) {
  return String(isrc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function normalizeText(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function buildProvenance({ operation, query, httpStatus, matched, confidence, durationMs, requestId, error }) {
  return {
    source:      'soundexchange_repertoire_api',
    operation,
    query,
    request_id:  requestId,
    http_status: httpStatus ?? null,
    matched,
    confidence,           // 'exact' | 'none'
    duration_ms: durationMs,
    called_at:   new Date().toISOString(),
    error:       error ? redact(error) : null,
  };
}

function logAudit(provenance) {
  // Structured, redacted audit line. Callers may additionally persist
  // `provenance` wherever they track enrichment/match provenance.
  console.log(`[soundexchange-adapter:audit] ${JSON.stringify(provenance)}`);
}

function notConfiguredResult(operation, query) {
  const provenance = buildProvenance({
    operation, query, httpStatus: null, matched: false, confidence: 'none',
    durationMs: 0, requestId: newRequestId(), error: null,
  });
  return {
    enabled: false,
    matched: false,
    candidates: [],
    reason: 'not_configured',
    message: 'SoundExchange Repertoire Search API is not enabled/configured. ' +
      'Set SOUNDEXCHANGE_API_ENABLED, SOUNDEXCHANGE_API_BASE_URL, ' +
      'SOUNDEXCHANGE_API_SEARCH_PATH, and SOUNDEXCHANGE_API_KEY once ' +
      'repertoire@soundexchange.com approves access.',
    provenance,
  };
}

// ── Public matchers ──────────────────────────────────────────────────────────
// Deterministic only: an exact, normalized match or no match. No fuzzy/partial
// scoring — this data feeds rights-adjacent claims and false positives are
// worse than a miss here.

async function matchByISRC(isrc) {
  const query = { isrc };
  if (!isEnabled()) return notConfiguredResult('matchByISRC', query);

  if (!checkRateLimit()) {
    const provenance = buildProvenance({
      operation: 'matchByISRC', query, httpStatus: 429, matched: false,
      confidence: 'none', durationMs: 0, requestId: newRequestId(),
      error: 'local rate limit exceeded',
    });
    logAudit(provenance);
    return { enabled: true, matched: false, candidates: [], reason: 'rate_limited', provenance };
  }

  const requestId = newRequestId();
  const t0 = Date.now();
  const target = normalizeIsrc(isrc);

  try {
    const { status, body } = await requestWithRetry({ isrc });
    const candidates = extractCandidates(body);
    const exact = candidates.find(c => normalizeIsrc(c.isrc) === target && target.length > 0);

    const provenance = buildProvenance({
      operation: 'matchByISRC', query, httpStatus: status,
      matched: !!exact, confidence: exact ? 'exact' : 'none',
      durationMs: Date.now() - t0, requestId,
    });
    logAudit(provenance);

    return { enabled: true, matched: !!exact, match: exact || null, candidates, provenance };
  } catch (err) {
    const provenance = buildProvenance({
      operation: 'matchByISRC', query, httpStatus: null, matched: false,
      confidence: 'none', durationMs: Date.now() - t0, requestId, error: err.message,
    });
    logAudit(provenance);
    return { enabled: true, matched: false, candidates: [], reason: 'error', error: err.message, provenance };
  }
}

async function matchByRecording({ artistName, title } = {}) {
  const query = { artist: artistName, title };
  if (!isEnabled()) return notConfiguredResult('matchByRecording', query);

  if (!artistName || !title) {
    return { enabled: true, matched: false, candidates: [], reason: 'invalid_query',
      error: 'artistName and title are both required for deterministic matching' };
  }

  if (!checkRateLimit()) {
    const provenance = buildProvenance({
      operation: 'matchByRecording', query, httpStatus: 429, matched: false,
      confidence: 'none', durationMs: 0, requestId: newRequestId(),
      error: 'local rate limit exceeded',
    });
    logAudit(provenance);
    return { enabled: true, matched: false, candidates: [], reason: 'rate_limited', provenance };
  }

  const requestId = newRequestId();
  const t0 = Date.now();
  const targetArtist = normalizeText(artistName);
  const targetTitle  = normalizeText(title);

  try {
    const { status, body } = await requestWithRetry({ artist: artistName, title });
    const candidates = extractCandidates(body);
    const exact = candidates.find(c =>
      normalizeText(c.artist || c.artistName) === targetArtist &&
      normalizeText(c.title  || c.recordingTitle) === targetTitle
    );

    const provenance = buildProvenance({
      operation: 'matchByRecording', query, httpStatus: status,
      matched: !!exact, confidence: exact ? 'exact' : 'none',
      durationMs: Date.now() - t0, requestId,
    });
    logAudit(provenance);

    return { enabled: true, matched: !!exact, match: exact || null, candidates, provenance };
  } catch (err) {
    const provenance = buildProvenance({
      operation: 'matchByRecording', query, httpStatus: null, matched: false,
      confidence: 'none', durationMs: Date.now() - t0, requestId, error: err.message,
    });
    logAudit(provenance);
    return { enabled: true, matched: false, candidates: [], reason: 'error', error: err.message, provenance };
  }
}

// Redacted config snapshot, safe to log or return in a status endpoint.
function describeConfig() {
  const c = config();
  return {
    enabled:          c.enabled,
    configured:       isEnabled(),
    baseUrlSet:       !!c.baseUrl,
    searchPathSet:    !!c.searchPath,
    apiKeySet:        !!c.apiKey,
    rateLimitPerMin:  RATE_LIMIT_MIN,
    timeoutMs:        TIMEOUT_MS,
    maxRetries:       MAX_RETRIES,
  };
}

module.exports = {
  isEnabled,
  matchByISRC,
  matchByRecording,
  describeConfig,
  // exported for tests only
  _internal: {
    normalizeIsrc, normalizeText, extractCandidates, redact,
    resetRateLimitForTests: () => { callTimestamps.length = 0; },
  },
};
