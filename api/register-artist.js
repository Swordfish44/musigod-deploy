const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const N8N_REGISTERED_WEBHOOK_URL = process.env.N8N_REGISTERED_WEBHOOK_URL || 'https://musigod-n8n.onrender.com/webhook/artist-registered'
const RESEND_API_KEY = process.env.RESEND_API_KEY
const OPS_EMAIL = process.env.OPS_EMAIL || process.env.VA_EMAIL || 'support@musigod.com'
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <support@musigod.com>'

const ALLOWED_PLANS = new Set(['starter', 'growth'])

module.exports = withSentry(async function handler(req, res) {
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

  const normalized = normalizePayload(body)
  const validationError = validate(normalized)
  if (validationError) return res.status(400).json({ error: validationError })

  try {
    const artist = await createArtist(normalized)
    const registration = await createRegistration(artist.id, normalized)

    await Promise.allSettled([
      notifyN8n(artist.id, registration?.id, normalized),
      sendEmail({
        to: normalized.email,
        subject: 'MusiGod registration received',
        html: `<p>We received your MusiGod registration.</p><p>Your next step is completing checkout so onboarding can begin.</p><p><strong>Artist ID:</strong> ${artist.id}</p>`,
      }),
      sendEmail({
        to: OPS_EMAIL,
        subject: `New MusiGod signup: ${normalized.legal_first_name} ${normalized.legal_last_name}`,
        html: `<p>New signup submitted.</p><p><strong>Artist ID:</strong> ${artist.id}<br><strong>Email:</strong> ${normalized.email}<br><strong>Plan:</strong> ${normalized.plan}</p>`,
      }),
    ])

    return res.status(200).json({ artist_id: artist.id, registration_id: registration?.id || null, plan: normalized.plan })
  } catch (err) {
    console.error('register-artist error:', err)
    captureException(err, {
      route: 'register-artist',
      method: req.method,
      path: req.url,
      statusCode: 500,
      plan: normalized.plan,
    })
    return res.status(500).json({ error: 'Registration failed' })
  }
}, 'register-artist')

function normalizePayload(body) {
  return {
    legal_first_name: clean(body.legal_first_name),
    legal_last_name: clean(body.legal_last_name),
    artist_name: clean(body.artist_name) || null,
    email: clean(body.email).toLowerCase(),
    phone: clean(body.phone) || null,
    city: clean(body.city) || null,
    state: clean(body.state) || null,
    plan: clean(body.plan || 'starter').toLowerCase(),
    pro: clean(body.pro || 'UNSURE') || 'UNSURE',
    catalog_size: clean(body.catalog_size) || null,
    works_registered: clean(body.works_registered) || null,
    genre: clean(body.genre) || null,
    referral_source: clean(body.referral_source) || null,
    ref_code: clean(body.ref_code).toUpperCase() || null,
  }
}

function validate(payload) {
  if (!payload.legal_first_name) return 'legal_first_name is required'
  if (!payload.legal_last_name) return 'legal_last_name is required'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return 'Valid email is required'
  if (!ALLOWED_PLANS.has(payload.plan)) return 'plan must be starter or growth'
  return null
}

async function createArtist(payload) {
  const artistPayload = {
    legal_first_name: payload.legal_first_name,
    legal_last_name: payload.legal_last_name,
    artist_name: payload.artist_name,
    email: payload.email,
    phone: payload.phone,
    city: payload.city,
    state: payload.state,
    country: 'US',
    plan_tier: payload.plan.toUpperCase(),
    plan_status: 'PENDING_CHECKOUT',
    ref_code: payload.ref_code,
    meta: {
      pro_affiliation: payload.pro,
      catalog_size: payload.catalog_size,
      works_registered: payload.works_registered,
      genre: payload.genre,
      referral_source: payload.referral_source,
      registered_at: new Date().toISOString(),
    },
  }

  const rows = await sbFetch('artists_v1', 'artists', {
    method: 'POST',
    body: artistPayload,
    prefer: 'return=representation',
  })
  if (!rows?.[0]?.id) throw new Error('Artist insert returned no id')
  return rows[0]
}

async function createRegistration(artistId, payload) {
  const regPayload = {
    artist_id: artistId,
    registration_type: 'ONBOARDING',
    registration_category: 'BUSINESS',
    status: 'PENDING',
    instructions: `New artist registration - ${payload.legal_first_name} ${payload.legal_last_name} (${payload.email}). Plan: ${payload.plan.toUpperCase()}. PRO: ${payload.pro}. Catalog: ${payload.catalog_size || 'unknown'}.`,
    meta: {
      plan: payload.plan,
      pro: payload.pro,
      catalog_size: payload.catalog_size,
      works_registered: payload.works_registered,
      genre: payload.genre,
      checkout_required: true,
    },
  }

  const rows = await sbFetch('registrations_v1?on_conflict=artist_id,registration_type', 'registrations', {
    method: 'POST',
    body: regPayload,
    prefer: 'resolution=merge-duplicates,return=representation',
  })
  return rows?.[0] || null
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

async function notifyN8n(artistId, registrationId, payload) {
  if (!N8N_REGISTERED_WEBHOOK_URL) return
  await fetch(N8N_REGISTERED_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      artist_id: artistId,
      registration_id: registrationId,
      name: `${payload.legal_first_name} ${payload.legal_last_name}`,
      artist_name: payload.artist_name,
      email: payload.email,
      plan: payload.plan,
      pro: payload.pro,
      ref_code: payload.ref_code,
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
