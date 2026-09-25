const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const PRICE_IDS = {
  starter: process.env.STRIPE_STARTER_PRICE_ID,
  growth:  process.env.STRIPE_GROWTH_PRICE_ID,
  pro: process.env.STRIPE_PRO_PRICE_ID,
  label: process.env.STRIPE_LABEL_PRICE_ID,
  rights_audit_unlock: process.env.STRIPE_RIGHTS_AUDIT_UNLOCK_PRICE_ID,
}

module.exports = withSentry(async function handler(req, res) {
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

  console.log(JSON.stringify({ event: 'checkout_start', plan, audit_id: audit_id || null, artist_id: artist_id || null, ts: new Date().toISOString() }))

  if (!artist_id && plan !== 'rights_audit_unlock') {
    return res.status(400).json({ error: 'artist_id required' })
  }
  if (plan === 'rights_audit_unlock' && (!audit_id || !email)) {
    return res.status(400).json({ error: 'audit_id and email required' })
  }
  if (!PRICE_IDS[plan]) {
    return res.status(400).json({ error: 'configured plan required' })
  }

  let billingTarget = null
  if (plan !== 'rights_audit_unlock') {
    if (!SB_KEY) return res.status(500).json({ error: 'Billing verification is not configured' })
    try {
      billingTarget = await getBillingTarget(artist_id)
    } catch (error) {
      captureException(error, { route: 'create-checkout-session', method: req.method, statusCode: 502 })
      return res.status(502).json({ error: 'Billing verification unavailable' })
    }
    if (!billingTarget?.artist) return res.status(404).json({ error: 'Artist registration not found' })
    if (String(billingTarget.artist.plan_tier || '').toLowerCase() !== plan) {
      return res.status(409).json({ error: 'Checkout plan does not match artist registration' })
    }
    if (billingTarget.artist.plan_status === 'ACTIVE') {
      return res.status(409).json({ error: 'Subscription is already active' })
    }
    if (billingTarget.artist.meta?.billing_status === 'PAID_AWAITING_AGREEMENT') {
      return res.status(409).json({ error: 'Payment already received. Sign your Publishing Administration Agreement to activate your account.', code: 'PAID_AWAITING_AGREEMENT' })
    }
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

  if (plan !== 'rights_audit_unlock') {
    params.append('subscription_data[metadata][artist_id]', artist_id)
    params.append('subscription_data[metadata][plan]', plan)
    params.append('client_reference_id', artist_id)
    if (billingTarget.stripeCustomerId) {
      params.append('customer', billingTarget.stripeCustomerId)
    } else {
      params.append('customer_creation', 'always')
      if (billingTarget.artist.email) params.append('customer_email', billingTarget.artist.email)
    }
    params.append('success_url', `https://musigod.com/success.html?artist_id=${encodeURIComponent(artist_id)}&session_id={CHECKOUT_SESSION_ID}`)
    params.append('cancel_url', `https://musigod.com/register.html?artist_id=${encodeURIComponent(artist_id)}&checkout=cancelled`)
  } else {
    // CANONICAL post-payment destination — NEVER rights-audit.html
    params.append('success_url', `https://musigod.com/audit-status.html?audit_id=${encodeURIComponent(audit_id || '')}&session_id={CHECKOUT_SESSION_ID}`)
    params.append('cancel_url', `https://musigod.com/rights-audit.html?audit_id=${encodeURIComponent(audit_id || '')}&unlock=cancelled`)
  }

  const t0 = Date.now()
  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const session = await stripeRes.json()
  console.log(JSON.stringify({ event: 'checkout_session_created', plan, audit_id: audit_id || null, stripe_latency_ms: Date.now() - t0, ok: stripeRes.ok }))

  if (!stripeRes.ok) {
    console.error(JSON.stringify({ event: 'checkout_session_failed', plan, audit_id: audit_id || null, stripe_status: stripeRes.status, error: session.error?.message }))
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

  console.log(JSON.stringify({ event: 'checkout_url_returned', plan, audit_id: audit_id || null, session_id: session.id }))
  res.status(200).json({ url: session.url })
}, 'create-checkout-session')

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function getBillingTarget(artistId) {
  const artistResponse = await fetch(
    `${SB_URL}/rest/v1/artists_v1?id=eq.${encodeURIComponent(artistId)}&select=id,email,plan_tier,plan_status,meta&limit=1`,
    { headers: sbHeaders('artists') }
  )
  if (!artistResponse.ok) throw new Error(`Artist billing lookup failed: ${artistResponse.status}`)
  const artists = await artistResponse.json()
  const artist = artists?.[0] || null
  if (!artist) return { artist: null, stripeCustomerId: null }

  const registrationResponse = await fetch(
    `${SB_URL}/rest/v1/registrations_v1?artist_id=eq.${encodeURIComponent(artistId)}&stripe_customer_id=not.is.null&select=stripe_customer_id&limit=1`,
    { headers: sbHeaders('registrations') }
  )
  if (!registrationResponse.ok) throw new Error(`Registration billing lookup failed: ${registrationResponse.status}`)
  const registrations = await registrationResponse.json()
  return { artist, stripeCustomerId: registrations?.[0]?.stripe_customer_id || null }
}

function sbHeaders(schema) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Accept-Profile': schema,
  }
}
