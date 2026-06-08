# MusiGod Catalog Enrichment — Codex Fix Brief

## Repo
github.com/Swordfish44/musigod-deploy, branch release/fulfillment-layer-v1
Working directory: C:\musigod-deploy (NOT the Spark repo — stay in musigod-deploy)

## Stack
- Vercel Pro serverless (Node 24, maxDuration 300s on api/enrich-artist.js)
- Supabase project uykzkrnoetcldeuxzqyy — raw fetch only, NO Supabase JS client
- MusicBrainz API + Discogs API for songwriter data
- PowerShell: semicolons only, never &&
- Deploy: vercel --prod --force

## What the feature does
POST /api/enrich-artist → pulls songwriter credits for an artist from MusicBrainz
and Discogs → generates ASCAP/BMI/MLC bulk registration CSVs → stores result in
public.catalog_enrichments_v1 Supabase table.

## Current status
Pipeline runs end-to-end (200 response, ~40s, no crashes) but returns 0 writers
for every track. Two bugs were just fixed by Claude Code (see git log) but not
yet verified against a live run:

1. stringify() crash in generate-registration-files.js — fixed (= {} default)
2. Discogs fallback blocked by ISWC flag — fixed (writers.length === 0 check)

## Your job
1. Read the codebase: lib/enrich-catalog.js, lib/discogs.js,
   lib/generate-registration-files.js, api/enrich-artist.js

2. Write and run a LOCAL test script (test-enrich.js) that:
   - Calls MusicBrainz for Esham (artist search → get one release → get one
     recording → get work-rels → get work → log ALL relation types returned)
   - Calls Discogs for "Esham Judgement Day" and logs what credits come back
   - Does NOT require Vercel env vars (hardcode the MB/Discogs URLs)
   - Run with: node test-enrich.js

3. Based on what the test shows, fix any remaining issues:
   - Wrong MB relation type strings in the filter list
   - Discogs search returning no results (title normalization)
   - Any other gaps between what the APIs return vs what the code expects

4. Verify generate-registration-files.js produces valid CSV output with
   at least one enriched track (write a unit test or just log the output)

5. git add, git commit -m "fix: verified writer enrichment against live MB+Discogs APIs"
   git push origin release/fulfillment-layer-v1

6. vercel --prod --force

7. Confirm: hit musigod.com/catalog-enrichment with artist "Esham",
   admin key mg-admin-2026, and verify writers > 0 in the result

## Constraints
- Stay in C:\musigod-deploy — do not touch any other repo
- No Supabase JS client anywhere — raw fetch with apikey + Authorization headers
- DISCOGS_TOKEN env var is set in Vercel (use process.env.DISCOGS_TOKEN in prod,
  can be empty string for local test)
- MB User-Agent header: "MusiGod-CatalogEnricher/1.0 +https://musigod.com"
- Rate limit: 500ms between MB calls, 1100ms between Discogs calls
