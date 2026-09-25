'use strict'

const assert = require('assert')
const crypto = require('crypto')
const { Readable } = require('stream')

process.env.STRIPE_WEBHOOK_SECRET = 'whsec_test_lifecycle'
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

const handler = require('../api/stripe-webhook')

function request(event, timestamp = Math.floor(Date.now() / 1000)) {
  const raw = Buffer.from(JSON.stringify(event))
  const signature = crypto
    .createHmac('sha256', process.env.STRIPE_WEBHOOK_SECRET)
    .update(`${timestamp}.${raw}`)
    .digest('hex')
  const req = Readable.from([raw])
  req.method = 'POST'
  req.url = '/api/stripe-webhook'
  req.headers = { 'stripe-signature': `t=${timestamp},v1=${signature}` }
  return req
}

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

function fetchResponse(body = '') {
  return {
    ok: true,
    status: 200,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
    json: async () => typeof body === 'string' ? JSON.parse(body || 'null') : body,
  }
}

async function run(event, timestamp) {
  const calls = []
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if ((options.method || 'GET') === 'GET') return fetchResponse([{ artist_id: 'artist-123' }])
    return fetchResponse('')
  }
  const res = response()
  await handler(request(event, timestamp), res)
  return { res, calls }
}

function event(type, object) {
  return { id: `evt_${type.replace(/\W/g, '_')}`, type, data: { object } }
}

function patches(result, schema) {
  return result.calls.filter(call =>
    call.options.method === 'PATCH' && call.options.headers?.['Content-Profile'] === schema
  )
}

;(async () => {
  const paid = await run(event('checkout.session.completed', {
    id: 'cs_live_paid',
    mode: 'subscription',
    payment_status: 'paid',
    customer: 'cus_123',
    subscription: 'sub_123',
    metadata: { artist_id: 'artist-123', plan: 'growth' },
  }))
  assert.equal(paid.res.statusCode, 200)
  assert.equal(patches(paid, 'registrations').length, 1)
  assert.equal(patches(paid, 'artists').length, 1)
  assert.deepEqual(JSON.parse(patches(paid, 'artists')[0].options.body), {
    plan_status: 'ACTIVE',
    plan_tier: 'GROWTH',
  })

  const unpaid = await run(event('checkout.session.completed', {
    id: 'cs_live_unpaid',
    mode: 'subscription',
    payment_status: 'unpaid',
    customer: 'cus_123',
    subscription: 'sub_123',
    metadata: { artist_id: 'artist-123', plan: 'growth' },
  }))
  assert.equal(patches(unpaid, 'artists').length, 0)
  assert.equal(patches(unpaid, 'registrations').length, 0)

  const failed = await run(event('invoice.payment_failed', {
    id: 'in_failed',
    customer: 'cus_123',
    subscription: 'sub_123',
    subscription_details: { metadata: { artist_id: 'artist-123', plan: 'starter' } },
  }))
  assert.equal(JSON.parse(patches(failed, 'artists')[0].options.body).plan_status, 'PAST_DUE')
  assert.equal(JSON.parse(patches(failed, 'registrations')[0].options.body).plan_status, 'PAST_DUE')

  const renewed = await run(event('invoice.paid', {
    id: 'in_paid',
    customer: 'cus_123',
    subscription: 'sub_123',
    subscription_details: { metadata: { artist_id: 'artist-123', plan: 'starter' } },
  }))
  assert.equal(JSON.parse(patches(renewed, 'artists')[0].options.body).plan_status, 'ACTIVE')

  const refunded = await run(event('charge.refunded', {
    id: 'ch_refunded', customer: 'cus_123', amount: 7900, amount_refunded: 7900, refunded: true,
  }))
  assert.equal(JSON.parse(patches(refunded, 'artists')[0].options.body).plan_status, 'SUSPENDED')

  const partial = await run(event('charge.refunded', {
    id: 'ch_partial', customer: 'cus_123', amount: 7900, amount_refunded: 1000, refunded: false,
  }))
  assert.equal(patches(partial, 'artists').length, 0)

  const stale = await run(event('customer.subscription.updated', {
    id: 'sub_stale', customer: 'cus_123', status: 'active', metadata: { artist_id: 'artist-123' },
  }), Math.floor(Date.now() / 1000) - 301)
  assert.equal(stale.res.statusCode, 400)
  assert.equal(stale.calls.length, 0)

  // Paid but Publishing Administration Agreement unsigned: DB guard refuses ACTIVE.
  {
    const calls = []
    let meta = { genre: 'rap' }
    global.fetch = async (url, options = {}) => {
      const u = String(url); const method = options.method || 'GET'
      calls.push({ url: u, options })
      const body = options.body ? JSON.parse(options.body) : {}
      if (u.includes('/artists_v1') && method === 'PATCH' && body.plan_status === 'ACTIVE') {
        return { ok: false, status: 400, text: async () => JSON.stringify({ code: 'P0001', message: 'Artist cannot be activated without a signed Publishing Administration Agreement.' }) }
      }
      if (u.includes('/artists_v1') && method === 'PATCH' && body.meta) { meta = body.meta; return fetchResponse('') }
      if (u.includes('/artists_v1') && method === 'GET') return fetchResponse([{ id: 'artist-123', plan_status: 'PENDING_CHECKOUT', meta }])
      if (method === 'GET') return fetchResponse([{ artist_id: 'artist-123' }])
      return fetchResponse('')
    }
    const res = response()
    await handler(request(event('checkout.session.completed', {
      id: 'cs_unsigned', mode: 'subscription', payment_status: 'paid', customer: 'cus_9', subscription: 'sub_9',
      metadata: { artist_id: 'artist-123', plan: 'starter' },
    })), res)
    assert.equal(res.statusCode, 200, 'webhook must not fail (Stripe would retry forever)')
    assert.equal(meta.billing_status, 'PAID_AWAITING_AGREEMENT')
    assert.equal(meta.billing_provider, 'stripe')
    assert.equal(meta.genre, 'rap')
    const reg = calls.filter(c => c.options.method === 'PATCH' && c.options.headers?.['Content-Profile'] === 'registrations')
    assert.equal(JSON.parse(reg[0].options.body).plan_status, 'PAID_AWAITING_AGREEMENT')
  }

  console.log('Stripe billing lifecycle: paid activation, canonical entitlements, failed renewals, refunds, and replay protection passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
