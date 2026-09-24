'use strict'

const { captureException, withSentry } = require('./_sentry')
const paypal = require('../lib/paypal-billing')
const entitlement = require('../lib/paid-entitlement')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Billing persistence is not configured' })

  let event
  try {
    event = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  try {
    if (!await paypal.verifyWebhook(req.headers, event)) {
      console.error('PayPal signature verification failed', { paypal_event_id: event.id || null })
      return res.status(400).json({ error: 'Invalid signature' })
    }
    if (!event.id || !event.event_type) return res.status(400).json({ error: 'Invalid event' })
    if (await eventAlreadyProcessed(event.id)) {
      return res.status(200).json({ received: true, duplicate: true })
    }

    const result = await handleEvent(event)
    await recordEvent(event, result)
    console.info('PAYPAL_WEBHOOK_PROCESSED', {
      paypal_event_id: event.id,
      paypal_event_type: event.event_type,
      artist_id: result.artistId || null,
      handled: result.handled,
    })
    return res.status(200).json({ received: true, handled: result.handled })
  } catch (error) {
    captureException(error, {
      route: 'paypal-webhook',
      method: req.method,
      statusCode: 500,
      paypalEventType: event?.event_type,
      paypalEventId: event?.id,
    })
    return res.status(500).json({ error: 'Handler failed' })
  }
}, 'paypal-webhook')

async function handleEvent(event) {
  const type = event.event_type
  let resource = event.resource || {}
  const saleTypes = new Set(['PAYMENT.SALE.COMPLETED', 'PAYMENT.SALE.REFUNDED', 'PAYMENT.SALE.REVERSED'])

  if (saleTypes.has(type)) {
    const subscriptionId = resource.billing_agreement_id
    if (!subscriptionId) return { handled: false }
    const subscription = await paypal.showSubscription(subscriptionId)
    resource = { ...subscription, id: subscriptionId }
  }

  const subscriptionTypes = new Set([
    'BILLING.SUBSCRIPTION.CREATED',
    'BILLING.SUBSCRIPTION.ACTIVATED',
    'BILLING.SUBSCRIPTION.UPDATED',
    'BILLING.SUBSCRIPTION.EXPIRED',
    'BILLING.SUBSCRIPTION.CANCELLED',
    'BILLING.SUBSCRIPTION.SUSPENDED',
    'BILLING.SUBSCRIPTION.PAYMENT.FAILED',
    ...saleTypes,
  ])
  if (!subscriptionTypes.has(type)) return { handled: false }

  const artistId = String(resource.custom_id || '')
  const subscriptionId = String(resource.id || '')
  const plan = paypal.planForId(resource.plan_id)
  if (!artistId || !subscriptionId || !plan) {
    console.warn('PayPal subscription event missing canonical binding', {
      paypal_event_type: type,
      paypal_subscription_id: subscriptionId || null,
      has_artist_id: Boolean(artistId),
      recognized_plan: Boolean(plan),
    })
    return { handled: false, artistId: artistId || null, subscriptionId: subscriptionId || null }
  }

  const status = statusForEvent(type, resource.status)
  await upsertPaymentAccount({ artistId, subscriptionId, plan, status, paypalStatus: resource.status })

  const entitlementStatus = entitlementStatusFor(status)
  const effective = entitlementStatus
    ? await syncEntitlement(artistId, plan, entitlementStatus, subscriptionId)
    : status
  return { handled: true, artistId, subscriptionId, plan, status: effective }
}

function statusForEvent(type, resourceStatus) {
  if (type === 'BILLING.SUBSCRIPTION.PAYMENT.FAILED') return 'PAST_DUE'
  if (type === 'PAYMENT.SALE.REFUNDED' || type === 'PAYMENT.SALE.REVERSED') return 'SUSPENDED'
  if (type === 'PAYMENT.SALE.COMPLETED') return 'ACTIVE'
  const normalized = String(resourceStatus || '').toUpperCase()
  if (normalized === 'ACTIVE') return 'ACTIVE'
  if (['CANCELLED', 'SUSPENDED', 'EXPIRED'].includes(normalized)) return 'SUSPENDED'
  return 'PENDING_CHECKOUT'
}

function entitlementStatusFor(status) {
  if (status === 'ACTIVE') return 'ACTIVE'
  if (status === 'PAST_DUE') return 'PAST_DUE'
  if (status === 'SUSPENDED') return 'SUSPENDED'
  return null
}

async function syncEntitlement(artistId, plan, status, subscriptionId) {
  // ACTIVE goes through the agreement-aware path; the DB refuses ACTIVE until
  // the Publishing Administration Agreement is signed.
  const effective = status === 'ACTIVE'
    ? await entitlement.activateOrHoldForAgreement({ artistId, plan, provider: 'paypal', subscriptionId })
    : status
  if (status !== 'ACTIVE') {
    await sbPatch('artists', `artists_v1?id=eq.${encodeURIComponent(artistId)}`, {
      plan_status: status,
      plan_tier: plan.toUpperCase(),
    })
  }
  await sbPatch('registrations', `registrations_v1?artist_id=eq.${encodeURIComponent(artistId)}`, {
    plan_status: effective,
    plan_type: plan,
  })
  return effective
}

async function upsertPaymentAccount({ artistId, subscriptionId, plan, status, paypalStatus }) {
  await sbPatch(
    'registrations',
    `payment_accounts_v1?artist_id=eq.${encodeURIComponent(artistId)}&is_primary=eq.true`,
    { is_primary: false, updated_at: new Date().toISOString() }
  )
  const response = await fetch(
    `${SB_URL}/rest/v1/payment_accounts_v1?on_conflict=provider,provider_subscription_id`,
    {
      method: 'POST',
      headers: sbHeaders('registrations', { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify({
        artist_id: artistId,
        provider: 'paypal',
        provider_subscription_id: subscriptionId,
        plan_code: plan,
        status,
        is_primary: true,
        metadata: { paypal_status: paypalStatus || null },
        updated_at: new Date().toISOString(),
      }),
    }
  )
  if (!response.ok) throw new Error(`Payment account upsert failed: ${response.status}`)
}

async function eventAlreadyProcessed(eventId) {
  const response = await fetch(
    `${SB_URL}/rest/v1/payment_event_receipts_v1?provider=eq.paypal&provider_event_id=eq.${encodeURIComponent(eventId)}&select=id&limit=1`,
    { headers: sbHeaders('registrations') }
  )
  if (!response.ok) throw new Error(`Payment event lookup failed: ${response.status}`)
  return Boolean((await response.json())?.length)
}

async function recordEvent(event, result) {
  const response = await fetch(`${SB_URL}/rest/v1/payment_event_receipts_v1`, {
    method: 'POST',
    headers: sbHeaders('registrations', { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify({
      provider: 'paypal',
      provider_event_id: event.id,
      event_type: event.event_type,
      artist_id: result.artistId || null,
      occurred_at: event.create_time || null,
      payload: {
        handled: result.handled,
        provider_subscription_id: result.subscriptionId || null,
        plan_code: result.plan || null,
        status: result.status || null,
      },
    }),
  })
  if (!response.ok) throw new Error(`Payment event receipt failed: ${response.status}`)
}

async function sbPatch(schema, path, data) {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: sbHeaders(schema),
    body: JSON.stringify(data),
  })
  if (!response.ok) throw new Error(`Supabase PATCH ${path.split('?')[0]} failed: ${response.status} ${await response.text().catch(() => '')}`)
}

function sbHeaders(schema, extra = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': schema,
    'Content-Profile': schema,
    ...extra,
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

module.exports._test = { statusForEvent, entitlementStatusFor, handleEvent }
