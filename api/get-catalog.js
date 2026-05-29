const { captureException, withSentry } = require('./_sentry')
const { log, safeErrorMessage } = require('./_fulfillment')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Service not configured' })

  const url = new URL(req.url, 'https://musigod.com')
  const auditId = clean(url.searchParams.get('audit_id'))
  const isAdmin = req.headers['x-admin-key'] === ADMIN_API_KEY && ADMIN_API_KEY

  if (!auditId) return res.status(400).json({ error: 'audit_id is required' })

  // Non-admin: verify audit exists and is paid (no email required — audit_id is the token)
  if (!isAdmin) {
    try {
      const rows = await sbGet(
        `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=paid_status&limit=1`,
        'public'
      )
      if (!rows?.length) return res.status(404).json({ error: 'Audit not found' })
      if (rows[0].paid_status !== 'PAID') return res.status(403).json({ error: 'Paid audit required' })
    } catch (err) {
      return res.status(500).json({ error: 'Audit lookup failed' })
    }
  }

  try {
    const tracks = await sbGet(
      `catalog_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=*&order=created_at.asc&limit=200`,
      'public'
    )
    log('info', 'CATALOG_FETCHED', { audit_id: auditId, count: tracks?.length || 0, admin: isAdmin })
    return res.status(200).json({ audit_id: auditId, tracks: tracks || [], count: tracks?.length || 0 })
  } catch (err) {
    log('error', 'CATALOG_FETCH_FAILED', { audit_id: auditId, message: safeErrorMessage(err) })
    captureException(err, { route: 'get-catalog', audit_id: auditId })
    return res.status(500).json({ error: 'Catalog fetch failed' })
  }
}, 'get-catalog')

async function sbGet(path, schema) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status}`)
  return text ? JSON.parse(text) : null
}

function clean(v) { return String(v || '').trim() }

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key')
}
