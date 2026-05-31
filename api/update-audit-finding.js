const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

const ALLOWED_STATUSES = new Set(['OPEN', 'APPROVED', 'REJECTED', 'ESCALATED', 'IN_REVIEW'])
const ALLOWED_SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })
  if (ADMIN_API_KEY && req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const { finding_id, status, severity, admin_notes, reviewed_by, regenerate_report } = body

  if (!finding_id) return res.status(400).json({ error: 'finding_id is required' })
  if (status && !ALLOWED_STATUSES.has(status)) {
    return res.status(400).json({ error: `status must be one of: ${[...ALLOWED_STATUSES].join(', ')}` })
  }
  if (severity && !ALLOWED_SEVERITIES.has(severity)) {
    return res.status(400).json({ error: `severity must be one of: ${[...ALLOWED_SEVERITIES].join(', ')}` })
  }

  try {
    // Use RPC for status update (handles timeline logging)
    let finding
    if (status) {
      finding = await sbRpc('fn_update_finding_status_v1', 'registrations', {
        p_finding_id:  finding_id,
        p_status:      status,
        p_admin_notes: admin_notes || null,
        p_reviewed_by: reviewed_by || 'admin',
      })
    }

    // Apply additional field patches if needed
    const patch = { updated_at: new Date().toISOString() }
    if (severity)    patch.severity    = severity
    if (admin_notes && !status) patch.admin_notes = admin_notes

    if (Object.keys(patch).length > 1) {
      const patchRes = await fetch(
        `${SB_URL}/rest/v1/audit_findings_v1?id=eq.${encodeURIComponent(finding_id)}`,
        {
          method: 'PATCH',
          headers: {
            apikey: SB_KEY,
            Authorization: `Bearer ${SB_KEY}`,
            'Content-Type': 'application/json',
            'Content-Profile': 'registrations',
            'Accept-Profile': 'registrations',
            Prefer: 'return=representation',
          },
          body: JSON.stringify(patch),
        }
      )
      const text = await patchRes.text()
      if (!patchRes.ok) throw new Error(`Patch failed: ${patchRes.status} ${text}`)
      const rows = text ? JSON.parse(text) : []
      finding = finding || rows[0]
    }

    // Optionally regenerate report
    if (regenerate_report && finding?.artist_email) {
      await sbRpc('fn_build_audit_report_v1', 'registrations', {
        p_artist_email: finding.artist_email,
        p_audit_id:     finding.audit_id || null,
        p_artist_id:    finding.artist_id || null,
      })
    }

    return res.status(200).json({ ok: true, finding })

  } catch (err) {
    console.error('update-audit-finding error:', err)
    captureException(err, { route: 'update-audit-finding' })
    return res.status(500).json({ error: 'Update failed: ' + err.message })
  }
}, 'update-audit-finding')

async function sbRpc(fn, schema, params) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Content-Profile': schema,
    },
    body: JSON.stringify(params),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`RPC ${fn} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
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
