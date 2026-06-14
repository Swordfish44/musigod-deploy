// api/get-writer-splits.js
// GET /api/get-writer-splits?artist_id=<uuid>

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const { artist_id } = req.query
  if (!artist_id) return res.status(400).json({ error: 'artist_id required' })

  const sbRes = await fetch(
    `${SB_URL}/rest/v1/catalog_writer_splits_v1?artist_id=eq.${artist_id}&order=track_title.asc`,
    {
      headers: {
        'apikey':        SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
      },
    }
  )

  if (!sbRes.ok) {
    return res.status(500).json({ error: 'Failed to fetch splits', detail: await sbRes.text() })
  }

  const rows = await sbRes.json()
  return res.status(200).json(rows)
}
