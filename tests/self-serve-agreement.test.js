'use strict'
// Artist self-serve: pay -> signing link (checkout page + email) -> artist signs
// -> recorded on the canonical artist -> activated. No operator step.
const assert = require('assert')
const { Readable } = require('stream')
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'
process.env.RESEND_API_KEY = 're_test'
process.env.PAYPAL_BILLING_ENABLED = 'true'

const signing = require('../lib/agreement-signing')
const paypal = require('../lib/paypal-billing')
paypal.verifyWebhook = async () => true
paypal.planForId = id => (id === 'P-STARTER' ? 'starter' : null)
paypal.showSubscription = async () => ({ status: 'ACTIVE', custom_id: 'a1', plan_id: 'P-STARTER' })
const agreementApi = require('../api/publishing-agreement')
const webhook = require('../api/paypal-webhook')
const verifyPaypal = require('../api/verify-paypal-subscription')

const AGREEMENT_TEXT = 'MUSIGOD PUBLISHING ADMINISTRATION AGREEMENT Version 1.0 ...'
let db, emails
function reset() {
  emails = []
  db = {
    artist: { id: 'a1', email: 'artist@example.com', legal_first_name: 'Roger', legal_last_name: 'Jackson', plan_tier: 'STARTER', plan_status: 'PENDING_CHECKOUT', meta: {}, agreement_signed_at: null },
    signed: [], registration: {}, accounts: [], receipts: [],
  }
}
const ok = b => ({ ok: true, status: 200, text: async () => JSON.stringify(b), json: async () => b })
global.fetch = async (url, opts = {}) => {
  const u = String(url); const m = opts.method || 'GET'; const body = opts.body ? JSON.parse(opts.body) : null
  if (u.startsWith('https://api.resend.com')) { emails.push(body); return ok({ id: 'em' }) }
  if (u.includes('/rpc/fn_sign_agreement_v1')) {
    const row = { id: `sa-${db.signed.length + 1}`, agreement_ref: 'AGR-1', artist_email: body.p_artist_email, artist_id: body.p_artist_id, service_type: body.p_service_type, version: 'v1.0', full_agreement_text: AGREEMENT_TEXT, signed_at: '2026-09-25T00:00:00Z', ip_address: body.p_ip_address }
    db.signed.push(row); return ok(row)
  }
  if (u.includes('/agreement_versions_v1')) return ok([{ title: 'MusiGod Publishing Administration Agreement', version: 'v1.0', body_text: AGREEMENT_TEXT }])
  if (u.includes('/signed_agreements_v1')) return ok(db.signed.filter(r => u.includes(r.id)))
  if (u.includes('/artists_v1')) {
    if (m === 'GET') return ok([db.artist])
    if (body.plan_status === 'ACTIVE' && !(body.agreement_signed_at || db.artist.agreement_signed_at)) {
      return { ok: false, status: 400, text: async () => '{"code":"P0001","message":"Artist cannot be activated without a signed Publishing Administration Agreement."}' }
    }
    Object.assign(db.artist, body); return ok([db.artist])
  }
  if (u.includes('/registrations_v1')) { Object.assign(db.registration, body); return ok([]) }
  if (u.includes('/payment_accounts_v1')) {
    if (m === 'GET') return ok(db.accounts.filter(a => a.is_primary))
    if (m === 'POST') { const e = db.accounts.find(a => a.provider_subscription_id === body.provider_subscription_id); e ? Object.assign(e, body) : db.accounts.push(body) }
    return ok([])
  }
  if (u.includes('/payment_event_receipts_v1')) { if (m === 'GET') return ok(db.receipts.filter(r => u.includes(r.provider_event_id))); db.receipts.push(body); return ok([]) }
  return ok([])
}
function call(handler, method, { query, body, headers } = {}) {
  const req = Readable.from([Buffer.from(body ? JSON.stringify(body) : '')])
  req.method = method; req.query = query || {}; req.headers = { host: 'preview-x.vercel.app', 'x-forwarded-for': '203.0.113.9', 'user-agent': 'test', ...(headers || {}) }
  const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v }, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this }, send(b) { this.body = b; return this }, end() { return this } }
  return Promise.resolve(handler(req, res)).then(() => res)
}
const quiet = { info: console.info, warn: console.warn, error: console.error }
const mute = () => { console.info = console.warn = console.error = () => {} }
const unmute = () => Object.assign(console, quiet)

;(async () => {
  mute()
  // 1. Payment arrives unsigned -> held, signing email sent once
  reset()
  const activated = { id: 'WH-1', event_type: 'BILLING.SUBSCRIPTION.ACTIVATED', resource: { id: 'I-1', custom_id: 'a1', plan_id: 'P-STARTER', status: 'ACTIVE' } }
  let r = await call(webhook, 'POST', { body: activated })
  assert.strictEqual(r.statusCode, 200)
  assert.strictEqual(db.artist.meta.billing_status, 'PAID_AWAITING_AGREEMENT')
  assert.strictEqual(emails.length, 1, 'signing email sent')
  assert.strictEqual(emails[0].to, 'artist@example.com')
  const link = emails[0].html.match(/href="([^"]+agreement\.html\?token=[^"]+)"/)[1]
  await call(webhook, 'POST', { body: { ...activated, id: 'WH-2', event_type: 'PAYMENT.SALE.COMPLETED', resource: { billing_agreement_id: 'I-1' } } })
  assert.strictEqual(emails.length, 1, 'redelivery/second event does not re-email')

  // 2. Checkout confirmation page gets the signing link too
  r = await call(verifyPaypal, 'POST', { body: { artist_id: 'a1', subscription_id: 'I-SUB01' } })
  assert.strictEqual(r.body.verified, true)
  assert(r.body.sign_url.startsWith('https://preview-x.vercel.app/agreement.html?token='))

  // 3. Artist opens the link
  const token = decodeURIComponent(link.split('token=')[1])
  r = await call(agreementApi, 'GET', { query: { token } })
  assert.strictEqual(r.statusCode, 200)
  assert.strictEqual(r.body.artist.legal_name, 'Roger Jackson')
  assert.strictEqual(r.body.agreement.body_text, AGREEMENT_TEXT)
  assert.strictEqual(r.body.already_signed, false)

  // 4. Guards
  assert.strictEqual((await call(agreementApi, 'GET', { query: { token: token + 'x' } })).statusCode, 401)
  assert.strictEqual((await call(agreementApi, 'POST', { body: { token, typed_name: 'Roger Jackson', consent: false } })).statusCode, 400)
  assert.strictEqual((await call(agreementApi, 'POST', { body: { token, typed_name: 'Roger', consent: true } })).statusCode, 400)
  const expired = signing.createSigningToken('a1', Date.now() - 31 * 864e5)
  assert.strictEqual((await call(agreementApi, 'POST', { body: { token: expired, typed_name: 'Roger Jackson', consent: true } })).statusCode, 401)
  assert.strictEqual(db.artist.plan_status, 'PENDING_CHECKOUT')

  // 5. Artist signs -> recorded + ACTIVE, no operator involved
  r = await call(agreementApi, 'POST', { body: { token, typed_name: '  Roger   Jackson ', consent: true } })
  assert.strictEqual(r.statusCode, 200, JSON.stringify(r.body))
  assert.strictEqual(r.body.activated, true)
  assert.strictEqual(db.artist.plan_status, 'ACTIVE')
  assert.strictEqual(db.artist.agreement_signed_by, 'Roger Jackson')
  assert.strictEqual(db.artist.agreement_ip_address, '203.0.113.9')
  assert(db.artist.agreement_document_url.startsWith('https://preview-x.vercel.app/api/publishing-agreement?receipt=sa-1&sig='))
  assert.strictEqual(db.registration.plan_status, 'ACTIVE')
  assert.strictEqual(db.signed.length, 1)
  assert.strictEqual(db.signed[0].service_type, 'PUBLISHING_ADMIN')

  // 6. Double submit is idempotent
  r = await call(agreementApi, 'POST', { body: { token, typed_name: 'Roger Jackson', consent: true } })
  assert.strictEqual(r.body.already_signed, true)
  assert.strictEqual(db.signed.length, 1)

  // 7. Signed copy is viewable only with a valid signature
  const receiptUrl = new URL(db.artist.agreement_document_url)
  r = await call(agreementApi, 'GET', { query: { receipt: receiptUrl.searchParams.get('receipt'), sig: receiptUrl.searchParams.get('sig') } })
  assert.strictEqual(r.statusCode, 200)
  assert(r.body.includes('Roger Jackson') && r.body.includes('AGR-1'))
  r = await call(agreementApi, 'GET', { query: { receipt: 'sa-1', sig: 'forged' } })
  assert.strictEqual(r.statusCode, 404)

  // 8. Sign BEFORE paying -> payment activates immediately later
  reset()
  const t2 = signing.createSigningToken('a1')
  r = await call(agreementApi, 'POST', { body: { token: t2, typed_name: 'Roger Jackson', consent: true } })
  assert.strictEqual(r.body.activated, false)
  assert.strictEqual(db.artist.plan_status, 'PENDING_CHECKOUT')
  await call(webhook, 'POST', { body: { ...activated, id: 'WH-9' } })
  assert.strictEqual(db.artist.plan_status, 'ACTIVE')
  assert.strictEqual(emails.length, 0, 'no signing email needed when already signed')

  unmute()
  console.log('self-serve agreement tests passed')
})().catch(e => { unmute(); console.error(e); process.exit(1) })
