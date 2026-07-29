# SoundExchange API Access Request

Status: **draft — not yet sent.** This document is the basis for an email to
`repertoire@soundexchange.com` requesting access to SoundExchange's
documented Repertoire Search API. It also records what MusiGod has and has
not confirmed about that API's contract, so the eventual integration
(`lib/soundexchange-adapter.js`) is built against reality, not assumption.

## What we've confirmed publicly

- SoundExchange operates a public ISRC/artist search at
  `isrc.soundexchange.com` and `soundexchange.com/artist-search`.
- SoundExchange has stated an API exists "for services to develop integrated
  access to the ISRC search site" for real-time recording/ISRC selection,
  and that interested parties should contact `repertoire@soundexchange.com`
  for details.
- The full request/response contract (base URL, auth scheme, endpoint paths,
  field names, rate limits, terms of use) is **not publicly published**. We
  have not received it. Nothing in `lib/soundexchange-adapter.js` assumes a
  specific endpoint path or field name beyond generic, overridable
  placeholders that stay inert until real values are configured.
- SoundExchange has **not** published a general account-data API (royalty
  balances, payment history, claims, adjustments) for third parties. That
  data is only accessible via authenticated login to a member's own
  SoundExchange account — which MusiGod does not have and will not attempt
  to access programmatically or by scraping.

## Ready-to-send email draft

Fill in the bracketed placeholders before sending. Everything else is ready
as-is.

```
To: repertoire@soundexchange.com
From: [Your Name] <[your-email@musigod.com]>
Subject: API access request — Repertoire Search (recording/ISRC matching)

Hi SoundExchange Repertoire team,

My name is [Your Name], [Your Title] at MusiGod (musigod.com). We're a
publishing administrator for independent artists — artists retain 100% of
their rights; we handle PRO registration, catalog administration, and
royalty recovery on their behalf.

I'd like to request API access to your Repertoire Search API for
recording/ISRC matching, per your team's guidance that integration access
goes through this address.

Our use case: as part of our artist rights-audit workflow, we check whether
an artist's recordings are registered in SoundExchange's repertoire for
digital performance royalties (webcasting, satellite radio, etc.), so we
can point unregistered artists to register directly with SoundExchange.
We are not a CMO, PRO, or collection agent for SoundExchange-administered
royalties, and we are not looking to access or move any funds — we want to
confirm registration status by ISRC or artist+title match only.

Specifically, we'd like access to:
1. ISRC lookup — given one or more ISRCs, whether each is present in your
   repertoire (and, for a confirmed match, the recording/artist metadata
   you're willing to expose).
2. Recording lookup by artist name + title — matching repertoire entries so
   we can confirm an exact match or confirm no match.

To be clear about what we're NOT requesting: no royalty balance, statement,
payment, claim, or adjustment data for any account, and no endpoint that
requires a SoundExchange member's own login credentials. This is
registration-status lookup only.

A few questions that would help us build this correctly on our end:

1. What is the base URL and endpoint path for the Repertoire Search API?
2. What authentication scheme do you use (API key header, OAuth, mTLS)?
3. What are the request parameter names for ISRC lookup vs. artist+title
   lookup?
4. What does a response look like — envelope shape and field names for
   ISRC, title, artist, and match/registration status?
5. What rate limits apply, and how are rate-limit responses signaled?
6. Is there a sandbox/test environment, or does all access hit production
   data?
7. Are there terms of use or data-handling restrictions on results (e.g.,
   can we display "registered" / "not found" to our own artists; any
   restriction on retention)?
8. Separately — is there any authorized path to account-level royalty data
   (balances, statements, claims, adjustments) for artists who've
   explicitly designated MusiGod as their agent? We currently handle that
   via each artist's own CSV/XLSX exports and would only build an
   integration for it if SoundExchange offers one directly.
9. Who should we work with for credential issuance once terms are agreed,
   and is there an application or agreement we need to sign first?

On our side: credentials would be stored only in encrypted environment
variables (never in source control or logs), all requests would be
server-side only, and the integration stays off by default until we've
validated the real contract against a test credential. Happy to share more
detail on our security practices if useful.

Thanks for your time — happy to hop on a call if that's easier than email.

Best,
[Your Name]
[Your Title]
MusiGod
[your-email@musigod.com]
```

## What we are asking for (internal notes)

### Our use case

MusiGod is a publishing administrator for independent artists (100% rights
retained by the artist). Part of our audit workflow identifies whether an
artist's recordings are registered with SoundExchange for digital
performance royalties (webcasting, satellite radio, etc.), so we can direct
unregistered artists to register directly with SoundExchange. We are not a
CMO, PRO, or collection agent for SoundExchange-administered royalties —
we want to *confirm registration status by ISRC/recording match only*, to
inform our own artists, not to access or move any funds.

### Endpoints we're requesting

1. **ISRC lookup** — given one or more ISRCs, return whether each is
   present in SoundExchange's repertoire (and, if present, the associated
   recording/artist metadata SoundExchange is willing to expose for a
   confirmed match).
2. **Recording (artist + title) lookup** — given an artist name and
   recording title, return matching repertoire entries so we can confirm a
   deterministic (exact) match, or confirm no match / ambiguous match
   requiring the artist to check manually.

We are explicitly **not** requesting:
- Royalty balance, statement, payment, claim, or adjustment data for any
  account.
- Any endpoint that requires a SoundExchange member's login credentials.
- Bulk/scrape access beyond reasonable per-artist lookup volume.

### Data fields needed

For each matched recording, at minimum:
- ISRC
- Recording title / version
- Artist name(s)
- Registration/repertoire status (registered vs. not found)
- Any SoundExchange-internal recording ID useful for future reference in
  the same lookup (not required)

We do **not** need and are not requesting: payment amounts, statement line
items, claim IDs, or any per-account financial data.

### Security model (ours)

- Credentials (API key/token) will be stored only in Vercel/`.env.local`
  environment variables, never committed to source control, never logged.
  See `.env.local.example` and the redaction logic in
  `lib/soundexchange-adapter.js`.
- Requests are server-side only (Vercel serverless functions) — no
  credentials ever reach the browser.
- The integration is feature-flagged off by default
  (`SOUNDEXCHANGE_API_ENABLED`) and will only be turned on in production
  after we've validated the real contract against a test credential.
- Per-process rate limiting and bounded retry/backoff are implemented
  client-side regardless of what SoundExchange enforces server-side, so we
  do not depend on your infrastructure to protect us from our own bugs.
- Every match/no-match result is logged with a redacted audit record
  (timestamp, operation, query, HTTP status, confidence, request ID) for
  provenance — see `buildProvenance()` in `lib/soundexchange-adapter.js`.

### Open questions for SoundExchange

1. What is the base URL and path for the Repertoire Search API endpoint(s)?
2. What authentication scheme is used (API key header, OAuth, mutual TLS)?
3. What are the exact request parameter names for ISRC lookup vs.
   artist+title lookup?
4. What is the response envelope shape (array, `{results: [...]}`, paginated,
   etc.) and the field names for ISRC, title, artist, and status?
5. What are the rate limits (requests/minute, daily quota) and what HTTP
   status/headers indicate a rate-limit response?
6. Is there a sandbox/test environment, or do all calls hit production data?
7. What are the terms of use / data-handling restrictions on results
   (e.g., can we display "registered" / "not found" to our own artists;
   any restriction on retention or redistribution)?
8. Is there a separate, authorized path to account-level royalty data
   (balances, statements, claims, adjustments) for artists who have
   explicitly authorized MusiGod as their agent — distinct from the
   Repertoire Search API? If so, we would like to evaluate it as a future
   replacement for our current CSV/XLSX import workflow.
9. Whom do we contact for production credential issuance once terms are
   agreed, and is there a required application/agreement to sign first?

## What happens once SoundExchange responds

1. Update this document's "What we've confirmed publicly" section with the
   real, disclosed contract details (do not guess or infer beyond what is
   given in writing).
2. Configure `SOUNDEXCHANGE_API_BASE_URL`, `SOUNDEXCHANGE_API_SEARCH_PATH`,
   and `SOUNDEXCHANGE_API_KEY` in `.env.local` (local) and Vercel (prod) —
   never in committed files.
3. Verify `lib/soundexchange-adapter.js`'s field-name assumptions
   (`isrc`, `artist`/`artistName`, `title`/`recordingTitle` — see
   `extractCandidates()` and the two `matchBy*` functions) against a real
   response payload, and adjust if SoundExchange's actual field names
   differ.
4. Only then set `SOUNDEXCHANGE_API_ENABLED=true` in a real environment.
5. Private royalty/payment/claim/adjustment data stays on the CSV/XLSX
   import workflow unless SoundExchange separately documents and
   authorizes an account-data API (see open question 8) — that would be a
   distinct, human-reviewed integration touching money/consent-adjacent
   data per `CLAUDE.md`, not an extension of this adapter.

## Status of this integration as of this document

| Capability | Status |
|---|---|
| Recording/ISRC matching via authorized API | **Blocked** — pending SoundExchange approval of the request above |
| Manual "check SoundExchange yourself" link in gap scanner | **Operational** — `lib/soundexchange.js` always returns a manual-check pointer when the adapter isn't configured |
| Unauthorized wp-admin AJAX scraping | **Removed** — the prior implementation hit an undocumented internal endpoint (`soundexchange.com/wp-admin/admin-ajax.php`) with a spoofed User-Agent/Referer; that code has been deleted |
| Royalty balance / payment / claim / adjustment data | **Not attempted** — stays on secure CSV/XLSX import per `CLAUDE.md`; no SoundExchange account-data API is currently known to exist for third parties |
