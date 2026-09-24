'use strict'
// Paid-but-unsigned artists: payment is recorded without bypassing the DB
// agreement guard, PayPal gets 200 (no retry storm), signing later activates.
const assert = require('assert')
const { Readable } = require('stream')
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

const paypal = require('../lib/paypal-billing')
paypal.verifyWebhook = async () => true
paypal.planForId = id => (id === 'P-STARTER' ? 'starter' : null)
const entitlement = require('../lib/paid-entitlement')
const webhook = require('../api/paypal-webhook')

let db
function reset(signed) {
  db = {
    artist: { id: 'a1', email: 'x@y.com', plan_status: 'PENDING_CHECKOUT', plan_tier: 'STARTER', meta: { genre: 'rap' }, agreement_signed_at: signed ? '2026-09-24' : null },
    registration: { artist_id: 'a1', status: 'PENDING', plan_status: null, plan_type: null },
    accounts: [], receipts: [],
  }
}
const ok = body => ({ ok: true, status: 200, text: async () => JSON.stringify(body), json: async () => body })
global.fetch = async (url, opts = {}) => {
  const u = String(url); const method = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : null
  if (u.includes('/artists_v1')) {
    if (method === 'GET') return ok([db.artist])
    if (body.plan_status === 'ACTIVE' && !db.artist.agreement_signed_at) {
      const t = JSON.stringify({ code: 'P0001', message: 'Artist cannot be activated without a signed Publishing Administration Agreement. Set agreement_signed_at, agreement_signed_by, and agreement_document_url first.' })
      return { ok: false, status: 400, text: async () => t }
    }
    if (body.plan_status && !['PENDING_CHECKOUT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'PAST_DUE', 'TRIAL'].includes(body.plan_status)) {
      return { ok: false, status: 400, text: async () => '{"code":"23514"}' }
    }
    Object.assign(db.artist, body); return ok([db.artist])
  }
  if (u.includes('/registrations_v1')) { Object.assign(db.registration, body); return ok([]) }
  if (u.includes('/payment_accounts_v1')) {
    if (method === 'GET') return ok(db.accounts.filter(a => a.is_primary))
    if (method === 'PATCH') { db.accounts.filter(a => a.is_primary).forEach(a => Object.assign(a, body)); return ok([]) }
    const existing = db.accounts.find(a => a.provider_subscription_id === body.provider_subscription_id)
    if (existing) Object.assign(existing, body); else db.accounts.push({ ...body })
    return ok([])
  }
  if (u.includes('/payment_event_receipts_v1')) {
    if (method === 'GET') return ok(db.receipts.filter(r => u.includes(encodeURIComponent(r.provider_event_id))))
    db.receipts.push(body); return ok([])
  }
  return ok([])
}
function send(event) {
  const req = Readable.from([Buffer.from(JSON.stringify(event))]); req.method = 'POST'; req.headers = {}
  const res = { statusCode: 200, setHeader() {}, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } }
  return webhook(req, res).then(() => res)
}
const activated = { id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-SUB', custom_id: 'a1', plan_id: 'P-STARTER', status: 'ACTIVE' } }
const quiet = console.info; console.info = () => {}

;(async () => {
  // 1. Unsigned: payment recorded, guard respected, PayPal gets 200, receipt written
  reset(false)
  let res = await send(activated)
  assert.strictEqual(res.statusCode, 200, JSON.stringify(res.body))
  assert.strictEqual(db.artist.plan_status, 'PENDING_CHECKOUT', 'guard never bypassed')
  assert.strictEqual(db.artist.meta.billing_status, 'PAID_AWAITING_AGREEMENT')
  assert.strictEqual(db.artist.meta.genre, 'rap', 'existing meta preserved')
  assert.strictEqual(db.artist.meta.billing_subscription_id, 'I-SUB')
  assert.strictEqual(db.registration.plan_status, 'PAID_AWAITING_AGREEMENT')
  assert.strictEqual(db.accounts.at(-1).status, 'ACTIVE')
  assert.strictEqual(db.receipts.length, 1)
  assert.strictEqual(db.receipts[0].payload.status, 'PAID_AWAITING_AGREEMENT')

  // 2. Redelivery is idempotent
  res = await send(activated)
  assert.strictEqual(res.body.duplicate, true)
  assert.strictEqual(db.receipts.length, 1)

  // 3. Signing later activates
  db.artist.agreement_signed_at = '2026-09-25'
  const a = await entitlement.activatePaidArtist('a1')
  assert.deepStrictEqual(a, { activated: true })
  assert.strictEqual(db.artist.plan_status, 'ACTIVE')
  assert.strictEqual(db.artist.meta.billing_status, 'ACTIVE')
  assert.strictEqual(db.registration.plan_status, 'ACTIVE')

  // 4. Signed before payment: webhook activates directly
  reset(true)
  res = await send({ ...activated, id: 'WH-2' })
  assert.strictEqual(res.statusCode, 200)
  assert.strictEqual(db.artist.plan_status, 'ACTIVE')
  assert.strictEqual(db.registration.plan_status, 'ACTIVE')

  // 5. Signing without any payment does not activate
  reset(true)
  assert.deepStrictEqual(await entitlement.activatePaidArtist('a1'), { activated: false, reason: 'not-paid-awaiting-agreement' })
  assert.strictEqual(db.artist.plan_status, 'PENDING_CHECKOUT')

  // 6. An abandoned (unpaid) subscription never displaces the paid primary
  reset(false)
  await send({ ...activated, id: 'WH-3' })
  await send({ id: 'WH-4', event_type: 'BILLING.SUBSCRIPTION.CREATED', resource: { id: 'I-ABANDONED', custom_id: 'a1', plan_id: 'P-STARTER', status: 'APPROVAL_PENDING' } })
  const primary = db.accounts.filter(a => a.is_primary)
  assert.strictEqual(primary.length, 1)
  assert.strictEqual(primary[0].provider_subscription_id, 'I-SUB')
  assert.strictEqual(db.accounts.find(a => a.provider_subscription_id === 'I-ABANDONED').is_primary, false)
  assert.strictEqual(db.artist.meta.billing_status, 'PAID_AWAITING_AGREEMENT')

  console.info = quiet
  console.log('paid-entitlement tests passed')
})().catch(e => { console.info = quiet; console.error(e); process.exit(1) })
