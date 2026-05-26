const { captureException, withSentry } = require('./_sentry')
const { STATUS, correlationId, log, safeLogAuditEvent, safeUpsertAuditStatus } = require('./_fulfillment')

const PRICE_IDS = {
  starter: process.env.STRIPE_STARTER_PRICE_ID,
  growth:  process.env.STRIPE_GROWTH_PRICE_ID,
  rights_audit_unlock: process.env.STRIPE_RIGHTS_AUDIT_UNLOCK_PRICE_ID,
}

module.exports = withSentry(async function handler(req, res) {
  const requestId = correlationId('checkout')
  setCors(req, res)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe secret key is not configured' })

  let body
  try {
    const raw = await getRawBody(req)
    body = JSON.parse(raw.toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const { artist_id, plan, audit_id, email } = body
  if (!artist_id && plan !== 'rights_audit_unlock') {
    return res.status(400).json({ error: 'artist_id required' })
  }
  if (plan === 'rights_audit_unlock' && (!audit_id || !email)) {
    return res.status(400).json({ error: 'audit_id and email required' })
  }
  if (!PRICE_IDS[plan]) {
    return res.status(400).json({ error: 'configured plan required' })
  }

  const params = new URLSearchParams()
  params.append('mode', plan === 'rights_audit_unlock' ? 'payment' : 'subscription')
  params.append('line_items[0][price]', PRICE_IDS[plan])
  params.append('line_items[0][quantity]', '1')
  if (artist_id) params.append('metadata[artist_id]', artist_id)
  params.append('metadata[plan]', plan)
  params.append('metadata[product_type]', plan)
  if (audit_id) params.append('metadata[audit_id]', audit_id)
  if (email) params.append('metadata[email]', email)
  if (email) params.append('customer_email', email)
  const baseUrl = resolveBaseUrl(req)
  let successUrl
  let cancelUrl
  if (plan !== 'rights_audit_unlock') {
    params.append('subscription_data[metadata][artist_id]', artist_id)
    params.append('subscription_data[metadata][plan]', plan)
    params.append('customer_creation', 'always')
    successUrl = `${baseUrl}/success.html?artist_id=${encodeURIComponent(artist_id)}&session_id={CHECKOUT_SESSION_ID}`
    cancelUrl = `${baseUrl}/register.html?artist_id=${encodeURIComponent(artist_id)}&checkout=cancelled`
  } else {
    successUrl = `${baseUrl}/audit-status?id=${encodeURIComponent(audit_id || '')}&session_id={CHECKOUT_SESSION_ID}`
    cancelUrl = `${baseUrl}/rights-audit.html?audit_id=${encodeURIComponent(audit_id || '')}&unlock=cancelled`
  }
  params.append('success_url', successUrl)
  params.append('cancel_url', cancelUrl)
  log('info', 'STRIPE_CHECKOUT_URLS_RESOLVED', {
    request_id: requestId,
    base_url: baseUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
    audit_id: audit_id || null,
  })

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const session = await stripeRes.json()
  if (!stripeRes.ok) {
    console.error('Stripe error:', session.error)
    captureException(new Error(session.error?.message || 'Stripe checkout session failed'), {
      route: 'create-checkout-session',
      method: req.method,
      path: req.url,
      statusCode: 500,
      stripeStatus: stripeRes.status,
      plan,
    })
    return res.status(500).json({ error: session.error?.message || 'Stripe error' })
  }

  if (plan === 'rights_audit_unlock') {
    log('info', 'RIGHTS_AUDIT_CHECKOUT_CREATED', {
      request_id: requestId,
      audit_id,
      stripe_session_id: session.id,
      base_url: baseUrl,
      success_url: successUrl,
      cancel_url: cancelUrl,
      checkout_url_present: Boolean(session.url),
    })
    log('info', 'RIGHTS_AUDIT_FINAL_REDIRECT_TARGET', {
      request_id: requestId,
      audit_id,
      session_id: session.id,
      final_redirect_target: successUrl.replace('{CHECKOUT_SESSION_ID}', session.id || ''),
    })
    await safeUpsertAuditStatus({
      audit_id,
      email,
      stripe_session_id: session.id,
      current_status: STATUS.PENDING_PAYMENT,
      status_message: 'Checkout started. Waiting for Stripe payment confirmation.',
      estimated_completion: 'Payment confirmation usually posts within one minute.',
    })
    await safeLogAuditEvent({
      audit_id,
      event_type: 'checkout_session_created',
      severity: 'info',
      source_system: 'stripe',
      correlation_id: requestId,
      payload: { stripe_session_id: session.id, plan },
    })
  }

  res.status(200).json({ url: session.url })
}, 'create-checkout-session')

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
}

function resolveBaseUrl(req) {
  const candidates = [
    req.headers.origin,
    forwardedOrigin(req),
    envUrl(process.env.PUBLIC_SITE_URL),
    envUrl(process.env.SITE_URL),
    'https://musigod.com',
  ]
  return candidates.map(normalizeBaseUrl).find(Boolean) || 'https://musigod.com'
}

function forwardedOrigin(req) {
  const host = clean(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0]
  if (!host) return ''
  const proto = clean(req.headers['x-forwarded-proto']).split(',')[0] || (host.includes('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

function envUrl(value) {
  return clean(value)
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(clean(value))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (!isAllowedHost(url)) return ''
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function isAllowedHost(url) {
  const host = url.hostname.toLowerCase()
  if (host === 'musigod.com' || host === 'www.musigod.com') return url.protocol === 'https:'
  if (host.endsWith('.vercel.app')) return url.protocol === 'https:'
  if (host === 'localhost' || host === '127.0.0.1') return true
  return false
}

function clean(value) {
  return String(value || '').trim()
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
