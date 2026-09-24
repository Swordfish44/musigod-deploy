'use strict'

const crypto = require('crypto')
const generatedWebhookConfig = require('../generated/paypal-webhook-config.json')

const PLAN_ENV = Object.freeze({
  starter: 'PAYPAL_STARTER_PLAN_ID',
  growth: 'PAYPAL_GROWTH_PLAN_ID',
  pro: 'PAYPAL_PRO_PLAN_ID',
  label: 'PAYPAL_LABEL_PLAN_ID',
})

function apiBase() {
  return process.env.PAYPAL_ENV === 'live'
    ? 'https://api-m.paypal.com'
    : 'https://api-m.sandbox.paypal.com'
}

function planIdFor(plan) {
  const envName = PLAN_ENV[String(plan || '').toLowerCase()]
  return envName ? process.env[envName] || null : null
}

function planForId(planId) {
  if (!planId) return null
  return Object.keys(PLAN_ENV).find(plan => process.env[PLAN_ENV[plan]] === planId) || null
}

function isConfigured() {
  return Boolean(process.env.PAYPAL_CLIENT_ID && process.env.PAYPAL_CLIENT_SECRET)
}

function webhookId() {
  return process.env.PAYPAL_WEBHOOK_ID || generatedWebhookConfig.id || null
}

async function accessToken(fetchImpl = fetch) {
  if (!isConfigured()) throw new Error('PayPal credentials are not configured')
  const encoded = Buffer.from(`${process.env.PAYPAL_CLIENT_ID}:${process.env.PAYPAL_CLIENT_SECRET}`).toString('base64')
  const response = await fetchImpl(`${apiBase()}/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${encoded}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    },
    body: 'grant_type=client_credentials',
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || !body.access_token) {
    throw new Error(`PayPal authentication failed (${response.status})`)
  }
  return body.access_token
}

async function request(path, { method = 'GET', body, requestId, fetchImpl = fetch } = {}) {
  const token = await accessToken(fetchImpl)
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  }
  if (requestId) headers['PayPal-Request-Id'] = requestId
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload.details?.[0]?.description || payload.message || `HTTP ${response.status}`
    throw new Error(`PayPal request failed: ${detail}`)
  }
  return payload
}

async function createSubscription({ artistId, plan, email, fetchImpl = fetch }) {
  const normalizedPlan = String(plan || '').toLowerCase()
  const planId = planIdFor(normalizedPlan)
  if (!planId) throw new Error('PayPal plan is not configured')

  const baseUrl = (process.env.PUBLIC_SITE_URL || 'https://musigod.com').replace(/\/$/, '')
  const returnUrl = `${baseUrl}/success.html?provider=paypal&artist_id=${encodeURIComponent(artistId)}`
  const cancelUrl = `${baseUrl}/register.html?artist_id=${encodeURIComponent(artistId)}&checkout=cancelled&payment=paypal`
  const requestId = crypto
    .createHash('sha256')
    .update(`musigod:paypal:subscription:${artistId}:${normalizedPlan}`)
    .digest('hex')
    .slice(0, 36)

  const payload = await request('/v1/billing/subscriptions', {
    method: 'POST',
    requestId,
    fetchImpl,
    body: {
      plan_id: planId,
      custom_id: String(artistId),
      subscriber: email ? { email_address: email } : undefined,
      application_context: {
        brand_name: 'MusiGod',
        locale: 'en-US',
        shipping_preference: 'NO_SHIPPING',
        user_action: 'SUBSCRIBE_NOW',
        return_url: returnUrl,
        cancel_url: cancelUrl,
      },
    },
  })

  const approvalUrl = payload.links?.find(link => link.rel === 'approve')?.href
  if (!payload.id || !approvalUrl) throw new Error('PayPal did not return an approval URL')
  return { id: payload.id, status: payload.status, url: approvalUrl, plan: normalizedPlan }
}

function showSubscription(subscriptionId, fetchImpl = fetch) {
  return request(`/v1/billing/subscriptions/${encodeURIComponent(subscriptionId)}`, { fetchImpl })
}

async function verifyWebhook(headers, webhookEvent, fetchImpl = fetch) {
  const configuredWebhookId = webhookId()
  if (!configuredWebhookId) throw new Error('PayPal webhook ID is not configured')
  const required = {
    transmission_id: headers['paypal-transmission-id'],
    transmission_time: headers['paypal-transmission-time'],
    cert_url: headers['paypal-cert-url'],
    auth_algo: headers['paypal-auth-algo'],
    transmission_sig: headers['paypal-transmission-sig'],
  }
  if (Object.values(required).some(value => !value)) return false

  const result = await request('/v1/notifications/verify-webhook-signature', {
    method: 'POST',
    fetchImpl,
    body: {
      ...required,
      webhook_id: configuredWebhookId,
      webhook_event: webhookEvent,
    },
  })
  return result.verification_status === 'SUCCESS'
}

module.exports = {
  PLAN_ENV,
  apiBase,
  planIdFor,
  planForId,
  isConfigured,
  webhookId,
  accessToken,
  createSubscription,
  showSubscription,
  verifyWebhook,
}
