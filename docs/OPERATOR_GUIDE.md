# MusiGod Operator Guide

Practical reference for whoever is running/monitoring MusiGod day to day.
This is not an architecture doc — see `CLAUDE.md` for constraints and
`.github/AGENT_BACKLOG.md` for the roadmap. This file is for "how do I turn
X on/off" and "what does this integration actually do right now."

## Royalty gap scanner (`api/scan-artist.js` → `lib/scanner.js`)

Used by the rights-audit lead-gen flow to estimate uncollected royalties
across five sources, run in parallel: Discogs, Spotify, MLC, YouTube, and
SoundExchange. Auth via `AUDIT_ADMIN_KEY` header (`x-admin-key`).

Every source is best-effort — a failure in one does not fail the whole scan
(`Promise.allSettled`). Estimates are always conservative/approximate; they
are marketing signals, not financial claims.

### SoundExchange integration

**Status as of this writing: manual-check only. No automated SoundExchange
API is enabled in production.**

- `lib/soundexchange-adapter.js` is a feature-flagged client for
  SoundExchange's documented Repertoire Search API (recording/ISRC matching
  only). It is **disabled by default** and stays disabled until all of
  `SOUNDEXCHANGE_API_ENABLED`, `SOUNDEXCHANGE_API_BASE_URL`,
  `SOUNDEXCHANGE_API_SEARCH_PATH`, and `SOUNDEXCHANGE_API_KEY` are set (see
  `.env.local.example`).
- We do not yet have that API contract from SoundExchange —
  `SOUNDEXCHANGE_API_ACCESS_REQUEST.md` at the repo root is the draft request
  to `repertoire@soundexchange.com` and tracks what's confirmed vs. open.
- `lib/soundexchange.js` (consumed by the scanner) checks
  `isEnabled()` from the adapter:
  - **Disabled (current default):** makes zero network calls to
    SoundExchange. Returns a `manualUrl` pointing to SoundExchange's public
    artist-search page so a human can check by hand, and a single
    `soundexchange_manual_check_needed` gap.
  - **Enabled + configured:** delegates to `matchByRecording()` for a
    deterministic (exact-match-only) registration check, with full audit
    provenance logged as `[soundexchange-adapter:audit] {...}` lines.
- **A prior implementation of `lib/soundexchange.js` scraped an undocumented
  internal endpoint** (`soundexchange.com/wp-admin/admin-ajax.php`) with a
  spoofed User-Agent/Referer to mimic their public search widget. That code
  has been removed — it was never an authorized integration. Do not
  reintroduce anything that scrapes soundexchange.com or hits SXDirect.
- **Private royalty balances, payments, claims, and adjustments are out of
  scope for this adapter entirely.** That data requires SoundExchange
  account login and is not something we automate. It continues to flow
  through the secure CSV/XLSX import workflow. See open question 8 in
  `SOUNDEXCHANGE_API_ACCESS_REQUEST.md` if SoundExchange ever offers an
  authorized account-data API — that would be a separate, human-reviewed
  integration (touches money-adjacent data per `CLAUDE.md`), not an
  extension of the recording-matching adapter.

**To enable the SoundExchange adapter once access is approved:**

1. Get the real endpoint contract from SoundExchange (base URL, search path,
   auth header format, field names) in writing.
2. Set `SOUNDEXCHANGE_API_BASE_URL`, `SOUNDEXCHANGE_API_SEARCH_PATH`,
   `SOUNDEXCHANGE_API_KEY` in Vercel env vars (never commit them).
3. Verify `extractCandidates()` / field-name assumptions in
   `lib/soundexchange-adapter.js` against a real sandbox/test response
   before flipping the flag in production.
4. Set `SOUNDEXCHANGE_API_ENABLED=true`.
5. Run `node tests/soundexchange-adapter.test.js` — it's fully mocked and
   should still pass unchanged; it does not require real credentials.

**To check current config without exposing secrets:** call
`describeConfig()` from `lib/soundexchange-adapter.js` (returns booleans/
counts only — never the raw API key).

## Partner rights resolution API (`api/partner/resolve-rights.js`)

Read-only, `X-Partner-Key`-authenticated. See `docs/partner-rights-api.yaml`
for the OpenAPI contract. No SoundExchange dependency currently.

## Test suite

`npm test` runs all offline/mocked suites (see `package.json`). Two tests —
`tests/ai-consent-ledger.test.js` and `tests/partner-resolve-rights.test.js`
— require a live Supabase connection and a running server, so they're
intentionally excluded from `npm test` and run manually when needed.
