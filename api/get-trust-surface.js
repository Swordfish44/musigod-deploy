const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const { email, audit_id } = req.query
  if (!email) return res.status(400).json({ error: 'email is required' })

  try {
    const [explanations, timelines, requiredDocs, readiness, authorizations] = await Promise.all([
      sbFetch(`flag_explanations_v1?artist_email=eq.${enc(email)}&order=created_at.desc`, 'registrations'),
      sbFetch(`recovery_timelines_v1?artist_email=eq.${enc(email)}&order=estimated_min_days.asc`, 'registrations'),
      sbFetch(`required_documents_v1?artist_email=eq.${enc(email)}&order=required_for_processing.desc`, 'registrations'),
      sbFetch(`v_recovery_readiness_v1?artist_email=eq.${enc(email)}&limit=1`, 'registrations'),
      sbFetch(`recovery_authorizations_v1?artist_email=eq.${enc(email)}&order=created_at.desc`, 'registrations'),
    ])

    // Cross-reference required docs with uploaded docs
    const uploadedDocs = await sbFetch(
      `artist_documents_v1?artist_email=eq.${enc(email)}&status=in.(UPLOADED,ACCEPTED)`,
      'registrations'
    )
    const uploadedTypes = new Set((uploadedDocs || []).map(d => d.document_type))

    const enrichedDocs = (requiredDocs || []).map(d => ({
      ...d,
      is_uploaded: uploadedTypes.has(d.document_type),
    }))

    return res.status(200).json({
      explanations:  explanations  || [],
      timelines:     timelines     || [],
      required_docs: enrichedDocs,
      readiness:     readiness?.[0] || null,
      authorizations: authorizations || [],
    })

  } catch (err) {
    console.error('get-trust-surface error:', err)
    captureException(err, { route: 'get-trust-surface' })
    return res.status(500).json({ error: err.message })
  }
}, 'get-trust-surface')

async function sbFetch(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function enc(v) { return encodeURIComponent(v) }
function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
