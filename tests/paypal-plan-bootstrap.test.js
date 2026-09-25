'use strict'

const assert = require('assert')

process.env.PAYPAL_ENV = 'sandbox'
process.env.PAYPAL_CLIENT_ID = 'sandbox-client'
process.env.PAYPAL_CLIENT_SECRET = 'sandbox-secret'

const { TIERS, productPayload, planPayload, execute } = require('../scripts/paypal/bootstrap-plans')

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

;(async () => {
  assert.equal(TIERS.length, 4)
  assert.deepEqual(TIERS.map(tier => tier.amount), ['79.00', '129.00', '179.00', '699.00'])
  assert.equal(productPayload().type, 'SERVICE')
  for (const tier of TIERS) {
    const payload = planPayload('PROD-TESTPRODUCT0000000', tier)
    assert.equal(payload.status, 'ACTIVE')
    assert.equal(payload.billing_cycles[0].frequency.interval_unit, 'MONTH')
    assert.equal(payload.billing_cycles[0].total_cycles, 0)
    assert.equal(payload.billing_cycles[0].pricing_scheme.fixed_price.value, tier.amount)
    assert.equal(payload.payment_preferences.payment_failure_threshold, 2)
  }

  const calls = []
  let planNumber = 0
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    if (String(url).endsWith('/v1/oauth2/token')) return response({ access_token: 'token' })
    if (String(url).endsWith('/v1/catalogs/products')) return response({ id: 'PROD-TESTPRODUCT0000000' }, 201)
    if (String(url).endsWith('/v1/billing/plans')) {
      planNumber += 1
      return response({ id: `P-TESTPLAN000000000000000${planNumber}`, status: 'ACTIVE' }, 201)
    }
    return response({}, 404)
  }

  const result = await execute(fetchImpl)
  assert.equal(result.productId, 'PROD-TESTPRODUCT0000000')
  assert.equal(Object.keys(result.planIds).length, 4)
  assert.equal(calls.filter(call => call.url.endsWith('/v1/catalogs/products')).length, 1)
  assert.equal(calls.filter(call => call.url.endsWith('/v1/billing/plans')).length, 4)
  assert(calls.filter(call => call.url.endsWith('/v1/billing/plans')).every(call =>
    call.options.headers['PayPal-Request-Id'] && call.options.headers.Prefer === 'return=representation'
  ))

  console.log('PayPal plan bootstrap: fail-safe monthly product and four canonical tier payloads passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
