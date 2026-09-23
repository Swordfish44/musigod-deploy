'use strict'

// Regression for the 2026-09-23 PGRST106 "Invalid schema: artists" outage.
// An in-database `pgrst.db_schemas` override on the authenticator role shadowed
// the dashboard Exposed-schemas list and dropped artists/registrations.
// This test pins:
//   1. which schemas the registration -> PayPal checkout path addresses,
//   2. that the fix exposes every one of them and never drops/creates tables,
//   3. that register-artist surfaces a PGRST106 as a 500 (not a silent success).

const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { Readable } = require('stream')

const root = path.resolve(__dirname, '..')
const release = path.join(root, 'supabase/releases/20260923_postgrest_exposed_schemas')
const read = f => fs.readFileSync(path.join(release, f), 'utf8')
const stripComments = sql => sql.replace(/--.*$/gm, '')

const fix = read('01_fix.sql')
const migration = fs.readFileSync(path.join(root, 'supabase/migrations/20260923000000_postgrest_exposed_schemas.sql'), 'utf8')
const preflight = stripComments(read('00_preflight.sql'))
const verify = stripComments(read('02_verify.sql'))

// ── Static release checks ────────────────────────────────────────────────────
assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(preflight.replace(/'[^']*'/g, "''")), 'preflight must be read-only')
assert(!/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\b/i.test(verify.replace(/'[^']*'/g, "''")), 'verify must be read-only')
assert(!/\b(DROP|TRUNCATE|DELETE)\b/i.test(stripComments(fix)), 'fix must not drop or delete anything')
assert(!/CREATE\s+(TABLE|SCHEMA|VIEW)/i.test(stripComments(fix)), 'fix must not create parallel persistence')
assert(!/\b(anon|authenticated)\b/.test(stripComments(fix)), 'fix must not widen anon/authenticated access')
assert(stripComments(fix).trim() === stripComments(migration).trim(), 'migration must match release 01_fix.sql')
assert(fix.includes("NOTIFY pgrst, 'reload config'"), 'fix must reload PostgREST config')
assert(fix.includes("to_regclass('artists.artists_v1') IS NULL"), 'fix must refuse to run without canonical artists table')
assert(fix.includes('to_regnamespace(s) IS NOT NULL'), 'fix must never expose a non-existent schema (PGRST002)')

const appSchemas = (fix.match(/app_schemas text\[\] := ARRAY\[([^\]]+)\]/) || [])[1]
assert(appSchemas, 'fix must declare app_schemas')
const exposed = new Set(appSchemas.split(',').map(s => s.trim().replace(/'/g, '')))

// Every Accept-Profile used on the registration -> checkout path must be exposed.
const pathFiles = ['api/register-artist.js', 'api/create-paypal-subscription.js', 'api/create-checkout-session.js']
for (const file of pathFiles) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  const used = new Set([
    ...[...src.matchAll(/'Accept-Profile':\s*'([a-z_]+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/sbFetch\([^,]+,\s*'([a-z_]+)'/g)].map(m => m[1]),
    ...[...src.matchAll(/sbHeaders\('([a-z_]+)'\)/g)].map(m => m[1]),
  ])
  used.delete('public')
  for (const schema of used) assert(exposed.has(schema), `${file} uses Accept-Profile ${schema}, which the fix does not expose`)
}
assert(exposed.has('artists') && exposed.has('registrations'))

// ── Behavioural check: register-artist uses the canonical schemas ────────────
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
delete process.env.RESEND_API_KEY
delete process.env.N8N_REGISTERED_WEBHOOK_URL
const handler = require('../api/register-artist')

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/api/register-artist'
  req.headers = { origin: 'https://musigod.com' }
  return req
}
function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(n, v) { this.headers[n] = v },
    status(c) { this.statusCode = c; return this },
    json(b) { this.body = b; return this },
    end() { return this },
  }
}
const body = { legal_first_name: 'Test', legal_last_name: 'Artist', email: 'regression@example.com', plan: 'starter' }
const quiet = console.error
console.error = () => {}

async function main() {
  // Exposed: both inserts go to their canonical profiles.
  const calls = []
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), opts })
    const u = String(url)
    if (u.endsWith('/rest/v1/artists_v1')) return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'a1' }]) }
    if (u.includes('/rest/v1/registrations_v1')) return { ok: true, status: 201, text: async () => JSON.stringify([{ id: 'r1' }]) }
    return { ok: true, status: 200, text: async () => '[]', json: async () => [] }
  }
  let res = response()
  await handler(request(body), res)
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body))
  assert.deepStrictEqual(res.body, { artist_id: 'a1', registration_id: 'r1', plan: 'starter' })
  const artistCall = calls.find(c => c.url.endsWith('/rest/v1/artists_v1'))
  assert.strictEqual(artistCall.opts.headers['Content-Profile'], 'artists')
  assert.strictEqual(artistCall.opts.headers['Accept-Profile'], 'artists')
  const regCall = calls.find(c => c.url.includes('/rest/v1/registrations_v1'))
  assert.strictEqual(regCall.opts.headers['Content-Profile'], 'registrations')
  assert(regCall.url.includes('on_conflict=artist_id,registration_type'), 'registration upsert must stay idempotent')
  assert(/resolution=merge-duplicates/.test(regCall.opts.headers.Prefer))

  // Not exposed (the outage): must fail loudly, never report success.
  global.fetch = async () => ({
    ok: false, status: 406,
    text: async () => JSON.stringify({ code: 'PGRST106', message: 'Invalid schema: artists' }),
  })
  res = response()
  await handler(request(body), res)
  assert.strictEqual(res.statusCode, 500)
  assert.deepStrictEqual(res.body, { error: 'Registration failed' })

  console.error = quiet
  console.log('postgrest-exposed-schemas tests passed')
}

main().catch(err => { console.error = quiet; console.error(err); process.exit(1) })
