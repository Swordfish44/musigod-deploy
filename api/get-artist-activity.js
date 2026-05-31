const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const { artist_email, artist_id, audit_id } = req.query

  if (!artist_email && !artist_id) {
    return res.status(400).json({ error: 'artist_email or artist_id is required' })
  }

  try {
    // Build filter — artist-visible events only
    const filters = ["visibility=in.(ARTIST,BOTH)", "order=created_at.desc", "limit=100"]
    if (artist_email) filters.unshift(`artist_email=eq.${encodeURIComponent(artist_email)}`)
    else if (artist_id) filters.unshift(`artist_id=eq.${encodeURIComponent(artist_id)}`)
    if (audit_id) filters.push(`audit_id=eq.${encodeURIComponent(audit_id)}`)

    const url = `${SB_URL}/rest/v1/artist_activity_timeline_v1?${filters.join('&')}`

    const res2 = await fetch(url, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Accept-Profile': 'registrations',
      },
    })

    const text = await res2.text()
    if (!res2.ok) throw new Error(`Supabase fetch failed: ${res2.status} ${text}`)
    const events = text ? JSON.parse(text) : []

    return res.status(200).json({ events })

  } catch (err) {
    console.error('get-artist-activity error:', err)
    captureException(err, { route: 'get-artist-activity' })
    return res.status(500).json({ error: 'Could not fetch activity' })
  }
}, 'get-artist-activity')

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
