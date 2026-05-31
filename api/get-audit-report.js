const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const { report_id, email, audit_id } = req.query

  if (!report_id && !email && !audit_id) {
    return res.status(400).json({ error: 'report_id, email, or audit_id is required' })
  }

  try {
    // Fetch report
    let reportQuery = 'audit_reports_v1?order=created_at.desc&limit=1'
    if (report_id) reportQuery += `&id=eq.${encodeURIComponent(report_id)}`
    else if (audit_id) reportQuery += `&audit_id=eq.${encodeURIComponent(audit_id)}`
    else if (email) reportQuery += `&artist_email=eq.${encodeURIComponent(email)}`

    const reports = await sbFetch(reportQuery, 'registrations')
    const report = reports?.[0]

    if (!report) {
      return res.status(404).json({ error: 'No report found. Generate a report first.' })
    }

    // Fetch findings
    const artist_email = report.artist_email
    let findingsQuery = `audit_findings_v1?artist_email=eq.${encodeURIComponent(artist_email)}&order=estimated_recovery_amount.desc`
    if (report.audit_id) findingsQuery += `&audit_id=eq.${encodeURIComponent(report.audit_id)}`

    const findings = await sbFetch(findingsQuery, 'registrations')

    // Fetch recovery cases
    const cases = await sbFetch(
      `recovery_cases_v1?artist_email=eq.${encodeURIComponent(artist_email)}&order=amount_identified.desc`,
      'registrations'
    )

    return res.status(200).json({
      report,
      findings: findings || [],
      recovery_cases: cases || [],
    })

  } catch (err) {
    console.error('get-audit-report error:', err)
    captureException(err, { route: 'get-audit-report' })
    return res.status(500).json({ error: 'Could not fetch report' })
  }
}, 'get-audit-report')

async function sbFetch(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
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
