'use strict'
const assert = require('assert')
const handler = require('../api/public-config')
function run(env) {
  for (const k of ['PAYPAL_BILLING_ENABLED', 'PAYMENT_CHECKOUT_PROVIDER', 'VERCEL_ENV', 'PAYPAL_ENV']) delete process.env[k]
  Object.assign(process.env, env)
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v }, status() { return this }, json(b) { this.body = b; return this } }
  handler({}, res)
  return res.body.checkoutProvider
}
assert.strictEqual(run({}), 'stripe', 'default is stripe (production behaviour)')
assert.strictEqual(run({ PAYMENT_CHECKOUT_PROVIDER: 'paypal', PAYPAL_BILLING_ENABLED: 'true' }), 'paypal')
assert.strictEqual(run({ PAYMENT_CHECKOUT_PROVIDER: ' PayPal\r\n', PAYPAL_BILLING_ENABLED: 'TRUE\n' }), 'paypal', 'pasted secrets tolerated')
assert.strictEqual(run({ PAYMENT_CHECKOUT_PROVIDER: 'paypal' }), 'stripe', 'paypal requires billing enabled')
assert.strictEqual(run({ PAYMENT_CHECKOUT_PROVIDER: 'stripe', PAYPAL_BILLING_ENABLED: 'true' }), 'stripe')
assert.strictEqual(run({ VERCEL_ENV: 'preview', PAYMENT_CHECKOUT_PROVIDER: 'stripe', PAYPAL_BILLING_ENABLED: 'true', PAYPAL_ENV: 'sandbox' }), 'paypal', 'preview + sandbox forces paypal')
assert.strictEqual(run({ VERCEL_ENV: 'preview', PAYMENT_CHECKOUT_PROVIDER: 'stripe', PAYPAL_BILLING_ENABLED: 'true', PAYPAL_ENV: 'live' }), 'stripe', 'preview in live mode keeps stripe')
assert.strictEqual(run({ VERCEL_ENV: 'preview', PAYMENT_CHECKOUT_PROVIDER: 'stripe' }), 'stripe', 'preview without paypal billing keeps stripe')
assert.strictEqual(run({ VERCEL_ENV: 'production', PAYMENT_CHECKOUT_PROVIDER: 'stripe', PAYPAL_BILLING_ENABLED: 'true' }), 'stripe', 'production unchanged')
console.log('public-config-provider tests passed')
