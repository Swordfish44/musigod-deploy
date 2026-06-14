// api/save-writer-splits.js
// POST /api/save-writer-splits
// Body: { artist_id, track_title, release_title?, writers: [{name, split_pct, role?, ipi?}] }
// split_pct values must sum to 100 (writer's share of the writer's 50% of the work)

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })

  const adminKey = req.headers['x-admin-key']
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  const { artist_id, track_title, release_title, writers } = body
  if (!artist_id || !track_title || !Array.isArray(writers) || writers.length === 0) {
    return res.status(400).json({ error: 'artist_id, track_title, and writers[] are required' })
  }

  const total = writers.reduce((s, w) => s + (parseFloat(w.split_pct) || 0), 0)
  if (Math.abs(total - 100) > 0.1) {
    return res.status(400).json({ error: `splits must sum to 100 (got ${total.toFixed(2)})` })
  }

  const payload = {
    artist_id,
    track_title: track_title.toLowerCase().trim(),
    release_title: release_title || null,
    writers: writers.map(w => ({
      name:      (w.name || '').trim(),
      split_pct: parseFloat(parseFloat(w.split_pct).toFixed(4)),
      role:      w.role || 'writer',
      ipi:       w.ipi || null,
    })),
    updated_at: new Date().toISOString(),
  }

  const sbRes = await fetch(
    `${SB_URL}/rest/v1/catalog_writer_splits_v1?on_conflict=artist_id,track_title`,
    {
      method: 'POST',
      headers: {
        'apikey':        SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Content-Type':  'application/json',
        'Prefer':        'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify(payload),
    }
  )

  if (!sbRes.ok) {
    const detail = await sbRes.text()
    return res.status(500).json({ error: 'Failed to save splits', detail })
  }

  const rows = await sbRes.json()
  return res.status(200).json({ success: true, id: rows[0]?.id })
}
