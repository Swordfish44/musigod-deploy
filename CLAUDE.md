# MusiGod Catalog Enrichment — Fix Brief

## Context
- Repo: C:\musigod-deploy, branch release/fulfillment-layer-v1
- Deploy: `vercel --prod --force` (already in correct dir, PowerShell uses `;` not `&&`)
- Live site: musigod.com/catalog-enrichment

## The Problem
Catalog enrichment runs clean (200, ~40s, no errors) but returns 0 writers for every track.
179 tracks processed for Esham, 0 ready to register.

## What Vercel Logs Show
- ~56 MusicBrainz API calls fire and succeed
- ZERO Discogs API calls (confirmed from External APIs panel)
- Function completes, writes DONE to Supabase
- Console: `[enrich] Enriched 17...` then silence

## Root Cause Hypothesis
1. MB work relation type filter is wrong — we filter for `['composer','lyricist','writer',...]`
   but MB may return different type strings for Esham's works (e.g. `'performer'`, `'written by'`)
2. Discogs fallback never fires — either the condition is wrong or it's being short-circuited

## Files to Read First
- lib/enrich-catalog.js
- lib/discogs.js
- lib/generate-registration-files.js
- api/enrich-artist.js

## Fix Steps
1. Write a quick test script that hits MB directly for a known Esham recording
   and logs ALL relation types returned on the work object
   (use fetch, User-Agent: `MusiGod/1.0 +https://musigod.com`)

2. Fix the writer relation type filter in enrich-catalog.js to match real MB types

3. Verify Discogs fallback in getDiscogsWritersForTrack() actually triggers
   when MB returns no writers — add a console.log to confirm

4. Verify lib/generate-registration-files.js works — csv-stringify was replaced
   with inline CSV code, make sure the stringify() function signature matches usage

5. Deploy: `vercel --prod --force`

6. Run enrichment for Esham — confirm writers > 0

## Constraints
- Supabase project: uykzkrnoetcldeuxzqyy
- NO Supabase JS client — raw fetch with apikey/Authorization headers only
- DISCOGS_TOKEN is set in Vercel env
- No && in PowerShell — use semicolons
