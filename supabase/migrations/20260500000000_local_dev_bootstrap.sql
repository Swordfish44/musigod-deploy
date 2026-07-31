-- supabase/migrations/20260500000000_local_dev_bootstrap.sql
--
-- LOCAL DEV BOOTSTRAP — runs first (2026-05 prefix sorts before all other migrations).
-- Creates schemas and minimal stub tables needed for FK resolution.
--
-- All statements use IF NOT EXISTS. This file is SAFE to apply to production:
-- every schema and table listed here pre-exists in production, so all statements
-- are no-ops there. The stubs only matter in a fresh local DB where the full
-- schema history was applied via SQL Editor rather than CLI migrations.
--
-- Why this file exists: several schemas (registrations, catalog, works) and
-- tables (artists_v1, graph_nodes_v1, works.recordings) were created directly
-- in production via SQL Editor and are not tracked as migration files
-- (CLAUDE.md backlog item #1). The later tracked migrations reference them,
-- so a fresh local DB needs these stubs before those migrations can run.

-- ── Non-public schemas ────────────────────────────────────────────────────────
-- All schemas referenced by config.toml db_schemas or by tracked migrations.
-- Created here because they were applied to production directly via SQL Editor
-- and are not tracked as migration files (CLAUDE.md backlog item #1).

CREATE SCHEMA IF NOT EXISTS registrations;
CREATE SCHEMA IF NOT EXISTS catalog;
CREATE SCHEMA IF NOT EXISTS works;
CREATE SCHEMA IF NOT EXISTS graph;
CREATE SCHEMA IF NOT EXISTS rights;
CREATE SCHEMA IF NOT EXISTS royalties;
CREATE SCHEMA IF NOT EXISTS disputes;
CREATE SCHEMA IF NOT EXISTS legal;

-- ── registrations.artists_v1 ─────────────────────────────────────────────────
-- FK target for intake_workflows_v1.artist_id and intake_upload_tokens_v1.artist_id.
-- Production table has the full structure; this stub satisfies the FK.
CREATE TABLE IF NOT EXISTS registrations.artists_v1 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

-- ── public.graph_nodes_v1 ────────────────────────────────────────────────────
-- FK target for ai_consent_ledger (work_id, granted_by columns).
-- Production table is the full graph nodes view; this stub satisfies the FK.
CREATE TABLE IF NOT EXISTS public.graph_nodes_v1 (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid()
);

-- ── works.recordings ─────────────────────────────────────────────────────────
-- Required by 20260711_recordings_musicbrainz_recording_id_idx.sql which adds
-- a CREATE INDEX on works.recordings(musicbrainz_recording_id). The index
-- migration cannot run without the table. Production has the full table;
-- this stub only needs the indexed column.
CREATE TABLE IF NOT EXISTS works.recordings (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  node_id                 UUID        UNIQUE,
  title                   TEXT,
  isrc                    TEXT,
  musicbrainz_recording_id UUID,
  composition_node_id     UUID,
  updated_at              TIMESTAMPTZ DEFAULT now()
);
