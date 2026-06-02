const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase key not configured' })

  const { service_type, version } = req.query
  if (!service_type) return res.status(400).json({ error: 'service_type is required' })

  try {
    let url = `agreement_versions_v1?service_type=eq.${encodeURIComponent(service_type)}&is_current=eq.true&order=created_at.desc&limit=1`
    if (version) url = `agreement_versions_v1?service_type=eq.${encodeURIComponent(service_type)}&version=eq.${encodeURIComponent(version)}&limit=1`

    const rows = await sbFetch(url, 'registrations')
    const agreement = rows?.[0]

    if (!agreement) {
      return res.status(404).json({ error: 'Agreement not found for service type: ' + service_type })
    }

    return res.status(200).json({
      service_type:  agreement.service_type,
      version:       agreement.version,
      title:         agreement.title,
      body_text:     agreement.body_text,
      effective_date: agreement.effective_date,
    })

  } catch (err) {
    console.error('render-agreement error:', err)
    captureException(err, { route: 'render-agreement' })
    return res.status(500).json({ error: err.message })
  }
}, 'render-agreement')

async function sbFetch(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
