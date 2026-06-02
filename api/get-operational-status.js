const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase key not configured' })

  const { email } = req.query
  if (!email) return res.status(400).json({ error: 'email is required' })

  try {
    const [stages, updates, assignments, readiness, signedAgreements, opSummary] = await Promise.all([
      sbFetch(`operational_stages_v1?artist_email=eq.${enc(email)}&stage_status=eq.ACTIVE&order=created_at.desc&limit=5`, 'registrations'),
      sbFetch(`operational_updates_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=10`, 'registrations'),
      sbFetch(`recovery_assignments_v1?artist_email=eq.${enc(email)}&assignment_status=eq.ACTIVE&order=assigned_at.desc`, 'registrations'),
      sbFetch(`recovery_readiness_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=1`, 'registrations'),
      sbFetch(`signed_agreements_v1?artist_email=eq.${enc(email)}&order=signed_at.desc`, 'registrations'),
      sbFetch(`v_operational_status_summary_v1?artist_email=eq.${enc(email)}&order=engagement_created_at.desc`, 'registrations'),
    ])

    // Recalculate readiness to ensure freshness
    await sbRpc('fn_calculate_recovery_readiness_v1', 'registrations', {
      p_artist_email: email,
      p_case_id: null,
    }).catch(() => null)

    const freshReadiness = await sbFetch(
      `recovery_readiness_v1?artist_email=eq.${enc(email)}&order=created_at.desc&limit=1`,
      'registrations'
    )

    return res.status(200).json({
      stages:           stages           || [],
      updates:          updates          || [],
      assignments:      assignments      || [],
      readiness:        freshReadiness?.[0] || readiness?.[0] || null,
      signed_agreements: signedAgreements || [],
      op_summary:       opSummary        || [],
    })

  } catch (err) {
    console.error('get-operational-status error:', err)
    captureException(err, { route: 'get-operational-status' })
    return res.status(500).json({ error: err.message })
  }
}, 'get-operational-status')

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
