'use strict'

const { captureException, withSentry } = require('./_sentry')
const paypal = require('../lib/paypal-billing')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (String(process.env.PAYPAL_BILLING_ENABLED || '').trim().toLowerCase() !== 'true') {
    return res.status(503).json({ error: 'PayPal checkout is not enabled' })
  }
  if (!paypal.isConfigured()) return res.status(500).json({ error: 'PayPal checkout is not configured' })
  if (!SB_KEY) return res.status(500).json({ error: 'Billing verification is not configured' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const artistId = String(body.artist_id || '')
  const plan = String(body.plan || '').toLowerCase()
  if (!artistId) return res.status(400).json({ error: 'artist_id required' })
  if (!paypal.PLAN_ENV[plan]) return res.status(400).json({ error: 'configured plan required' })
  if (!paypal.planIdFor(plan)) {
    console.error('PAYPAL_PLAN_NOT_CONFIGURED', { plan, env_var: paypal.PLAN_ENV[plan], vercel_env: process.env.VERCEL_ENV || null })
    return res.status(503).json({ error: `PayPal ${plan} plan is not configured on this deployment (${paypal.PLAN_ENV[plan]})` })
  }

  try {
    const artist = await getArtist(artistId)
    if (!artist) return res.status(404).json({ error: 'Artist registration not found' })
    if (String(artist.plan_tier || '').toLowerCase() !== plan) {
      return res.status(409).json({ error: 'Checkout plan does not match artist registration' })
    }
    if (artist.plan_status === 'ACTIVE') {
      return res.status(409).json({ error: 'Subscription is already active' })
    }
    if (artist.meta?.billing_status === 'PAID_AWAITING_AGREEMENT') {
      return res.status(409).json({ error: 'Payment already received. Sign your Publishing Administration Agreement to activate your account.', code: 'PAID_AWAITING_AGREEMENT' })
    }

    const subscription = await paypal.createSubscription({
      artistId,
      plan,
      email: artist.email,
      siteUrl: siteUrlForRequest(req),
    })
    console.info('PAYPAL_SUBSCRIPTION_CREATED', {
      artist_id: artistId,
      plan,
      paypal_subscription_id: subscription.id,
    })
    return res.status(200).json({
      provider: 'paypal',
      session_id: subscription.id,
      url: subscription.url,
    })
  } catch (error) {
    captureException(error, { route: 'create-paypal-subscription', method: req.method, statusCode: 502, plan })
    return res.status(502).json({ error: 'PayPal checkout is temporarily unavailable' })
  }
}, 'create-paypal-subscription')

async function getArtist(artistId) {
  const response = await fetch(
    `${SB_URL}/rest/v1/artists_v1?id=eq.${encodeURIComponent(artistId)}&select=id,email,plan_tier,plan_status,meta&limit=1`,
    { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': 'artists' } }
  )
  if (!response.ok) throw new Error(`Artist billing lookup failed: ${response.status}`)
  return (await response.json())?.[0] || null
}

// Send PayPal's return/cancel back to the deployment the buyer started on, so a
// Preview checkout returns to the Preview (not production). Only trusted hosts.
function siteUrlForRequest(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase()
  if (host === 'musigod.com' || host === 'www.musigod.com' || /^[a-z0-9-]+\.vercel\.app$/.test(host)) return `https://${host}`
  return null
}

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
