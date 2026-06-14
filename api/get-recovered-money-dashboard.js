const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const isAdmin = ADMIN_API_KEY && req.headers['x-admin-key'] === ADMIN_API_KEY

  try {
    const [dashboardRes, caseTypeRes, artistSummaryRes, recentRes] = await Promise.all([
      sbFetch('v_recovered_money_dashboard_v1', 'registrations'),
      sbFetch('v_case_type_breakdown_v1', 'registrations'),
      sbFetch('v_artist_recovery_summary_v1?limit=20', 'registrations'),
      sbFetch('recovery_cases_v1?status=in.(RECOVERED,PAID_OUT)&order=recovered_at.desc&limit=10', 'registrations'),
    ])

    const dashboard = dashboardRes?.[0] || {
      total_amount_identified: 0,
      total_amount_recovered: 0,
      total_musigod_fees: 0,
      open_cases: 0,
      recovered_cases: 0,
      paid_out_cases: 0,
      avg_recovery_confidence: 0,
    }

    // Mask artist emails for public mode
    const artistSummary = (artistSummaryRes || []).map(row => ({
      ...row,
      artist_email: isAdmin ? row.artist_email : maskEmail(row.artist_email),
      artist_id:    isAdmin ? row.artist_id    : null,
    }))

    const recentRecoveries = (recentRes || []).map(row => ({
      id:               row.id,
      case_type:        row.case_type,
      work_title:       row.work_title,
      royalty_source:   row.royalty_source,
      amount_recovered: row.amount_recovered,
      territory:        row.territory,
      recovered_at:     row.recovered_at,
      artist_name:      row.artist_name || 'Artist',
      artist_email:     isAdmin ? row.artist_email : maskEmail(row.artist_email),
    }))

    return res.status(200).json({
      dashboard,
      by_case_type:      caseTypeRes || [],
      artist_summary:    artistSummary,
      recent_recoveries: recentRecoveries,
      is_admin:          isAdmin,
    })

  } catch (err) {
    console.error('get-recovered-money-dashboard error:', err)
    captureException(err, { route: 'get-recovered-money-dashboard' })
    return res.status(500).json({ error: 'Could not fetch dashboard' })
  }
}, 'get-recovered-money-dashboard')

async function sbFetch(path, schema) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase fetch ${path} failed: ${res.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function maskEmail(email) {
  if (!email) return '***'
  const [local, domain] = email.split('@')
  return `${local.slice(0, 2)}***@${domain}`
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
