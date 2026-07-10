-- 20260709_graph_recording_mbid_bridge.sql
--
-- Additive only. No existing columns, constraints, or data changed.
--
-- Fixes Gap Analysis Finding 1:
--   works.works_recordings_v1.musicbrainz_recording_id and
--   public.catalog_enriched_tracks_v1.recording_mbid represent the same
--   concept (the MB recording UUID) in two tables with no shared index.
--   This migration adds an index on the graph-side column so MBID-based
--   lookups from the enrichment pipeline (and future MB bulk import) are
--   efficient rather than full-scan.
--
--   The index on public.catalog_enriched_tracks_v1.recording_mbid already
--   exists (added in 20260619_catalog_enriched_tracks_v1.sql).
--
-- Companion code fix: api/graph-sync.js syncEnrichmentToGraph() now writes
-- musicbrainz_recording_id to works_recordings_v1 when a recording MBID is
-- present in the incoming track, and no longer overwrites the node's
-- external_id / external_id_ns (Finding 2 fix).
--
-- Rollback: DROP INDEX IF EXISTS works.works_recordings_v1_musicbrainz_recording_id_idx;
--   (safe — index-only change, no data affected)

CREATE INDEX IF NOT EXISTS works_recordings_v1_musicbrainz_recording_id_idx
  ON works.works_recordings_v1 (musicbrainz_recording_id)
  WHERE musicbrainz_recording_id IS NOT NULL;

-- Reload PostgREST so the index is visible to the query planner via REST.
NOTIFY pgrst, 'reload schema';
