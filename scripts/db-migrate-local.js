'use strict';
// scripts/db-migrate-local.js
// LOCAL / NON-PRODUCTION ONLY.
// Applies all SQL migration files in supabase/migrations/ in lexicographic order
// to a local or non-production database via psql.
//
// Setup:
//   1. Create .env.local (gitignored) with:
//        LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres
//   2. Install psql (comes with PostgreSQL client tools).
//   3. Run: npm run db:migrate
//
// The local DB URL for a Supabase local stack is typically:
//   postgresql://postgres:postgres@localhost:54322/postgres
//
// WARNING: Never set LOCAL_DATABASE_URL to the production Supabase connection string.
// Production migrations are applied via the Supabase dashboard or CLI against
// the production project (uykzkrnoetcldeuxzqyy) only after human review.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Load .env.local
const envLocalPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envLocalPath)) {
  require('dotenv').config({ path: envLocalPath });
} else {
  console.warn('Warning: .env.local not found. Set LOCAL_DATABASE_URL in your environment.');
}

const DATABASE_URL = process.env.LOCAL_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Error: LOCAL_DATABASE_URL is not set.');
  console.error('');
  console.error('Create .env.local with:');
  console.error('  LOCAL_DATABASE_URL=postgresql://postgres:postgres@localhost:54322/postgres');
  console.error('');
  console.error('For a Supabase local stack: run `supabase start` in a project with config.toml first.');
  process.exit(1);
}

// Safety check: block obvious production URL patterns
if (DATABASE_URL.includes('uykzkrnoetcldeuxzqyy') || DATABASE_URL.includes('supabase.co')) {
  console.error('Error: LOCAL_DATABASE_URL appears to point to the production Supabase project.');
  console.error('Local migrations must not be applied to the production database.');
  console.error('Use the Supabase dashboard or CLI for production migration review and application.');
  process.exit(1);
}

// Verify psql is available
try {
  execSync('psql --version', { stdio: 'pipe' });
} catch {
  console.error('Error: psql not found in PATH.');
  console.error('Install PostgreSQL client tools or add psql to your PATH.');
  console.error('  Windows: https://www.postgresql.org/download/windows/');
  console.error('  Mac:     brew install libpq && brew link --force libpq');
  process.exit(1);
}

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');
const files = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();  // lexicographic order = chronological for timestamp-prefixed files

if (files.length === 0) {
  console.log('No migration files found in supabase/migrations/.');
  process.exit(0);
}

console.log(`\nApplying ${files.length} migration(s) to: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}\n`);

let appliedCount = 0;
let failedFile = null;

for (const file of files) {
  const filePath = path.join(migrationsDir, file);
  process.stdout.write(`  ${file} ... `);
  try {
    execSync(`psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${filePath}"`, { stdio: 'pipe' });
    console.log('OK');
    appliedCount++;
  } catch (err) {
    console.log('FAILED');
    console.error(`\n  Error output:\n${err.stderr ? err.stderr.toString() : err.message}\n`);
    failedFile = file;
    break;
  }
}

if (failedFile) {
  console.error(`\nMigration failed at: ${failedFile}`);
  console.error('Fix the error above and re-run. Previously applied migrations in this run are committed.');
  process.exit(1);
}

console.log(`\n${appliedCount} migration(s) applied successfully.\n`);
