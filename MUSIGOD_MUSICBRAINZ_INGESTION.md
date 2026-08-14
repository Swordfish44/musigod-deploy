# MusiGod — MusicBrainz Open Data Ingestion

MusicBrainz is Layer 0 metadata for the MusiGod rights graph: stable identifiers (MBIDs),
recording-to-work relationships, and entity disambiguation that anchors every downstream
enrichment source (Discogs, Genius, manual).

---

## Architecture

```
MusicBrainz data source
  (MB API  ←  already live via lib/enrich-catalog.js)
  (MB dump ←  bulk import, requires local dump files)
      │
      ▼
mb_staging schema in Supabase
  artists_v1, recordings_v1, works_v1, releases_v1
  release_groups_v1, isrcs_v1, iswcs_v1, relationships_v1
  ingestion_state_v1  (checkpoint / resume)
      │
      ▼
Entity resolution  (lib/mb-entity-resolver.js)
  mb_staging.entity_matches_v1
  confidence tiers: 1.0 / 1.0 / 0.95 / 0.70–0.89
      │
      ▼ (human review gate at confidence < 0.95)
      │
      ▼
Canonical MusiGod rights graph
  catalog_enriched_tracks_v1 (existing)
  graph schema nodes/edges (existing)
```

Raw MusicBrainz data remains in `mb_staging` until entity resolution and (for
matches below 0.95 confidence) explicit human review. Nothing is auto-merged
into the canonical graph without a deterministic identifier match.

---

## Schema Changes

**New schema:** `mb_staging`

| Table | Purpose |
|---|---|
| `mb_staging.artists_v1` | MB artists (person, group, etc.) |
| `mb_staging.artist_aliases_v1` | All known alternate names per artist |
| `mb_staging.recordings_v1` | Specific audio performances |
| `mb_staging.isrcs_v1` | Sound recording identifiers (ISRC) |
| `mb_staging.works_v1` | Abstract compositions |
| `mb_staging.iswcs_v1` | Composition identifiers (ISWC) |
| `mb_staging.releases_v1` | Specific product editions (albums, singles) |
| `mb_staging.release_groups_v1` | Abstract album groupings |
| `mb_staging.relationships_v1` | recording→work, artist→work, etc. |
| `mb_staging.ingestion_state_v1` | Checkpoint / resume state per entity type |
| `mb_staging.entity_matches_v1` | Candidate links MB ↔ MusiGod entities |

Migration: `supabase/migrations/20260809000000_mb_staging_schema_v1.sql`

**PostgREST access:** After applying the migration, add `mb_staging` to
**Settings → API → Extra search path** in the Supabase dashboard so PostgREST
routes `Accept-Profile: mb_staging` requests correctly.

---

## Source Files

| File | Role |
|---|---|
| `lib/mb-dump-parser.js` | Streaming TSV parser for MB dump files |
| `lib/mb-entity-resolver.js` | Confidence-scored entity resolution |
| `lib/mb-staging-writer.js` | Batch upsert to mb_staging via REST |
| `scripts/mb-import.js` | Main CLI (API mode + dump mode) |
| `lib/enrich-catalog.js` | Existing live-API enrichment (unchanged) |

---

## Entity Mappings

| MusicBrainz | MusiGod Staging | MusiGod Canonical |
|---|---|---|
| `recording` | `mb_staging.recordings_v1` | `catalog_enriched_tracks_v1.recording_mbid` |
| `work` | `mb_staging.works_v1` | `catalog_enriched_tracks_v1.iswc` |
| `artist` | `mb_staging.artists_v1` | graph `artist` node |
| `release` | `mb_staging.releases_v1` | `catalog_enriched_tracks_v1.release_mbid` |
| `release-group` | `mb_staging.release_groups_v1` | `catalog_enriched_tracks_v1.release_group_mbid` |
| `ISRC` | `mb_staging.isrcs_v1` | `catalog_enriched_tracks_v1.isrcs[]` |
| `ISWC` | `mb_staging.iswcs_v1` | `catalog_enriched_tracks_v1.iswc` |
| composer/lyricist rels | `mb_staging.relationships_v1` | `catalog_enriched_tracks_v1.writers[]` |

**Distinction preserved:** recordings (specific performances) are never stored as
works (abstract compositions). They have separate MBIDs and separate staging tables.

---

## Matching Strategy

Confidence tiers in `entity_matches_v1.confidence`:

| Method | Confidence | Notes |
|---|---|---|
| `isrc_exact` | 1.000 | ISRC → mb_staging.isrcs_v1 exact match |
| `mbid_direct` | 1.000 | recording_mbid already in our data |
| `iswc_exact` | 0.950 | ISWC → mb_staging.iswcs_v1 exact match |
| `name_fuzzy` | 0.700–0.890 | Trigram Jaccard on title + optional duration bonus |

**Ranking:** identifier matches always outrank text matches. A fuzzy match is
never promoted over an identifier match for the same track.

**No auto-promotion below 0.95.** All `name_fuzzy` matches sit in staging with
`review_status = 'pending'` until a human approves them via `review_status = 'approved'`.

**Artist collision guard:** if two different MB artists share a name, both are
kept as separate staging rows (distinct `mb_artist_id`). They are never merged
without a MBID-level match.

---

## Import Commands

### Prerequisites

```powershell
# .env file must have:
SUPABASE_SERVICE_ROLE_KEY=<service-role-key>
# SUPABASE_URL defaults to https://uykzkrnoetcldeuxzqyy.supabase.co
```

### API mode (immediate — no dump download required)

Pulls data from the MusicBrainz API for all artists already in `catalog_enriched_tracks_v1`.

```bash
# All entities for all known artists + entity resolution
npm run musicbrainz:import:all

# Single artist (useful for testing)
node scripts/mb-import.js --artists --recordings --works --artist-name "Esham"

# Entity resolution only (after staging is populated)
npm run musicbrainz:resolve

# Dry-run (no writes)
npm run musicbrainz:dry-run

# Resume after interruption
node scripts/mb-import.js --all --resume
```

**Rate limit:** MB API allows 1 req/sec with a proper User-Agent. The script
uses 1.1s per request. For 50 artists × ~25 release groups × ~3 API calls
each ≈ 4,000 requests ≈ ~75 minutes. Run overnight or in a background process.

### THE REAL FIRST IMPORT COMMAND

After applying the migration and confirming env vars are set:

```bash
node scripts/mb-import.js --artists --recordings --works --releases --relationships --resolve
```

To target only the Esham test catalog first:

```bash
node scripts/mb-import.js --artists --recordings --works --releases --relationships --resolve --artist-name "Esham"
```

### Dump mode (bulk — for full MB dataset)

Use when you need to ingest millions of records without API rate limits.

#### 1. Download MB dump (one-time, ~25 GB compressed)

```bash
# Download latest full export
wget -r -l1 --no-parent -A '*.tar.bz2' \
  https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST/

# Extract (requires ~150 GB free disk)
tar xjf mbdump.tar.bz2 -C data/musicbrainz/dumps/
```

The key dump files needed:
- `mbdump/artist` — all artists
- `mbdump/recording` — all recordings
- `mbdump/work` — all works
- `mbdump/release` — all releases
- `mbdump/isrc` — all ISRCs
- `mbdump/iswc` — all ISWCs (inside `mbdump-derived.tar.bz2`)
- `mbdump/l_recording_work` — recording→work links
- `mbdump/l_artist_work` — composer/lyricist links

#### 2. Import entities (order matters for FK consistency)

```bash
# Artists first
node scripts/mb-import.js --artists --dump-file data/musicbrainz/dumps/mbdump/artist

# Then recordings
node scripts/mb-import.js --recordings --dump-file data/musicbrainz/dumps/mbdump/recording

# Then works
node scripts/mb-import.js --works --dump-file data/musicbrainz/dumps/mbdump/work

# Then releases
node scripts/mb-import.js --releases --dump-file data/musicbrainz/dumps/mbdump/release
```

#### 3. Resume interrupted dump import

```bash
node scripts/mb-import.js --recordings --dump-file data/musicbrainz/dumps/mbdump/recording --resume
```

---

## Incremental Updates

MusicBrainz publishes incremental replication packets at:
`https://data.metabrainz.org/pub/musicbrainz/data/replication/`

Each packet covers ~1 hour of edits. Format: JSON change feeds.

**Current status:** Replication state table (`ingestion_state_v1`) and checkpoint
infrastructure are in place. The actual replication packet downloader is not yet
implemented. **Next implementation step:**

1. Download `replication-1.tar.bz2`, `replication-2.tar.bz2`, … from the MB CDN.
2. Parse the JSON change records (INSERT/UPDATE/DELETE per table).
3. Apply changes to `mb_staging` using upsertBatch with `resolution=merge-duplicates`.
4. Re-run entity resolution for any recording/work that changed.
5. Save the highest processed packet number to `ingestion_state_v1.metadata.last_replication_packet`.

MusicBrainz replication packets are ~1 MB each. A daily cron that downloads
and applies the last 24 packets (~24 MB) keeps the staging data within one day
of live MB state with negligible infrastructure cost.

---

## Verification / Record Counts

```sql
-- Count rows per staging table
SELECT 'artists'        AS tbl, count(*) FROM mb_staging.artists_v1
UNION ALL
SELECT 'recordings',             count(*) FROM mb_staging.recordings_v1
UNION ALL
SELECT 'works',                  count(*) FROM mb_staging.works_v1
UNION ALL
SELECT 'releases',               count(*) FROM mb_staging.releases_v1
UNION ALL
SELECT 'isrcs',                  count(*) FROM mb_staging.isrcs_v1
UNION ALL
SELECT 'iswcs',                  count(*) FROM mb_staging.iswcs_v1
UNION ALL
SELECT 'relationships',          count(*) FROM mb_staging.relationships_v1
UNION ALL
SELECT 'entity_matches',         count(*) FROM mb_staging.entity_matches_v1;

-- Pending matches by confidence tier
SELECT
  match_method,
  count(*) AS candidates,
  avg(confidence)::numeric(4,3) AS avg_confidence,
  count(*) FILTER (WHERE confidence >= 0.95) AS auto_promotable
FROM mb_staging.entity_matches_v1
WHERE review_status = 'pending'
GROUP BY match_method
ORDER BY avg_confidence DESC;

-- Ingestion progress
SELECT entity_type, import_mode, status, total_processed, total_errors, updated_at
FROM mb_staging.ingestion_state_v1
ORDER BY updated_at DESC;
```

---

## Rolling Back Staging Data

Staging data is isolated in the `mb_staging` schema. It has no foreign-key
relationship to the canonical graph schema — dropping or truncating staging
tables has zero impact on production artist data.

```sql
-- Truncate all staging tables (safe rollback of import run)
TRUNCATE mb_staging.entity_matches_v1,
         mb_staging.relationships_v1,
         mb_staging.iswcs_v1,
         mb_staging.isrcs_v1,
         mb_staging.releases_v1,
         mb_staging.release_groups_v1,
         mb_staging.works_v1,
         mb_staging.recordings_v1,
         mb_staging.artist_aliases_v1,
         mb_staging.artists_v1,
         mb_staging.ingestion_state_v1
  RESTART IDENTITY CASCADE;
```

To re-run after rollback: `node scripts/mb-import.js --all` (no `--resume`).

---

## Operational Requirements

| Requirement | Detail |
|---|---|
| Node.js | v18+ (v24 in production) |
| Supabase | Service role key with RLS bypass |
| Disk (dump mode) | ~150 GB for full MB extract |
| Disk (API mode) | Negligible — data goes direct to Supabase |
| Memory | <512 MB — streaming parser holds one batch at a time |
| Time (API mode) | ~2–4 hours per 50 artists (MB rate limit) |
| Time (dump mode) | ~1–4 hours per entity type depending on table size |

---

## Licensing Notes

| Data | License |
|---|---|
| MusicBrainz database content | **CC0 (public domain)** — no attribution required |
| MusicBrainz trademarks | Not CC0 — do not display MB branding without permission |
| ISRC, ISWC identifiers | The identifiers themselves are public standards |

Every row stored in `mb_staging` carries `provenance.source = 'musicbrainz'`
and `provenance.data_license = 'CC0'` for auditable provenance chain tracking.

MusiGod's downstream use (displaying writer credits to artists, registering
with PROs, issuing licenses) is compatible with CC0.

---

## Known Limitations

1. **Dump-mode relationship tables** (`l_recording_work`, `l_artist_work`) require
   a join with the `link` and `link_type` tables to resolve the relationship name
   from an integer FK. The current dump parser ingests entities; relationship
   ingestion from dump files requires a multi-pass ETL (entity tables first,
   then relationship tables with a lookup map). API mode handles this correctly.

2. **MB MBID redirects:** When MB merges two entities, the old MBID redirects to
   the new one. The current schema does not have a `mb_redirects_v1` table (noted
   in `docs/musicbrainz-ingestion-plan.md` as future work). Until that is added,
   a stale MBID in `catalog_enriched_tracks_v1` may not match any row in
   `mb_staging.recordings_v1` after a MB merge event.

3. **Artist name disambiguation:** MB uses a `comment` field (e.g., "US rapper")
   to disambiguate artists with the same name. This is stored in `artists_v1.comment`
   but not yet surfaced in the entity resolution scoring. Two artists named "Ghost"
   will both be candidate-matched to any MusiGod track by "Ghost" — human review
   of the disambiguation comment is required for low-confidence matches.

4. **Incremental replication** is architecturally prepared (ingestion_state_v1
   has the checkpoint fields) but the replication packet downloader is not yet
   implemented. See "Incremental Updates" section above.

5. **Supabase row limits:** The free/pro Supabase plan has row limits. The full
   MB dataset (~200M recordings, ~37M works) cannot fit in a Supabase instance.
   The staging schema is designed for **artist-scoped subsets** — all recordings
   for MusiGod's enrolled artists, not the entire MB catalog. For full-catalog
   analysis, use the local Docker staging environment in
   `data/musicbrainz/docker-compose.musicbrainz.yml`.

---

## Next Steps

1. **Apply the migration** via SQL Editor or `supabase db push`:
   `supabase/migrations/20260809000000_mb_staging_schema_v1.sql`

2. **Add mb_staging to PostgREST exposed schemas** in Supabase Settings → API.

3. **Run the first import** for the Esham test catalog:
   ```bash
   node scripts/mb-import.js --artists --recordings --works --releases --relationships --resolve --artist-name "Esham"
   ```

4. **Review entity matches** in the Supabase table editor or via SQL:
   ```sql
   SELECT * FROM mb_staging.entity_matches_v1 WHERE review_status = 'pending' ORDER BY confidence DESC LIMIT 50;
   ```

5. **Implement replication packet downloader** for daily incremental sync.

6. **Implement mb_redirects_v1** table for MBID redirect tracking.

7. **Promote high-confidence matches** once reviewed:
   ```sql
   UPDATE mb_staging.entity_matches_v1
   SET review_status = 'approved', reviewed_by = 'naim'
   WHERE confidence = 1.0 AND match_method IN ('isrc_exact', 'mbid_direct');
   ```
