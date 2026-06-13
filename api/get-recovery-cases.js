// api/get-recovery-cases.js
// GET /api/get-recovery-cases?audit_id=<uuid>&email=<email>
// Artist-facing. Returns recovery cases for a paid audit (no admin key required).
// email is used as a lightweight ownership check (matches rights_audits_v1.email).

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const { audit_id, email } = req.query
  if (!audit_id || !email) {
    return res.status(400).json({ error: 'audit_id and email are required' })
  }

  try {
    // Verify email matches the audit record (ownership check)
    const auditRes = await sbGet(
      `rights_audits_v1?audit_id=eq.${encodeURIComponent(audit_id)}&email=eq.${encodeURIComponent(email.toLowerCase())}&select=audit_id,paid_status,artist_name&limit=1`,
      'public'
    )
    if (!auditRes.length) {
      return res.status(404).json({ error: 'Audit not found or email does not match' })
    }
    if (auditRes[0].paid_status !== 'PAID') {
      return res.status(403).json({ error: 'Recovery cases require a paid audit' })
    }

    // Fetch recovery cases
    const cases = await sbGet(
      `recovery_cases_v1?audit_id=eq.${encodeURIComponent(audit_id)}&order=amount_identified.desc&select=id,case_type,royalty_source,work_title,isrc,iswc,territory,amount_identified,amount_recovered,musigod_fee_amount,recovery_confidence_score,status,priority,notes,submitted_at,recovered_at,paid_out_at,created_at,updated_at`,
      'registrations'
    )

    // Fetch report summary
    const reportRes = await sbGet(
      `audit_reports_v1?audit_id=eq.${encodeURIComponent(audit_id)}&order=created_at.desc&limit=1&select=report_id,status,total_estimated_recovery,findings_count,critical_findings_count,executive_summary,created_at`,
      'registrations'
    )

    return res.status(200).json({
      artist_name: auditRes[0].artist_name,
      paid_status: auditRes[0].paid_status,
      report: reportRes[0] || null,
      recovery_cases: cases,
      totals: {
        total_identified: cases.reduce((s, c) => s + parseFloat(c.amount_identified || 0), 0),
        total_recovered:  cases.reduce((s, c) => s + parseFloat(c.amount_recovered  || 0), 0),
        open_cases:       cases.filter(c => !['RECOVERED', 'PAID_OUT', 'CLOSED_NO_RECOVERY', 'REJECTED'].includes(c.status)).length,
        recovered_cases:  cases.filter(c => ['RECOVERED', 'PAID_OUT'].includes(c.status)).length,
      },
    })
  } catch (err) {
    console.error('[get-recovery-cases] error:', err.message)
    return res.status(500).json({ error: 'Recovery cases fetch failed', detail: err.message })
  }
}

async function sbGet(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase GET ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : []
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
