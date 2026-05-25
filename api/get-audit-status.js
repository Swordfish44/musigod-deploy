const { captureException, withSentry } = require('./_sentry')
const { STATUS, correlationId, getAuditStatus, listAuditEvents, log, safeLogAuditEvent, safeUpsertAuditStatus, sbFetch, safeErrorMessage } = require('./_fulfillment')

const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  const requestId = correlationId('audit_status')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key is not configured' })

  const url = new URL(req.url, 'https://musigod.com')
  const auditId = clean(url.searchParams.get('id') || url.searchParams.get('audit_id'))
  if (!auditId) {
    return res.status(400).json({
      error: 'audit id is required',
      status: fallbackStatus('ACTION_REQUIRED', 'Audit ID is missing. Use the link from your MusiGod email or contact support.'),
    })
  }

  try {
    let status = await getAuditStatus(auditId)
    const audit = await getAudit(auditId)

    if (!status && audit) {
      const currentStatus = audit.paid_status === 'PAID' ? STATUS.PAID : STATUS.PENDING_PAYMENT
      status = await safeUpsertAuditStatus({
        audit_id: auditId,
        email: audit.email,
        stripe_session_id: audit.stripe_session_id,
        current_status: currentStatus,
        status_message: audit.paid_status === 'PAID' ? 'Payment confirmed. Fulfillment status is being prepared.' : 'Audit request received. Payment is required to unlock review.',
        estimated_completion: audit.paid_status === 'PAID' ? 'Most paid audits move into review within 1 business day.' : 'Payment unlocks the next-step review queue.',
      })
    }

    if (!status) {
      return res.status(404).json({
        error: 'Audit status not found',
        status: fallbackStatus('ACTION_REQUIRED', 'We could not find this audit status. Contact support with your audit ID.'),
      })
    }

    await safeLogAuditEvent({
      audit_id: auditId,
      event_type: 'artist_viewed_status_page',
      severity: 'info',
      source_system: 'frontend',
      correlation_id: requestId,
      payload: { user_agent: clean(req.headers['user-agent']) || null },
    })

    const events = await listAuditEvents(auditId, 8)
    log('info', 'AUDIT_STATUS_VIEWED', { request_id: requestId, audit_id: auditId, current_status: status.current_status })
    return res.status(200).json({
      status: normalizeStatus(status, audit),
      events: events.map(publicEvent),
      server_time: new Date().toISOString(),
    })
  } catch (err) {
    log('error', 'AUDIT_STATUS_LOOKUP_FAILED', { request_id: requestId, audit_id: auditId, message: safeErrorMessage(err) })
    captureException(err, {
      route: 'get-audit-status',
      method: req.method,
      path: req.url,
      statusCode: 500,
    })
    return res.status(200).json({
      status: fallbackStatus('ACTION_REQUIRED', 'Status is temporarily unavailable. Your payment flow is not affected. Contact support if this persists.'),
      events: [],
      server_time: new Date().toISOString(),
    })
  }
}, 'get-audit-status')

async function getAudit(auditId) {
  const rows = await sbFetch(
    `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,email,artist_name,paid_status,paid_at,stripe_session_id,next_steps_email_sent_at,fulfilled_at,fulfillment_status,fulfillment_error,n8n_fulfillment_status,created_at&limit=1`,
    'public'
  )
  return rows?.[0] || null
}

function normalizeStatus(status, audit) {
  return {
    audit_id: status.audit_id,
    email: status.email || audit?.email || null,
    artist_name: audit?.artist_name || null,
    current_status: status.current_status,
    status_message: status.status_message || defaultMessage(status.current_status),
    estimated_completion: status.estimated_completion || defaultEstimate(status.current_status),
    last_error: status.last_error || null,
    paid_status: audit?.paid_status || (status.current_status === STATUS.PENDING_PAYMENT ? 'UNPAID' : 'PAID'),
    stripe_session_id_present: Boolean(status.stripe_session_id || audit?.stripe_session_id),
    next_steps_email_sent_at: audit?.next_steps_email_sent_at || null,
    fulfilled_at: audit?.fulfilled_at || status.completed_at || null,
    fulfillment_status: audit?.fulfillment_status || null,
    n8n_fulfillment_status: audit?.n8n_fulfillment_status || null,
    updated_at: status.updated_at,
    created_at: status.created_at,
  }
}

function publicEvent(event) {
  return {
    event_type: event.event_type,
    severity: event.severity,
    source_system: event.source_system,
    created_at: event.created_at,
  }
}

function fallbackStatus(currentStatus, message) {
  return {
    audit_id: null,
    current_status: currentStatus,
    status_message: message,
    estimated_completion: 'Support can confirm status manually.',
    paid_status: 'UNKNOWN',
    stripe_session_id_present: false,
    updated_at: new Date().toISOString(),
  }
}

function defaultMessage(status) {
  if (status === STATUS.PENDING_PAYMENT) return 'Waiting for payment confirmation.'
  if (status === STATUS.PAID) return 'Payment confirmed.'
  if (status === STATUS.FULFILLMENT_QUEUED) return 'Fulfillment is queued.'
  if (status === STATUS.PROCESSING) return 'MusiGod is reviewing your audit.'
  if (status === STATUS.COMPLETED) return 'Fulfillment is complete.'
  if (status === STATUS.FAILED_RETRYING) return 'MusiGod operations is retrying fulfillment.'
  return 'MusiGod needs additional action to complete this audit.'
}

function defaultEstimate(status) {
  if (status === STATUS.COMPLETED) return 'Complete.'
  if (status === STATUS.ACTION_REQUIRED || status === STATUS.FAILED_RETRYING) return 'Operations will review and follow up.'
  return 'Most paid audits begin review within 1 business day.'
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function clean(value) {
  return String(value || '').trim()
}
