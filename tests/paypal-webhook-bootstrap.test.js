'use strict'

const assert = require('assert')

process.env.PAYPAL_ENV = 'sandbox'
process.env.PAYPAL_CLIENT_ID = 'sandbox-client'
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret'

const {
  EVENT_TYPES,
  normalizeWebhookUrl,
  hasAllEvents,
  execute,
} = require('../scripts/paypal/bootstrap-webhook')

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

function fetchHarness(webhooks = []) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith('/v1/oauth2/token')) return response({ access_token: 'token' })
    if (String(url).endsWith('/v1/notifications/webhooks') && (!options.method || options.method === 'GET')) {
      return response({ webhooks })
    }
    if (String(url).endsWith('/v1/notifications/webhooks') && options.method === 'POST') {
      return response({ id: '8XL12345TEST', url: JSON.parse(options.body).url }, 201)
    }
    if (String(url).includes('/v1/notifications/webhooks/') && options.method === 'PATCH') {
      return response({}, 204)
    }
    return response({}, 404)
  }
  return { calls, fetchImpl }
}

;(async () => {
  const url = 'https://preview.example.com/api/paypal-webhook'
  assert.equal(EVENT_TYPES.length, 10)
  assert.equal(normalizeWebhookUrl(`${url}/`), url)
  assert.throws(() => normalizeWebhookUrl('http://preview.example.com/hook'), /HTTPS/)
  assert(hasAllEvents({ event_types: EVENT_TYPES }))

  const createHarness = fetchHarness()
  const created = await execute(url, createHarness.fetchImpl)
  assert.equal(created.id, '8XL12345TEST')
  assert.equal(created.created, true)
  const createCall = createHarness.calls.find(call =>
    call.url.endsWith('/v1/notifications/webhooks') && call.options.method === 'POST'
  )
  assert(createCall)
  assert(createCall.options.headers['PayPal-Request-Id'])
  assert.equal(JSON.parse(createCall.options.body).event_types.length, 10)

  const existingHarness = fetchHarness([{ id: 'WH-EXISTING', url, event_types: EVENT_TYPES }])
  const existing = await execute(url, existingHarness.fetchImpl)
  assert.equal(existing.id, 'WH-EXISTING')
  assert.equal(existing.created, false)
  assert.equal(existing.updated, false)
  assert.equal(existingHarness.calls.filter(call =>
    call.url.endsWith('/v1/notifications/webhooks') && call.options.method === 'POST'
  ).length, 0)

  const staleHarness = fetchHarness([{ id: 'WH-STALE', url, event_types: EVENT_TYPES.slice(0, 2) }])
  const updated = await execute(url, staleHarness.fetchImpl)
  assert.equal(updated.id, 'WH-STALE')
  assert.equal(updated.updated, true)
  const patchCall = staleHarness.calls.find(call => call.options.method === 'PATCH')
  assert(patchCall)
  assert.equal(JSON.parse(patchCall.options.body)[0].value.length, 10)

  process.env.PAYPAL_ENV = 'live'
  await assert.rejects(() => execute(url, fetchHarness().fetchImpl), /--allow-live/)
  process.env.PAYPAL_ENV = 'sandbox'

  console.log('PayPal webhook bootstrap: HTTPS-only, duplicate-safe event registration passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
