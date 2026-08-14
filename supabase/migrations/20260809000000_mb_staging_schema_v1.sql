-- supabase/migrations/20260809000000_mb_staging_schema_v1.sql
--
-- MusicBrainz Staging Schema — Layer 0 metadata infrastructure.
--
-- Architecture:
--   MB API / Dump Files
--     → mb_staging.{artists,recordings,works,releases,isrcs,iswcs,relationships}_v1
--     → mb_staging.entity_matches_v1  (candidate matches with confidence scores)
--     → (human review gate at confidence < 0.95)
--     → canonical graph promotion
--
-- Data license: CC0 (public domain). No attribution required per MusicBrainz terms.
-- Provenance chain must be preserved per MusiGod evidence requirements (source field).
--
-- PostgREST access: Add 'mb_staging' to Settings > API > Extra search path.
-- Import: node scripts/mb-import.js [--artists|--recordings|--works|--releases|--relationships|--all]

CREATE SCHEMA IF NOT EXISTS mb_staging;

GRANT USAGE ON SCHEMA mb_staging TO service_role;
GRANT USAGE ON SCHEMA mb_staging TO authenticator;

-- ─── 1. Artists ──────────────────────────────────────────────────────────────
-- One row per MB artist (person, group, orchestra, character, other).
-- mb_artist_id is the MB UUID (MBID); never store the internal MB integer id.

CREATE TABLE IF NOT EXISTS mb_staging.artists_v1 (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_artist_id      TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  sort_name         TEXT,
  artist_type       TEXT,          -- 'Person' | 'Group' | 'Orchestra' | 'Choir' | 'Character' | 'Other'
  country           TEXT,          -- ISO 3166-1 alpha-2
  area              TEXT,          -- Area name (city/region/country)
  begin_date        TEXT,          -- YYYY or YYYY-MM or YYYY-MM-DD
  end_date          TEXT,
  comment           TEXT,          -- MB disambiguation comment
  ended             BOOLEAN     NOT NULL DEFAULT false,
  mb_last_updated   TIMESTAMPTZ,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source  TEXT        NOT NULL DEFAULT 'api',  -- 'api' | 'dump'
  provenance        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mb_staging_artists_v1_mb_artist_id_uq UNIQUE (mb_artist_id)
);

CREATE INDEX IF NOT EXISTS mb_staging_artists_v1_name_idx
  ON mb_staging.artists_v1 (lower(name));
CREATE INDEX IF NOT EXISTS mb_staging_artists_v1_sort_name_idx
  ON mb_staging.artists_v1 (lower(sort_name));

ALTER TABLE mb_staging.artists_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_artists_v1_service_role ON mb_staging.artists_v1;
CREATE POLICY mb_staging_artists_v1_service_role
  ON mb_staging.artists_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.artists_v1 TO service_role;

-- ─── 2. Artist Aliases ───────────────────────────────────────────────────────
-- All known alternate names, transliterations, and search names for an artist.
-- Used in disambiguation and fuzzy-match candidate generation.

CREATE TABLE IF NOT EXISTS mb_staging.artist_aliases_v1 (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_artist_id    TEXT        NOT NULL,   -- references artists_v1.mb_artist_id
  alias_name      TEXT        NOT NULL,
  alias_type      TEXT,                   -- 'Artist name' | 'Legal name' | 'Search hint' | 'Label name'
  locale          TEXT,                   -- BCP-47 locale (e.g. 'en', 'ja')
  primary_alias   BOOLEAN     NOT NULL DEFAULT false,
  begin_date      TEXT,
  end_date        TEXT,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mb_staging_artist_aliases_v1_uq UNIQUE (mb_artist_id, alias_name)
);

CREATE INDEX IF NOT EXISTS mb_staging_artist_aliases_v1_artist_idx
  ON mb_staging.artist_aliases_v1 (mb_artist_id);
CREATE INDEX IF NOT EXISTS mb_staging_artist_aliases_v1_name_idx
  ON mb_staging.artist_aliases_v1 (lower(alias_name));

ALTER TABLE mb_staging.artist_aliases_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_artist_aliases_v1_service_role ON mb_staging.artist_aliases_v1;
CREATE POLICY mb_staging_artist_aliases_v1_service_role
  ON mb_staging.artist_aliases_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.artist_aliases_v1 TO service_role;

-- ─── 3. Recordings ───────────────────────────────────────────────────────────
-- A specific audio performance of a work.
-- IMPORTANT: recordings ≠ works. A recording is a sound file; a work is the composition.
-- Never conflate them — they are distinct entities with distinct MBIDs.

CREATE TABLE IF NOT EXISTS mb_staging.recordings_v1 (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_recording_id   TEXT        NOT NULL,
  title             TEXT        NOT NULL,
  length_ms         INTEGER,            -- Duration in milliseconds
  artist_credit     TEXT,               -- Denormalized display string ("Esham feat. X")
  mb_artist_id      TEXT,               -- Primary artist MBID (from artist-credit)
  comment           TEXT,
  video             BOOLEAN     NOT NULL DEFAULT false,
  mb_last_updated   TIMESTAMPTZ,
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source  TEXT        NOT NULL DEFAULT 'api',
  provenance        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mb_staging_recordings_v1_mb_recording_id_uq UNIQUE (mb_recording_id)
);

CREATE INDEX IF NOT EXISTS mb_staging_recordings_v1_title_idx
  ON mb_staging.recordings_v1 (lower(title));
CREATE INDEX IF NOT EXISTS mb_staging_recordings_v1_artist_idx
  ON mb_staging.recordings_v1 (mb_artist_id) WHERE mb_artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mb_staging_recordings_v1_length_idx
  ON mb_staging.recordings_v1 (length_ms) WHERE length_ms IS NOT NULL;

ALTER TABLE mb_staging.recordings_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_recordings_v1_service_role ON mb_staging.recordings_v1;
CREATE POLICY mb_staging_recordings_v1_service_role
  ON mb_staging.recordings_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.recordings_v1 TO service_role;

-- ─── 4. ISRCs ────────────────────────────────────────────────────────────────
-- Sound recording identifiers (International Standard Recording Code).
-- One recording may have multiple ISRCs; one ISRC belongs to one recording.
-- ISRC is the highest-confidence match signal for sound recordings.

CREATE TABLE IF NOT EXISTS mb_staging.isrcs_v1 (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_recording_id  TEXT        NOT NULL,
  isrc             TEXT        NOT NULL,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mb_staging_isrcs_v1_uq UNIQUE (mb_recording_id, isrc)
);

CREATE INDEX IF NOT EXISTS mb_staging_isrcs_v1_isrc_idx
  ON mb_staging.isrcs_v1 (isrc);
CREATE INDEX IF NOT EXISTS mb_staging_isrcs_v1_recording_idx
  ON mb_staging.isrcs_v1 (mb_recording_id);

ALTER TABLE mb_staging.isrcs_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_isrcs_v1_service_role ON mb_staging.isrcs_v1;
CREATE POLICY mb_staging_isrcs_v1_service_role
  ON mb_staging.isrcs_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.isrcs_v1 TO service_role;

-- ─── 5. Works (compositions) ─────────────────────────────────────────────────
-- An abstract composition — the song as written, independent of any recording.
-- Works carry composer/lyricist credits; recordings carry performer credits.

CREATE TABLE IF NOT EXISTS mb_staging.works_v1 (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_work_id       TEXT        NOT NULL,
  title            TEXT        NOT NULL,
  work_type        TEXT,               -- 'Song' | 'Symphony' | 'Soundtrack' | 'Opera' | etc.
  language         TEXT,               -- ISO 639-3 language code
  comment          TEXT,
  mb_last_updated  TIMESTAMPTZ,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source TEXT        NOT NULL DEFAULT 'api',
  provenance       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mb_staging_works_v1_mb_work_id_uq UNIQUE (mb_work_id)
);

CREATE INDEX IF NOT EXISTS mb_staging_works_v1_title_idx
  ON mb_staging.works_v1 (lower(title));

ALTER TABLE mb_staging.works_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_works_v1_service_role ON mb_staging.works_v1;
CREATE POLICY mb_staging_works_v1_service_role
  ON mb_staging.works_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.works_v1 TO service_role;

-- ─── 6. ISWCs ────────────────────────────────────────────────────────────────
-- Composition identifiers (International Standard Musical Work Code).
-- Used by ASCAP, BMI, SESAC for composition identification.

CREATE TABLE IF NOT EXISTS mb_staging.iswcs_v1 (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_work_id  TEXT        NOT NULL,
  iswc        TEXT        NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mb_staging_iswcs_v1_uq UNIQUE (mb_work_id, iswc)
);

CREATE INDEX IF NOT EXISTS mb_staging_iswcs_v1_iswc_idx
  ON mb_staging.iswcs_v1 (iswc);
CREATE INDEX IF NOT EXISTS mb_staging_iswcs_v1_work_idx
  ON mb_staging.iswcs_v1 (mb_work_id);

ALTER TABLE mb_staging.iswcs_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_iswcs_v1_service_role ON mb_staging.iswcs_v1;
CREATE POLICY mb_staging_iswcs_v1_service_role
  ON mb_staging.iswcs_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.iswcs_v1 TO service_role;

-- ─── 7. Releases ─────────────────────────────────────────────────────────────
-- A specific product edition: an album pressing, a digital release, a single.

CREATE TABLE IF NOT EXISTS mb_staging.releases_v1 (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_release_id        TEXT        NOT NULL,
  mb_release_group_id  TEXT,
  title                TEXT        NOT NULL,
  artist_credit        TEXT,
  mb_artist_id         TEXT,
  release_date         TEXT,           -- YYYY or YYYY-MM or YYYY-MM-DD
  country              TEXT,
  status               TEXT,           -- 'Official' | 'Promotion' | 'Bootleg' | 'Pseudo-Release'
  barcode              TEXT,           -- UPC or EAN barcode
  mb_last_updated      TIMESTAMPTZ,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source     TEXT        NOT NULL DEFAULT 'api',
  provenance           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mb_staging_releases_v1_mb_release_id_uq UNIQUE (mb_release_id)
);

CREATE INDEX IF NOT EXISTS mb_staging_releases_v1_title_idx
  ON mb_staging.releases_v1 (lower(title));
CREATE INDEX IF NOT EXISTS mb_staging_releases_v1_release_group_idx
  ON mb_staging.releases_v1 (mb_release_group_id) WHERE mb_release_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mb_staging_releases_v1_barcode_idx
  ON mb_staging.releases_v1 (barcode) WHERE barcode IS NOT NULL;
CREATE INDEX IF NOT EXISTS mb_staging_releases_v1_artist_idx
  ON mb_staging.releases_v1 (mb_artist_id) WHERE mb_artist_id IS NOT NULL;

ALTER TABLE mb_staging.releases_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_releases_v1_service_role ON mb_staging.releases_v1;
CREATE POLICY mb_staging_releases_v1_service_role
  ON mb_staging.releases_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.releases_v1 TO service_role;

-- ─── 8. Release Groups ───────────────────────────────────────────────────────
-- The abstract "album concept" grouping all editions/formats of one release.

CREATE TABLE IF NOT EXISTS mb_staging.release_groups_v1 (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_release_group_id  TEXT        NOT NULL,
  title                TEXT        NOT NULL,
  primary_type         TEXT,           -- 'Album' | 'Single' | 'EP' | 'Broadcast' | 'Other'
  secondary_types      TEXT[]      NOT NULL DEFAULT '{}',
  mb_artist_id         TEXT,
  first_release_date   TEXT,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source     TEXT        NOT NULL DEFAULT 'api',
  provenance           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT mb_staging_release_groups_v1_mb_release_group_id_uq UNIQUE (mb_release_group_id)
);

CREATE INDEX IF NOT EXISTS mb_staging_release_groups_v1_title_idx
  ON mb_staging.release_groups_v1 (lower(title));
CREATE INDEX IF NOT EXISTS mb_staging_release_groups_v1_artist_idx
  ON mb_staging.release_groups_v1 (mb_artist_id) WHERE mb_artist_id IS NOT NULL;

ALTER TABLE mb_staging.release_groups_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_release_groups_v1_service_role ON mb_staging.release_groups_v1;
CREATE POLICY mb_staging_release_groups_v1_service_role
  ON mb_staging.release_groups_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.release_groups_v1 TO service_role;

-- ─── 9. Relationships ────────────────────────────────────────────────────────
-- The core rights-chain link: recording→work, artist→work (composer/lyricist),
-- artist→recording (performer), release→label.
--
-- relationship_type matches values in lib/enrich-catalog.js writerRels filter:
--   'composer' | 'lyricist' | 'writer' | 'composer-lyricist' | 'arranger'
--   'music' | 'lyrics' | 'words' | 'written by' (legacy MB types)
--   'performer' | 'instrument' | 'vocal' | etc.

CREATE TABLE IF NOT EXISTS mb_staging.relationships_v1 (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type       TEXT        NOT NULL,   -- 'recording' | 'artist' | 'release' | 'work'
  source_mb_id      TEXT        NOT NULL,
  target_type       TEXT        NOT NULL,   -- 'work' | 'artist' | 'recording' | 'release' | 'label'
  target_mb_id      TEXT        NOT NULL,
  relationship_type TEXT        NOT NULL,
  attributes        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  begin_date        TEXT,
  end_date          TEXT,
  direction         TEXT        NOT NULL DEFAULT 'forward',
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mb_staging_relationships_v1_uq
    UNIQUE (source_type, source_mb_id, target_type, target_mb_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS mb_staging_relationships_v1_source_idx
  ON mb_staging.relationships_v1 (source_type, source_mb_id);
CREATE INDEX IF NOT EXISTS mb_staging_relationships_v1_target_idx
  ON mb_staging.relationships_v1 (target_type, target_mb_id);
CREATE INDEX IF NOT EXISTS mb_staging_relationships_v1_type_idx
  ON mb_staging.relationships_v1 (relationship_type);

ALTER TABLE mb_staging.relationships_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_relationships_v1_service_role ON mb_staging.relationships_v1;
CREATE POLICY mb_staging_relationships_v1_service_role
  ON mb_staging.relationships_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.relationships_v1 TO service_role;

-- ─── 10. Ingestion State (checkpoints / resumability) ────────────────────────
-- One row per entity_type+import_mode combination.
-- last_offset: byte offset for dump-mode; artist count for api-mode.
-- last_mb_id: last MBID processed (used to resume api-mode artist iteration).

CREATE TABLE IF NOT EXISTS mb_staging.ingestion_state_v1 (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type      TEXT        NOT NULL,   -- 'artists' | 'recordings' | 'works' | 'releases' | 'relationships'
  import_mode      TEXT        NOT NULL DEFAULT 'api',  -- 'api' | 'dump'
  status           TEXT        NOT NULL DEFAULT 'pending',
  --   'pending' | 'running' | 'completed' | 'failed' | 'paused'
  last_offset      BIGINT      NOT NULL DEFAULT 0,
  last_mb_id       TEXT,
  total_processed  BIGINT      NOT NULL DEFAULT 0,
  total_errors     BIGINT      NOT NULL DEFAULT 0,
  dump_file        TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  error_message    TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mb_staging_ingestion_state_v1_entity_mode_uq
    UNIQUE (entity_type, import_mode)
);

ALTER TABLE mb_staging.ingestion_state_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_ingestion_state_v1_service_role ON mb_staging.ingestion_state_v1;
CREATE POLICY mb_staging_ingestion_state_v1_service_role
  ON mb_staging.ingestion_state_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.ingestion_state_v1 TO service_role;

CREATE OR REPLACE FUNCTION mb_staging.fn_touch_ingestion_state_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_ingestion_state_updated_at ON mb_staging.ingestion_state_v1;
CREATE TRIGGER trg_touch_ingestion_state_updated_at
  BEFORE UPDATE ON mb_staging.ingestion_state_v1
  FOR EACH ROW EXECUTE FUNCTION mb_staging.fn_touch_ingestion_state_updated_at();

-- ─── 11. Entity Matches ──────────────────────────────────────────────────────
-- Candidate links between MB entities and MusiGod canonical entities.
-- Confidence tiers:
--   1.000 — ISRC exact match (sound recording identity)
--   1.000 — MBID direct match (already resolved)
--   0.950 — ISWC exact match (composition identity)
--   0.700–0.890 — Name fuzzy + duration match (requires human review)
--
-- Auto-promotion is only allowed at confidence = 1.0 via explicit CLI flag.
-- All other matches require review_status → 'approved' before promotion.

CREATE TABLE IF NOT EXISTS mb_staging.entity_matches_v1 (
  id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  mb_entity_type      TEXT         NOT NULL,   -- 'recording' | 'work' | 'artist' | 'release'
  mb_entity_id        TEXT         NOT NULL,
  musigod_entity_type TEXT         NOT NULL,   -- 'enriched_track' | 'catalog_track' | 'graph_node'
  musigod_entity_id   TEXT         NOT NULL,
  match_method        TEXT         NOT NULL,   -- 'isrc_exact' | 'iswc_exact' | 'mbid_direct' | 'name_fuzzy'
  confidence          NUMERIC(4,3) NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  match_signals       JSONB        NOT NULL DEFAULT '{}'::jsonb,
  review_status       TEXT         NOT NULL DEFAULT 'pending',
  --   'pending' | 'approved' | 'rejected'
  promoted            BOOLEAN      NOT NULL DEFAULT false,
  promoted_at         TIMESTAMPTZ,
  reviewed_by         TEXT,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT mb_staging_entity_matches_v1_uq
    UNIQUE (mb_entity_type, mb_entity_id, musigod_entity_type, musigod_entity_id)
);

CREATE INDEX IF NOT EXISTS mb_staging_entity_matches_v1_mb_entity_idx
  ON mb_staging.entity_matches_v1 (mb_entity_type, mb_entity_id);
CREATE INDEX IF NOT EXISTS mb_staging_entity_matches_v1_musigod_idx
  ON mb_staging.entity_matches_v1 (musigod_entity_type, musigod_entity_id);
CREATE INDEX IF NOT EXISTS mb_staging_entity_matches_v1_confidence_idx
  ON mb_staging.entity_matches_v1 (confidence DESC);
CREATE INDEX IF NOT EXISTS mb_staging_entity_matches_v1_pending_idx
  ON mb_staging.entity_matches_v1 (review_status) WHERE review_status = 'pending';

ALTER TABLE mb_staging.entity_matches_v1 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS mb_staging_entity_matches_v1_service_role ON mb_staging.entity_matches_v1;
CREATE POLICY mb_staging_entity_matches_v1_service_role
  ON mb_staging.entity_matches_v1 FOR ALL TO service_role USING (true) WITH CHECK (true);
GRANT ALL ON mb_staging.entity_matches_v1 TO service_role;

CREATE OR REPLACE FUNCTION mb_staging.fn_touch_entity_matches_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_entity_matches_updated_at ON mb_staging.entity_matches_v1;
CREATE TRIGGER trg_touch_entity_matches_updated_at
  BEFORE UPDATE ON mb_staging.entity_matches_v1
  FOR EACH ROW EXECUTE FUNCTION mb_staging.fn_touch_entity_matches_updated_at();

-- ─── Reload PostgREST ─────────────────────────────────────────────────────────
NOTIFY pgrst, 'reload schema';
