'use strict'

const assert = require('assert')
const {
  gate,
  previewWebhookUrl,
  prepare,
} = require('../scripts/paypal/prepare-preview-webhook')

const readyEnv = {
  VERCEL_ENV: 'preview',
  VERCEL_BRANCH_URL: 'musigod-preview.example.com',
  VERCEL_AUTOMATION_BYPASS_SECRET: 'bypass secret/with symbols',
  PAYPAL_ENV: 'sandbox',
  PAYPAL_BILLING_ENABLED: 'true',
}

;(async () => {
  assert.equal(gate(readyEnv), null)
  assert.equal(gate({ ...readyEnv, VERCEL_ENV: 'production' }), 'not-a-preview')
  assert.equal(gate({ ...readyEnv, PAYPAL_ENV: 'live' }), 'not-paypal-sandbox')
  assert.equal(gate({ ...readyEnv, PAYPAL_BILLING_ENABLED: 'false' }), 'paypal-billing-disabled')
  assert.equal(gate({ ...readyEnv, VERCEL_AUTOMATION_BYPASS_SECRET: '' }), 'missing-vercel-bypass-secret')

  const url = new URL(previewWebhookUrl(readyEnv))
  assert.equal(url.origin, 'https://musigod-preview.example.com')
  assert.equal(url.pathname, '/api/paypal-webhook')
  assert.equal(url.searchParams.get('x-vercel-protection-bypass'), readyEnv.VERCEL_AUTOMATION_BYPASS_SECRET)

  const writes = []
  const calls = []
  const result = await prepare({
    env: readyEnv,
    writeFileSync: (_path, contents) => writes.push(JSON.parse(contents)),
    executeWebhook: async webhookUrl => {
      calls.push(webhookUrl)
      return { id: 'WH-PREVIEW-TEST', created: true, updated: false }
    },
  })
  assert.deepEqual(result, { mode: 'READY', id: 'WH-PREVIEW-TEST', created: true, updated: false })
  assert.equal(calls.length, 1)
  assert.deepEqual(writes, [{ id: null }, { id: 'WH-PREVIEW-TEST' }])

  const skippedWrites = []
  const skipped = await prepare({
    env: { ...readyEnv, VERCEL_ENV: 'production' },
    writeFileSync: (_path, contents) => skippedWrites.push(JSON.parse(contents)),
    executeWebhook: async () => { throw new Error('must not run') },
  })
  assert.deepEqual(skipped, { mode: 'SKIPPED', reason: 'not-a-preview' })
  assert.deepEqual(skippedWrites, [{ id: null }])

  console.log('PayPal preview build: sandbox-only gated registration and generated webhook config passed')
})().catch(error => {
  console.error(error)
  process.exitCode = 1
})
