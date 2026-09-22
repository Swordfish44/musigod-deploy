const { captureException, withSentry } = require('./_sentry')

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.STRIPE_SECRET_KEY) return res.status(500).json({ error: 'Stripe is not configured' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const artistId = clean(body.artist_id)
  const sessionId = clean(body.session_id)
  if (!artistId || !/^cs_(test_|live_)?[A-Za-z0-9_]+$/.test(sessionId)) {
    return res.status(400).json({ error: 'Valid artist_id and session_id required' })
  }

  try {
    const stripeResponse = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
      headers: { Authorization: `Bearer ${process.env.STRIPE_SECRET_KEY}` },
    })
    const session = await stripeResponse.json()
    if (!stripeResponse.ok) return res.status(404).json({ verified: false })

    const sameArtist = session.metadata?.artist_id === artistId
    const isSubscription = session.mode === 'subscription' && Boolean(session.subscription)
    const isComplete = session.status === 'complete'
    const isPaid = session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
    const verified = sameArtist && isSubscription && isComplete && isPaid

    if (!verified) return res.status(409).json({ verified: false })
    return res.status(200).json({ verified: true, plan: session.metadata?.plan || null })
  } catch (error) {
    captureException(error, { route: 'verify-checkout-session', method: req.method, statusCode: 502 })
    return res.status(502).json({ error: 'Checkout verification unavailable', verified: false })
  }
}, 'verify-checkout-session')

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
