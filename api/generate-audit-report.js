const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <noreply@musigod.com>'

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

  const artist_email = clean(body.artist_email)
  const audit_id     = clean(body.audit_id) || null
  const artist_id    = clean(body.artist_id) || null
  const send_email   = body.send_email !== false

  if (!artist_email) return res.status(400).json({ error: 'artist_email is required' })

  try {
    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'AUDIT_REPORT_GENERATE_START',
      artist_email, audit_id,
    }))

    // Step 1: Run deterministic audit rules
    const rulesResult = await sbRpc('fn_run_audit_rules_v1', 'registrations', {
      p_artist_email: artist_email,
      p_audit_id:     audit_id || null,
      p_artist_id:    artist_id || null,
    })
    const findings_created = typeof rulesResult === 'number' ? rulesResult : 0

    // Step 2: Build report
    const reportId = await sbRpc('fn_build_audit_report_v1', 'registrations', {
      p_artist_email: artist_email,
      p_audit_id:     audit_id || null,
      p_artist_id:    artist_id || null,
    })

    // Step 3: Fetch the generated report
    const reports = await sbFetch(
      `audit_reports_v1?artist_email=eq.${encodeURIComponent(artist_email)}&order=created_at.desc&limit=1`,
      'registrations'
    )
    const report = reports?.[0]

    // Step 4: Optionally send email
    if (send_email && report && RESEND_API_KEY) {
      await sendReportEmail({ report, artist_email, audit_id })
    }

    // Step 5: Create admin queue task
    await sbRpc('fn_create_admin_queue_task_v1', 'registrations', {
      p_queue_name:    'RECOVERY_PENDING_QUEUE',
      p_artist_email:  artist_email,
      p_task_title:    `Audit report ready for review: ${artist_email}`,
      p_task_body:     `${findings_created} findings. Estimated recovery: $${report?.total_estimated_recovery || 0}. Report ID: ${report?.report_id || 'N/A'}`,
      p_artist_id:     artist_id || null,
      p_audit_id:      audit_id || null,
      p_priority:      report?.critical_findings_count > 0 ? 'HIGH' : 'NORMAL',
    })

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'AUDIT_REPORT_GENERATED',
      artist_email,
      report_id: report?.report_id,
      findings_created,
      total_estimated_recovery: report?.total_estimated_recovery,
    }))

    return res.status(200).json({
      ok: true,
      report_id: report?.id,
      report_reference: report?.report_id,
      findings_created,
      total_estimated_recovery: report?.total_estimated_recovery,
      status: report?.status,
    })

  } catch (err) {
    console.error('generate-audit-report error:', err)
    captureException(err, { route: 'generate-audit-report' })
    return res.status(500).json({ error: 'Report generation failed: ' + err.message })
  }
}, 'generate-audit-report')

async function sendReportEmail({ report, artist_email, audit_id }) {
  const resolvedAuditId = report.audit_id || audit_id || ''
  const trackerUrl = `https://musigod.com/recovery-tracker?audit_id=${encodeURIComponent(resolvedAuditId)}&email=${encodeURIComponent(artist_email)}`
  const reportUrl  = `https://musigod.com/audit-report.html?report_id=${encodeURIComponent(report.id)}&email=${encodeURIComponent(artist_email)}`
  const recovered  = parseFloat(report.total_estimated_recovery || 0).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 })
  const html = `
    <p style="font-size:16px;">Your MusiGod rights audit is complete — we found <strong>${recovered} in recoverable royalties</strong> across ${report.findings_count} issue${report.findings_count !== 1 ? 's' : ''}.</p>
    <p>${esc(report.executive_summary || '')}</p>
    <p style="margin:32px 0;">
      <a href="${esc(trackerUrl)}"
         style="background:#E8262A;color:#fff;padding:16px 32px;border-radius:6px;text-decoration:none;font-weight:700;font-size:16px;display:inline-block;">
        Track Your Recovery Cases →
      </a>
    </p>
    <p style="color:#666;font-size:14px;">
      Your tracker shows every open case, the amounts identified, and our progress recovering them.<br>
      Report reference: <code>${esc(report.report_id)}</code>
    </p>
    <p style="color:#666;font-size:13px;">
      <a href="${esc(reportUrl)}">View full audit report</a> ·
      <a href="${esc(trackerUrl)}">Open recovery tracker</a>
    </p>
    <p style="color:#999;font-size:12px;margin-top:32px;">MusiGod Publishing Administration · Artists retain 100% ownership.</p>
  `
  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: artist_email,
      subject: `${recovered} in recoverable royalties identified — your MusiGod recovery tracker is ready`,
      html,
    }),
  })
  if (!emailRes.ok) {
    const t = await emailRes.text()
    console.warn('Report email failed:', emailRes.status, t)
  }
}

async function sbFetch(path, schema, options = {}) {
  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Accept-Profile': schema,
  }
  if (options.body) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Profile'] = schema
  }
  if (options.prefer) headers.Prefer = options.prefer
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

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

function clean(v) { return String(v || '').trim() }

function esc(v) {
  return String(v || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
