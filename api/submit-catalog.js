const { captureException, withSentry } = require('./_sentry')
const { log, safeLogAuditEvent, correlationId, safeErrorMessage } = require('./_fulfillment')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const MAX_TRACKS = 100

module.exports = withSentry(async function handler(req, res) {
  const requestId = correlationId('catalog_submit')
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Service not configured' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const auditId = clean(body.audit_id)
  if (!auditId) return res.status(400).json({ error: 'audit_id is required' })

  const tracks = Array.isArray(body.tracks) ? body.tracks : []
  if (!tracks.length) return res.status(400).json({ error: 'At least one track is required' })
  if (tracks.length > MAX_TRACKS) return res.status(400).json({ error: `Maximum ${MAX_TRACKS} tracks per submission` })

  // Verify audit exists and is paid
  let audit
  try {
    const rows = await sbGet(
      `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,paid_status,artist_name,email&limit=1`,
      'public'
    )
    audit = rows?.[0]
  } catch (err) {
    log('error', 'CATALOG_SUBMIT_AUDIT_LOOKUP_FAILED', { request_id: requestId, audit_id: auditId, message: safeErrorMessage(err) })
    return res.status(500).json({ error: 'Audit lookup failed' })
  }

  if (!audit) {
    log('warn', 'CATALOG_SUBMIT_AUDIT_NOT_FOUND', { request_id: requestId, audit_id: auditId })
    return res.status(404).json({ error: 'Audit not found' })
  }
  if (audit.paid_status !== 'PAID') {
    log('warn', 'CATALOG_SUBMIT_AUDIT_NOT_PAID', { request_id: requestId, audit_id: auditId, paid_status: audit.paid_status })
    return res.status(403).json({ error: 'Catalog submission requires a paid audit' })
  }

  log('info', 'CATALOG_SUBMIT_START', { request_id: requestId, audit_id: auditId, track_count: tracks.length })

  // Insert tracks
  const now = new Date().toISOString()
  const catalogRows = tracks.map(t => normalizeTrack(t, auditId))
  let inserted = []

  try {
    inserted = await sbPost('catalog_v1', 'public', catalogRows)
    log('info', 'CATALOG_SUBMIT_TRACKS_INSERTED', { request_id: requestId, audit_id: auditId, inserted: inserted.length })
  } catch (err) {
    log('error', 'CATALOG_SUBMIT_INSERT_FAILED', { request_id: requestId, audit_id: auditId, message: safeErrorMessage(err) })
    captureException(err, { route: 'submit-catalog', audit_id: auditId })
    return res.status(500).json({ error: 'Catalog insert failed' })
  }

  // Queue enrichment jobs (one per track)
  const enrichmentRows = inserted.map(row => ({
    catalog_id: row.catalog_id,
    audit_id: auditId,
    status: 'QUEUED',
  }))
  try {
    await sbPost('catalog_enrichment_v1', 'public', enrichmentRows)
    log('info', 'CATALOG_ENRICHMENT_QUEUED', { request_id: requestId, audit_id: auditId, queued: enrichmentRows.length })
  } catch (err) {
    // Non-fatal — enrichment can be re-queued
    log('warn', 'CATALOG_ENRICHMENT_QUEUE_FAILED', { request_id: requestId, audit_id: auditId, message: safeErrorMessage(err) })
  }

  // Update audit record: catalog_submitted_at + track_count
  try {
    await sbPatch(
      `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`,
      { catalog_submitted_at: now, catalog_track_count: tracks.length },
      'public'
    )
  } catch (err) {
    log('warn', 'CATALOG_SUBMIT_AUDIT_UPDATE_FAILED', { request_id: requestId, audit_id: auditId, message: safeErrorMessage(err) })
  }

  // Log event
  await safeLogAuditEvent({
    audit_id: auditId,
    event_type: 'catalog_submitted',
    severity: 'info',
    source_system: 'api',
    correlation_id: requestId,
    payload: { track_count: tracks.length, enrichment_queued: enrichmentRows.length },
  })

  log('info', 'CATALOG_SUBMIT_COMPLETE', { request_id: requestId, audit_id: auditId, track_count: tracks.length })

  return res.status(200).json({
    ok: true,
    audit_id: auditId,
    catalog_count: inserted.length,
    enrichment_queued: enrichmentRows.length,
    message: `${inserted.length} track${inserted.length === 1 ? '' : 's'} submitted. Your catalog is being processed.`,
  })
}, 'submit-catalog')

function normalizeTrack(t, auditId) {
  return {
    audit_id: auditId,
    track_title: clean(t.track_title || t.title),
    album_title: clean(t.album_title || t.album) || null,
    isrc: clean(t.isrc).toUpperCase() || null,
    iswc: clean(t.iswc) || null,
    upc: clean(t.upc) || null,
    release_date: cleanDate(t.release_date),
    distributor: clean(t.distributor) || null,
    pro_affiliation: clean(t.pro_affiliation || t.pro) || null,
    publisher: clean(t.publisher) || null,
    writers: normalizeList(t.writers),
    producers: normalizeList(t.producers),
    featured_artists: normalizeList(t.featured_artists),
    writer_splits: typeof t.writer_splits === 'object' && t.writer_splits ? t.writer_splits : {},
    producer_splits: typeof t.producer_splits === 'object' && t.producer_splits ? t.producer_splits : {},
    revenue_sources: normalizeList(t.revenue_sources),
    label_agreement: !!t.label_agreement,
    publishing_admin: clean(t.publishing_admin) || null,
    neighboring_rights_admin: clean(t.neighboring_rights_admin) || null,
    mechanical_admin: clean(t.mechanical_admin) || null,
    content_id_registered: !!t.content_id_registered,
    soundexchange_registered: !!t.soundexchange_registered,
    notes: clean(t.notes) || null,
    source: 'catalog-intake',
    metadata: {},
  }
}

function normalizeList(v) {
  if (Array.isArray(v)) return v.map(clean).filter(Boolean).slice(0, 20)
  return clean(v).split(',').map(clean).filter(Boolean).slice(0, 20)
}

function cleanDate(v) {
  if (!v) return null
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

function clean(v) { return String(v || '').trim() }

async function sbGet(path, schema) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase GET ${path} failed: ${res.status} ${text.slice(0, 200)}`)
  return text ? JSON.parse(text) : null
}

async function sbPost(table, schema, rows) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(rows),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : []
}

async function sbPatch(path, data, schema) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
    },
    body: JSON.stringify(data),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase PATCH ${path} failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
