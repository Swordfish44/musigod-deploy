const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key is not configured' })

  const url = new URL(req.url, 'https://musigod.com')
  const admin = url.searchParams.get('admin') === '1'

  try {
    if (admin) {
      const authError = requireAdmin(req)
      if (authError) return res.status(authError.status).json({ error: authError.error })
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '50', 10), 1), 100)
      const rows = await sbFetch(`rights_audits_v1?select=*&order=created_at.desc&limit=${limit}`, 'public')
      return res.status(200).json({ audits: rows || [] })
    }

    const auditId = clean(url.searchParams.get('audit_id'))
    const email = clean(url.searchParams.get('email')).toLowerCase()
    if (!auditId || !email) return res.status(400).json({ error: 'audit_id and email are required' })

    const rows = await sbFetch(
      `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&email=eq.${encodeURIComponent(email)}&select=audit_id,status,artist_name,email,catalog_size,released_music,platforms,rights_concerns,created_at,updated_at&limit=1`,
      'public'
    )
    if (!rows?.length) return res.status(404).json({ error: 'Rights audit not found' })
    return res.status(200).json({ audit: rows[0] })
  } catch (err) {
    console.error('get-rights-audit error:', err)
    return res.status(500).json({ error: 'Rights audit lookup failed' })
  }
}

function requireAdmin(req) {
  if (!ADMIN_API_KEY) return { status: 500, error: 'ADMIN_API_KEY is not configured' }
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) return { status: 401, error: 'Unauthorized' }
  return null
}

async function sbFetch(path, schema) {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase GET ${path} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function clean(value) {
  return String(value || '').trim()
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key')
}
