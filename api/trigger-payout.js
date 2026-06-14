// api/trigger-payout.js
// MusiGod — Trigger royalty payout via Stripe Connect
// POST /api/trigger-payout
// Body: { disbursement_id } OR { artist_id } to pay all pending for artist

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

function sbGet(path, schema) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    }
  })
}

function sbPatch(path, schema, data) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
      'Content-Profile': schema,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal',
    },
    body: JSON.stringify(data),
  })
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

  const { disbursement_id, artist_id } = body
  if (!disbursement_id && !artist_id) {
    return res.status(400).json({ error: 'Missing required field: disbursement_id or artist_id' })
  }

  try {
    // 1. Fetch disbursement(s)
    const query = disbursement_id
      ? `disbursement_queue_v1?id=eq.${disbursement_id}&status=eq.PENDING`
      : `disbursement_queue_v1?artist_id=eq.${artist_id}&status=eq.PENDING`

    const disbRes = await sbGet(query, 'royalties')
    const disbursements = await disbRes.json()

    if (!disbursements?.length) {
      return res.status(404).json({ error: 'No pending disbursements found' })
    }

    const results = []

    for (const disb of disbursements) {
      // 2. Get artist's Stripe account ID
      // Try artists schema, fallback to public
      let artist = null
      for (const schema of ['artists', 'public']) {
        const artistRes = await sbGet(`artists_v1?id=eq.${disb.artist_id}&select=id,stripe_account_id`, schema)
        const artistBody = await artistRes.text()
        console.log('[trigger-payout] artist lookup schema:', schema, 'status:', artistRes.status, 'body:', artistBody.slice(0, 200))
        try {
          const artists = JSON.parse(artistBody)
          if (Array.isArray(artists) && artists.length) { artist = artists[0]; break }
        } catch(e) {}
      }

      if (!artist?.stripe_account_id) {
        console.error('[trigger-payout] no stripe_account_id for artist:', disb.artist_id, 'artist:', JSON.stringify(artist))
        results.push({ disbursement_id: disb.id, status: 'HELD', reason: 'Artist has no Stripe Connect account — onboarding required' })
        await sbPatch(`disbursement_queue_v1?id=eq.${disb.id}`, 'royalties', {
          status: 'HELD',
          notes: 'Artist has no Stripe Connect account',
          updated_at: new Date().toISOString(),
        })
        continue
      }

      // 3. Fire Stripe transfer
      const amount_cents = Math.round(parseFloat(disb.net_to_artist_usd) * 100)
      const transferParams = new URLSearchParams({
        amount: amount_cents.toString(),
        currency: 'usd',
        destination: artist.stripe_account_id,
        description: `MusiGod royalty: ${disb.period_label}`,
        'metadata[disbursement_id]': disb.id,
        'metadata[artist_id]': disb.artist_id,
        'metadata[period_label]': disb.period_label,
      })

      const transferRes = await fetch('https://api.stripe.com/v1/transfers', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${STRIPE_SECRET}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: transferParams.toString(),
      })

      const transfer = await transferRes.json()

      if (!transferRes.ok || !transfer.id) {
        results.push({ disbursement_id: disb.id, status: 'FAILED', reason: transfer.error?.message || 'Stripe transfer failed' })
        await sbPatch(`disbursement_queue_v1?id=eq.${disb.id}`, 'royalties', {
          status: 'FAILED',
          notes: transfer.error?.message || 'Stripe transfer failed',
          updated_at: new Date().toISOString(),
        })
        continue
      }

      // 4. Mark disbursement as SENT
      await sbPatch(`disbursement_queue_v1?id=eq.${disb.id}`, 'royalties', {
        status: 'SENT',
        disbursement_method: 'ACH',
        disbursed_at: new Date().toISOString(),
        notes: `Stripe transfer ${transfer.id}`,
        updated_at: new Date().toISOString(),
      })

      results.push({
        disbursement_id: disb.id,
        status: 'SENT',
        stripe_transfer_id: transfer.id,
        amount_usd: disb.net_to_artist_usd,
        artist_id: disb.artist_id,
      })
    }

    const sent = results.filter(r => r.status === 'SENT').length
    const failed = results.filter(r => r.status === 'FAILED').length

    return res.status(200).json({
      success: true,
      sent,
      failed,
      results,
    })

  } catch (err) {
    console.error('[trigger-payout] error:', err)
    return res.status(500).json({ error: 'Internal server error', detail: err.message })
  }
}
