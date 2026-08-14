'use strict';
// lib/mb-corpus-db.js
// PostgreSQL connection pool for the external MusicBrainz corpus database.
//
// The full MB corpus (artists, recordings, ISRCs, works, ISWCs, releases,
// release_groups, relationships, ingestion_state) lives in an external
// PostgreSQL instance, NOT in Supabase. Only entity_matches_v1 (the
// human-review boundary) remains in Supabase.
//
// Configuration:
//   MUSICBRAINZ_DATABASE_URL=postgres://user:pass@host:5432/musicbrainz
//
// Isolation guarantee: if the corpus DB is unavailable, corpus lookups and
// writes fail with logged warnings. entity_matches_v1 writes to Supabase
// are never blocked by corpus DB outages.

const { Pool } = require('pg');

const POOL_OPTIONS = {
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
};

let _pool = null;

function isConfigured() {
  return !!process.env.MUSICBRAINZ_DATABASE_URL;
}

function getPool() {
  if (_pool) return _pool;
  const url = process.env.MUSICBRAINZ_DATABASE_URL;
  if (!url) {
    throw new Error(
      '[mb-corpus-db] MUSICBRAINZ_DATABASE_URL is not set. ' +
      'Set this env var to a postgres:// connection string for the MusicBrainz corpus DB.'
    );
  }
  _pool = new Pool({ connectionString: url, ...POOL_OPTIONS });
  _pool.on('error', (err) => {
    console.error('[mb-corpus-db] Idle client error:', err.message);
  });
  return _pool;
}

async function query(sql, params = []) {
  return getPool().query(sql, params);
}

async function healthCheck() {
  try {
    await query('SELECT 1');
    return true;
  } catch (err) {
    console.error('[mb-corpus-db] Health check failed:', err.message);
    return false;
  }
}

async function close() {
  if (_pool) {
    await _pool.end();
    _pool = null;
  }
}

// Inject a mock pool for testing. Call _reset() between tests.
function _setPool(mockPool) {
  _pool = mockPool;
}

function _reset() {
  _pool = null;
}

module.exports = { query, healthCheck, isConfigured, close, _setPool, _reset };
