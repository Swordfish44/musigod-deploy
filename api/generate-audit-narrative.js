const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })
  if (ADMIN_API_KEY && req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  let body
  try { body = JSON.parse((await getRawBody(req)).toString()) }
  catch { return res.status(400).json({ error: 'Invalid request body' }) }

  const artist_email = clean(body.artist_email)
  const audit_id     = clean(body.audit_id) || null
  const artist_id    = clean(body.artist_id) || null
  const report_id    = clean(body.report_id) || null
  const admin_override = clean(body.admin_override_text) || null

  if (!artist_email) return res.status(400).json({ error: 'artist_email is required' })

  try {
    // Generate deterministic narrative
    const narrative = await sbRpc('fn_generate_narrative_v1', 'registrations', {
      p_artist_email: artist_email,
      p_audit_id:     audit_id,
      p_artist_id:    artist_id,
      p_report_id:    report_id,
    })

    // Apply admin override if provided
    if (admin_override && narrative?.id) {
      await sbFetch(`audit_narratives_v1?id=eq.${encodeURIComponent(narrative.id)}`, 'registrations', {
        method: 'PATCH',
        body: {
          admin_override_text: admin_override,
          admin_overridden: true,
          updated_at: new Date().toISOString(),
        },
      })
    }

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'NARRATIVE_GENERATED',
      artist_email,
      narrative_id: narrative?.id,
      confidence_level: narrative?.confidence_level,
    }))

    return res.status(200).json({ ok: true, narrative })

  } catch (err) {
    console.error('generate-audit-narrative error:', err)
    captureException(err, { route: 'generate-audit-narrative' })
    return res.status(500).json({ error: err.message })
  }
}, 'generate-audit-narrative')

async function sbFetch(path, schema, options = {}) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema }
  if (options.body) { headers['Content-Type'] = 'application/json'; headers['Content-Profile'] = schema }
  if (options.prefer) headers.Prefer = options.prefer
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET', headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function sbRpc(fn, schema, params) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Content-Profile': schema },
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
function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
