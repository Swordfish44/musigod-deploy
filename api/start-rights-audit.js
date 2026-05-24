const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const OPS_EMAIL = process.env.OPS_EMAIL || process.env.VA_EMAIL || 'support@musigod.com'
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <support@musigod.com>'
const RIGHTS_AUDIT_WEBHOOK_URL = process.env.RIGHTS_AUDIT_WEBHOOK_URL || 'https://musigod-n8n.onrender.com/webhook/rights-audit-started'

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key is not configured' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const payload = normalizePayload(body, req)
  const validationError = validate(payload)
  if (validationError) return res.status(400).json({ error: validationError })

  try {
    const audit = await createAudit(payload)
    await Promise.allSettled([
      notifyN8n(audit),
      sendEmail({
        to: payload.email,
        subject: 'MusiGod rights audit received',
        html: `<p>We received your rights audit request.</p><p>Audit ID: <strong>${audit.audit_id}</strong></p><p>MusiGod will review your rights, registrations, and royalty collection gaps and follow up with next steps.</p>`,
      }),
      sendEmail({
        to: OPS_EMAIL,
        subject: `Rights audit requested: ${payload.artist_name}`,
        html: `<p>New rights audit request.</p><p><strong>Audit ID:</strong> ${audit.audit_id}<br><strong>Artist:</strong> ${payload.artist_name}<br><strong>Email:</strong> ${payload.email}<br><strong>Catalog:</strong> ${payload.catalog_size}</p>`,
      }),
    ])

    return res.status(200).json({
      audit_id: audit.audit_id,
      status: audit.status,
      created_at: audit.created_at,
    })
  } catch (err) {
    console.error('start-rights-audit error:', err)
    return res.status(500).json({ error: 'Rights audit could not be started' })
  }
}

function normalizePayload(body, req) {
  return {
    artist_name: clean(body.artist_name),
    legal_name: clean(body.legal_name),
    email: clean(body.email).toLowerCase(),
    phone: clean(body.phone),
    pro_affiliation: clean(body.pro_affiliation),
    publisher_name: clean(body.publisher_name),
    catalog_size: clean(body.catalog_size),
    released_music: clean(body.released_music),
    platforms: normalizeList(body.platforms),
    rights_concerns: normalizeList(body.rights_concerns),
    notes: clean(body.notes),
    source: clean(body.source) || 'rights-audit.html',
    ip_address: clean(req.headers['x-forwarded-for']).split(',')[0] || null,
    user_agent: clean(req.headers['user-agent']) || null,
  }
}

function validate(payload) {
  if (!payload.artist_name) return 'artist_name is required'
  if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return 'Valid email is required'
  if (!payload.catalog_size) return 'catalog_size is required'
  if (!payload.released_music) return 'released_music is required'
  if (!payload.rights_concerns.length) return 'At least one rights concern is required'
  return null
}

async function createAudit(payload) {
  const rows = await sbFetch('rights_audits_v1', 'public', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      status: 'NEW',
      artist_name: payload.artist_name,
      legal_name: payload.legal_name || null,
      email: payload.email,
      phone: payload.phone || null,
      pro_affiliation: payload.pro_affiliation || null,
      publisher_name: payload.publisher_name || null,
      catalog_size: payload.catalog_size,
      released_music: payload.released_music,
      platforms: payload.platforms,
      rights_concerns: payload.rights_concerns,
      notes: payload.notes || null,
      source: payload.source,
      ip_address: payload.ip_address,
      user_agent: payload.user_agent,
      metadata: {
        submitted_at: new Date().toISOString(),
      },
    },
  })
  if (!rows?.[0]?.audit_id) throw new Error('Rights audit insert returned no audit_id')
  return rows[0]
}

async function notifyN8n(audit) {
  if (!RIGHTS_AUDIT_WEBHOOK_URL) return
  await fetch(RIGHTS_AUDIT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'rights_audit.started',
      audit_id: audit.audit_id,
      status: audit.status,
      artist_name: audit.artist_name,
      legal_name: audit.legal_name,
      email: audit.email,
      phone: audit.phone,
      catalog_size: audit.catalog_size,
      released_music: audit.released_music,
      platforms: audit.platforms,
      rights_concerns: audit.rights_concerns,
      submitted_at: audit.created_at,
    }),
  })
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) return
  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  })
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

  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).slice(0, 20)
  return clean(value).split(',').map(clean).filter(Boolean).slice(0, 20)
}

function clean(value) {
  return String(value || '').trim()
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
