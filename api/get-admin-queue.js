// api/get-admin-queue.js v2
// GET /api/get-admin-queue?queue_name=RECOVERY_PENDING_QUEUE&status=OPEN&limit=50
// Admin-only. Lists tasks from registrations.admin_queues_v1.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

const ALLOWED_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'])
const ALLOWED_QUEUES   = new Set(['RECOVERY_PENDING_QUEUE', 'PRO_REGISTRATION_QUEUE', 'PUBLISHING_ADMIN_CONFLICT'])

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  if (!ADMIN_API_KEY || req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const { queue_name, status = 'OPEN', limit = '50', audit_id, artist_email } = req.query
  const cap = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200)

  let path = `admin_queues_v1?order=created_at.asc&limit=${cap}`
  if (queue_name && ALLOWED_QUEUES.has(queue_name)) {
    path += `&queue_name=eq.${encodeURIComponent(queue_name)}`
  }
  if (status && ALLOWED_STATUSES.has(status)) {
    path += `&status=eq.${encodeURIComponent(status)}`
  }
  if (audit_id)     path += `&audit_id=eq.${encodeURIComponent(audit_id)}`
  if (artist_email) path += `&artist_email=eq.${encodeURIComponent(artist_email)}`

  path += '&select=id,queue_name,artist_id,artist_email,audit_id,recovery_case_id,task_title,task_body,status,priority,assigned_to,due_at,completed_at,metadata,created_at,updated_at'

  try {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Accept-Profile': 'registrations',
      },
    })
    const text = await r.text()
    if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
    const tasks = text ? JSON.parse(text) : []

    // Also pull summary stats
    const summaryRes = await fetch(`${SB_URL}/rest/v1/v_admin_queue_summary_v1`, {
      headers: {
        apikey: SB_KEY,
        Authorization: `Bearer ${SB_KEY}`,
        'Accept-Profile': 'registrations',
      },
    })
    const summary = summaryRes.ok ? (await summaryRes.json()) : []

    return res.status(200).json({ tasks, summary, count: tasks.length })
  } catch (err) {
    console.error('[get-admin-queue] error:', err.message)
    return res.status(500).json({ error: 'Queue fetch failed', detail: err.message })
  }
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
