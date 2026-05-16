const PRICE_IDS = {
  starter: process.env.STRIPE_STARTER_PRICE_ID,
  growth:  process.env.STRIPE_GROWTH_PRICE_ID,
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body
  try {
    const raw = await getRawBody(req)
    body = JSON.parse(raw.toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const { artist_id, plan } = body
  if (!artist_id || !PRICE_IDS[plan]) {
    return res.status(400).json({ error: 'artist_id and plan (starter|growth) required' })
  }

  const params = new URLSearchParams()
  params.append('mode', 'subscription')
  params.append('line_items[0][price]', PRICE_IDS[plan])
  params.append('line_items[0][quantity]', '1')
  params.append('metadata[artist_id]', artist_id)
  params.append('metadata[plan]', plan)
  params.append('customer_creation', 'always')
  params.append('success_url', 'https://musigod.com/success.html')
  params.append('cancel_url', 'https://musigod.com/portal')

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
    return res.status(500).json({ error: session.error?.message || 'Stripe error' })
  }

  res.status(200).json({ url: session.url })
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
