const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key is not configured' })
  if (ADMIN_API_KEY && req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const id = String(body.registration_id || '').trim()
  const action = String(body.action || '').trim().toLowerCase()
  if (!id) return res.status(400).json({ error: 'registration_id is required' })
  if (!['activate', 'reject'].includes(action)) return res.status(400).json({ error: 'Unsupported action' })

  try {
    const update = action === 'activate'
      ? { status: 'ACTIVE' }
      : { status: 'REJECTED', rejection_reason: String(body.reason || '').trim() }
    if (action === 'reject' && !update.rejection_reason) return res.status(400).json({ error: 'reason is required' })

    await sbFetch(`registrations_v1?id=eq.${encodeURIComponent(id)}`, 'registrations', { method: 'PATCH', body: update })

    const registration = await getRegistration(id)
    if (action === 'activate' && registration?.artist_id) await createCommission(registration.artist_id)
    if (action === 'reject') await notifyReject(id, registration?.artist_id, update.rejection_reason)

    return res.status(200).json({ ok: true })
  } catch (err) {
    console.error('admin-registration-action error:', err)
    return res.status(500).json({ error: 'Admin action failed' })
  }
}

async function getRegistration(id) {
  const rows = await sbFetch(`registrations_v1?id=eq.${encodeURIComponent(id)}&select=artist_id&limit=1`, 'registrations')
  return rows?.[0] || null
}

async function createCommission(artistId) {
  const artists = await sbFetch(`artists_v1?id=eq.${encodeURIComponent(artistId)}&select=ref_code&limit=1`, 'artists')
  const refCode = artists?.[0]?.ref_code
  if (!refCode) return
  await sbFetch('rpc/fn_create_commission', 'public', {
    method: 'POST',
    body: { p_affiliate_code: refCode, p_artist_id: artistId, p_trigger: 'activation' },
  }).catch(err => console.warn('commission skipped:', err.message))
}

async function notifyReject(registrationId, artistId, reason) {
  await fetch('https://musigod-n8n.onrender.com/webhook/registration-rejected', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ registration_id: registrationId, rejection_reason: reason, artist_id: artistId || null }),
  }).catch(err => console.warn('reject webhook skipped:', err.message))
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
  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key')
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
