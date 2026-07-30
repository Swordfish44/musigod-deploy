'use strict';
// scripts/db-seed-local.js
// LOCAL / NON-PRODUCTION ONLY.
// Applies supabase/seed.sql to the local database.
// The seed file contains Echo test artist data only — no real artist records.
//
// Run: npm run db:seed
// Requires: LOCAL_DATABASE_URL in .env.local, psql in PATH.

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const envLocalPath = path.join(__dirname, '..', '.env.local');
if (fs.existsSync(envLocalPath)) {
  require('dotenv').config({ path: envLocalPath });
}

const DATABASE_URL = process.env.LOCAL_DATABASE_URL;
if (!DATABASE_URL) {
  console.error('Error: LOCAL_DATABASE_URL is not set. See scripts/db-migrate-local.js for setup.');
  process.exit(1);
}

if (DATABASE_URL.includes('uykzkrnoetcldeuxzqyy') || DATABASE_URL.includes('supabase.co')) {
  console.error('Error: LOCAL_DATABASE_URL appears to point to the production Supabase project.');
  console.error('Seed data must not be applied to the production database.');
  process.exit(1);
}

try {
  execSync('psql --version', { stdio: 'pipe' });
} catch {
  console.error('Error: psql not found in PATH. See scripts/db-migrate-local.js for setup.');
  process.exit(1);
}

const seedFile = path.join(__dirname, '..', 'supabase', 'seed.sql');
if (!fs.existsSync(seedFile)) {
  console.error('Error: supabase/seed.sql not found.');
  process.exit(1);
}

console.log(`\nApplying seed to: ${DATABASE_URL.replace(/:[^:@]+@/, ':***@')}`);
console.log('  supabase/seed.sql ... ');

try {
  execSync(`psql "${DATABASE_URL}" -v ON_ERROR_STOP=1 -f "${seedFile}"`, { stdio: 'inherit' });
  console.log('\nSeed applied. Echo test workflow seeded at engagement_id: pilot-001-echo-sandbox\n');
} catch {
  console.error('\nSeed failed. Ensure migrations 000000–000004 have been applied first (npm run db:migrate).');
  process.exit(1);
}
