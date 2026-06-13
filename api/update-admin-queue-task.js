// api/update-admin-queue-task.js
// POST /api/update-admin-queue-task
// Body: { task_id, status, assigned_to? }
// Admin-only. Updates a task in registrations.admin_queues_v1.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

const ALLOWED_STATUSES = new Set(['OPEN', 'IN_PROGRESS', 'COMPLETED', 'BLOCKED'])

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  if (!ADMIN_API_KEY || req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const { task_id, status, assigned_to } = body
  if (!task_id) return res.status(400).json({ error: 'task_id is required' })
  if (status && !ALLOWED_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}` })
  }

  const patch = { updated_at: new Date().toISOString() }
  if (status)      patch.status = status
  if (assigned_to !== undefined) patch.assigned_to = String(assigned_to || '').trim() || null
  if (status === 'COMPLETED') patch.completed_at = new Date().toISOString()

  try {
    const r = await fetch(
      `${SB_URL}/rest/v1/admin_queues_v1?id=eq.${encodeURIComponent(task_id)}`,
      {
        method: 'PATCH',
        headers: {
          apikey: SB_KEY,
          Authorization: `Bearer ${SB_KEY}`,
          'Content-Type': 'application/json',
          'Accept-Profile': 'registrations',
          'Content-Profile': 'registrations',
          Prefer: 'return=representation',
        },
        body: JSON.stringify(patch),
      }
    )
    const text = await r.text()
    if (!r.ok) throw new Error(`Supabase PATCH failed: ${r.status} ${text}`)
    const rows = text ? JSON.parse(text) : []
    if (!rows.length) return res.status(404).json({ error: 'Task not found' })
    return res.status(200).json({ ok: true, task: rows[0] })
  } catch (err) {
    console.error('[update-admin-queue-task] error:', err.message)
    return res.status(500).json({ error: 'Task update failed', detail: err.message })
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
