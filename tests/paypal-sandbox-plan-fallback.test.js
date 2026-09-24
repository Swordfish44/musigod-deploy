'use strict'
const assert = require('assert')
const plans = require('../generated/paypal-sandbox-plans.json')
const names = ['PAYPAL_STARTER_PLAN_ID', 'PAYPAL_GROWTH_PLAN_ID', 'PAYPAL_PRO_PLAN_ID', 'PAYPAL_LABEL_PLAN_ID']
const load = env => {
  for (const k of [...names, 'PAYPAL_ENV', 'VERCEL_ENV']) delete process.env[k]
  Object.assign(process.env, env)
  delete require.cache[require.resolve('../lib/paypal-billing')]
  return require('../lib/paypal-billing')
}
for (const p of ['starter', 'growth', 'pro', 'label']) assert(/^P-[0-9A-Z]{24}$/.test(plans[p]), `bad sandbox id for ${p}`)

let pp = load({ VERCEL_ENV: 'preview' })
assert.strictEqual(pp.planIdFor('starter'), plans.starter, 'preview falls back to sandbox id')
assert.strictEqual(pp.planForId(plans.growth), 'growth', 'webhook maps fallback id back to plan')

pp = load({ VERCEL_ENV: 'preview', PAYPAL_STARTER_PLAN_ID: '  P-FROMENV0000000000000000\r\n' })
assert.strictEqual(pp.planIdFor('starter'), 'P-FROMENV0000000000000000', 'env var wins and is trimmed')

pp = load({ VERCEL_ENV: 'production' })
assert.strictEqual(pp.planIdFor('starter'), null, 'production never uses sandbox ids')

pp = load({ VERCEL_ENV: 'preview', PAYPAL_ENV: 'live' })
assert.strictEqual(pp.planIdFor('starter'), null, 'live mode never uses sandbox ids')
assert.strictEqual(pp.planIdFor('bogus'), null)
console.log('paypal-sandbox-plan-fallback tests passed')
