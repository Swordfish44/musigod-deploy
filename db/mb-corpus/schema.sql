-- db/mb-corpus/schema.sql
-- External PostgreSQL schema for the MusicBrainz corpus database.
--
-- Apply this to MUSICBRAINZ_DATABASE_URL before running mb-import.js.
-- This is NOT a Supabase migration — it targets a plain PostgreSQL instance.
-- No RLS, no pgrst notifications, no Supabase-specific extensions required.
--
-- Compatible with PostgreSQL 14+.
-- Required extension: none (gen_random_uuid() is built-in since PG 13).
--
-- Apply:
--   psql "$MUSICBRAINZ_DATABASE_URL" -f db/mb-corpus/schema.sql
--
-- entity_matches_v1 is NOT here — it lives in Supabase (the review boundary).

CREATE SCHEMA IF NOT EXISTS mb_staging;

-- ─── 1. Artists ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.artists_v1 (
  mb_artist_id     TEXT        PRIMARY KEY,
  name             TEXT        NOT NULL,
  sort_name        TEXT,
  artist_type      TEXT,
  country          TEXT,
  area             TEXT,
  begin_date       TEXT,
  end_date         TEXT,
  comment          TEXT,
  ended            BOOLEAN     NOT NULL DEFAULT false,
  mb_last_updated  TIMESTAMPTZ,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source TEXT        NOT NULL DEFAULT 'api',
  provenance       JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS mb_artists_name_idx      ON mb_staging.artists_v1 (lower(name));
CREATE INDEX IF NOT EXISTS mb_artists_sort_name_idx ON mb_staging.artists_v1 (lower(sort_name));

-- ─── 2. Artist Aliases ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.artist_aliases_v1 (
  mb_artist_id   TEXT        NOT NULL REFERENCES mb_staging.artists_v1 (mb_artist_id) ON DELETE CASCADE,
  alias_name     TEXT        NOT NULL,
  alias_type     TEXT,
  locale         TEXT,
  primary_alias  BOOLEAN     NOT NULL DEFAULT false,
  begin_date     TEXT,
  end_date       TEXT,
  ingested_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mb_artist_id, alias_name)
);

CREATE INDEX IF NOT EXISTS mb_artist_aliases_name_idx ON mb_staging.artist_aliases_v1 (lower(alias_name));

-- ─── 3. Recordings ───────────────────────────────────────────────────────────
-- Recording ≠ Work. Never conflate.

CREATE TABLE IF NOT EXISTS mb_staging.recordings_v1 (
  mb_recording_id  TEXT        PRIMARY KEY,
  title            TEXT        NOT NULL,
  length_ms        INTEGER,
  artist_credit    TEXT,
  mb_artist_id     TEXT,
  comment          TEXT,
  video            BOOLEAN     NOT NULL DEFAULT false,
  mb_last_updated  TIMESTAMPTZ,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source TEXT        NOT NULL DEFAULT 'api',
  provenance       JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS mb_recordings_title_idx  ON mb_staging.recordings_v1 (lower(title));
CREATE INDEX IF NOT EXISTS mb_recordings_artist_idx ON mb_staging.recordings_v1 (mb_artist_id) WHERE mb_artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mb_recordings_length_idx ON mb_staging.recordings_v1 (length_ms)    WHERE length_ms IS NOT NULL;

-- ─── 4. ISRCs ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.isrcs_v1 (
  mb_recording_id TEXT        NOT NULL REFERENCES mb_staging.recordings_v1 (mb_recording_id) ON DELETE CASCADE,
  isrc            TEXT        NOT NULL,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mb_recording_id, isrc)
);

CREATE INDEX IF NOT EXISTS mb_isrcs_isrc_idx ON mb_staging.isrcs_v1 (isrc);

-- ─── 5. Works (compositions) ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.works_v1 (
  mb_work_id       TEXT        PRIMARY KEY,
  title            TEXT        NOT NULL,
  work_type        TEXT,
  language         TEXT,
  comment          TEXT,
  mb_last_updated  TIMESTAMPTZ,
  ingested_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source TEXT        NOT NULL DEFAULT 'api',
  provenance       JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS mb_works_title_idx ON mb_staging.works_v1 (lower(title));

-- ─── 6. ISWCs ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.iswcs_v1 (
  mb_work_id  TEXT        NOT NULL REFERENCES mb_staging.works_v1 (mb_work_id) ON DELETE CASCADE,
  iswc        TEXT        NOT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (mb_work_id, iswc)
);

CREATE INDEX IF NOT EXISTS mb_iswcs_iswc_idx ON mb_staging.iswcs_v1 (iswc);

-- ─── 7. Releases ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.releases_v1 (
  mb_release_id        TEXT        PRIMARY KEY,
  mb_release_group_id  TEXT,
  title                TEXT        NOT NULL,
  artist_credit        TEXT,
  mb_artist_id         TEXT,
  release_date         TEXT,
  country              TEXT,
  status               TEXT,
  barcode              TEXT,
  mb_last_updated      TIMESTAMPTZ,
  ingested_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source     TEXT        NOT NULL DEFAULT 'api',
  provenance           JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS mb_releases_title_idx         ON mb_staging.releases_v1 (lower(title));
CREATE INDEX IF NOT EXISTS mb_releases_release_group_idx ON mb_staging.releases_v1 (mb_release_group_id) WHERE mb_release_group_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS mb_releases_barcode_idx       ON mb_staging.releases_v1 (barcode)             WHERE barcode IS NOT NULL;

-- ─── 8. Release Groups ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.release_groups_v1 (
  mb_release_group_id TEXT        PRIMARY KEY,
  title               TEXT        NOT NULL,
  primary_type        TEXT,
  secondary_types     TEXT[]      NOT NULL DEFAULT '{}',
  mb_artist_id        TEXT,
  first_release_date  TEXT,
  ingested_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  ingestion_source    TEXT        NOT NULL DEFAULT 'api',
  provenance          JSONB       NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS mb_release_groups_title_idx  ON mb_staging.release_groups_v1 (lower(title));
CREATE INDEX IF NOT EXISTS mb_release_groups_artist_idx ON mb_staging.release_groups_v1 (mb_artist_id) WHERE mb_artist_id IS NOT NULL;

-- ─── 9. Relationships ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS mb_staging.relationships_v1 (
  source_type       TEXT        NOT NULL,
  source_mb_id      TEXT        NOT NULL,
  target_type       TEXT        NOT NULL,
  target_mb_id      TEXT        NOT NULL,
  relationship_type TEXT        NOT NULL,
  attributes        JSONB       NOT NULL DEFAULT '{}',
  begin_date        TEXT,
  end_date          TEXT,
  direction         TEXT        NOT NULL DEFAULT 'forward',
  ingested_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source_type, source_mb_id, target_type, target_mb_id, relationship_type)
);

CREATE INDEX IF NOT EXISTS mb_rels_source_idx ON mb_staging.relationships_v1 (source_type, source_mb_id);
CREATE INDEX IF NOT EXISTS mb_rels_target_idx ON mb_staging.relationships_v1 (target_type, target_mb_id);
CREATE INDEX IF NOT EXISTS mb_rels_type_idx   ON mb_staging.relationships_v1 (relationship_type);

-- ─── 10. Ingestion State ─────────────────────────────────────────────────────
-- Checkpoint/resume table. One row per (entity_type, import_mode).

CREATE TABLE IF NOT EXISTS mb_staging.ingestion_state_v1 (
  entity_type      TEXT        NOT NULL,
  import_mode      TEXT        NOT NULL DEFAULT 'api',
  status           TEXT        NOT NULL DEFAULT 'pending',
  last_offset      BIGINT      NOT NULL DEFAULT 0,
  last_mb_id       TEXT,
  total_processed  BIGINT      NOT NULL DEFAULT 0,
  total_errors     BIGINT      NOT NULL DEFAULT 0,
  dump_file        TEXT,
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ,
  error_message    TEXT,
  metadata         JSONB       NOT NULL DEFAULT '{}',
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_type, import_mode)
);

-- Auto-update updated_at on change.
CREATE OR REPLACE FUNCTION mb_staging.fn_touch_ingestion_state()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_touch_ingestion_state ON mb_staging.ingestion_state_v1;
CREATE TRIGGER trg_touch_ingestion_state
  BEFORE UPDATE ON mb_staging.ingestion_state_v1
  FOR EACH ROW EXECUTE FUNCTION mb_staging.fn_touch_ingestion_state();

-- ─── Verify ───────────────────────────────────────────────────────────────────
-- Run after apply to confirm all tables exist:
--   SELECT table_name FROM information_schema.tables
--   WHERE table_schema = 'mb_staging' ORDER BY table_name;
--
-- Expected: artist_aliases_v1, artists_v1, ingestion_state_v1,
--           isrcs_v1, iswcs_v1, recordings_v1, release_groups_v1,
--           releases_v1, relationships_v1, works_v1
