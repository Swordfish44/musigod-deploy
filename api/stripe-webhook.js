const crypto = require('crypto')

const SB_URL = process.env.SUPABASE_URL
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const rawBody = await getRawBody(req)
  const sig = req.headers['stripe-signature']

  if (!verifySignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error('Stripe signature verification failed')
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event
  try {
    event = JSON.parse(rawBody.toString())
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutComplete(event.data.object)
    } else if (event.type === 'customer.subscription.created') {
      await handleSubscriptionCreated(event.data.object)
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object)
    }
  } catch (e) {
    console.error('Webhook handler error:', e)
    return res.status(500).json({ error: 'Handler failed' })
  }

  res.status(200).json({ received: true })
}

async function handleCheckoutComplete(session) {
  const artistId = session.metadata?.artist_id
  const plan     = session.metadata?.plan
  if (!artistId) return

  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    stripe_customer_id:      session.customer,
    stripe_subscription_id:  session.subscription,
    plan_status:             'ACTIVE',
    plan_type:               plan,
  })
}

async function handleSubscriptionCreated(subscription) {
  const artistId = await artistIdByCustomer(subscription.customer)
  if (!artistId) return
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    stripe_subscription_id: subscription.id,
    plan_status: 'ACTIVE',
  })
}

async function handleSubscriptionDeleted(subscription) {
  const artistId = await artistIdByCustomer(subscription.customer)
  if (!artistId) return
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    plan_status: 'SUSPENDED',
  })
}

async function artistIdByCustomer(customerId) {
  if (!customerId) return null
  const res = await fetch(
    `${SB_URL}/rest/v1/registrations_v1?stripe_customer_id=eq.${customerId}&select=artist_id&limit=1`,
    { headers: sbReadHeaders() }
  )
  const rows = await res.json()
  return rows?.[0]?.artist_id || null
}

async function sbPatch(path, data) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey:           SB_KEY,
      Authorization:    `Bearer ${SB_KEY}`,
      'Content-Type':   'application/json',
      'Accept-Profile': 'registrations',
      'Content-Profile':'registrations',
    },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const text = await res.text()
    console.error('Supabase PATCH error:', res.status, text)
  }
}

function sbReadHeaders() {
  return {
    apikey:           SB_KEY,
    Authorization:    `Bearer ${SB_KEY}`,
    'Accept-Profile': 'registrations',
  }
}

function verifySignature(payload, header, secret) {
  if (!header || !secret) return false
  const parts = {}
  header.split(',').forEach(p => {
    const idx = p.indexOf('=')
    parts[p.slice(0, idx)] = p.slice(idx + 1)
  })
  const { t, v1 } = parts
  if (!t || !v1) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${payload}`, 'utf8')
    .digest('hex')

  const a = Buffer.from(v1, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
