# Agent Backlog — B2B2B Rights Infrastructure Build

Mirrors the GitHub Issues labeled `agent-ready`. This file is for human
reading; the issues are what the nightly workflow actually consumes.

## Lane A — AI-licensing consent ledger
Extend the rights graph (`graph`/`rights` schemas) with consent state per work:
opt-in/opt-out for AI training, AI generation, and NIL (name/image/likeness)
use, each independently settable, each with a timestamp and provenance
(who set it, when, via what flow). Mirrors what Sureel AI offers rightsholders
on the detection side — this is the ownership-side counterpart.
**Touches consent state → needs-human-merge.**

## Lane B — Partner-facing rights resolution API
A read-only, OpenAPI-documented endpoint: given a work or recording identifier
(ISWC, ISRC, or MusiGod internal ID), return current ownership, writer/
publisher splits, registration status, and AI-licensing consent state.
This is the artifact you'd put in front of an AI platform's BD team. Needs
auth (API key per partner) and rate limiting. No money or consent state
changes — agent-buildable.

## Lane C — AI licensing as a royalty source type
Extend the `royalties` schema: add `ai_licensing` as a `statement_sources_v1`
category, wire a new statement type through the existing `submit-statement.js`
→ `disbursement_queue_v1` → Stripe Connect payout path, so when an AI platform
pays for catalog use, the money reaches the actual indie rightsholder through
infrastructure that already works.
**Touches royalties/payout → needs-human-merge.**

## Lane D — Continuous catalog ingestion (the actual moat)
Scale the MusicBrainz → Discogs → Genius enrichment pipeline to run
unattended and continuously across new artists, not just the Esham test
catalog. Every clean, consented work added while you sleep is an asset a
competitor cannot backfill later. Agent-buildable; flag any artist-facing
consent collection as needs-human-merge.

## Lane 0 — Migration debt (do this first)
Reconstruct the rights graph and royalty schema as version-controlled files
in `supabase/migrations/` — they currently exist only as SQL Editor history.
Without this, the agent has no reliable source of truth for current schema
state and every other lane risks drifting from production. Read-only/
reconstruction work — agent-buildable, but verify against live schema via
`information_schema` queries before writing the migration files.
