'use strict'

const crypto = require('crypto')
const { apiBase, accessToken } = require('../../lib/paypal-billing')

const EVENT_TYPES = Object.freeze([
  'BILLING.SUBSCRIPTION.CREATED',
  'BILLING.SUBSCRIPTION.ACTIVATED',
  'BILLING.SUBSCRIPTION.UPDATED',
  'BILLING.SUBSCRIPTION.EXPIRED',
  'BILLING.SUBSCRIPTION.CANCELLED',
  'BILLING.SUBSCRIPTION.SUSPENDED',
  'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
  'PAYMENT.SALE.COMPLETED',
  'PAYMENT.SALE.REFUNDED',
  'PAYMENT.SALE.REVERSED',
].map(name => Object.freeze({ name })))

function normalizeWebhookUrl(value) {
  const url = new URL(String(value || ''))
  if (url.protocol !== 'https:') throw new Error('PayPal webhook URL must use HTTPS')
  url.hash = ''
  return url.toString().replace(/\/$/, '')
}

function configuredUrl(argv = process.argv) {
  const flagIndex = argv.indexOf('--url')
  const value = flagIndex >= 0 ? argv[flagIndex + 1] : process.env.PAYPAL_WEBHOOK_URL
  if (!value) throw new Error('Set PAYPAL_WEBHOOK_URL or pass --url https://.../api/paypal-webhook')
  return normalizeWebhookUrl(value)
}

function assertSafeEnvironment(argv = process.argv) {
  if (process.env.PAYPAL_ENV === 'live' && !argv.includes('--allow-live')) {
    throw new Error('Live PayPal webhook bootstrap requires the explicit --allow-live flag')
  }
}

async function authorizedRequest(path, { method = 'GET', body, requestKey, fetchImpl = fetch } = {}) {
  const token = await accessToken(fetchImpl)
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (requestKey) {
    headers['PayPal-Request-Id'] = crypto.createHash('sha256').update(requestKey).digest('hex').slice(0, 36)
  }
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload.details?.[0]?.description || payload.message || `HTTP ${response.status}`
    throw new Error(`PayPal webhook bootstrap failed: ${detail}`)
  }
  return payload
}

function hasAllEvents(webhook) {
  const configured = new Set((webhook.event_types || []).map(event => event.name))
  return EVENT_TYPES.every(event => configured.has(event.name))
}

async function execute(url, fetchImpl = fetch) {
  assertSafeEnvironment()
  const normalizedUrl = normalizeWebhookUrl(url)
  const listing = await authorizedRequest('/v1/notifications/webhooks', { fetchImpl })
  const existing = (listing.webhooks || []).find(webhook => normalizeWebhookUrl(webhook.url) === normalizedUrl)

  if (existing?.id) {
    if (!hasAllEvents(existing)) {
      await authorizedRequest(`/v1/notifications/webhooks/${encodeURIComponent(existing.id)}`, {
        method: 'PATCH',
        fetchImpl,
        body: [{ op: 'replace', path: '/event_types', value: EVENT_TYPES }],
      })
    }
    return { id: existing.id, url: normalizedUrl, created: false, updated: !hasAllEvents(existing) }
  }

  const webhook = await authorizedRequest('/v1/notifications/webhooks', {
    method: 'POST',
    fetchImpl,
    requestKey: `musigod:${process.env.PAYPAL_ENV || 'sandbox'}:webhook:${normalizedUrl}:v1`,
    body: { url: normalizedUrl, event_types: EVENT_TYPES },
  })
  if (!webhook.id) throw new Error('PayPal did not return a webhook ID')
  return { id: webhook.id, url: normalizedUrl, created: true, updated: false }
}

function printDryRun(url) {
  console.log(JSON.stringify({
    mode: 'DRY_RUN',
    environment: process.env.PAYPAL_ENV || 'sandbox',
    webhook: { url, event_types: EVENT_TYPES },
    next: 'Set sandbox credentials, then rerun with --execute. Save the returned ID as PAYPAL_WEBHOOK_ID in Vercel Preview.',
  }, null, 2))
}

if (require.main === module) {
  try {
    const url = configuredUrl()
    if (!process.argv.includes('--execute')) {
      printDryRun(url)
    } else {
      execute(url).then(result => {
        console.log(JSON.stringify({
          mode: 'EXECUTED',
          environment: process.env.PAYPAL_ENV || 'sandbox',
          webhook: result,
          vercel_environment_variables: { PAYPAL_WEBHOOK_ID: result.id },
        }, null, 2))
      }).catch(error => {
        console.error(error.message)
        process.exitCode = 1
      })
    }
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = {
  EVENT_TYPES,
  normalizeWebhookUrl,
  hasAllEvents,
  authorizedRequest,
  execute,
}
