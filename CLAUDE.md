# MusiGod — Operating Rules for Claude Code (Agent Runs)

This file is read on every Claude Code run — interactive or headless. It is the
durable contract. Do not violate these without explicit human sign-off in the PR.

## What MusiGod is
Publishing Administrator — artists retain 100% of rights. MusiGod handles LLC
formation, PRO registration, royalty identification, and retroactive recovery
(15% fee on recovered amounts) plus monthly SaaS subscriptions. The platform is
expanding from artist-facing SaaS into B2B2B: licensing the rights graph as
infrastructure to DSPs, PROs, labels, and AI music platforms that need to clear
and pay independent/indie catalog.

## Architecture constraints — NEVER violate
- **No Supabase JS client, anywhere.** Raw `fetch` only, with `apikey` and
  `Authorization: Bearer` headers.
- **Non-public schema calls require BOTH** `Accept-Profile` and `Content-Profile`
  headers set to the target schema (`graph`, `works`, `rights`, `royalties`,
  `disputes`, `legal`, etc.). Public schema does not need these.
- After any schema/grant change, run `NOTIFY pgrst, 'reload schema';` in the SQL
  Editor (or via a migration) — PostgREST will not see new tables/columns
  otherwise. RPCs into unresolved schemas hang silently instead of erroring.
- Admin operations use the service role key. Never the anon key.
- Supabase project ID: `uykzkrnoetcldeuxzqyy`. The Supabase MCP connector in
  this environment is authenticated to a DIFFERENT project (Noterminal). Never
  attempt to use Supabase MCP tools for MusiGod work — use raw fetch or the
  SQL Editor.
- Deploy command is `vercel --prod --force`, run from repo root (no `cd`).
  PowerShell sessions use `;` to chain commands, never `&&`.

## Money and consent — human merge required, no exceptions
Any change touching the `royalties` schema, Stripe Connect disbursement logic
(`api/create-connect-account.js`, `api/trigger-payout.js`, `submit-statement.js`),
the `legal` schema, or any AI-licensing consent ledger/table:
- Open a PR. Do not merge it.
- Do not modify production data via headless run.
- Flag explicitly in the PR description what financial or consent state would
  change and why.

Everything else — schema scaffolding in non-money tables, catalog ingestion,
enrichment pipelines, API scaffolding for read-only endpoints, tests, docs,
CSS/HTML, bug fixes with test coverage — can be built and PR'd autonomously.

## Current build context (as of June 2026)
- Rights graph: property graph on Postgres (`graph` schema: nodes/edges/history),
  25 node types across `works`, `rights`, `royalties`, `disputes` schemas,
  architected for future Neo4j/Neptune export. Graph sync wired into
  `register-artist.js`, `submit-catalog.js`, `enrich-artist.js` via
  `api/graph-sync.js`.
- Catalog enrichment: MusicBrainz to Discogs to Genius three-tier writer-credit
  fallback. Esham test catalog: 161/179 tracks enriched.
- Royalty disbursement: Stripe Connect (Express), `royalties` schema with
  `statements_v1`, `statement_line_items_v1`, `disbursement_queue_v1`,
  `statement_sources_v1`.
- Legal compliance: `legal` schema, 9 tables, ToS/privacy acceptance tracking,
  helper fns `fn_record_terms_acceptance_v1`, `fn_record_privacy_acceptance_v1`.
- Gap: rights graph and royalty schema migrations were applied directly via
  SQL Editor and are NOT currently version-controlled as files in
  `supabase/migrations/`. Reconstructing them as tracked migrations is backlog
  item #1 — see `.github/AGENT_BACKLOG.md`.

## Test artist / credentials for agent verification runs
- Test artist Echo: `artist_id 86c8df13-dbc6-4846-a8da-cdbaaf386cc7`
- Anon key, admin key, and Stripe test account live in Vercel/Supabase env vars
  — never hardcode credentials in committed files.

## Commit discipline
Small, reviewable commits. One concern per PR. Write a commit message that
states what changed and why, not just what files moved.
