const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })
  if (ADMIN_API_KEY && req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { queue_name, status, priority, assigned_to, limit = '50', offset = '0' } = req.query

  try {
    const filters = ['order=created_at.desc']
    if (queue_name)   filters.push(`queue_name=eq.${encodeURIComponent(queue_name)}`)
    if (status)       filters.push(`status=eq.${encodeURIComponent(status)}`)
    if (priority)     filters.push(`priority=eq.${encodeURIComponent(priority)}`)
    if (assigned_to)  filters.push(`assigned_to=eq.${encodeURIComponent(assigned_to)}`)
    filters.push(`limit=${Math.min(parseInt(limit) || 50, 200)}`)
    filters.push(`offset=${parseInt(offset) || 0}`)

    const url = `${SB_URL}/rest/v1/admin_queues_v1?${filters.join('&')}`

    const res2 = await fetch(url, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Accept-Profile': 'registrations',
        Prefer: 'count=exact',
      },
    })

    const text = await res2.text()
    if (!res2.ok) throw new Error(`Supabase fetch failed: ${res2.status} ${text}`)
    const tasks = text ? JSON.parse(text) : []
    const total = parseInt(res2.headers.get('content-range')?.split('/')[1] || '0')

    // Also fetch summary view
    const summaryRes = await fetch(
      `${SB_URL}/rest/v1/v_admin_queue_summary_v1?order=queue_name.asc`,
      {
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Accept-Profile': 'registrations',
        },
      }
    )
    const summaryText = await summaryRes.text()
    const summary = summaryText ? JSON.parse(summaryText) : []

    return res.status(200).json({ tasks, total, summary })

  } catch (err) {
    console.error('get-admin-queues error:', err)
    captureException(err, { route: 'get-admin-queues' })
    return res.status(500).json({ error: 'Could not fetch queues' })
  }
}, 'get-admin-queues')

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
