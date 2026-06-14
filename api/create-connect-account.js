// api/create-connect-account.js
// MusiGod — Create Stripe Connect account for artist
// POST /api/create-connect-account
// Body: { artist_id, email, country? }

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const STRIPE_SECRET = process.env.STRIPE_SECRET_KEY || process.env.MUSIGOD_STRIPE_SECRET_KEY

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sbHeaders() {
  return {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Accept-Profile': 'artists',
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString('utf8'))
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const { artist_id, email, country = 'US' } = body
  if (!artist_id || !email) {
    return res.status(400).json({ error: 'Missing required fields: artist_id, email' })
  }

  try {
    // 1. Create Stripe Connect Express account
    const accountParams = new URLSearchParams({
      type: 'express',
      email,
      country,
      'capabilities[transfers][requested]': 'true',
      'capabilities[card_payments][requested]': 'true',
      'business_type': 'individual',
    })

    const accountRes = await fetch('https://api.stripe.com/v1/accounts', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: accountParams.toString(),
    })

    const account = await accountRes.json()
    if (!accountRes.ok || !account.id) {
      return res.status(500).json({ error: 'Failed to create Stripe Connect account', detail: account })
    }

    // 2. Generate onboarding link
    const linkParams = new URLSearchParams({
      account: account.id,
      refresh_url: `https://musigod.com/portal?connect=refresh`,
      return_url: `https://musigod.com/portal?connect=success`,
      type: 'account_onboarding',
    })

    const linkRes = await fetch('https://api.stripe.com/v1/account_links', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${STRIPE_SECRET}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: linkParams.toString(),
    })

    const link = await linkRes.json()
    if (!linkRes.ok || !link.url) {
      return res.status(500).json({ error: 'Failed to generate onboarding link', detail: link })
    }

    // 3. Save stripe_account_id to artist record
    const updateRes = await fetch(
      `${SB_URL}/rest/v1/artists_v1?id=eq.${artist_id}`,
      {
        method: 'PATCH',
        headers: {
          ...sbHeaders(),
          'Content-Type': 'application/json',
          'Content-Profile': 'artists',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({ stripe_account_id: account.id }),
      }
    )

    if (!updateRes.ok) {
      console.error('[create-connect-account] failed to save stripe_account_id:', await updateRes.text())
    }

    return res.status(200).json({
      success: true,
      stripe_account_id: account.id,
      onboarding_url: link.url,
    })

  } catch (err) {
    console.error('[create-connect-account] error:', err)
    return res.status(500).json({ error: 'Internal server error', detail: err.message })
  }
}
