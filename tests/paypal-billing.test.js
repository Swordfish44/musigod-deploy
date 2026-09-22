'use strict'

const assert = require('assert')
const { Readable } = require('stream')

process.env.PAYPAL_ENV = 'sandbox'
process.env.PAYPAL_BILLING_ENABLED = 'true'
process.env.PAYPAL_CLIENT_ID = 'paypal-client-test'
process.env.PAYPAL_CLIENT_SECRET = 'paypal-secret-test'
process.env.PAYPAL_WEBHOOK_ID = 'paypal-webhook-test'
process.env.PAYPAL_STARTER_PLAN_ID = 'P-STARTERTEST00000000000000'
process.env.SUPABASE_URL = 'https://example.supabase.co'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-test'

const paypal = require('../lib/paypal-billing')
const createHandler = require('../api/create-paypal-subscription')
const verifyHandler = require('../api/verify-paypal-subscription')
const webhookHandler = require('../api/paypal-webhook')

function request(body, url, headers = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = url
  req.headers = headers
  return req
}

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value },
    status(code) { this.statusCode = code; return this },
    json(body) { this.body = body; return this },
    end() { return this },
  }
}

function fetchResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => typeof body === 'string' ? body : JSON.stringify(body),
  }
}

const webhookHeaders = {
  'paypal-transmission-id': 'transmission-1',
  'paypal-transmission-time': '2026-09-22T05:00:00Z',
  'paypal-cert-url': 'https://api-m.sandbox.paypal.com/cert.pem',
  'paypal-auth-algo': 'SHA256withRSA',
  'paypal-transmission-sig': 'test-signature',
}

;(async () => {
  const helperCalls = []
  const helperFetch = async (url, options = {}) => {
    helperCalls.push({ url: String(url), options })
    if (String(url).endsWith('/v1/oauth2/token')) return fetchResponse({ access_token: 'access-token' })
    return fetchResponse({
      id: 'I-SUBSCRIPTION1',
      status: 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve' }],
    })
  }
  const created = await paypal.createSubscription({
    artistId: '11111111-1111-1111-1111-111111111111',
    plan: 'starter',
    email: 'artist@example.com',
    fetchImpl: helperFetch,
  })
  assert.equal(created.url, 'https://www.sandbox.paypal.com/approve')
  const createCall = helperCalls.find(call => call.url.endsWith('/v1/billing/subscriptions'))
  const createBody = JSON.parse(createCall.options.body)
  assert.equal(createBody.plan_id, process.env.PAYPAL_STARTER_PLAN_ID)
  assert.equal(createBody.custom_id, '11111111-1111-1111-1111-111111111111')
  assert.equal(createBody.application_context.shipping_preference, 'NO_SHIPPING')
  assert(createCall.options.headers['PayPal-Request-Id'])

  const checkoutCalls = []
  global.fetch = async (url, options = {}) => {
    checkoutCalls.push({ url: String(url), options })
    if (String(url).includes('/artists_v1')) {
      return fetchResponse([{
        id: '11111111-1111-1111-1111-111111111111',
        email: 'artist@example.com',
        plan_tier: 'STARTER',
        plan_status: 'PENDING_CHECKOUT',
      }])
    }
    if (String(url).endsWith('/v1/oauth2/token')) return fetchResponse({ access_token: 'access-token' })
    return fetchResponse({
      id: 'I-SUBSCRIPTION2',
      status: 'APPROVAL_PENDING',
      links: [{ rel: 'approve', href: 'https://www.sandbox.paypal.com/approve-2' }],
    })
  }
  const checkoutRes = response()
  await createHandler(request({
    artist_id: '11111111-1111-1111-1111-111111111111',
    plan: 'starter',
  }, '/api/create-paypal-subscription', { origin: 'https://musigod.com' }), checkoutRes)
  assert.equal(checkoutRes.statusCode, 200)
  assert.equal(checkoutRes.body.provider, 'paypal')
  assert.equal(checkoutRes.body.session_id, 'I-SUBSCRIPTION2')

  global.fetch = async (url) => {
    if (String(url).endsWith('/v1/oauth2/token')) return fetchResponse({ access_token: 'access-token' })
    return fetchResponse({
      id: 'I-SUBSCRIPTION2',
      status: 'ACTIVE',
      custom_id: '11111111-1111-1111-1111-111111111111',
      plan_id: process.env.PAYPAL_STARTER_PLAN_ID,
    })
  }
  const verifyRes = response()
  await verifyHandler(request({
    artist_id: '11111111-1111-1111-1111-111111111111',
    subscription_id: 'I-SUBSCRIPTION2',
  }, '/api/verify-paypal-subscription'), verifyRes)
  assert.equal(verifyRes.statusCode, 200)
  assert.equal(verifyRes.body.verified, true)

  const webhookCalls = []
  global.fetch = async (url, options = {}) => {
    webhookCalls.push({ url: String(url), options })
    if (String(url).endsWith('/v1/oauth2/token')) return fetchResponse({ access_token: 'access-token' })
    if (String(url).endsWith('/v1/notifications/verify-webhook-signature')) {
      return fetchResponse({ verification_status: 'SUCCESS' })
    }
    if (String(url).includes('payment_event_receipts_v1') && (options.method || 'GET') === 'GET') {
      return fetchResponse([])
    }
    return fetchResponse('')
  }
  const webhookRes = response()
  await webhookHandler(request({
    id: 'WH-PAYPAL-1',
    event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
    create_time: '2026-09-22T05:00:00Z',
    resource: {
      id: 'I-SUBSCRIPTION2',
      status: 'ACTIVE',
      custom_id: '11111111-1111-1111-1111-111111111111',
      plan_id: process.env.PAYPAL_STARTER_PLAN_ID,
    },
  }, '/api/paypal-webhook', webhookHeaders), webhookRes)
  assert.equal(webhookRes.statusCode, 200)
  assert.equal(webhookRes.body.handled, true)

  const artistPatch = webhookCalls.find(call =>
    call.url.includes('/artists_v1') && call.options.method === 'PATCH'
  )
  assert.deepEqual(JSON.parse(artistPatch.options.body), {
    plan_status: 'ACTIVE',
    plan_tier: 'STARTER',
  })
  assert(webhookCalls.some(call => call.url.includes('/payment_accounts_v1')))
  assert(webhookCalls.some(call =>
    call.url.endsWith('/payment_event_receipts_v1') && call.options.method === 'POST'
  ))

  console.log('PayPal billing: canonical checkout, server verification, verified webhook activation, and provider-neutral persistence passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
