'use strict';
// scripts/db-status-local.js
// Lists all migration files in supabase/migrations/ with their timestamps.
// Does not require a database connection — reports filesystem state only.
//
// Run: npm run db:status

const fs = require('fs');
const path = require('path');

const migrationsDir = path.join(__dirname, '..', 'supabase', 'migrations');

if (!fs.existsSync(migrationsDir)) {
  console.error('supabase/migrations/ directory not found.');
  process.exit(1);
}

const files = fs.readdirSync(migrationsDir)
  .filter(f => f.endsWith('.sql'))
  .sort();

console.log(`\nMusiGod migration status — ${files.length} file(s) in supabase/migrations/\n`);
console.log('  (Filesystem only — no DB connection. Run npm run db:migrate to apply.)\n');

for (let i = 0; i < files.length; i++) {
  const file = files[i];
  const filePath = path.join(migrationsDir, file);
  const stat = fs.statSync(filePath);
  const sizeKb = (stat.size / 1024).toFixed(1);
  console.log(`  [${String(i + 1).padStart(2, '0')}] ${file}  (${sizeKb} KB)`);
}

console.log('\nTo apply all migrations to a local database:');
console.log('  1. Set LOCAL_DATABASE_URL in .env.local');
console.log('  2. Run: npm run db:migrate');
console.log('  3. Run: npm run db:seed  (Echo test data only)\n');
console.log('WARNING: Never apply these migrations to the production Supabase project');
console.log('         (uykzkrnoetcldeuxzqyy) directly. Use the dashboard or Supabase CLI');
console.log('         with human review for production migrations.\n');
