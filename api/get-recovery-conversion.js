const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const { email, audit_id, artist_id, run_pipeline } = req.query
  if (!email) return res.status(400).json({ error: 'email is required' })

  try {
    // Optionally run the pipeline first to ensure fresh data
    if (run_pipeline === '1') {
      await sbRpc('fn_run_conversion_pipeline_v1', 'registrations', {
        p_artist_email: email,
        p_audit_id:     audit_id || null,
        p_artist_id:    artist_id || null,
      })
    }

    const [
      estimate,
      probability,
      confidence,
      actions,
      engagements,
      narrative,
      leakage,
    ] = await Promise.all([
      sbFetch(`recovery_estimates_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=1`, 'registrations'),
      sbFetch(`recovery_probability_scores_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=1`, 'registrations'),
      sbFetch(`audit_confidence_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=1`, 'registrations'),
      sbFetch(`recommended_actions_v1?artist_email=eq.${enc(email)}&status=eq.PENDING&order=estimated_recovery_value.desc`, 'registrations'),
      sbFetch(`recovery_engagements_v1?artist_email=eq.${enc(email)}&order=created_at.desc`, 'registrations'),
      sbFetch(`audit_narratives_v1?artist_email=eq.${enc(email)}&narrative_type=eq.EXECUTIVE_SUMMARY&order=created_at.desc&limit=1`, 'registrations'),
      sbFetch(`royalty_leakage_scores_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=1`, 'registrations'),
    ])

    return res.status(200).json({
      estimate:    estimate?.[0]    || null,
      probability: probability?.[0] || null,
      confidence:  confidence?.[0]  || null,
      actions:     actions          || [],
      engagements: engagements      || [],
      narrative:   narrative?.[0]   || null,
      leakage:     leakage?.[0]     || null,
    })

  } catch (err) {
    console.error('get-recovery-conversion error:', err)
    captureException(err, { route: 'get-recovery-conversion' })
    return res.status(500).json({ error: err.message })
  }
}, 'get-recovery-conversion')

async function sbFetch(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function sbRpc(fn, schema, params) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Content-Profile': schema },
    body: JSON.stringify(params),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`RPC ${fn} failed: ${r.status} ${text}`)
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
