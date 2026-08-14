# SoundExchange API Access Request

**Prepared by:** MusiGod  
**Date:** 2026-07-29  
**Purpose:** To document the process for obtaining authorized programmatic access to SoundExchange data, and to serve as a template for the formal application.

---

## Background

MusiGod is a publishing administrator that assists independent artists with royalty identification and recovery. As part of a Neighboring Rights Recovery Audit product, MusiGod processes SoundExchange catalog and statement exports on behalf of artist clients.

The current authorized workflow is entirely file-based:
1. Client logs into SoundExchange Direct (SXDirect) and exports catalog/statement CSV files
2. Client transfers the files to MusiGod via secure upload
3. MusiGod ingests the files through the `lib/neighboring-rights-audit.js` import pipeline
4. No SoundExchange portal credentials or account access are shared with MusiGod

This document serves as:
- A record of the audit finding that no publicly documented API exists
- A template for applying to SoundExchange's data-exchange program
- Documentation for the feature-flagged adapter (`lib/soundexchange-adapter.js`) that is ready to integrate once official access is granted

---

## Audit Finding: No Public API Available

As of 2026-07-29, SoundExchange does not publish a documented REST API for third-party programmatic access to:
- Repertoire data (catalog, ISRC registrations)
- Royalty statements or payment history
- Unclaimed royalties or search-and-claim results
- Performer or rightsholder registration status

**The prior MusiGod implementation** (`lib/soundexchange.js` before this session) called `https://www.soundexchange.com/wp-admin/admin-ajax.php` with `action=artist_search`. This is a WordPress internal AJAX endpoint that powers their public artist-search web page. It is:
- Not documented in any SoundExchange developer or API guide
- Not covered by any published terms of service permitting programmatic access
- Structurally fragile (subject to breaking changes with any WordPress update)
- Unable to return dollar amounts or account data

**This call has been removed** from the MusiGod codebase and replaced with a feature-flagged stub that returns `found: null` and directs operators to the manual URL and CSV import path.

---

## What SoundExchange Does Offer

Based on publicly available information:

| Program | Description | Availability |
|---------|-------------|--------------|
| SoundExchange Direct (SXDirect) | Member portal for artists and rights holders; CSV export of catalog, statements, and search-and-claim results | Members only; browser-based |
| Public artist search | Web form at soundexchange.com/artist-search — intended for human use | Public; not an API |
| Distributor data exchange | Data-sharing arrangements with qualifying distributors, labels, and administrators under contractual terms | Application required; NDA/contract-gated |
| PRO and CMO interoperability programs | Royalty flow agreements with PROs and international CMOs | Bilateral agreements only |

---

## Application Steps for Official API/Data-Exchange Access

SoundExchange may offer data-exchange arrangements to qualifying entities under their business programs. The general steps are:

### Step 1 — Establish contact
- Contact: SoundExchange Business Development or Licensing team
- Website: `www.soundexchange.com/who-we-work-with/`
- Email: (use contact form on SoundExchange website — do not hardcode email here)

### Step 2 — Identify the correct program
Ask SoundExchange which program applies to MusiGod's use case:
- **Administrator/administrator data exchange:** for publishing administrators acting on behalf of registered members
- **Distributor data program:** for entities that distribute recordings and need to cross-reference ISRC registration status
- **Label partner program:** for labels with large catalogs

### Step 3 — Provide business documentation
Typically required for any data-exchange application:
- Business entity documentation (LLC formation, EIN)
- Description of use case and how data will be used
- Security and data-handling policies
- Client authorization framework (how MusiGod obtains artist consent)
- Volume estimate (number of catalogs, ISRCs, artists)

### Step 4 — Execute data-use agreement
Any data exchange will be governed by a contract specifying:
- Permitted use of data
- Data retention and deletion requirements
- Security standards
- Liability and indemnification
- Termination conditions

### Step 5 — Receive credentials and endpoint documentation
Upon approval, SoundExchange will provide:
- API endpoint URL(s)
- Authentication scheme (likely OAuth2 client credentials)
- Rate limits and usage policies
- Acceptable data fields

### Step 6 — Configure MusiGod adapter
Once credentials are received:
```
SOUNDEXCHANGE_API_ENABLED=true
SOUNDEXCHANGE_CLIENT_ID=<client-id-from-soundexchange>
SOUNDEXCHANGE_CLIENT_SECRET=<client-secret-from-soundexchange>
SOUNDEXCHANGE_API_BASE_URL=<endpoint-from-soundexchange>
```
The `lib/soundexchange-adapter.js` adapter is pre-wired for these variables. The `_liveRepertoireSearch()` and `_liveISRCLookup()` stubs will need to be completed with the actual endpoint paths and response-field mapping once the official documentation is provided.

---

## What MusiGod Will NOT Do

Regardless of feature-flag state or credentials:
- Will not send private royalty statements or payment data through any API — statement data stays on the local CSV import path
- Will not share client portal credentials with any API call
- Will not submit claims, registrations, or mandates through this adapter — those require separate human authorization
- Will not use undocumented endpoints or reverse-engineered APIs

---

## Current Adapter Status

```
lib/soundexchange-adapter.js  — feature-flagged adapter (ready for credentials)
lib/soundexchange.js          — compatibility shim (removes unauthorized call)
tests/soundexchange-adapter.test.js — 17 test scenarios, all passing in mock/disabled mode

Feature flag: SOUNDEXCHANGE_API_ENABLED
Default state: disabled (FEATURE_DISABLED)
Authorized data path (always available): CSV import via validateCatalogImport() / validateStatementImport()
Live API path: stub — awaiting official SoundExchange endpoint documentation
```

---

## Immediate Authorized Path (No API Required)

While API access is pending, the fully authorized workflow is:

1. **Client exports from SXDirect:**
   - Catalog → CSV
   - Statements (all years) → CSV
   - Search-and-claim results → CSV

2. **Client transfers via secure upload** (never via email unencrypted)

3. **MusiGod operator validates import:**
   ```javascript
   const adapter = new SoundExchangeAdapter();
   const { valid, quarantine } = adapter.validateCatalogImport(rows);
   ```

4. **MusiGod runs audit pipeline:**
   ```javascript
   const result = runAudit({ dryRun: true, catalogTracks, soundexchangeStatements });
   ```

5. **Operator reviews classifications** and produces client report per `NEIGHBORING_RIGHTS_AUDIT_OPERATOR_GUIDE.md`

This workflow requires no API credentials, no portal access, and no SoundExchange application. It is operational today.

---

*This document is an internal planning and compliance record. Do not send it to SoundExchange as-is — use the official contact and application process described in Step 1 above.*
