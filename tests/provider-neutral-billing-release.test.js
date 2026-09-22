'use strict'

const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const release = path.join(root, 'supabase/releases/20260922_provider_neutral_billing')
const read = name => fs.readFileSync(path.join(release, name), 'utf8')
const stripComments = sql => sql.replace(/--.*$/gm, '')

const preflight = stripComments(read('00_preflight.sql'))
const install = read('01_install.sql')
const verify = stripComments(read('02_verify.sql'))
const rollback = read('03_rollback.sql')
const migration = fs.readFileSync(
  path.join(root, 'supabase/migrations/20260922000000_provider_neutral_billing.sql'),
  'utf8'
)

assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(preflight))
assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE)\b/i.test(verify))

for (const fragment of [
  'registrations.payment_accounts_v1',
  'registrations.payment_event_receipts_v1',
  'payment_accounts_v1_primary_artist_idx',
  'ENABLE ROW LEVEL SECURITY',
  'REVOKE ALL',
  'GRANT ALL',
]) {
  assert(install.includes(fragment), `install missing ${fragment}`)
  assert(migration.includes(fragment), `migration missing ${fragment}`)
}

assert(install.includes('BEGIN;') && install.includes('COMMIT;'))
assert(rollback.includes("Rollback blocked: registrations.payment_accounts_v1 contains data"))
assert(rollback.includes("Rollback blocked: registrations.payment_event_receipts_v1 contains data"))
assert(rollback.indexOf('RAISE EXCEPTION') < rollback.indexOf('DROP TABLE'))

console.log('Provider-neutral billing release: read-only preflight/verification, canonical install controls, and guarded rollback passed')
