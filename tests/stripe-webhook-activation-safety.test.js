'use strict'
// Proves the Stripe activation chain, in order:
//   verified Stripe event -> correct artist -> payment recorded idempotently
//   -> agreement requirements checked -> guarded activation -> audit event
// against a stateful in-memory stand-in for the production tables. The stand-in
// enforces the plan_status CHECK constraint and the artists_v1 activation guard
// (ACTIVE requires agreement_signed_at, agreement_signed_by and
// agreement_document_url) the way production is documented to.
// This is code-level proof only; it is not evidence of production behaviour.
const assert = require('assert')
const crypto = require('crypto')
const { Readable } = require('stream')

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_activation'
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

const handler = require('../api/stripe-webhook')
const entitlement = require('../lib/paid-entitlement')
const { normalizeSubscriptionStatus } = handler._test

const VALID_PLAN_STATUS = ['PENDING_CHECKOUT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'PAST_DUE', 'TRIAL']
const GUARD = JSON.stringify({ code: 'P0001', message: 'Artist cannot be activated without a signed Publishing Administration Agreement. Set agreement_signed_at, agreement_signed_by, and agreement_document_url first.' })
const SIGNED = { agreement_signed_at: '2026-09-25T10:00:00Z', agreement_signed_by: 'Artist One', agreement_document_url: 'legal/agreements/artist-1.pdf' }

let db
function reset({ agreement = SIGNED, planStatus = 'PENDING_CHECKOUT', meta = {}, exists = true } = {}) {
  db = {
    artists: exists ? [{
      id: 'artist-1', email: 'a@b.co', plan_status: planStatus, plan_tier: 'STARTER', meta: { genre: 'rap', ...meta },
      agreement_signed_at: null, agreement_signed_by: null, agreement_document_url: null, ...agreement,
    }] : [],
    registrations: [{ artist_id: 'artist-1', stripe_customer_id: null, plan_status: null }, { artist_id: 'artist-2', stripe_customer_id: 'cus_other' }],
    receipts: [], accounts: [], timeline: [],
    ops: [],
    fail: {}, // { ledger, audit, auditOnce, guardRefuses, metaOnce }
  }
}
const artist = () => db.artists[0]
const ok = body => ({ ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => body })
const bad = (status, text) => ({ ok: false, status, text: async () => text, json: async () => JSON.parse(text) })

global.fetch = async (url, options = {}) => {
  const u = decodeURIComponent(String(url)); const method = options.method || 'GET'
  const body = options.body ? JSON.parse(options.body) : null
  const id = (u.match(/id=eq\.([^&]+)/) || [])[1]

  if (u.includes('/payment_event_receipts_v1')) {
    if (db.fail.ledger) return bad(404, '{"code":"PGRST205"}')
    if (method === 'GET') { db.ops.push('ledger.lookup'); return ok(db.receipts.filter(r => u.includes(r.provider_event_id)).map(r => ({ provider_event_id: r.provider_event_id }))) }
    if (!db.receipts.some(r => r.provider_event_id === body.provider_event_id)) db.receipts.push(body)
    db.ops.push('ledger.receipt'); return ok('')
  }
  if (u.includes('/payment_accounts_v1')) {
    if (method === 'GET') return ok(db.accounts.filter(a => a.is_primary && a.artist_id === 'artist-1'))
    if (method === 'PATCH') { db.accounts.filter(a => a.is_primary).forEach(a => Object.assign(a, body)); return ok('') }
    const existing = db.accounts.find(a => a.provider === body.provider && a.provider_subscription_id === body.provider_subscription_id)
    if (existing) Object.assign(existing, body); else db.accounts.push({ ...body })
    db.ops.push('payment.recorded'); return ok('')
  }
  if (u.includes('/artist_activity_timeline_v1')) {
    if (db.fail.audit || db.fail.auditOnce) { db.fail.auditOnce = false; return bad(503, 'audit unavailable') }
    db.timeline.push(body); db.ops.push(`audit.${body.event_type}`); return ok('')
  }
  if (u.includes('/artists_v1')) {
    const row = db.artists.find(a => a.id === id)
    if (method === 'GET') { if (u.includes('select=id,plan_tier,plan_status')) db.ops.push('binding.artist'); return ok(row ? [JSON.parse(JSON.stringify(row))] : []) }
    if (!row) return ok('')
    if (body.plan_status !== undefined && !VALID_PLAN_STATUS.includes(body.plan_status)) return bad(400, '{"code":"23514"}')
    if (body.plan_status === 'ACTIVE') {
      db.ops.push('guard.check')
      const complete = row.agreement_signed_at && row.agreement_signed_by && row.agreement_document_url
      if (!complete || db.fail.guardRefuses) { db.ops.push('guard.refused'); return bad(400, GUARD) }
      db.ops.push('artist.ACTIVE')
    }
    if (body.meta) {
      if (db.fail.metaOnce && body.meta.activation_event) { db.fail.metaOnce = false; return bad(503, 'meta write failed') }
      if (body.meta.activation_event && !row.meta?.activation_event) db.ops.push('artist.activation_event')
    }
    Object.assign(row, body); return ok('')
  }
  if (u.includes('/registrations_v1')) {
    if (method === 'GET') {
      if (u.includes('stripe_customer_id=eq.')) {
        db.ops.push('binding.customer')
        const cus = u.match(/stripe_customer_id=eq\.([^&]+)/)[1]
        return ok(db.registrations.filter(r => r.stripe_customer_id === cus).map(r => ({ artist_id: r.artist_id })))
      }
      return ok(db.registrations.filter(r => r.artist_id === 'artist-1'))
    }
    if (body.plan_status !== undefined && !VALID_PLAN_STATUS.concat('PAID_AWAITING_AGREEMENT').includes(body.plan_status)) return bad(400, '{"code":"23514"}')
    const aid = (u.match(/artist_id=eq\.([^&]+)/) || [])[1]
    db.registrations.filter(r => r.artist_id === aid).forEach(r => Object.assign(r, body)); return ok('')
  }
  return ok('')
}

function send(event, { secret = process.env.STRIPE_WEBHOOK_SECRET } = {}) {
  const raw = Buffer.from(JSON.stringify(event))
  const t = Math.floor(Date.now() / 1000)
  const sig = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')
  const req = Readable.from([raw]); req.method = 'POST'; req.url = '/api/stripe-webhook'
  req.headers = { 'stripe-signature': `t=${t},v1=${sig}` }
  const res = { statusCode: 200, body: null, status(c) { this.statusCode = c; return this }, json(b) { this.body = b; return this } }
  return handler(req, res).then(() => res)
}

const checkout = (id = 'evt_cs_paid', over = {}) => ({
  id, type: 'checkout.session.completed', created: 1790000000, livemode: false,
  data: { object: { id: 'cs_test_1', mode: 'subscription', payment_status: 'paid', customer: 'cus_1', subscription: 'sub_1', client_reference_id: 'artist-1', metadata: { artist_id: 'artist-1', plan: 'starter' }, ...over } },
})
const subEvent = (id, type, status) => ({
  id, type, created: 1790000001,
  data: { object: { id: 'sub_1', customer: 'cus_1', status, metadata: { artist_id: 'artist-1', plan: 'starter' } } },
})

function assertOrder(ops, expected) {
  let i = 0
  for (const op of ops) if (op === expected[i]) i++
  assert.equal(i, expected.length, `expected ordered steps ${JSON.stringify(expected)}\n got ${JSON.stringify(ops)}`)
}
const auditTypes = () => db.timeline.map(t => t.event_type)

let passed = 0
async function check(name, fn) { await fn(); passed++; console.log(`  ✓ ${name}`) }
const saved = [console.info, console.warn, console.error, console.log]
const quiet = () => { console.info = () => {}; console.warn = () => {}; console.error = () => {} }
const loud = () => { [console.info, console.warn, console.error] = saved }

;(async () => {
  quiet()
  await check('CHAIN: verified event -> artist -> payment recorded -> agreement checked -> guarded ACTIVE -> audit, in order', async () => {
    reset()
    const res = await send(checkout())
    assert.equal(res.statusCode, 200, JSON.stringify(res.body))
    assertOrder(db.ops, [
      'ledger.lookup',                 // idempotency check on the verified event
      'binding.artist',                // correct artist
      'binding.customer',
      'payment.recorded',              // payment recorded before any entitlement change
      'audit.ACTIVATION_AUTHORIZED',   // agreement checked; audit precedes activation
      'guard.check', 'artist.ACTIVE',  // DB guard still evaluated
      'audit.ACCOUNT_ACTIVATED',
      'artist.activation_event',
      'ledger.receipt',                // receipt last
    ])
    const acct = db.accounts[0]
    assert.equal(acct.provider, 'stripe'); assert.equal(acct.provider_subscription_id, 'sub_1')
    assert.equal(acct.provider_customer_id, 'cus_1'); assert.equal(acct.status, 'ACTIVE'); assert.equal(acct.plan_code, 'starter')
    assert.equal(acct.metadata.last_event_id, 'evt_cs_paid')
    const ev = artist().meta.activation_event
    assert.equal(ev.trigger, 'payment_confirmed'); assert.equal(ev.provider_event_id, 'evt_cs_paid')
    assert.equal(ev.provider_customer_id, 'cus_1'); assert.equal(ev.provider_subscription_id, 'sub_1')
    assert.equal(ev.agreement_signed_by, 'Artist One'); assert.equal(ev.agreement_document_url, 'legal/agreements/artist-1.pdf')
    const activated = db.timeline.find(t => t.event_type === 'ACCOUNT_ACTIVATED')
    assert.equal(activated.visibility, 'ADMIN_ONLY'); assert.equal(activated.artist_id, 'artist-1')
    assert.equal(activated.metadata.provider_event_id, 'evt_cs_paid')
    assert.equal(artist().meta.genre, 'rap', 'existing meta preserved')
    assert.equal(db.receipts[0].payload.status, 'ACTIVE')
    assert.equal(db.receipts[0].occurred_at, new Date(1790000000 * 1000).toISOString())
  })

  await check('unverified signature: 400 and zero database calls', async () => {
    reset()
    const res = await send(checkout(), { secret: 'whsec_wrong' })
    assert.equal(res.statusCode, 400)
    assert.equal(db.ops.length, 0); assert.equal(artist().plan_status, 'PENDING_CHECKOUT')
  })

  await check('wrong artist: client_reference_id mismatch -> nothing recorded or activated', async () => {
    reset()
    const res = await send(checkout('evt_mismatch', { client_reference_id: 'artist-9' }))
    assert.equal(res.statusCode, 200)
    assert.equal(db.accounts.length, 0); assert.equal(artist().plan_status, 'PENDING_CHECKOUT'); assert.equal(db.timeline.length, 0)
    assert.equal(db.receipts[0].payload.reason, 'binding_rejected:client_reference_mismatch')
  })

  await check('wrong artist: artist does not exist -> nothing recorded or activated', async () => {
    reset({ exists: false })
    const res = await send(checkout('evt_ghost'))
    assert.equal(res.statusCode, 200)
    assert.equal(db.accounts.length, 0); assert.equal(db.receipts[0].payload.reason, 'binding_rejected:artist_not_found')
  })

  await check('wrong artist: Stripe customer already bound to another artist -> refused', async () => {
    reset()
    const res = await send(checkout('evt_cus_other', { customer: 'cus_other' }))
    assert.equal(res.statusCode, 200)
    assert.equal(db.accounts.length, 0); assert.equal(artist().plan_status, 'PENDING_CHECKOUT')
    assert.equal(db.receipts[0].payload.reason, 'binding_rejected:customer_bound_to_other_artist')
  })

  await check('idempotent: redelivery is skipped; payment account is one row per subscription', async () => {
    reset()
    await send(checkout())
    const before = { ops: db.ops.length, timeline: db.timeline.length }
    const res = await send(checkout())
    assert.equal(res.body.duplicate, true)
    assert.deepEqual(db.ops.slice(before.ops), ['ledger.lookup'], 'redelivery does nothing but the lookup')
    assert.equal(db.timeline.length, before.timeline)
    await send({ id: 'evt_renewal', type: 'invoice.paid', created: 1792600000, data: { object: { id: 'in_2', customer: 'cus_1', subscription: 'sub_1', subscription_details: { metadata: { artist_id: 'artist-1', plan: 'starter' } } } } })
    assert.equal(db.accounts.length, 1)
    assert.equal(db.accounts[0].metadata.last_event_id, 'evt_renewal')
    assert.equal(db.receipts.length, 2)
  })

  await check('renewal: no second activation, original activation record untouched', async () => {
    reset()
    await send(checkout())
    const original = JSON.stringify(artist().meta.activation_event)
    await send({ id: 'evt_renewal', type: 'invoice.paid', created: 1792600000, data: { object: { id: 'in_2', customer: 'cus_1', subscription: 'sub_1', subscription_details: { metadata: { artist_id: 'artist-1', plan: 'starter' } } } } })
    assert.equal(JSON.stringify(artist().meta.activation_event), original)
    assert.equal(auditTypes().filter(t => t === 'ACCOUNT_ACTIVATED').length, 1)
  })

  await check('agreement unsigned: payment recorded, held, audit HELD, DB guard never asked', async () => {
    reset({ agreement: {} })
    const res = await send(checkout('evt_paid_unsigned'))
    assert.equal(res.statusCode, 200)
    assert.equal(db.accounts[0].status, 'ACTIVE', 'payment recorded')
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT')
    assert(!db.ops.includes('guard.check'), 'no activation attempted without agreement')
    assert.equal(artist().meta.billing_status, 'PAID_AWAITING_AGREEMENT')
    assert.equal(artist().meta.billing_event_id, 'evt_paid_unsigned')
    assert.deepEqual(auditTypes(), ['ACTIVATION_HELD_AWAITING_AGREEMENT'])
    assert.deepEqual(db.timeline[0].metadata.missing_agreement_fields, ['agreement_signed_at', 'agreement_signed_by', 'agreement_document_url'])
    assert.equal(db.registrations[0].plan_status, 'PAID_AWAITING_AGREEMENT')
  })

  await check('agreement partially recorded (no document): held, not activated', async () => {
    reset({ agreement: { agreement_signed_at: SIGNED.agreement_signed_at, agreement_signed_by: SIGNED.agreement_signed_by } })
    await send(checkout('evt_partial'))
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT')
    assert(!db.ops.includes('guard.check'))
    assert.deepEqual(db.timeline[0].metadata.missing_agreement_fields, ['agreement_document_url'])
  })

  await check('sign after pay: agreement_signed activation carries the original payment evidence', async () => {
    reset({ agreement: {} })
    await send(checkout('evt_paid_unsigned'))
    Object.assign(artist(), SIGNED)
    db.ops = []
    const out = await entitlement.activatePaidArtist('artist-1')
    assert.equal(out.activated, true)
    assertOrder(db.ops, ['audit.ACTIVATION_AUTHORIZED', 'guard.check', 'artist.ACTIVE', 'audit.ACCOUNT_ACTIVATED', 'artist.activation_event'])
    const ev = artist().meta.activation_event
    assert.equal(ev.trigger, 'agreement_signed'); assert.equal(ev.provider, 'stripe')
    assert.equal(ev.provider_event_id, 'evt_paid_unsigned'); assert.equal(ev.provider_subscription_id, 'sub_1')
    assert.equal(ev.provider_customer_id, 'cus_1')
  })

  await check('signing without any verified payment never activates', async () => {
    reset()
    assert.deepEqual(await entitlement.activatePaidArtist('artist-1'), { activated: false, reason: 'not-paid-awaiting-agreement' })
    reset({ meta: { billing_status: 'PAID_AWAITING_AGREEMENT' } })
    assert.deepEqual(await entitlement.activatePaidArtist('artist-1'), { activated: false, reason: 'no-payment-evidence' })
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT')
  })

  await check('DB guard refuses despite app check: guard wins, artist held', async () => {
    reset()
    db.fail.guardRefuses = true
    const res = await send(checkout('evt_guard'))
    assert.equal(res.statusCode, 200)
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT')
    assert.equal(artist().meta.billing_status, 'PAID_AWAITING_AGREEMENT')
    assert(db.ops.includes('guard.refused'))
    assert(!auditTypes().includes('ACCOUNT_ACTIVATED'))
  })

  await check('audit store down: no activation, 500, no receipt; Stripe retry then activates', async () => {
    reset()
    db.fail.auditOnce = true
    const res = await send(checkout('evt_audit_down'))
    assert.equal(res.statusCode, 500)
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT', 'never ACTIVE without a prior audit record')
    assert.equal(db.receipts.length, 0)
    const retry = await send(checkout('evt_audit_down'))
    assert.equal(retry.statusCode, 200)
    assert.equal(artist().plan_status, 'ACTIVE')
    assert.deepEqual(auditTypes(), ['ACTIVATION_AUTHORIZED', 'ACCOUNT_ACTIVATED'])
  })

  await check('interrupted activation (meta write failed) is completed on retry', async () => {
    reset()
    db.fail.metaOnce = true
    const res = await send(checkout('evt_interrupted'))
    assert.equal(res.statusCode, 500)
    assert.equal(artist().plan_status, 'ACTIVE')
    assert.equal(artist().meta.activation_event, undefined)
    const retry = await send(checkout('evt_interrupted'))
    assert.equal(retry.statusCode, 200)
    assert.equal(artist().meta.activation_event.provider_event_id, 'evt_interrupted')
  })

  await check('ledger unavailable: fail closed (500), no payment applied', async () => {
    reset()
    db.fail.ledger = true
    const res = await send(checkout('evt_no_ledger'))
    assert.equal(res.statusCode, 500)
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT'); assert.equal(db.accounts.length, 0)
  })

  await check('status mapping: only definitive Stripe statuses change entitlement', async () => {
    assert.equal(normalizeSubscriptionStatus('active'), 'ACTIVE')
    assert.equal(normalizeSubscriptionStatus('past_due'), 'PAST_DUE')
    assert.equal(normalizeSubscriptionStatus('unpaid'), 'PAST_DUE')
    assert.equal(normalizeSubscriptionStatus('canceled'), 'SUSPENDED')
    assert.equal(normalizeSubscriptionStatus('incomplete_expired'), 'SUSPENDED')
    for (const s of ['incomplete', 'trialing', 'paused', undefined, 'something_new']) assert.equal(normalizeSubscriptionStatus(s), null, String(s))
  })

  await check('incomplete / trialing: 200 no-op, no invalid enum write, no activation', async () => {
    for (const status of ['incomplete', 'trialing']) {
      reset()
      const res = await send(subEvent(`evt_${status}`, 'customer.subscription.created', status))
      assert.equal(res.statusCode, 200)
      assert.equal(artist().plan_status, 'PENDING_CHECKOUT'); assert.equal(db.accounts.length, 0)
      assert.equal(db.receipts[0].payload.reason, `non_definitive_status:${status}`)
    }
  })

  await check('late incomplete event does not revert a paid, active artist', async () => {
    reset()
    await send(checkout())
    const res = await send(subEvent('evt_late', 'customer.subscription.created', 'incomplete'))
    assert.equal(res.statusCode, 200)
    assert.equal(artist().plan_status, 'ACTIVE'); assert.equal(db.registrations[0].plan_status, 'ACTIVE')
  })

  await check('unpaid or non-subscription checkout never activates', async () => {
    reset()
    await send(checkout('evt_unpaid', { payment_status: 'unpaid' }))
    await send(checkout('evt_payment_mode', { mode: 'payment', subscription: null }))
    assert.equal(artist().plan_status, 'PENDING_CHECKOUT'); assert.equal(db.accounts.length, 0); assert.equal(db.timeline.length, 0)
  })

  loud()
  console.log(`stripe-webhook-activation-safety: ${passed} passed, 0 failed`)
})().catch(err => {
  loud()
  console.error(err)
  process.exitCode = 1
})
