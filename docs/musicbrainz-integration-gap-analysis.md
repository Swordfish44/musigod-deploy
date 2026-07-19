# MusicBrainz Integration Gap Analysis
**Branch:** release/fulfillment-layer-v1  
**Date:** 2026-07-09  
**Scope:** Read-only analysis of production codebase. No schema was modified. No data was touched.

---

## 1. Existing Graph Tables, Node Types, Edge Types, Constraints, Indexes, Provenance, and History

### Graph Schema (graph.*)

The graph schema is **not version-controlled** in `supabase/migrations/`. It was applied directly via the Supabase SQL Editor. The following is reconstructed from `api/graph-sync.js`, `scripts/sync-esham-to-graph.js`, and API call patterns in `api/partner/resolve-rights.js`.

#### `graph.nodes` (PostgREST alias: `graph_nodes_v1`)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | gen_random_uuid() |
| `node_type` | TEXT | Enum in practice: artist, creator, work, recording, territory, society, dsp |
| `label` | TEXT | Human-readable display name |
| `external_id` | TEXT | Identifier from the source system |
| `external_id_ns` | TEXT | Namespace: musigod_artist, musigod_catalog, isrc, iswc, iso2, pro, dsp, mbid |
| `properties` | JSONB | Arbitrary key-value bag per node type |
| `created_at` | TIMESTAMPTZ | |
| `updated_at` | TIMESTAMPTZ | |

**Unique constraint:** `(external_id, external_id_ns)` — used by `graph_upsert_node` RPC for idempotent upserts.

RPC `graph_upsert_node(p_node_type, p_label, p_external_id, p_external_ns, p_properties)` returns the UUID of the upserted node. This is the only sanctioned write path.

#### `graph.edges` (PostgREST alias: `graph_edges_v1`)

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK | gen_random_uuid() |
| `from_node_id` | UUID FK → nodes | |
| `to_node_id` | UUID FK → nodes | |
| `edge_type` | TEXT | See edge type inventory below |
| `share_numerator` | NUMERIC | Writer/ownership share numerator |
| `share_denominator` | NUMERIC | Default 100 |
| `confidence` | NUMERIC | 0.0–1.0 |
| `confidence_sources` / `sources` | TEXT[] | Evidence labels: self_reported, musicbrainz, discogs, genius |
| `provenance_ref` | TEXT | Free-form reference (catalog_id, MBID, artist ID) |
| `provenance_url` | TEXT | URL to source evidence |
| `properties` | JSONB | role, needs_confirmation, right_type, territory_ids |
| `status` | TEXT | active / inactive / disputed |
| `effective_from` | TIMESTAMPTZ | |
| `effective_until` | TIMESTAMPTZ | |

**Upsert path:** `graph_upsert_edge` RPC. Manual script (`sync-esham-to-graph.js`) uses `INSERT ... on_conflict=from_node_id,to_node_id,edge_type,status`.

#### Known Active Edge Types

| Edge Type | Direction | Meaning |
|---|---|---|
| `alias_of` | artist → creator | Same human, different role identity |
| `wrote` | creator → work | Authorship, includes share and role |
| `owns_publishing` | creator → work | Publishing ownership, includes share and territory |
| `has_recording` | work → recording | A specific sound recording of the composition |
| `performed` | artist → recording | Performance credit |
| `member_of_society` | creator → society | PRO membership |
| `generates_royalties_from` | recording → dsp | Revenue source linkage |

**Missing edge types for MB:** `published_by` (publisher entity), `released_on` (release node), `distributed_by` (label node).

#### History/Versioning

There is a `graph_edge_history` table referenced architecturally in `CLAUDE.md` ("nodes/edges/history"). No migration file exists for it. Edges have `effective_from`/`effective_until` fields, indicating a temporal validity model. No full audit trigger was found in code — versioning appears structural but is not yet enforced by a trigger.

---

### Works Schema (works.*)

**`works.works_compositions_v1`**

| Column | Notes |
|---|---|
| `node_id` UUID PK/FK | References graph.nodes |
| `iswc` TEXT | ISWC-T identifier |
| `title` TEXT | |
| `work_type` TEXT | original, arrangement, etc. |
| `has_lyrics` BOOLEAN | |
| `public_domain` BOOLEAN | |
| `ascap_id` TEXT | |
| `bmi_id` TEXT | |
| `sesac_id` TEXT | |
| `mlc_work_id` TEXT | |
| `musicbrainz_id` TEXT | **Work-level MBID** (not recording MBID) |
| `copyright_year` TEXT | |
| `copyright_claimant` TEXT | |

**`works.works_recordings_v1`**

| Column | Notes |
|---|---|
| `node_id` UUID PK/FK | References graph.nodes |
| `isrc` TEXT | Single ISRC (not array) |
| `title` TEXT | |
| `version_title` TEXT | |
| `duration_seconds` INTEGER | |
| `release_date` DATE | |
| `album_title` TEXT | Denormalized; no formal release node |
| `track_number` TEXT | |
| `ean_upc` TEXT | |
| `master_rights_holder` TEXT | |
| `neighboring_rights_registered` BOOLEAN | |
| `musicbrainz_recording_id` TEXT | **Recording-level MBID** |
| `composition_node_id` UUID FK | → graph.nodes (the linked work node) |

---

### Rights Schema (rights.*)

**`rights.rights_artists_v1`:** node_id, legal_name, stage_name, artist_type, country, user_id

**`rights.rights_creators_v1`:** node_id, legal_name, display_name, pro_performance, role_types TEXT[], user_id

**`rights.rights_split_allocations_v1`:** id, split_sheet_node_id, role, share_percent, right_type, territory_scope, confirmed_by_party, confirmed_at

**`rights.rights_registrations_v1`:** registration_type, registration_number, registration_date, registrar, status, territory_node_id, work_node_id

---

### Public Schema (public.*)

| Table | Purpose |
|---|---|
| `catalog_enriched_tracks_v1` | Per-track output of enrichment pipeline with all MBIDs |
| `catalog_enrichments_v1` | Job queue and status for enrichment runs |
| `catalog_v1` | Paid audit catalog submissions |
| `catalog_enrichment_v1` | Per-track enrichment queue for audit submissions |
| `catalog_writer_overrides` | Manual writer credit overrides |
| `catalog_writer_splits_v1` | Confirmed writer splits per track |
| `ai_consent_v1` | AI licensing consent ledger keyed on graph node |
| `partners_v1` | Licensed B2B partners |
| `partner_api_calls_v1` | Audit log of partner API calls |
| `enriched_tracks_v1` | View alias for `catalog_enriched_tracks_v1` |
| `rights_audits_v1` | Rights audit intake |

---

## 2. MusicBrainz-Compatible Entities Already Represented

### Work / Composition
**Status: Fully represented**  
`graph.nodes` (`node_type='work'`) + `works.works_compositions_v1`. Fields: title, ISWC, work_type, has_lyrics, public_domain, ASCAP/BMI/SESAC IDs, MLC work ID, `musicbrainz_id` (work MBID). Enrichment pipeline populates these via MB work-level lookup.

### Recording
**Status: Represented in two parallel tables — not yet joined by FK**  
`graph.nodes` (`node_type='recording'`) + `works.works_recordings_v1` (formal graph, ISRC as single TEXT).  
`public.catalog_enriched_tracks_v1` (enrichment pipeline, `isrcs TEXT[]` as array, `recording_mbid` TEXT).  
**Gap:** `works_recordings_v1.musicbrainz_recording_id` and `catalog_enriched_tracks_v1.recording_mbid` store the same concept but have no FK between them. The bridge is done at query time only in `resolve-rights.js` via ISRC string match — fragile if ISRC is missing.

### Release
**Status: Partially represented — no formal graph node**  
`release_mbid`, `release_group_mbid`, `release_title`, `release_year`, `release_type` exist as columns in `catalog_enriched_tracks_v1`. `album_title` is denormalized in `works_recordings_v1`. There is no `release` node type in the graph and no `works_releases_v1` table. The MB release → release-group hierarchy is not modeled.

### Artist / Person
**Status: Represented as two node types**  
`graph.nodes` (`node_type='artist'`) + `rights.rights_artists_v1` for the performing identity.  
`graph.nodes` (`node_type='creator'`) + `rights.rights_creators_v1` for the authorship identity.  
The two are linked via `alias_of` edge. MB `artist_type` (Person/Group/Orchestra/Character) disambiguation is not yet enforced — `rights_artists_v1.artist_type` exists but is always set to 'individual' on programmatic insert.

### Label / Organization
**Status: Not represented**  
Explicitly noted in `data/musicbrainz/staging/musicbrainz-to-musigod-mapping.md` as "planned for Rights Graph v2." No `node_type='label'` exists and no `rights_labels_v1` detail table exists.

### Identifiers
**Status: Partial**  
- ISRC: stored as `isrc` TEXT in `works_recordings_v1` (single) and `isrcs TEXT[]` in `catalog_enriched_tracks_v1` (array). MB recordings can have multiple ISRCs — only the array form handles this correctly.  
- ISWC: stored in `works_compositions_v1.iswc` and `catalog_enriched_tracks_v1.iswc`.  
- MBID (recording): `works_recordings_v1.musicbrainz_recording_id` and `catalog_enriched_tracks_v1.recording_mbid` — two columns, no FK.  
- MBID (work): `works_compositions_v1.musicbrainz_id`.  
- MBID (artist): `catalog_enriched_tracks_v1.artist_mbid`; not stored in `rights_artists_v1` or `rights_creators_v1`.  
- IPI: stored only in `catalog_enriched_tracks_v1.writers` JSONB array (`{name, mbid, ipi, role, source}`). No formal IPI column in `rights_creators_v1`.
- `mb_redirects_v1` table (for deprecated MBID tracking): **planned in ingestion plan doc, not yet created.**

### Relationships
**Status: Represented via graph edges with source attribution**  
Writer relationships land as `wrote` edges with `confidence_sources: ['musicbrainz']`, `properties.role` mapped from MB relationship type. The supported MB relationship type strings are: `composer`, `lyricist`, `writer`, `music`, `lyrics`, `composer-lyricist`, `arranger`, `words`, `written by` (see `lib/enrich-catalog.js:283`).  
Publisher relationships produce `owns_publishing` edges but no publisher entity node.

---

## 3. What Is Missing to Safely Ingest the MusicBrainz Full Dataset

The following are absent and required before full-dataset ingestion can begin:

1. **Staging tables in Supabase (or staging Postgres)** — no `mb_staging_*` tables exist. The Docker Compose environment (port 55432) is scaffolded but empty; no restore scripts or transform SQL files exist in `data/musicbrainz/staging/`.

2. **Transform pipeline scripts** — the mapping doc (`data/musicbrainz/staging/musicbrainz-to-musigod-mapping.md`) documents intent but there are no actual transform scripts, only the shell scaffold.

3. **Checkpoint table** — no `mb_ingest_checkpoints_v1` or equivalent to track position in a bulk import across restarts.

4. **Dead-letter table** — no mechanism for capturing entity batches that fail transform/validation so they can be retried or reviewed.

5. **`mb_redirects_v1` table** — planned in `docs/musicbrainz-ingestion-plan.md`, not created.

6. **Label node type and `rights_labels_v1` detail table** — MB has ~40K active labels. Needed for recording-label and work-publisher relationships.

7. **Release as a formal graph node** — `works_releases_v1` table and `node_type='release'` not yet supported.

8. **Artist MBID in `rights_artists_v1` / `rights_creators_v1`** — stored in enriched tracks JSONB but not as a formal column in the rights tables.

9. **IPI as a formal column** — needed for PRO registration dedup against real IPI registry.

10. **Entity-level disambiguation for artist name collisions** — the current `findArtistMBID` function does case-insensitive exact match then falls back to first result. At MB scale (1M+ artists with name collisions), this is not safe.

11. **MBID-namespace consistency** — `external_id_ns` values for MBIDs are inconsistent: some use `'musicbrainz'`, some use `'isrc'` after ISRC lookup, some use `'musigod_catalog'` for recordings without ISRCs. There is no canonical `external_id_ns='mbid'` namespace enforced.

12. **Incremental replication job** — no pg_cron or Render cron job exists for daily MB change feed processing.

---

## 4. Can the Existing nodes/edges/history Model Support MusicBrainz Scale Without Schema Redesign?

**Short answer: Yes for the canonical (MusiGod-relevant) subset. No for the full MB dump.**

The property graph model (`graph.nodes + graph.edges`) is sound and does not need a redesign. The `external_id + external_id_ns` unique constraint is the right join key. The JSONB `properties` bag is appropriate for variable-shape node data.

**Scale ceiling concerns:**

| Concern | Details |
|---|---|
| Full MB recording count: ~25M | The current graph likely has <5,000 nodes (Esham pilot). 25M nodes is a 5,000× scale jump. UUID-indexed JSONB is fine for this, but PostgREST row-by-row upserts via `graph_upsert_node` are not. Bulk insert via `COPY` or staging SQL is required. |
| JSONB property scans | Any query filtering on `properties->>'some_key'` without a GIN index will full-scan. Not yet an issue at 5K nodes; critical at 25M. Add GIN index on `nodes.properties` before import. |
| Edge fan-out | MB has composer relationships that link single works to 5–10 co-writers. 25M works × 3 avg co-writers = 75M wrote edges. This is within Postgres capability but requires careful batching. |
| Connection pool | Supabase default connection limit (60 direct + pgBouncer pooling). Bulk import requires either direct COPY or a single-connection batch loader — not the current PostgREST upsert-per-node approach. |
| PostgREST payload limit | `lib/persist-enriched-tracks.js` chunks at 200 rows. Adequate for enrichment; completely inadequate for 25M-row bulk load. Staging → COPY → production is the only viable path. |

**The schema itself does not need redesign. The write path does.**

---

## 5. Existing Entity-Resolution and Deduplication Logic That Can Be Reused

### `lib/writer-merge-policy.js` — Reusable, extend for MB scale

`isSameWriter(a, b)`: MBID-first identity resolution, falling back to normalized name. This is the correct pattern for MB entity resolution. It can be generalized into a shared `isSameEntity(a, b, entityType)` for artists, works, and recordings.

`applyPolicy()`: Seven-action provenance-aware merge policy (INSERT, UPGRADE, MERGE, IDEMPOTENT, KEEP_EXISTING, UPDATE_META, CONFLICT). This is the right model for MB import: MB data may contradict self-reported data — the CONFLICT action creates a review flag rather than silently overwriting. **Extend to handle MB-vs-MB conflicts (e.g., two MB recordings claiming the same ISWC).**

### `lib/persist-enriched-tracks.js` — Pattern reusable, mechanism too slow for bulk

`fetchExistingRows()` + `applyPolicy()` + `upsertRows()` pattern is correct for incremental/selective ingest (enriching a specific artist's catalog). For the full MB dump, the fetch-before-upsert approach (N reads before N writes) is too slow — replace with staging table + SQL merge for bulk.

`dedup_key` generated column: `lower(artist_name) || '|' || coalesce(recording_mbid, '') || '|' || lower(track_title)` — this works for artist-scoped enrichment. For MB-wide ingestion, the dedup key should be MBID-only (`recording_mbid` when present, else `artist_mbid + work_mbid + release_mbid`).

### `api/graph-sync.js` — `upsertNode` / `upsertEdge` pattern is reusable

The `upsertNode` + `upsertEdge` pattern with `external_id`/`external_id_ns` as the idempotency key is sound. For bulk import, these should be compiled into batch SQL rather than called one-at-a-time via PostgREST RPCs.

### `lib/enrich-catalog.js` — `isSameWriter` / MBID-priority matching

The existing MB API traversal path (artist → release-groups → releases → recordings → work-rels → work → artist-rels) is the correct join path. For dump-based ingest, the equivalent SQL join path is documented in `data/musicbrainz/staging/musicbrainz-to-musigod-mapping.md`.

---

## 6. Exact Mapping: MusicBrainz Source Tables → MusiGod Canonical Entities

| MB Source Table | Join Condition | MusiGod Target | Transform Notes |
|---|---|---|---|
| `artist` | `artist.id = <mbid>` | `graph.nodes` (node_type='artist' or 'creator') | Set `external_id=artist.id, external_id_ns='musicbrainz'`. Map `artist_type`: Person→creator, Group→artist, Orchestra→artist, Character→creator |
| `artist` | (same) | `rights.rights_artists_v1` or `rights_creators_v1` | `stage_name=artist.name`, `legal_name=artist.sort_name` (needs manual review for non-Western names) |
| `recording` | `recording.id = <mbid>` | `graph.nodes` (node_type='recording') + `works.works_recordings_v1` | `external_id=recording.id, external_id_ns='musicbrainz'`. `isrc` from first `isrc_recording` row. `duration_seconds = recording.length / 1000` |
| `isrc_recording` | `recording_id = recording.id` | `works_recordings_v1.isrc` | Take lowest (earliest) ISRC. Log all if multiple — the current schema stores only one in `works_recordings_v1` vs array in `catalog_enriched_tracks_v1` |
| `work` | `work.id = <mbid>` | `graph.nodes` (node_type='work') + `works.works_compositions_v1` | `external_id=work.id, external_id_ns='musicbrainz'`. `iswc` from `iswc` table JOIN |
| `iswc` | `work_id = work.id` | `works_compositions_v1.iswc` | MB can have multiple ISWCs per work — take first, log conflicts |
| `l_recording_work` | `entity0=recording.id, entity1=work.id` | `graph.edges` (edge_type='has_recording') | `confidence=0.95, sources=['musicbrainz']` |
| `l_artist_work` + `link` + `link_type` | JOIN on `link.id = l_artist_work.link, link_type.id = link.link_type` | `graph.edges` (edge_type='wrote') | Filter `link_type.name IN ('composer','lyricist','writer','music','lyrics','composer-lyricist','arranger','words','written by')`. `properties.role = link_type.name` |
| `l_artist_recording` + `link_type` | (same pattern) | `graph.edges` (edge_type='performed') | Filter `link_type.name = 'performer'`. `confidence=0.9` |
| `release` | `release.id = <mbid>` | `catalog_enriched_tracks_v1.release_mbid` | No formal release node yet. Denormalized to recording rows. |
| `release_group` | `release_group.id = <mbid>` | `catalog_enriched_tracks_v1.release_group_mbid` | No formal release-group node yet. |
| `label` | `label.id = <mbid>` | **NOT YET MAPPED** | Needs `node_type='label'` and `rights_labels_v1` detail table |
| `area` | `area.id`, ISO codes | `graph.nodes` (node_type='territory') | Can match on `external_id=iso_3166_1_codes[0], external_id_ns='iso2'` for country-level areas |
| `artist_credit_name` | `artist_credit = recording.artist_credit` | `catalog_enriched_tracks_v1.artist_credits TEXT[]` | Flatten artist credit name strings |

---

## 7. Required Additive Migrations Only

These are additive — no existing columns, constraints, or tables are changed.

### Migration 1: `mb_redirects_v1`
Track deprecated MBIDs to canonical successors. Referenced in `docs/musicbrainz-ingestion-plan.md` as required.

```sql
CREATE TABLE IF NOT EXISTS public.mb_redirects_v1 (
  deprecated_mbid  TEXT        NOT NULL,
  canonical_mbid   TEXT        NOT NULL,
  entity_type      TEXT        NOT NULL,  -- 'recording' | 'work' | 'artist' | 'release'
  redirected_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  source           TEXT        NOT NULL DEFAULT 'musicbrainz',
  PRIMARY KEY (deprecated_mbid, entity_type)
);
CREATE INDEX IF NOT EXISTS mb_redirects_v1_canonical_idx
  ON public.mb_redirects_v1 (canonical_mbid);
NOTIFY pgrst, 'reload schema';
```

### Migration 2: `mb_ingest_checkpoints_v1`
Resumable bulk import — tracks position per entity type.

```sql
CREATE TABLE IF NOT EXISTS public.mb_ingest_checkpoints_v1 (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type   TEXT        NOT NULL,   -- 'recording' | 'work' | 'artist' | 'release' | 'label'
  batch_id      TEXT        NOT NULL,   -- e.g. 'full-2026-07-09' or 'daily-2026-07-10'
  status        TEXT        NOT NULL DEFAULT 'PENDING'
                  CHECK (status IN ('PENDING','RUNNING','DONE','ERROR','PAUSED')),
  offset_val    BIGINT      NOT NULL DEFAULT 0,
  rows_processed BIGINT     NOT NULL DEFAULT 0,
  rows_failed   BIGINT      NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at    TIMESTAMPTZ,
  completed_at  TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity_type, batch_id)
);
NOTIFY pgrst, 'reload schema';
```

### Migration 3: `mb_ingest_dead_letters_v1`
Dead-letter queue for entities that fail transform/validation.

```sql
CREATE TABLE IF NOT EXISTS public.mb_ingest_dead_letters_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  checkpoint_id   UUID        REFERENCES public.mb_ingest_checkpoints_v1(id) ON DELETE SET NULL,
  entity_type     TEXT        NOT NULL,
  source_mbid     TEXT        NOT NULL,
  raw_payload     JSONB       NOT NULL DEFAULT '{}'::jsonb,
  error_message   TEXT        NOT NULL,
  retry_count     INTEGER     NOT NULL DEFAULT 0,
  last_attempted  TIMESTAMPTZ,
  resolved        BOOLEAN     NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mb_ingest_dead_letters_v1_entity_idx
  ON public.mb_ingest_dead_letters_v1 (entity_type, resolved);
CREATE INDEX IF NOT EXISTS mb_ingest_dead_letters_v1_source_mbid_idx
  ON public.mb_ingest_dead_letters_v1 (source_mbid);
NOTIFY pgrst, 'reload schema';
```

### Migration 4: Add `artist_mbid` and `ipi` to rights creator/artist tables

```sql
-- IPI as formal column (currently buried in catalog_enriched_tracks.writers JSONB only)
ALTER TABLE rights.rights_creators_v1
  ADD COLUMN IF NOT EXISTS artist_mbid TEXT,
  ADD COLUMN IF NOT EXISTS ipi         TEXT;

CREATE INDEX IF NOT EXISTS rights_creators_v1_artist_mbid_idx
  ON rights.rights_creators_v1 (artist_mbid) WHERE artist_mbid IS NOT NULL;

-- Mirror on rights_artists_v1
ALTER TABLE rights.rights_artists_v1
  ADD COLUMN IF NOT EXISTS artist_mbid TEXT;

CREATE INDEX IF NOT EXISTS rights_artists_v1_artist_mbid_idx
  ON rights.rights_artists_v1 (artist_mbid) WHERE artist_mbid IS NOT NULL;
```

### Migration 5: GIN index on `graph.nodes.properties` (required before bulk import)

```sql
CREATE INDEX IF NOT EXISTS graph_nodes_v1_properties_gin_idx
  ON graph.nodes USING GIN (properties);
```

### Migration 6: MBID namespace index on `graph.nodes`

```sql
CREATE INDEX IF NOT EXISTS graph_nodes_v1_mbid_ns_idx
  ON graph.nodes (external_id)
  WHERE external_id_ns IN ('musicbrainz', 'mbid', 'isrc', 'iswc');
```

### Migration 7: `works_releases_v1` (additive, for formal release model)

This is optional for Phase 1 ingest but required before B2B partner API can return release-level metadata.

```sql
CREATE TABLE IF NOT EXISTS works.works_releases_v1 (
  node_id           UUID        PRIMARY KEY REFERENCES graph.nodes(id) ON DELETE CASCADE,
  title             TEXT        NOT NULL,
  release_date      DATE,
  release_type      TEXT,       -- Album, Single, EP, Compilation, etc.
  ean_upc           TEXT,
  catalog_number    TEXT,
  label_node_id     UUID        REFERENCES graph.nodes(id) ON DELETE SET NULL,
  release_group_mbid TEXT,
  status            TEXT        NOT NULL DEFAULT 'official'
);
CREATE INDEX IF NOT EXISTS works_releases_v1_release_group_idx
  ON works.works_releases_v1 (release_group_mbid) WHERE release_group_mbid IS NOT NULL;
```

---

## 8. Required Staging Tables, Transformation Jobs, Checkpoints, Retry Handling, Dead-Letter Handling, Structured Logging, and Observability

### Staging Layer (local Docker Postgres on port 55432)

The Docker Compose is scaffolded but the staging database is empty. The following are needed before any transform work can begin:

**Step 1: Download and restore the MB dump**
```
MusicBrainz full dump (~25GB compressed, ~150GB expanded)
→ docker exec musigod_mb_staging pg_restore ...
→ Validates: ~25M recordings, ~20M works, ~1M artists
```

**Step 2: Apply MB schema**  
MB ships with its own schema SQL (`CreateTables.sql`, `CreateIndexes.sql`, `CreateConstraints.sql`). These must be applied to the staging DB before restore.

**Step 3: Create transform views/queries**  
The core join path (already documented in the mapping file) needs to be built as materialized staging views:

```sql
-- Staging view: MB recording → work → composer chain
CREATE MATERIALIZED VIEW mb_staging.recording_work_writers AS
SELECT
  r.id        AS recording_mbid,
  r.name      AS recording_title,
  r.length    AS duration_ms,
  w.id        AS work_mbid,
  w.name      AS work_title,
  a.id        AS writer_mbid,
  a.name      AS writer_name,
  lt.name     AS writer_role,
  ARRAY_AGG(DISTINCT ir.isrc) FILTER (WHERE ir.isrc IS NOT NULL) AS isrcs,
  ARRAY_AGG(DISTINCT iswc.iswc) FILTER (WHERE iswc.iswc IS NOT NULL) AS iswcs
FROM recording r
JOIN l_recording_work lrw ON lrw.entity0 = r.id
JOIN work w               ON w.id = lrw.entity1
JOIN l_artist_work law    ON law.entity1 = w.id
JOIN link l               ON l.id = law.link
JOIN link_type lt         ON lt.id = l.link_type
JOIN artist a             ON a.id = law.entity0
LEFT JOIN isrc_recording ir ON ir.recording = r.id
LEFT JOIN iswc ON iswc.work = w.id
WHERE lt.name IN ('composer','lyricist','writer','music','lyrics',
                  'composer-lyricist','arranger','words','written by')
GROUP BY r.id, r.name, r.length, w.id, w.name, a.id, a.name, lt.name;
```

### Transformation Job Requirements

| Job | Trigger | Input | Output | Checkpoint? |
|---|---|---|---|---|
| `mb-transform-artists` | One-time (post-restore) | `mb_staging.artist` | `graph.nodes` (artist/creator) | Yes — by MBID offset |
| `mb-transform-works` | One-time (post-restore) | `mb_staging.work` + `iswc` | `graph.nodes` (work) + `works.works_compositions_v1` | Yes |
| `mb-transform-recordings` | One-time (post-restore) | `mb_staging.recording` + `isrc_recording` | `graph.nodes` (recording) + `works.works_recordings_v1` | Yes |
| `mb-transform-edges` | After nodes complete | `mb_staging.recording_work_writers` | `graph.edges` (wrote, has_recording, performed) | Yes |
| `mb-daily-delta` | Daily cron (after initial import) | MB JSON change feed API | Delta upserts to nodes/edges | Via checkpoint table |

All jobs must:
- Write failed entities to `mb_ingest_dead_letters_v1` (not fail silently)
- Update `mb_ingest_checkpoints_v1` every 10,000 rows
- Apply the `writer-merge-policy` when the target entity already has writer credits
- Never touch the `royalties` schema

### Structured Logging Requirements

Currently, the enrichment pipeline uses only `console.log/warn/error`. For bulk MB ingest this is insufficient. Required:

- **Sentry integration** — `api/_sentry.js` exists but is not wired into `graph-sync.js` or any bulk import path.
- **Ingestion metrics table** — add a `mb_ingest_metrics_v1` table or use `mb_ingest_checkpoints_v1.rows_processed / rows_failed` for dashboard-level visibility.
- **Structured log format** — each transform job should emit JSON lines: `{event, entity_type, mbid, action, error?, elapsed_ms, batch_id}`.

### Observability Gaps

| Gap | Impact |
|---|---|
| No alerting on stalled enrichment jobs | `catalog_enrichments_v1` rows stuck in RUNNING are silent |
| No metrics on `graph.nodes` growth rate | Can't detect import stalls |
| No partner API latency SLO | `partner_api_calls_v1.response_ms` is logged but not dashboarded |
| No dead-letter alert | `mb_ingest_dead_letters_v1` doesn't exist yet, but once created needs a count alert |
| Sentry not wired to `graph-sync.js` | Graph write failures not surfaced in error tracking |

---

## 9. Storage and Compute Requirements

### Initial Full Import (local staging → production Supabase)

| Stage | Estimate | Location |
|---|---|---|
| MB dump download (compressed) | ~25 GB | Local disk / Docker volume |
| MB dump extracted | ~150 GB | Docker volume (`data/musicbrainz/postgres-data/`) |
| Staging Postgres running size | ~180 GB (with indexes) | Docker volume |
| Transform staging views | ~10–30 GB | Staging Postgres |

For **production Supabase (canonical subset only)** — assuming MusiGod indexes only works that have at least one ISRC or US artist relationship (~5% of full MB):

| Table | Estimated Rows | Estimated Size |
|---|---|---|
| `graph.nodes` | ~2M (works + recordings + artists) | ~2–4 GB |
| `graph.edges` | ~6M (wrote + has_recording + performed) | ~3–6 GB |
| `works.works_compositions_v1` | ~1M | ~500 MB |
| `works.works_recordings_v1` | ~1.5M | ~1 GB |
| `catalog_enriched_tracks_v1` | Existing ~161 rows + ~1.5M enriched | ~1.5 GB |
| Index overhead (GIN + B-tree) | ~30–50% above | ~3–5 GB |
| **Total production additions** | | **~12–20 GB** |

This is within Supabase Pro storage capacity.

### Daily Replication (post-initial-import)

MB publishes JSON change feeds. Daily delta is typically:
- ~5,000–20,000 new/edited recordings per day
- ~2,000–10,000 new/edited works
- Delta payload: <5 MB/day (compressed)
- Processing time: ~5–15 minutes at 500ms/entity rate-limited API calls
- Or: ~30 seconds if ingesting from the daily JSON dump diff file directly

---

## 10. Production Risks Before Ingestion Begins

### Risk 1 (Critical): Dual MBID columns with no FK bridge
`works_recordings_v1.musicbrainz_recording_id` and `catalog_enriched_tracks_v1.recording_mbid` are the same concept stored in two places with no FK between them. The `resolve-rights.js` API bridges them by ISRC string match — which silently fails for the ~18 Esham tracks that have no ISRC. Before MB ingest, add a FK or shared index: `recording_mbid → musicbrainz_recording_id`.

### Risk 2 (Critical): `external_id_ns` inconsistency for MBIDs
MusicBrainz recording IDs are stored under namespace `'musicbrainz'` in `graph_sync.js` but `'isrc'` after ISRC lookup (overwriting the MBID with the ISRC). See `graph-sync.js:203-208`: after enrichment, the node's `external_id` is patched to the ISRC and `external_id_ns` changed to `'isrc'`, losing the original MBID as the primary lookup key. This will cause `findNodeByExternalId(mbid, 'musicbrainz')` to miss nodes that have been ISRC-upgraded. **Fix before ingestion: preserve MBID as a secondary external_id or store in a dedicated column.**

### Risk 3 (High): Graph schema not version-controlled
The `graph`, `works`, `rights`, `royalties`, and `legal` schema migrations were applied directly via the SQL Editor and do not exist as files in `supabase/migrations/`. Any bulk import that causes a PostgREST schema reload (`NOTIFY pgrst, 'reload schema'`) or requires a migration to be rolled back has no documented rollback path. **Reconstruct migrations before importing.**

### Risk 4 (High): `catalog_enrichments_v1` schema split
Two migrations create `catalog_enrichments_v1`: one in `catalog.*` schema (v1, now likely orphaned) and one in `public.*` schema (v2, actively used by code). If the `catalog` schema version was never cleaned up, there are two tables with the same name in different schemas. Any enrichment job that accidentally uses the wrong schema header would silently write to the wrong table.

### Risk 5 (High): `dedup_key` NULL behavior
The `dedup_key` generated column in `catalog_enriched_tracks_v1` is:
```sql
lower(artist_name) || '|' || coalesce(recording_mbid, '') || '|' || lower(track_title)
```
When `recording_mbid` is NULL, `coalesce` returns `''` (empty string), meaning two different tracks with the same artist and title but no recording MBID will collide on the dedup key. Tracks with neither ISRC nor MBID are prone to false dedup merges. This is an existing issue but becomes critical if MB tracks without MBIDs are bulk-ingested.

### Risk 6 (Medium): Rate limiting on bulk MB API ingest
`lib/enrich-catalog.js` rates at 500ms per call. Full MB via live API would take years. The dump-based approach is required. However, the `mb-download-notes.ps1` script explicitly does not download the dump — it only prints instructions. No automated download or restore tooling exists yet.

### Risk 7 (Medium): PostgREST connection pool exhaustion during bulk import
Bulk ingest via PostgREST RPCs (`graph_upsert_node` + `graph_upsert_edge`) is a one-row-at-a-time pattern that will exhaust Supabase's connection pool for large batches. The `persistEnrichedTracks` chunking at 200 rows works for enrichment-scale; for MB bulk import, use a single-connection batch loader writing directly to staging tables, then promote via SQL.

### Risk 8 (Low-Medium): `artist.sort_name` as `legal_name` source
The code uses MB `sort_name` as `legal_name` for creators. MB sort names are formatted as "Last, First" for Western names but vary for non-Western artists. Blindly inserting MB `sort_name` into `legal_name` will produce incorrect values (e.g., "Smith, Esham" instead of "Esham Smith"). Apply a normalization function before insert.

### Risk 9 (Low): Hardcoded service role key in `scripts/sync-esham-to-graph.js`
Line 6 of `scripts/sync-esham-to-graph.js` contains a hardcoded service role JWT. This is a local-run script, but if it were ever committed with the real token visible, it would expose full Supabase write access. The token is present in the file on the current branch. Confirm this is an expired/rotated key or rotate it before this file is pushed to a public remote.

---

## Summary: 10 Most Important Findings

| # | Finding | Severity |
|---|---|---|
| 1 | `works_recordings_v1.musicbrainz_recording_id` and `catalog_enriched_tracks_v1.recording_mbid` are the same field stored twice with no FK — bridged only by fragile ISRC string match | Critical |
| 2 | `external_id_ns` for recording MBIDs is overwritten to `'isrc'` after enrichment, breaking MBID-based lookups in the graph | Critical |
| 3 | Graph, works, rights, royalties, and legal schema migrations were never version-controlled — no rollback path exists | High |
| 4 | No staging tables, transform scripts, checkpoints, or dead-letter tables exist — only a Docker Compose shell scaffold | High |
| 5 | `dedup_key` NULL collision: tracks with no MBID and same artist+title will false-merge during bulk import | High |
| 6 | Label, publisher entity, and release node types are absent from the graph — blocking full MB relationship ingestion | High |
| 7 | Artist MBID and IPI have no formal columns in `rights_creators_v1` / `rights_artists_v1` — stored only in JSONB | Medium |
| 8 | `catalog_enrichments_v1` exists in both `catalog.*` and `public.*` schemas — potential silent write to wrong table | Medium |
| 9 | Full MB ingest via PostgREST RPCs is architecturally incompatible — a direct Postgres bulk-load path is required | Medium |
| 10 | Hardcoded service role JWT in `scripts/sync-esham-to-graph.js` line 6 — rotate before pushing to public remote | Medium |

---

## Single Next Implementation Step

**Fix the dual MBID field problem and the `external_id_ns` overwrite (Findings 1 and 2) before any ingest work begins.**

Specifically: write and apply a migration that adds a `recording_mbid` column to `works_recordings_v1` (matching the field name in `catalog_enriched_tracks_v1`), backfill it from `musicbrainz_recording_id`, and update `graph-sync.js:syncEnrichmentToGraph()` to stop overwriting `external_id_ns` to `'isrc'` — instead patch the ISRC into a separate index and preserve the MBID as the primary `external_id`.

Without this fix, every bulk import that resolves recording nodes by MBID will fail to find nodes that have gone through the ISRC-upgrade path, creating duplicates in the graph.
