'use strict'

const assert = require('assert')
const { Readable } = require('stream')

process.env.STRIPE_SECRET_KEY = 'sk_test_not_a_real_key'
const handler = require('../api/verify-checkout-session')

function request(body) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))])
  req.method = 'POST'
  req.url = '/api/verify-checkout-session'
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
  }
}

async function run(body, stripeSession) {
  global.fetch = async () => ({ ok: true, json: async () => stripeSession })
  const res = response()
  await handler(request(body), res)
  return res
}

;(async () => {
  const base = {
    id: 'cs_test_verified123',
    mode: 'subscription',
    status: 'complete',
    payment_status: 'paid',
    subscription: 'sub_123',
    metadata: { artist_id: 'artist-123', plan: 'starter' },
  }

  const verified = await run({ artist_id: 'artist-123', session_id: base.id }, base)
  assert.equal(verified.statusCode, 200)
  assert.deepEqual(verified.body, { verified: true, plan: 'starter' })
  assert.equal(verified.headers['Cache-Control'], 'no-store')

  const wrongArtist = await run({ artist_id: 'artist-other', session_id: base.id }, base)
  assert.equal(wrongArtist.statusCode, 409)
  assert.equal(wrongArtist.body.verified, false)

  const unpaid = await run({ artist_id: 'artist-123', session_id: base.id }, { ...base, payment_status: 'unpaid' })
  assert.equal(unpaid.statusCode, 409)

  console.log('checkout verification: paid matching subscription passes; mismatched or unpaid sessions fail closed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
