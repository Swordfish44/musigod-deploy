'use strict'

const assert = require('assert')
const { Readable } = require('stream')

process.env.STRIPE_SECRET_KEY = 'sk_test_checkout'
process.env.STRIPE_STARTER_PRICE_ID = 'price_starter'
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

const handler = require('../api/create-checkout-session')

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/api/create-checkout-session'
  req.headers = { origin: 'https://musigod.com' }
  return req
}

function response() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
  }
}

async function run(body, { artistPlan = 'STARTER', artistStatus = 'PENDING_CHECKOUT', customerId = null } = {}) {
  const calls = []
  global.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).includes('/artists_v1')) {
      return { ok: true, status: 200, json: async () => [{ id: body.artist_id, email: 'artist@example.com', plan_tier: artistPlan, plan_status: artistStatus }] }
    }
    if (String(url).includes('/registrations_v1')) {
      return { ok: true, status: 200, json: async () => customerId ? [{ stripe_customer_id: customerId }] : [] }
    }
    return { ok: true, status: 200, json: async () => ({ id: 'cs_test_created', url: 'https://checkout.stripe.test/session' }) }
  }
  const res = response()
  await handler(request(body), res)
  return { res, calls }
}

;(async () => {
  const created = await run({ artist_id: 'artist-123', plan: 'starter' })
  assert.equal(created.res.statusCode, 200)
  const stripeCall = created.calls.find(call => call.url.includes('api.stripe.com'))
  assert(stripeCall)
  const params = new URLSearchParams(stripeCall.options.body)
  assert.equal(params.get('customer_email'), 'artist@example.com')
  assert.equal(params.get('client_reference_id'), 'artist-123')
  assert.equal(params.get('metadata[artist_id]'), 'artist-123')

  const reused = await run({ artist_id: 'artist-123', plan: 'starter' }, { customerId: 'cus_existing' })
  const reusedParams = new URLSearchParams(reused.calls.find(call => call.url.includes('api.stripe.com')).options.body)
  assert.equal(reusedParams.get('customer'), 'cus_existing')
  assert.equal(reusedParams.has('customer_creation'), false)

  const mismatch = await run({ artist_id: 'artist-123', plan: 'starter' }, { artistPlan: 'GROWTH' })
  assert.equal(mismatch.res.statusCode, 409)
  assert.equal(mismatch.calls.some(call => call.url.includes('api.stripe.com')), false)

  const duplicate = await run({ artist_id: 'artist-123', plan: 'starter' }, { artistStatus: 'ACTIVE' })
  assert.equal(duplicate.res.statusCode, 409)
  assert.equal(duplicate.calls.some(call => call.url.includes('api.stripe.com')), false)

  console.log('checkout creation: canonical artist/plan binding, customer reuse, and duplicate-subscription guard passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
