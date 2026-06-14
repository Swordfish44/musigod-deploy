const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <noreply@musigod.com>'

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase key not configured' })

  let body
  try { body = JSON.parse((await getRawBody(req)).toString()) }
  catch { return res.status(400).json({ error: 'Invalid request body' }) }

  const {
    artist_email, artist_id, service_type,
    engagement_id, disclosure_acknowledged,
  } = body

  if (!artist_email)           return res.status(400).json({ error: 'artist_email is required' })
  if (!service_type)           return res.status(400).json({ error: 'service_type is required' })
  if (!disclosure_acknowledged) return res.status(400).json({ error: 'disclosure_acknowledged must be true' })

  const ip_address = clean(req.headers['x-forwarded-for']).split(',')[0] || null
  const user_agent = clean(req.headers['user-agent']) || null

  try {
    // Run full onboarding pipeline: sign + stage + assign + readiness
    const result = await sbRpc('fn_complete_authorization_onboarding_v1', 'registrations', {
      p_artist_email:  artist_email,
      p_service_type:  service_type,
      p_engagement_id: engagement_id || null,
      p_artist_id:     artist_id || null,
      p_ip_address:    ip_address,
      p_user_agent:    user_agent,
    })

    // Fetch the signed agreement record
    const signed = await sbFetch(
      `signed_agreements_v1?artist_email=eq.${enc(artist_email)}&service_type=eq.${enc(service_type)}&order=signed_at.desc&limit=1`,
      'registrations'
    )
    const agreement = signed?.[0]

    // Send signed agreement confirmation email
    if (RESEND_API_KEY && agreement) {
      await sendSignedEmail({ artist_email, agreement, result }).catch(() => null)
    }

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'AGREEMENT_SIGNED',
      artist_email,
      service_type,
      agreement_ref: agreement?.agreement_ref,
      ip_address,
      version: agreement?.version,
    }))

    return res.status(200).json({
      ok: true,
      agreement_ref:  agreement?.agreement_ref,
      signed_at:      agreement?.signed_at,
      service_type,
      version:        agreement?.version,
      stage_label:    result?.stage_label,
      assigned_team:  result?.assigned_team,
      readiness_score: result?.readiness_score,
      readiness_level: result?.readiness_level,
      next_steps_url: `/upload-documents.html?artist_email=${enc(artist_email)}&artist_id=${enc(artist_id || '')}`,
    })

  } catch (err) {
    console.error('sign-agreement error:', err)
    captureException(err, { route: 'sign-agreement' })
    return res.status(500).json({ error: err.message })
  }
}, 'sign-agreement')

async function sendSignedEmail({ artist_email, agreement, result }) {
  const uploadUrl   = `https://musigod.com/upload-documents.html?artist_email=${enc(artist_email)}`
  const activityUrl = `https://musigod.com/activity.html?artist_email=${enc(artist_email)}`

  const html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0A0A0A;color:#fff;padding:40px 32px;border-radius:8px;">
      <div style="margin-bottom:32px;">
        <span style="font-size:1.4rem;font-weight:800;"><span style="color:#fff;">MUSI</span><span style="color:#E8262A;">GOD</span></span>
      </div>
      <h1 style="font-size:1.5rem;font-weight:800;margin-bottom:0.5rem;">Agreement signed. Recovery initiated.</h1>
      <p style="color:#999;font-size:0.88rem;margin-bottom:2rem;">Your signed agreement has been recorded. MusiGod will begin operational steps within 1 business day.</p>

      <div style="background:#1A1A1A;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:1.5rem;margin-bottom:1.5rem;">
        <div style="font-size:0.6rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#555;margin-bottom:0.75rem;">Agreement Details</div>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Agreement Ref</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;font-family:monospace;">${esc(agreement.agreement_ref)}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Service</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${esc(agreement.service_type.replace(/_/g,' '))}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Version</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${esc(agreement.version)}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Signed At</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${new Date(agreement.signed_at).toLocaleString()}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Operational Stage</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${esc(result?.stage_label || 'Recovery Initiated')}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Assigned Team</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${esc((result?.assigned_team || 'Recovery Operations').replace(/_/g,' '))}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Recovery Readiness</td><td style="padding:0.4rem 0;color:${result?.readiness_score >= 50 ? '#22C55E' : '#F59E0B'};font-size:0.8rem;font-weight:700;text-align:right;">${result?.readiness_score || 0}/100</td></tr>
        </table>
      </div>

      <div style="background:rgba(245,158,11,0.06);border:1px solid rgba(245,158,11,0.2);border-left:3px solid #F59E0B;border-radius:6px;padding:1rem 1.25rem;margin-bottom:1.5rem;font-size:0.8rem;color:#999;">
        <strong style="color:#F59E0B;">Next step:</strong> Upload required documents to accelerate recovery processing.
      </div>

      <p style="margin:24px 0;">
        <a href="${esc(uploadUrl)}" style="background:#E8262A;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;font-size:0.82rem;letter-spacing:0.05em;text-transform:uppercase;">
          Upload Required Documents
        </a>
      </p>

      <p style="font-size:0.78rem;color:#555;margin-bottom:0.5rem;">
        <a href="${esc(activityUrl)}" style="color:#999;">Track recovery progress →</a>
      </p>

      <p style="font-size:0.7rem;color:#333;margin-top:2rem;border-top:1px solid rgba(255,255,255,0.06);padding-top:1rem;">
        MusiGod Publishing Administration · Recovered royalties. Verified rights. Artists keep ownership.
      </p>
    </div>
  `

  await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: artist_email,
      subject: `Agreement signed — ${agreement.service_type.replace(/_/g,' ')} · Ref: ${agreement.agreement_ref}`,
      html,
    }),
  })
}

async function sbFetch(path, schema, options = {}) {
  const headers = { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema }
  if (options.body) { headers['Content-Type'] = 'application/json'; headers['Content-Profile'] = schema }
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

function enc(v) { return encodeURIComponent(String(v || '')) }
function esc(v) { return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function clean(v) { return String(v || '').trim() }
function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
