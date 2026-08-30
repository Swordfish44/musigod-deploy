'use strict'
// Regression test for the PR #33 production failure:
//   ERROR: 42703: column "profile_id" does not exist
//   CONTEXT: CREATE POLICY profile_read_processing_checkpoints_v1 ...
//
// Root cause: processing_checkpoints_v1 was created without profile_id, then
// unconditionally referenced in a dynamic RLS policy loop that assumed every
// listed table had that column.
//
// This file does static, content-based assertions on the migration SQL and
// the worker source — the same style already used by
// tests/large-statement-ingestion.test.js — so it runs everywhere `npm test`
// runs, with no database required. The live-database proof (self-repair
// against the exact broken shape, idempotent reapply, real RLS tenant
// isolation) lives in .github/workflows/royalty-intelligence-migration-validation.yml,
// which runs against a real Postgres service container on every PR touching
// these files — mirroring the pattern already established for the enterprise
// and HarbourView migrations in enterprise-migration-validation.yml.
const assert = require('assert'), fs = require('fs'), path = require('path'), root = path.join(__dirname, '..')

const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260829000002_large_statement_ingestion_v1.sql'), 'utf8')
const worker = fs.readFileSync(path.join(root, 'api/admin/run-ingestion-worker.js'), 'utf8')
const fixture = fs.readFileSync(path.join(root, 'supabase/fixtures/large_statement_ingestion_partial_state_v1.sql'), 'utf8')
const ciWorkflow = fs.readFileSync(path.join(root, '.github/workflows/royalty-intelligence-migration-validation.yml'), 'utf8')

// 1. The migration contains a safe existing-table repair path for
//    processing_checkpoints_v1.profile_id: add-if-missing, backfill from the
//    parent job, add the FK only if absent, then enforce NOT NULL.
assert(/ALTER TABLE royalty_intelligence\.processing_checkpoints_v1 ADD COLUMN IF NOT EXISTS profile_id uuid/.test(migration),
  'migration must add profile_id to processing_checkpoints_v1 idempotently')
assert(/UPDATE royalty_intelligence\.processing_checkpoints_v1 c[\s\S]*SET profile_id = j\.profile_id[\s\S]*FROM royalty_intelligence\.ingestion_jobs_v1 j/.test(migration),
  'migration must backfill profile_id from the parent ingestion job')
assert(/WHERE c\.job_id = j\.id AND c\.profile_id IS NULL/.test(migration),
  'backfill must only touch rows missing profile_id (safe on rerun)')
assert(/pg_constraint[\s\S]*processing_checkpoints_v1_profile_id_fkey/.test(migration),
  'migration must check pg_constraint before adding the profile_id foreign key (idempotent)')
assert(/FOREIGN KEY \(profile_id\) REFERENCES registrations\.rights_registration_profiles_v1\(id\) ON DELETE CASCADE/.test(migration),
  'profile_id foreign key must reference rights_registration_profiles_v1 with ON DELETE CASCADE')
assert(/ALTER TABLE royalty_intelligence\.processing_checkpoints_v1 ALTER COLUMN profile_id SET NOT NULL/.test(migration),
  'profile_id must ultimately be enforced NOT NULL')

// 2. Every profile-scoped policy in the dynamic loop references a column that
//    is verified to exist first — the exact defect that caused 42703 in
//    production can no longer reach CREATE POLICY undetected.
const loopMatch = migration.match(/FOREACH t IN ARRAY ARRAY\[([\s\S]*?)\][\s\S]*?END LOOP;\s*\nEND \$\$;/)
assert(loopMatch, 'expected the profile-scoped RLS FOREACH loop to be present')
const loopStart = migration.indexOf('DO $$\nDECLARE\n  t text;')
const loopEndMarker = 'END LOOP;\nEND $$;'
const loopBody = migration.slice(loopStart, migration.indexOf(loopEndMarker, loopStart) + loopEndMarker.length)
assert(/information_schema\.columns/.test(loopBody), 'RLS loop must check information_schema.columns before trusting profile_id exists')
assert(/column_name = 'profile_id'/.test(loopBody), 'RLS loop must specifically check for the profile_id column')
assert(/RAISE EXCEPTION.*missing profile_id/.test(loopBody), 'RLS loop must fail loudly and specifically if a future table lacks profile_id')
const loopTables = ['statement_packages_v1','upload_sessions_v1','source_files_v1','ingestion_jobs_v1','processing_checkpoints_v1','import_chunks_v1','raw_source_rows_v1','column_mappings_v1','import_exceptions_v1','import_approvals_v1']
for (const t of loopTables) assert(loopBody.includes(`'${t}'`), `RLS loop must still cover ${t}`)

// 3. Every policy statement in the file is idempotent (DROP IF EXISTS or
//    ON CONFLICT before create/insert) — no duplicate-object failure on rerun.
// This specifically catches the adapter_versions_read_v1 policy, which shipped
// in PR #33 without a DROP POLICY IF EXISTS guard and broke on any reapply.
assert(/DROP POLICY IF EXISTS adapter_versions_read_v1 ON royalty_intelligence\.adapter_versions_v1;\s*\nCREATE POLICY adapter_versions_read_v1/.test(migration),
  'adapter_versions_read_v1 must be dropped before recreation (idempotent rerun)')
assert(/DROP POLICY IF EXISTS statement_tus_insert_v1/.test(migration), 'storage insert policy must be idempotent')
assert(/DROP POLICY IF EXISTS statement_tus_select_v1/.test(migration), 'storage select policy must be idempotent')
assert(/ON CONFLICT\(adapter_key,adapter_version\) DO NOTHING/.test(migration), 'adapter version seed rows must be idempotent')
assert(/ON CONFLICT\(id\) DO UPDATE SET public=false/.test(migration), 'storage bucket upsert must be idempotent and stay private')

// 4. Checkpoint creation in the worker includes profile_id — the other half
//    of the original bug (the RLS policy filters on a column the worker
//    never populated, which would have silently hidden every checkpoint row
//    from its own owner even after the schema fix).
const checkpointInsertMatch = worker.match(/sb\('processing_checkpoints_v1',\{[^}]*body:\{([^}]*)\}/)
assert(checkpointInsertMatch, 'expected a processing_checkpoints_v1 insert in the ingestion worker')
assert(/profile_id:job\.profile_id/.test(checkpointInsertMatch[1]), 'worker must include profile_id:job.profile_id when creating a checkpoint')

// 5. Fixture and CI wiring exist so the self-repair and idempotency claims
//    above are actually exercised against a live database on every PR that
//    touches these files, not just asserted statically here.
assert(fixture.includes('CREATE TABLE IF NOT EXISTS royalty_intelligence.processing_checkpoints_v1'),
  'partial-state fixture must recreate the broken (profile_id-less) checkpoint table shape')
assert(!/profile_id/.test(fixture.match(/CREATE TABLE IF NOT EXISTS royalty_intelligence\.processing_checkpoints_v1\([\s\S]*?\);/)[0]),
  'fixture\'s processing_checkpoints_v1 must reproduce the broken shape with no profile_id column')
assert(ciWorkflow.includes('large_statement_ingestion_partial_state_v1.sql'), 'CI workflow must apply the partial-state fixture')
assert(/Reapply migration twice to prove idempotency/.test(ciWorkflow), 'CI workflow must reapply the migration to prove idempotency')
assert(/tenant isolation/.test(ciWorkflow), 'CI workflow must verify tenant isolation, not just schema shape')

console.log('large statement ingestion migration repair: self-repair path, audited RLS loop, idempotent policies, worker profile_id, and CI wiring all verified')
