'use strict'

// Registration state machine regression suite. A fake PostgREST enforces the
// production constraints: artists_v1_email_key (case-sensitive UNIQUE(email))
// and registrations_v1 UNIQUE(artist_id, registration_type).

const assert = require('assert')
const { Readable } = require('stream')

process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
process.env.PAYPAL_BILLING_ENABLED = 'true'
delete process.env.RESEND_API_KEY
delete process.env.N8N_REGISTERED_WEBHOOK_URL

const paypal = require('../lib/paypal-billing')
paypal.isConfigured = () => true
paypal.planIdFor = plan => (['starter', 'growth', 'pro', 'label'].includes(plan) ? `P-SANDBOX-${plan}` : null)
paypal.createSubscription = async ({ artistId, plan }) => ({
  id: `I-${artistId}`,
  url: `https://www.sandbox.paypal.com/webapps/billing/subscriptions?ba_token=${plan}`,
})

const register = require('../api/register-artist')
const createPaypal = require('../api/create-paypal-subscription')

let db, calls, raceHook
function reset() {
  db = { artists: [], registrations: [] }
  calls = []
  raceHook = null
}
let seq = 0
const id = p => `${p}-${++seq}`
const json = (status, body) => ({ ok: status < 300, status, text: async () => JSON.stringify(body), json: async () => body })
const conflict = (constraint, detail) => json(409, { code: '23505', message: `duplicate key value violates unique constraint "${constraint}"`, details: detail })

function parse(url) {
  const u = new URL(url)
  const table = u.pathname.split('/').pop()
  return { table, q: u.searchParams }
}
function match(row, q) {
  for (const [k, v] of q) {
    if (['select', 'limit', 'order', 'on_conflict'].includes(k)) continue
    const [op, ...rest] = v.split('.')
    const val = rest.join('.')
    if (op === 'eq' && String(row[k]) !== val) return false
    if (op === 'ilike' && String(row[k]).toLowerCase() !== val.toLowerCase()) return false
    if (op === 'in' && !val.replace(/[()]/g, '').split(',').includes(String(row[k]))) return false
  }
  return true
}

global.fetch = async (url, opts = {}) => {
  const method = opts.method || 'GET'
  const { table, q } = parse(String(url))
  const profile = opts.headers?.['Accept-Profile']
  calls.push({ method, table, url: String(url), profile })
  if (!String(url).includes('/rest/v1/')) return json(200, {})
  if (table === 'artists_v1') {
    assert.strictEqual(profile, 'artists')
    if (method === 'GET') return json(200, db.artists.filter(r => match(r, q)).slice(0, Number(q.get('limit') || 100)))
    if (method === 'POST') {
      if (raceHook) { raceHook(); raceHook = null }
      const body = JSON.parse(opts.body)
      if (db.artists.some(a => a.email === body.email)) {
        return conflict('artists_v1_email_key', `Key (email)=(${body.email}) already exists.`)
      }
      const row = { id: id('artist'), created_at: new Date().toISOString(), ...body }
      db.artists.push(row)
      return json(201, [row])
    }
    if (method === 'PATCH') {
      const body = JSON.parse(opts.body)
      const rows = db.artists.filter(r => match(r, q))
      rows.forEach(r => Object.assign(r, body))
      return json(200, rows)
    }
  }
  if (table === 'registrations_v1') {
    assert.strictEqual(profile, 'registrations')
    if (method === 'POST') {
      const body = JSON.parse(opts.body)
      const merge = /merge-duplicates/.test(opts.headers.Prefer || '')
      const existing = db.registrations.find(r => r.artist_id === body.artist_id && r.registration_type === body.registration_type)
      if (existing && !merge) return conflict('registrations_v1_artist_id_registration_type_key', '')
      if (existing) { Object.assign(existing, body); return json(201, [existing]) }
      const row = { id: id('reg'), ...body }
      db.registrations.push(row)
      return json(201, [row])
    }
  }
  if (table === 'graph_upsert_node' || String(url).includes('/rpc/')) return json(200, {})
  return json(200, [])
}

function request(body, url = '/api/register-artist') {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = { origin: 'https://musigod.com', host: 'preview.vercel.app' }
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
async function registerWith(overrides = {}) {
  const res = response()
  await register(request({ legal_first_name: 'Test', legal_last_name: 'Artist', email: 'immobiliers@yahoo.com', plan: 'starter', ...overrides }), res)
  return res
}
const artistInserts = () => calls.filter(c => c.table === 'artists_v1' && c.method === 'POST').length

const quiet = { error: console.error, info: console.info, warn: console.warn, log: console.log }
function mute() { console.error = console.info = console.warn = console.log = () => {} }
function unmute() { Object.assign(console, quiet) }

const tests = []
const test = (name, fn) => tests.push({ name, fn })

test('1. new artist registration creates one artist + one pending registration', async () => {
  const res = await registerWith()
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body))
  assert.strictEqual(res.body.resumed, false)
  assert.strictEqual(res.body.status, 'PENDING_CHECKOUT')
  assert.strictEqual(res.body.payment_required, true)
  assert.strictEqual(db.artists.length, 1)
  assert.strictEqual(db.artists[0].plan_status, 'PENDING_CHECKOUT')
  assert.strictEqual(db.registrations.length, 1)
  assert.strictEqual(db.registrations[0].status, 'PENDING')
})

test('2. retry with same pending email reuses artist, no INSERT', async () => {
  const first = await registerWith()
  calls = []
  const second = await registerWith()
  assert.strictEqual(second.statusCode, 200, JSON.stringify(second.body))
  assert.strictEqual(second.body.artist_id, first.body.artist_id)
  assert.strictEqual(second.body.resumed, true)
  assert.strictEqual(artistInserts(), 0, 'must not attempt a duplicate artist INSERT')
})

test('3. case/whitespace-normalized retry reuses artist', async () => {
  const first = await registerWith()
  calls = []
  const second = await registerWith({ email: '  IMMOBILIERS@Yahoo.COM  ' })
  assert.strictEqual(second.statusCode, 200)
  assert.strictEqual(second.body.artist_id, first.body.artist_id)
  assert.strictEqual(artistInserts(), 0)
  const lookup = calls.find(c => c.table === 'artists_v1' && c.method === 'GET')
  assert(lookup.url.includes('email=eq.immobiliers%40yahoo.com'), lookup.url)
})

test('3b. legacy mixed-case stored email is found case-insensitively', async () => {
  db.artists.push({ id: 'legacy-1', email: 'Immobiliers@Yahoo.com', plan_status: 'PENDING', plan_tier: 'STARTER' })
  const res = await registerWith()
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(res.body.artist_id, 'legacy-1')
  assert.strictEqual(db.artists.length, 1)
  assert.strictEqual(db.artists[0].plan_status, 'PENDING_CHECKOUT')
})

test('4. 23505 race is recovered by re-reading the canonical artist', async () => {
  raceHook = () => db.artists.push({ id: 'raced-1', email: 'immobiliers@yahoo.com', plan_status: 'PENDING_CHECKOUT', plan_tier: 'STARTER' })
  const res = await registerWith()
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body))
  assert.strictEqual(res.body.artist_id, 'raced-1')
  assert.strictEqual(db.artists.length, 1)
})

test('4b. 23505 with an invisible row returns a specific 409, not "Registration failed"', async () => {
  raceHook = () => {}
  const origGet = db.artists
  db.artists = [{ id: 'hidden', email: 'immobiliers@yahoo.com', plan_status: 'PENDING_CHECKOUT', hidden: true }]
  const realFetch = global.fetch
  global.fetch = async (url, opts = {}) => {
    if (String(url).includes('artists_v1') && (opts.method || 'GET') === 'GET') return json(200, [])
    return realFetch(url, opts)
  }
  const res = await registerWith()
  global.fetch = realFetch
  db.artists = origGet
  assert.strictEqual(res.statusCode, 409)
  assert.strictEqual(res.body.code, 'EMAIL_ALREADY_REGISTERED')
  assert.notStrictEqual(res.body.error, 'Registration failed')
})

test('5. existing ACTIVE artist gets a clear 409 and no new rows', async () => {
  db.artists.push({ id: 'active-1', email: 'immobiliers@yahoo.com', plan_status: 'ACTIVE', plan_tier: 'STARTER' })
  const res = await registerWith()
  assert.strictEqual(res.statusCode, 409)
  assert.strictEqual(res.body.code, 'ACCOUNT_ACTIVE')
  assert.strictEqual(res.body.error, 'This MusiGod account is already active. Please sign in.')
  assert.strictEqual(artistInserts(), 0)
  assert.strictEqual(db.registrations.length, 0)
  assert.strictEqual(db.artists[0].plan_status, 'ACTIVE')
})

test('6. pending resume with a different plan updates the pending artist plan', async () => {
  await registerWith({ plan: 'growth' })
  const res = await registerWith({ plan: 'starter' })
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(db.artists.length, 1)
  assert.strictEqual(db.artists[0].plan_tier, 'STARTER')
  assert.strictEqual(db.registrations[0].meta.plan, 'starter')
})

test('7+8. five retries => one artist, one registration', async () => {
  for (let i = 0; i < 5; i++) {
    const res = await registerWith({ email: i % 2 ? ' Immobiliers@yahoo.com' : 'immobiliers@yahoo.com' })
    assert.strictEqual(res.statusCode, 200)
  }
  assert.strictEqual(db.artists.length, 1)
  assert.strictEqual(db.registrations.length, 1)
  const reg = calls.filter(c => c.table === 'registrations_v1' && c.method === 'POST')
  assert(reg.every(c => c.url.includes('on_conflict=artist_id,registration_type')))
})

test('9. checkout creation succeeds after pending artist reuse (PayPal sandbox URL)', async () => {
  await registerWith({ plan: 'growth' })
  const resumed = await registerWith({ plan: 'starter' })
  const res = response()
  await createPaypal(request({ artist_id: resumed.body.artist_id, plan: 'starter' }, '/api/create-paypal-subscription'), res)
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body))
  assert.strictEqual(res.body.provider, 'paypal')
  assert(res.body.url.startsWith('https://www.sandbox.paypal.com/'))
})

test('10. valid pending retry never returns generic "Registration failed"', async () => {
  await registerWith()
  const res = await registerWith()
  assert.strictEqual(res.statusCode, 200)
  assert.notStrictEqual(res.body?.error, 'Registration failed')
})

;(async () => {
  let failed = 0
  for (const t of tests) {
    reset()
    mute()
    try { await t.fn(); unmute(); console.log(`  ✓ ${t.name}`) } catch (e) { unmute(); failed++; console.log(`  ✗ ${t.name}\n    ${e.stack}`) }
  }
  console.log(`register-artist-resume: ${tests.length - failed} passed, ${failed} failed`)
  process.exit(failed ? 1 : 0)
})()
