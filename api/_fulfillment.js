const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const STATUS = {
  PENDING_PAYMENT: 'PENDING_PAYMENT',
  PAID: 'PAID',
  FULFILLMENT_QUEUED: 'FULFILLMENT_QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED_RETRYING: 'FAILED_RETRYING',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
}

function correlationId(prefix = 'fulfillment') {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

function log(level, event, data = {}) {
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info
  writer(JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    ...data,
  }))
}

async function sbFetch(path, schema, options = {}) {
  if (!SB_KEY) throw new Error('Supabase service key is not configured')
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

  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase ${options.method || 'GET'} ${schema}.${path} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function upsertAuditStatus(input) {
  const auditId = clean(input.audit_id || input.auditId)
  if (!auditId) throw new Error('audit_id is required for fulfillment status')
  const body = {
    audit_id: auditId,
    current_status: clean(input.current_status || input.currentStatus),
    status_message: clean(input.status_message || input.statusMessage) || null,
    estimated_completion: clean(input.estimated_completion || input.estimatedCompletion) || null,
    last_error: clean(input.last_error || input.lastError) || null,
  }
  const email = clean(input.email)
  const stripeSessionId = clean(input.stripe_session_id || input.stripeSessionId)
  if (email) body.email = email
  if (stripeSessionId) body.stripe_session_id = stripeSessionId
  if (!body.current_status) throw new Error('current_status is required for fulfillment status')
  if (Number.isFinite(input.n8n_retry_count)) body.n8n_retry_count = input.n8n_retry_count
  if (input.fulfillment_queued_at) body.fulfillment_queued_at = input.fulfillment_queued_at
  if (input.processing_started_at) body.processing_started_at = input.processing_started_at
  if (input.completed_at) body.completed_at = input.completed_at

  const rows = await sbFetch('audit_status_v1?on_conflict=audit_id', 'fulfillment', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=representation',
    body,
  })
  return rows?.[0] || null
}

async function patchAuditStatus(auditId, patch) {
  await sbFetch(`audit_status_v1?audit_id=eq.${encodeURIComponent(auditId)}`, 'fulfillment', {
    method: 'PATCH',
    body: patch,
  })
}

async function logAuditEvent(input) {
  const body = {
    audit_id: clean(input.audit_id || input.auditId) || null,
    event_type: clean(input.event_type || input.eventType),
    severity: clean(input.severity) || 'info',
    source_system: clean(input.source_system || input.sourceSystem) || 'api',
    correlation_id: clean(input.correlation_id || input.correlationId) || null,
    payload: input.payload && typeof input.payload === 'object' ? input.payload : {},
  }
  if (!body.event_type) throw new Error('event_type is required for fulfillment event')
  const rows = await sbFetch('audit_event_log_v1', 'fulfillment', {
    method: 'POST',
    prefer: 'return=representation',
    body,
  })
  return rows?.[0] || null
}

async function safeLogAuditEvent(input) {
  try {
    return await logAuditEvent(input)
  } catch (err) {
    log('error', 'FULFILLMENT_EVENT_LOG_FAILED', {
      audit_id: input.audit_id || input.auditId || null,
      event_type: input.event_type || input.eventType || null,
      message: safeErrorMessage(err),
    })
    return null
  }
}

async function safeUpsertAuditStatus(input) {
  try {
    return await upsertAuditStatus(input)
  } catch (err) {
    log('error', 'FULFILLMENT_STATUS_WRITE_FAILED', {
      audit_id: input.audit_id || input.auditId || null,
      current_status: input.current_status || input.currentStatus || null,
      message: safeErrorMessage(err),
    })
    return null
  }
}

async function getAuditStatus(auditId) {
  const rows = await sbFetch(`audit_status_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=*&limit=1`, 'fulfillment')
  return rows?.[0] || null
}

async function listAuditStatuses({ query = '', status = '', limit = 50 } = {}) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 100)
  let path = `audit_status_v1?select=*&order=updated_at.desc&limit=${safeLimit}`
  if (status) path += `&current_status=eq.${encodeURIComponent(status)}`
  if (query) {
    const q = encodeURIComponent(`*${query}*`)
    path += `&or=(audit_id.ilike.${q},email.ilike.${q},stripe_session_id.ilike.${q})`
  }
  return await sbFetch(path, 'fulfillment') || []
}

async function listAuditEvents(auditId, limit = 10) {
  const safeLimit = Math.min(Math.max(parseInt(limit, 10) || 10, 1), 50)
  return await sbFetch(`audit_event_log_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=*&order=created_at.desc&limit=${safeLimit}`, 'fulfillment') || []
}

function safeErrorMessage(err) {
  return clean(err?.message || String(err)).slice(0, 500)
}

function clean(value) {
  return String(value || '').trim()
}

module.exports = {
  STATUS,
  correlationId,
  getAuditStatus,
  listAuditEvents,
  listAuditStatuses,
  log,
  logAuditEvent,
  patchAuditStatus,
  safeLogAuditEvent,
  safeUpsertAuditStatus,
  sbFetch,
  safeErrorMessage,
  upsertAuditStatus,
}
