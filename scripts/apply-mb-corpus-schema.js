'use strict';
// scripts/apply-mb-corpus-schema.js
// Apply db/mb-corpus/schema.sql to the MusicBrainz corpus database.
// Used during initial provisioning — connects via EICE tunnel or direct URL.
// Never commit credentials. Connection string comes from env or CLI arg.
//
// Usage:
//   MUSICBRAINZ_DATABASE_URL="postgres://..." node scripts/apply-mb-corpus-schema.js
//   node scripts/apply-mb-corpus-schema.js postgres://...
//
// Exits 0 on success, 1 on failure.

const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.env.MUSICBRAINZ_DATABASE_URL || process.argv[2];
  if (!url) {
    console.error('[apply-schema] ERROR: No connection URL. Set MUSICBRAINZ_DATABASE_URL or pass as first arg.');
    process.exit(1);
  }

  const schemaPath = path.join(__dirname, '..', 'db', 'mb-corpus', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    console.error(`[apply-schema] ERROR: Schema file not found: ${schemaPath}`);
    process.exit(1);
  }

  const sql = fs.readFileSync(schemaPath, 'utf8');
  console.log(`[apply-schema] Schema file: ${schemaPath} (${sql.length} bytes)`);

  // When connecting via EICE tunnel (localhost), the RDS TLS cert hostname won't match.
  // rejectUnauthorized: false only for this bootstrap operation — the tunnel itself encrypts.
  const parsed = new URL(url);
  const isTunnel = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const sslConfig = isTunnel ? { rejectUnauthorized: false } : undefined;

  const client = new Client({
    connectionString: url,
    connectionTimeoutMillis: 15000,
    ...(sslConfig && { ssl: sslConfig }),
  });

  try {
    console.log('[apply-schema] Connecting…');
    await client.connect();
    console.log('[apply-schema] Connected. Applying schema…');
    await client.query(sql);
    console.log('[apply-schema] Schema applied successfully.');

    // Verify all expected tables exist
    const { rows } = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'mb_staging'
      ORDER BY table_name
    `);
    const tables = rows.map(r => r.table_name);
    console.log(`[apply-schema] Tables in mb_staging (${tables.length}): ${tables.join(', ')}`);

    const expected = [
      'artist_aliases_v1', 'artists_v1', 'ingestion_state_v1',
      'isrcs_v1', 'iswcs_v1', 'recordings_v1', 'release_groups_v1',
      'releases_v1', 'relationships_v1', 'works_v1',
    ];
    const missing = expected.filter(t => !tables.includes(t));
    if (missing.length) {
      console.error(`[apply-schema] MISSING TABLES: ${missing.join(', ')}`);
      process.exit(1);
    }
    console.log('[apply-schema] All 10 expected tables verified. PASS');
  } catch (err) {
    console.error(`[apply-schema] ERROR: ${err.message}`);
    process.exit(1);
  } finally {
    await client.end();
  }
}

main();
