const { captureException, withSentry } = require('./_sentry')

const PRICE_IDS = {
  starter: process.env.STRIPE_STARTER_PRICE_ID,
  growth:  process.env.STRIPE_GROWTH_PRICE_ID,
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
    params.append('customer_creation', 'always')
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
