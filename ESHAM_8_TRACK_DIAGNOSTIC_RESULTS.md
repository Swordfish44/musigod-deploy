# Esham Zero-Writer Track Diagnostic Results

**Diagnostic date:** 2026-07-29  
**Script:** `scripts/diagnose-zero-writer-tracks.js`  
**Mode:** Read-only — zero database writes  
**Test suite:** 421/421 passed (all 8 test files)  
**Supabase project:** `uykzkrnoetcldeuxzqyy`  
**Genius dry run v1 (exact only):** 2026-07-29 — 8/8 false negatives (see note below)  
**Genius dry run v2 (fuzzy+corroboration):** 2026-07-29 — 5/8 FOUND_UNCREDITED; 3/8 NOT_FOUND  
**Genius dry run v3 (classified states):** 2026-07-29 — FOUND_UNCREDITED=5, NOT_FOUND=3, FOUND_WITH_WRITERS=0

---

## Summary

All 8 zero-writer Esham tracks require manual research for writer credits. The
three-tier enrichment pipeline (MusicBrainz → Discogs → Genius) and all prior
enrichment job CSVs contain no writer data for these tracks.

The initial Genius dry run (v1) reported 8/8 "not found" — this was a **false
negative**. The v1 code treated "song found but no writers listed" the same as
"song not found." The v2 fuzzy run with proper title matching and raw-hit
surfacing revealed that 5 of the 8 songs exist on Genius with EXACT title
matches but with zero writers credited on their Genius pages.

| Metric | Value |
|--------|-------|
| Esham tracks in catalog | 196 |
| Tracks with writer data | 188 |
| Tracks without writer data | **8** |
| Auto-resolvable from prior enrichment CSVs | 0 |
| FOUND_UNCREDITED on Genius (page confirmed, no writers) | **5** |
| NOT_FOUND on Genius (not indexed by title) | **3** |
| FOUND_WITH_WRITERS on Genius | **0** |
| Requires manual PRO/Discogs research | **8** |

---

## False-Negative Root Cause

The original `lib/genius.js` `getGeniusWriters()` returns `[]` when
`writer_artists` is empty on the Genius page. The v1 diagnostic treated an empty
writer list as "not found." All 5 found tracks return `writer_artists: []` on
Genius — Genius has the song page but has not populated writer credits.

The v3 diagnostic introduces three explicit states enforced by `classifyGeniusResult()`:

| `geniusStatus` | Meaning |
|----------------|---------|
| `FOUND_WITH_WRITERS` | Song found AND `writer_artists` non-empty — directly resolvable |
| `FOUND_UNCREDITED` | Song found BUT `writer_artists: []` — page confirmed, credits not populated |
| `NOT_FOUND` | No song matched any search query |

A result with `found=true, writers=[]` is `FOUND_UNCREDITED`, never `NOT_FOUND`.
This is enforced in `classifyGeniusResult()` and covered by regression tests in
`tests/genius-search-classify.test.js` (32 assertions, 32 passed).

All 8 tracks fall into `FOUND_UNCREDITED` (5) or `NOT_FOUND` (3).
`FOUND_WITH_WRITERS` = 0 — no Genius page for any of the 8 has writer credits populated.

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
| **Genius status** | `FOUND_UNCREDITED` — EXACT title match, no writers on Genius page |
| **Genius evidence URL** | https://genius.com/Esham-as-i-rock-n-roll-lyrics |
| **Genius album** | "Bootleg" (From The Lost Vault) Vol. 1 — same release, different title format |

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
| **Genius status** | `FOUND_UNCREDITED` — EXACT title match, no writers on Genius page |
| **Genius evidence URL** | https://genius.com/Esham-monkey-mix-lyrics |
| **Genius album** | "Bootleg" (From The Lost Vault) Vol. 1 — same release, different title format |

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
| **Genius status** | `FOUND_UNCREDITED` — EXACT title match, no writers on Genius page |
| **Genius evidence URL** | https://genius.com/Esham-price-on-ya-head-lyrics |
| **Genius album** | "Bootleg" (From The Lost Vault) Vol. 1 — same release, different title format |

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
| **Genius status** | `FOUND_UNCREDITED` — EXACT title match, no writers on Genius page |
| **Genius evidence URL** | https://genius.com/Esham-suffer-the-consequences-lyrics |
| **Genius album** | "Bootleg" (From The Lost Vault) Vol. 1 — same release, different title format |

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
| **Genius status** | `FOUND_UNCREDITED` — EXACT title match, no writers on Genius page |
| **Genius evidence URL** | https://genius.com/Esham-helterskkkellter-lyrics |
| **Genius album** | No album listed on the Genius song page |

**Title/album spelling note:** The Genius *album* URL is
`genius.com/albums/Esham/Hellterskkkelter` (double-l, double-k), while the Genius
*track* URL uses `helterskkkellter` — matching our DB title exactly. The v1 run
returning "not found" was a false negative caused by the `writer_artists: []`
→ "not found" mapping, not a title mismatch.

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/ad23ceab-999f-4da8-b9a6-65f122b47254
- BMI repertoire: search title "Helterskkkellter" + ISRC USASN0802426
- Discogs: search "Esham" + "Helterskkkelter" — 1993 release may have scanned liner notes
- Use exact DB spelling in all searches (three k's, double l in second half)

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
| **Genius status** | `NOT_FOUND` — not indexed by title; closest hit: `"? (Mail Dominance Track 16)"` |
| **Genius hint URL** | https://genius.com/Esham-mail-dominance-track-16-lyrics |

**Note:** Likely a cover of "California Dreamin'" by The Mamas & The Papas
(John Phillips / Michelle Phillips, 1965). Genius lists *Mail Dominance* track 16
as `"?"` — may be this song under an unknown track number. Confirm via liner notes
or ISRC lookup, then enter original writers via `lib/overrides.js`.

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/a9a482bb-2df1-485a-a444-b0fbddeae5fa
- BMI repertoire: search title "California Dreamin" + ISRC USASN0802518
- Genius Mail Dominance album page for track listing and position

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
| **Genius status** | `NOT_FOUND` — not indexed by title; closest hit: `"? (Mail Dominance Track 16)"` |
| **Genius hint URL** | https://genius.com/Esham-mail-dominance-track-16-lyrics |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/88935d29-9e53-4909-8cae-fe311b86cbed
- BMI repertoire: search title "Ozonelayer" + ISRC USASN0802515
- ASCAP ACE: search title "Ozonelayer" + artist "Esham"
- Genius Mail Dominance album page for track listing and position

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
| **Genius status** | `NOT_FOUND` — not indexed by title; closest hit: `"? (Mail Dominance Track 16)"` |
| **Genius hint URL** | https://genius.com/Esham-mail-dominance-track-16-lyrics |

**Recommended research queries:**
- MusicBrainz: https://musicbrainz.org/recording/725e4a0d-fa62-4cbd-9b20-7cc37c77bf20
- BMI repertoire: search title "Youknowucan'tride" + ISRC USASN0802508
- ASCAP ACE: search title "Youknowucan'tride" + artist "Esham"
- Try alternate spellings: "You Know U Can't Ride"
- Genius Mail Dominance album page for track listing and position

---

## Release Grouping

Three distinct releases account for all 8 tracks. A single Discogs or liner-note
lookup per release could unblock multiple tracks at once.

| Release | Year | Tracks in this set | Genius status |
|---------|------|-------------------|---------------|
| Bootleg: From the Lost Vault, Volume 1 | 2000 | 4 (tracks 1–4) | `FOUND_UNCREDITED` — 4 pages confirmed, 0 writers |
| Helterskkkelter | 1993 | 1 (track 5) | `FOUND_UNCREDITED` — page confirmed, 0 writers |
| Mail Dominance | 1999 | 3 (tracks 6–8) | `NOT_FOUND` — unlisted as "?" on album page |

---

## Genius v3 Dry-Run Detail (2026-07-29)

### Classification logic

`classifyGeniusResult(result)` in `scripts/diagnose-zero-writer-tracks.js`:

```
found=false or null  →  NOT_FOUND
found=true, writers.length > 0  →  FOUND_WITH_WRITERS
found=true, writers.length === 0  →  FOUND_UNCREDITED   ← never NOT_FOUND
```

Regression tests in `tests/genius-search-classify.test.js` cover all three
states across 32 assertions (32 passed).

### Matching strategy

1. **Exact** — `normTitle(geniusTitle) === normTitle(trackTitle)` (strip non-alnum, lowercase)
2. **Normalized** — `collapseRepeats(normTitle(...))` matches (collapses consecutive repeated
   characters: `"skkkk"` → `"sk"`, `"ll"` → `"l"`)
3. **Substring** — one normalized form contains the other (≥5 chars)
4. **Artist guard** — `primary_artist.name` must normalize to include `"esham"`
5. **Album corroboration** — Genius `album.name` vs our `release_title` (normalized + collapsed)
6. **Raw-hit surfacing** — when `NOT_FOUND`, top Esham hits from all queries are shown

### Per-track results

| Track | Genius title | Confidence | `geniusStatus` | Writers on Genius |
|-------|-------------|------------|----------------|-------------------|
| As I Rock-N-Roll | "As I Rock-N-Roll" | EXACT | `FOUND_UNCREDITED` | 0 |
| Monkey Mix | "Monkey Mix" | EXACT | `FOUND_UNCREDITED` | 0 |
| Price on Ya Head | "Price On Ya Head" | EXACT | `FOUND_UNCREDITED` | 0 |
| Suffer the Consequences | "Suffer the Consequences" | EXACT | `FOUND_UNCREDITED` | 0 |
| Helterskkkellter | "Helterskkkellter" | EXACT | `FOUND_UNCREDITED` | 0 |
| California Dreamin | — | — | `NOT_FOUND` | — |
| Ozonelayer | — | — | `NOT_FOUND` | — |
| Youknowucan'tride | — | — | `NOT_FOUND` | — |

### Album title format difference — not a real mismatch

For all four *Bootleg: From the Lost Vault, Volume 1* tracks, Genius lists the
album as `"Bootleg" (From The Lost Vault) Vol. 1`. This is the same release with
punctuation/capitalization differences. The corroboration algorithm flags it
as a mismatch because the normalized strings differ
(`bootlegfromthelostvaultvolume1` vs `bootlegfromthelostvault1`). A human
reviewer can confirm these are the same release.

### Zero DB writes

All Genius calls were read-only search and song-detail GET requests. No
`writer_artists` data was written to any table.

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

**Link breakdown by `node_role`** (the 31 rows across 3 tracks):

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

## Next Steps for the 8 Tracks

All automated enrichment sources are exhausted for writer credits. Genius
confirms 5 song pages exist but has no writers populated. Manual research is
the only remaining path.

### Tracks 1–4 (Bootleg: From the Lost Vault, Volume 1)

One Discogs lookup for the release may credit all 4 tracks at once. The
Genius pages are confirmed — use them to verify track identity before entering
manual credits into `lib/overrides.js`.

### Track 5 (Helterskkkellter)

The Genius page exists at the URL above. No writers listed there. BMI/ASCAP
ISRC search (USASN0802426) is the next best path.

### Tracks 6–8 (Mail Dominance)

Genius lists some *Mail Dominance* tracks as `"? (Mail Dominance Track N)"` —
the album page may identify track positions. Cross-reference the ISRC values
(USASN0802518, USASN0802515, USASN0802508) via BMI/ASCAP. "California Dreamin"
is likely a cover (John Phillips / Michelle Phillips) — confirm then enter
directly via `lib/overrides.js`.

### Applying credits

Once any credit is confirmed from an authoritative source:

```js
// lib/overrides.js — add entry with source documentation
```

The next enrichment run will pick it up. Do not write directly to
`catalog_enriched_tracks_v1` — use the enrichment pipeline.
