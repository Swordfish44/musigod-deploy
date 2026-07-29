# Esham Zero-Writer Track Diagnostic Results

**Diagnostic date:** 2026-07-29  
**Script:** `scripts/diagnose-zero-writer-tracks.js`  
**Mode:** Read-only — zero database writes  
**Test suite:** 421/421 passed (all 8 test files)  
**Supabase project:** `uykzkrnoetcldeuxzqyy`  
**Genius dry run:** completed 2026-07-29 — token present, 8/8 tracks searched, 0 found

---

## Summary

All 8 zero-writer Esham tracks are **genuine hard cases**, not regressions. The
three-tier enrichment pipeline (MusicBrainz → Discogs → Genius) already ran and
found no writer credits for these tracks. They were never enriched — they did not
regress from a previously enriched state.

| Metric | Value |
|--------|-------|
| Esham tracks in catalog | 196 |
| Tracks with writer data | 188 |
| Tracks without writer data | **8** |
| Auto-resolvable from prior enrichment CSVs | 0 |
| Auto-resolvable from Genius (token present, 8 queried) | **0** |
| Requires manual research | **8** |

---

## The 8 Zero-Writer Tracks

### [1] As I Rock-N-Roll

| Field | Value |
|-------|-------|
| **Track ID** | `f5af75de-9774-4013-b7f8-2768e9cb01e8` |
| **Release** | Bootleg: From the Lost Vault, Volume 1 |
| **Year** | 2000 |
| **Recording MBID** | `dd1ac7f5-2a30-4aad-9154-de7b24d7a67b` |
| **ISRC** | USASN0802524 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/dd1ac7f5-2a30-4aad-9154-de7b24d7a67b
- BMI repertoire: search title "As I Rock-N-Roll" + ISRC USASN0802524
- ASCAP ACE: search title "As I Rock-N-Roll" + artist "Esham"

---

### [2] Monkey Mix

| Field | Value |
|-------|-------|
| **Track ID** | `99316837-225e-48cb-835c-f886937a17d4` |
| **Release** | Bootleg: From the Lost Vault, Volume 1 |
| **Year** | 2000 |
| **Recording MBID** | `ec1fe701-6449-4e52-895a-53348465600b` |
| **ISRC** | (none) |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/ec1fe701-6449-4e52-895a-53348465600b
- Discogs: search "Esham" + "Bootleg: From the Lost Vault" for track listing with credits
- BMI repertoire: search title "Monkey Mix" + artist "Esham"
- Note: no ISRC — MB and Discogs are the primary lookup paths

---

### [3] Price on Ya Head

| Field | Value |
|-------|-------|
| **Track ID** | `44608cf1-fdbf-465a-aa87-ad0ace984135` |
| **Release** | Bootleg: From the Lost Vault, Volume 1 |
| **Year** | 2000 |
| **Recording MBID** | `9a824b1e-a127-4953-aada-cda10b89b893` |
| **ISRC** | USASN0802533 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/9a824b1e-a127-4953-aada-cda10b89b893
- BMI repertoire: search title "Price on Ya Head" + ISRC USASN0802533
- ASCAP ACE: search title "Price on Ya Head" + artist "Esham"

---

### [4] Suffer the Consequences

| Field | Value |
|-------|-------|
| **Track ID** | `24f5e154-6869-4815-b1bd-f1bea843c28a` |
| **Release** | Bootleg: From the Lost Vault, Volume 1 |
| **Year** | 2000 |
| **Recording MBID** | `eccbf63f-c7bd-4471-8197-d02095ee91dd` |
| **ISRC** | USASN0802537 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/eccbf63f-c7bd-4471-8197-d02095ee91dd
- BMI repertoire: search title "Suffer the Consequences" + ISRC USASN0802537
- ASCAP ACE: search title "Suffer the Consequences" + artist "Esham"

---

### [5] Helterskkkellter

| Field | Value |
|-------|-------|
| **Track ID** | `a88aa8d4-7ef3-42fd-9ada-6c0a9982fdc7` |
| **Release** | Helterskkkelter |
| **Year** | 1993 |
| **Recording MBID** | `ad23ceab-999f-4da8-b9a6-65f122b47254` |
| **ISRC** | USASN0802426 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/ad23ceab-999f-4da8-b9a6-65f122b47254
- BMI repertoire: search title "Helterskkkellter" + ISRC USASN0802426
- Discogs: search "Esham" + "Helterskkkelter" — 1993 album may have physical liner notes scanned
- Note: unusual spelling of title (three k's) — use exact string in all searches

---

### [6] California Dreamin

| Field | Value |
|-------|-------|
| **Track ID** | `06b761ce-a9f8-4d6a-b7fa-7f5531c409cb` |
| **Release** | Mail Dominance |
| **Year** | 1999 |
| **Recording MBID** | `a9a482bb-2df1-485a-a444-b0fbddeae5fa` |
| **ISRC** | USASN0802518 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/a9a482bb-2df1-485a-a444-b0fbddeae5fa
- BMI repertoire: search title "California Dreamin" + ISRC USASN0802518
- Note: likely a Mamas & the Papas cover (John Phillips / Michelle Phillips) — check if the
  original work relationship exists in MB and whether Esham's version credits original writers

---

### [7] Ozonelayer

| Field | Value |
|-------|-------|
| **Track ID** | `c6310472-e825-4909-8ac8-334a075b9c58` |
| **Release** | Mail Dominance |
| **Year** | 1999 |
| **Recording MBID** | `88935d29-9e53-4909-8cae-fe311b86cbed` |
| **ISRC** | USASN0802515 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/88935d29-9e53-4909-8cae-fe311b86cbed
- BMI repertoire: search title "Ozonelayer" + ISRC USASN0802515
- ASCAP ACE: search title "Ozonelayer" + artist "Esham"

---

### [8] Youknowucan'tride

| Field | Value |
|-------|-------|
| **Track ID** | `37d6f798-1630-43fb-acbe-4f52dd54492c` |
| **Release** | Mail Dominance |
| **Year** | 1999 |
| **Recording MBID** | `725e4a0d-fa62-4cbd-9b20-7cc37c77bf20` |
| **ISRC** | USASN0802508 |
| **Enrichment source** | (none — never enriched) |
| **Pipeline error** | No work in MB; no credits on Discogs or Genius |
| **Prior CSV match** | Not found in any of 10 DONE enrichment jobs |
| **Genius dry-run result** | Not found (2026-07-29) |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/725e4a0d-fa62-4cbd-9b20-7cc37c77bf20
- BMI repertoire: search title "Youknowucan'tride" + ISRC USASN0802508
- ASCAP ACE: search title "Youknowucan'tride" + artist "Esham"
- Note: condensed title with apostrophe — try alternate spellings ("You Know U Can't Ride")

---

## Release Grouping

Three distinct releases account for all 8 tracks. A single Discogs or liner-note
lookup per release could unblock multiple tracks at once.

| Release | Year | Tracks in this set |
|---------|------|-------------------|
| Bootleg: From the Lost Vault, Volume 1 | 2000 | 4 (tracks 1–4 above) |
| Helterskkkelter | 1993 | 1 (track 5) |
| Mail Dominance | 1999 | 3 (tracks 6–8) |

---

## Enrichment Evidence

10 DONE enrichment jobs were scanned. The two most recent jobs (2026-07-12 and
2026-07-13) indexed 188 tracks total with prior writer data — every track
currently enriched in the catalog. None of the 8 tracks appeared in any job CSV,
confirming they were not enriched by any prior pipeline run.

| Job date | Tracks indexed (cumulative new) |
|----------|---------------------------------|
| 2026-07-13 | 148 |
| 2026-07-12 | 40 |
| 2026-07-08 | 0 |
| 2026-06-12 | 0 |
| 2026-06-11 (×4) | 0 each |
| 2026-06-08 | 0 |
| 2026-06-07 | 0 |

---

## Graph Sync Gap

| Metric | Value |
|--------|-------|
| Total Esham tracks in `catalog_enriched_tracks_v1` | 196 |
| Tracks with `graph_catalog_links_v1` entries | **3** |
| Total link rows in `graph_catalog_links_v1` | **31** |
| Tracks with **no** graph links | **193** |

**Link breakdown by `node_role`** (the 31 rows on 3 tracks):

| node_role | rows |
|-----------|------|
| creator | 21 |
| recording | 4 |
| composition | 3 |
| artist | 3 |

**All 31 rows were created by `fn_sync_track_to_graph`** (the `linked_by` column
value on every row).

### Root cause

Two separate graph paths exist and are **not connected**:

**Path 1 — live enrichment pipeline** (`api/graph-sync.js`):  
→ calls `rpc_upsert_recording_enrichment()`  
→ writes to `graph.nodes` + `works.recordings` (non-public schema)  
→ does **not** touch `graph_catalog_links_v1`

**Path 2 — catalog bridge** (SQL functions in public schema):  
→ `fn_sync_track_to_graph(track_id)` or `fn_backfill_catalog_to_graph()`  
→ writes to `graph_catalog_links_v1`, `graph_nodes_v1`, `graph_edges_v1`  
→ was called manually for 3 tracks at some earlier point

193 tracks went through Path 1 only. They exist in `graph.nodes` but not in
`graph_catalog_links_v1`.

### Fix (not applied — requires human action)

Run in Supabase SQL Editor (session mode, not transaction pooler):

```sql
SELECT fn_backfill_catalog_to_graph();
```

This is idempotent and safe to run multiple times. No migration required — the
function is already deployed. Closes the 193-track gap.

---

## Genius Dry-Run Results (2026-07-29)

Genius was queried live (read-only) with a valid token for all 8 tracks. Every
query returned "not found". The three-tier pipeline (MusicBrainz → Discogs →
Genius) is now **fully exhausted** for these tracks. Automated recovery is not
possible without a new data source.

| Track | Genius result |
|-------|--------------|
| As I Rock-N-Roll | not found |
| Monkey Mix | not found |
| Price on Ya Head | not found |
| Suffer the Consequences | not found |
| Helterskkkellter | not found |
| California Dreamin | not found |
| Ozonelayer | not found |
| Youknowucan'tride | not found |

Zero database writes. Zero credentials exposed.

---

## Next Steps for the 8 Tracks

All automated enrichment sources (MusicBrainz, Discogs, Genius) are exhausted.
Manual research is the only remaining path.

1. **BMI/ASCAP public repertoire search** — use the ISRCs and track titles in the
   per-track tables above. Seven of the 8 tracks have ISRCs, which are the most
   reliable lookup key for PRO repertoire databases.

2. **"California Dreamin"** — almost certainly a cover of the Mamas & the Papas
   song (John Phillips / Michelle Phillips, 1965). The original writers are
   well-documented. Confirm the cover relationship is intentional, then add the
   credits via `lib/overrides.js`.

3. **Release-level Discogs lookup** — one Discogs page per release may credit all
   tracks on that release. Prioritize *Bootleg: From the Lost Vault, Volume 1*
   (unblocks 4 tracks) and *Mail Dominance* (unblocks 3 tracks).

4. **Manual entries** — once credits are confirmed from any authoritative source,
   add them to `lib/overrides.js`. The next enrichment run will pick them up
   without requiring the three-tier pipeline to find them independently.
