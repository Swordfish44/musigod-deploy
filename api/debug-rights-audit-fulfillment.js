const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key is not configured' })
  if (!ADMIN_API_KEY) return res.status(500).json({ error: 'ADMIN_API_KEY is not configured' })
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })

  const url = new URL(req.url, 'https://musigod.com')
  const auditId = clean(url.searchParams.get('audit_id'))
  if (!auditId) return res.status(400).json({ error: 'audit_id is required' })

  try {
    const rows = await sbFetch(
      `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,email,paid_status,paid_at,stripe_session_id,stripe_customer_email,next_steps_email_sent_at,fulfilled_at,fulfillment_status,fulfillment_error,n8n_fulfillment_sent_at,n8n_fulfillment_status&limit=1`,
      'public'
    )
    if (!rows?.length) return res.status(404).json({ error: 'Rights audit not found' })
    const audit = rows[0]

    return res.status(200).json({
      audit_id: audit.audit_id,
      email: audit.email,
      paid_status: audit.paid_status,
      paid_at: audit.paid_at,
      stripe_session_id_present: Boolean(audit.stripe_session_id),
      stripe_customer_email: audit.stripe_customer_email,
      next_steps_email_sent_at: audit.next_steps_email_sent_at,
      fulfilled_at: audit.fulfilled_at,
      fulfillment_status: audit.fulfillment_status,
      fulfillment_error: audit.fulfillment_error,
      n8n_fulfillment_sent_at: audit.n8n_fulfillment_sent_at,
      n8n_fulfillment_status: audit.n8n_fulfillment_status,
    })
  } catch (err) {
    console.error('debug-rights-audit-fulfillment error:', err)
    captureException(err, {
      route: 'debug-rights-audit-fulfillment',
      method: req.method,
      path: req.url,
      statusCode: 500,
    })
    return res.status(500).json({ error: 'Rights audit fulfillment debug lookup failed' })
  }
}, 'debug-rights-audit-fulfillment')

async function sbFetch(path, schema) {
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase GET ${path} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function clean(value) {
  return String(value || '').trim()
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key')
}
