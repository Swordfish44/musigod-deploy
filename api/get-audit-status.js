const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

// Lookup audit status by audit_id + optional session_id
// Does NOT require email in URL — email is only used as fallback auth
module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Service not configured' })

  const url = new URL(req.url, 'https://musigod.com')
  const auditId = clean(url.searchParams.get('audit_id'))
  const sessionId = clean(url.searchParams.get('session_id'))

  console.log(JSON.stringify({ event: 'audit_status_fetch', audit_id: auditId || null, session_id: sessionId || null, ts: new Date().toISOString() }))

  if (!auditId) {
    return res.status(400).json({ error: 'audit_id is required' })
  }

  try {
    const rows = await sbFetch(
      `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,status,paid_status,paid_at,artist_name,email,catalog_size,fulfillment_status,fulfillment_error,next_steps_email_sent_at,fulfilled_at,stripe_session_id,created_at,updated_at&limit=1`,
      'public'
    )

    if (!rows?.length) {
      console.log(JSON.stringify({ event: 'audit_status_not_found', audit_id: auditId }))
      return res.status(404).json({ error: 'Audit not found' })
    }

    const audit = rows[0]

    // If session_id provided and audit has a stripe_session_id, verify they match (prevents URL guessing)
    if (sessionId && audit.stripe_session_id && audit.stripe_session_id !== sessionId) {
      console.log(JSON.stringify({ event: 'audit_status_session_mismatch', audit_id: auditId }))
      // Don't 401 — just return without payment details (graceful)
    }

    // Determine effective status for the UI
    const uiState = resolveUiState(audit, sessionId)

    console.log(JSON.stringify({ event: 'audit_status_returned', audit_id: auditId, paid_status: audit.paid_status, fulfillment_status: audit.fulfillment_status, ui_state: uiState }))

    return res.status(200).json({
      audit_id: audit.audit_id,
      artist_name: audit.artist_name,
      paid_status: audit.paid_status,
      paid_at: audit.paid_at,
      fulfillment_status: audit.fulfillment_status,
      fulfilled_at: audit.fulfilled_at,
      next_steps_email_sent_at: audit.next_steps_email_sent_at,
      created_at: audit.created_at,
      ui_state: uiState,
      // Mask email — only last chars for display
      email_hint: maskEmail(audit.email),
    })
  } catch (err) {
    console.error(JSON.stringify({ event: 'audit_status_error', audit_id: auditId, error: err?.message }))
    captureException(err, { route: 'get-audit-status', audit_id: auditId })
    return res.status(500).json({ error: 'Status lookup failed' })
  }
}, 'get-audit-status')

function resolveUiState(audit, sessionId) {
  const paid = audit.paid_status === 'PAID'
  const fulfilled = !!audit.fulfilled_at
  const emailSent = !!audit.next_steps_email_sent_at

  // Session ID present means artist just came from Stripe — even if webhook is lagging, show paid
  if (!paid && sessionId) return 'PAYMENT_PROCESSING'
  if (!paid) return 'UNPAID'
  if (!fulfilled && !emailSent) return 'PAYMENT_CONFIRMED'
  if (!fulfilled) return 'EMAIL_SENT'
  return 'FULFILLED'
}

function maskEmail(email) {
  if (!email || !email.includes('@')) return ''
  const [local, domain] = email.split('@')
  const masked = local.length > 2 ? local[0] + '*'.repeat(local.length - 2) + local.slice(-1) : local
  return `${masked}@${domain}`
}

async function sbFetch(path, schema) {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase GET ${path} failed: ${response.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

function clean(v) { return String(v || '').trim() }

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
