-- 20260711_recordings_musicbrainz_recording_id_idx.sql
--
-- Confirmed production schema (verified 2026-07-11 via pg_class query):
--   works.recordings            — base table; contains musicbrainz_recording_id
--   public.works_recordings_v1  — VIEW over works.recordings
--   works.works_recordings_v1   — does NOT exist
--
-- Existing indexes on works.recordings (from pg_indexes verification):
--   recordings_pkey, recordings_isrc_key,
--   idx_rec_comp, idx_rec_isrc, idx_rec_no_isrc, idx_rec_spotify, idx_rec_title
-- No existing index on musicbrainz_recording_id.
--
-- This migration adds a partial index on works.recordings(musicbrainz_recording_id)
-- to support MBID-based lookups from the enrichment pipeline and future
-- MusicBrainz bulk import. The partial predicate keeps the index lean:
-- only rows that carry an MBID are indexed.
--
-- Rollback: DROP INDEX IF EXISTS works.recordings_musicbrainz_recording_id_idx;

CREATE INDEX IF NOT EXISTS recordings_musicbrainz_recording_id_idx
  ON works.recordings (musicbrainz_recording_id)
  WHERE musicbrainz_recording_id IS NOT NULL;

-- Reload PostgREST schema cache so the index is visible via REST queries.
NOTIFY pgrst, 'reload schema';
