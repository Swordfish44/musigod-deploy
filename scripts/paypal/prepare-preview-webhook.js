'use strict'

const fs = require('fs')
const path = require('path')
const { execute } = require('./bootstrap-webhook')

const CONFIG_PATH = path.resolve(__dirname, '../../generated/paypal-webhook-config.json')

function writeConfig(id, writeFileSync = fs.writeFileSync) {
  writeFileSync(CONFIG_PATH, `${JSON.stringify({ id: id || null }, null, 2)}\n`)
}

function previewWebhookUrl(env = process.env) {
  const hostname = String(env.VERCEL_BRANCH_URL || '').trim().replace(/^https?:\/\//, '').replace(/\/$/, '')
  if (!hostname) return null

  const url = new URL(`https://${hostname}/api/paypal-webhook`)
  url.searchParams.set('x-vercel-protection-bypass', env.VERCEL_AUTOMATION_BYPASS_SECRET)
  return url.toString()
}

function gate(env = process.env) {
  if (env.VERCEL_ENV !== 'preview') return 'not-a-preview'
  if (env.PAYPAL_ENV !== 'sandbox') return 'not-paypal-sandbox'
  if (env.PAYPAL_BILLING_ENABLED !== 'true') return 'paypal-billing-disabled'
  if (!env.VERCEL_AUTOMATION_BYPASS_SECRET) return 'missing-vercel-bypass-secret'
  if (!env.VERCEL_BRANCH_URL) return 'missing-vercel-branch-url'
  return null
}

async function prepare({
  env = process.env,
  executeWebhook = execute,
  writeFileSync = fs.writeFileSync,
} = {}) {
  // A reused build workspace must never carry a webhook ID into a non-preview build.
  writeConfig(null, writeFileSync)

  const skipped = gate(env)
  if (skipped) return { mode: 'SKIPPED', reason: skipped }

  const result = await executeWebhook(previewWebhookUrl(env))
  if (!result?.id) throw new Error('PayPal preview webhook bootstrap did not return an ID')
  writeConfig(result.id, writeFileSync)
  return { mode: 'READY', id: result.id, created: Boolean(result.created), updated: Boolean(result.updated) }
}

if (require.main === module) {
  prepare().then(result => {
    // Never print the webhook URL because it contains the Vercel bypass secret.
    console.log(JSON.stringify(result))
  }).catch(error => {
    console.error(`PayPal preview webhook preparation failed: ${error.message}`)
    process.exitCode = 1
  })
}

module.exports = {
  CONFIG_PATH,
  gate,
  previewWebhookUrl,
  prepare,
}
