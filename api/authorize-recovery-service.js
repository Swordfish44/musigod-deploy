const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <noreply@musigod.com>'

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  let body
  try { body = JSON.parse((await getRawBody(req)).toString()) }
  catch { return res.status(400).json({ error: 'Invalid request body' }) }

  const {
    artist_email, artist_id, audit_id,
    service_type, service_title,
    engagement_id,
    disclosure_acknowledged,
  } = body

  if (!artist_email)          return res.status(400).json({ error: 'artist_email is required' })
  if (!service_type)          return res.status(400).json({ error: 'service_type is required' })
  if (!disclosure_acknowledged) return res.status(400).json({ error: 'disclosure_acknowledged must be true' })

  const ip_address = clean(req.headers['x-forwarded-for']).split(',')[0] || null
  const user_agent = clean(req.headers['user-agent']) || null

  try {
    // Fetch agreement text for this service type
    const agreements = await sbFetch(
      `recovery_agreements_v1?service_type=eq.${enc(service_type)}&is_active=eq.true&order=created_at.desc&limit=1`,
      'registrations'
    )
    const agreement = agreements?.[0]

    // Create authorization via RPC
    const authorization = await sbRpc('fn_create_recovery_authorization_v1', 'registrations', {
      p_artist_email:  artist_email,
      p_service_type:  service_type,
      p_service_title: service_title || agreement?.service_title || service_type,
      p_engagement_id: engagement_id || null,
      p_artist_id:     artist_id || null,
      p_audit_id:      audit_id || null,
      p_ip_address:    ip_address,
      p_user_agent:    user_agent,
    })

    // Run full onboarding: sign + stage + assign + readiness
    await sbRpc('fn_complete_authorization_onboarding_v1', 'registrations', {
      p_artist_email:  artist_email,
      p_service_type:  service_type,
      p_engagement_id: engagement_id || null,
      p_artist_id:     artist_id || null,
      p_ip_address:    ip_address,
      p_user_agent:    user_agent,
    }).catch(err => console.warn('Onboarding pipeline non-fatal:', err.message))

    // Also create/update engagement record
    await sbRpc('fn_create_recovery_engagement_v1', 'registrations', {
      p_artist_email:  artist_email,
      p_service_type:  service_type,
      p_service_title: service_title || agreement?.service_title || service_type,
      p_service_desc:  agreement?.full_text?.slice(0, 500) || null,
      p_artist_id:     artist_id || null,
      p_audit_id:      audit_id || null,
      p_recovery_case_id: null,
    }).catch(() => null) // Non-fatal if engagement already exists

    // Mark engagement as authorized
    if (engagement_id) {
      await sbFetch(`recovery_engagements_v1?id=eq.${enc(engagement_id)}`, 'registrations', {
        method: 'PATCH',
        body: { status: 'AUTHORIZED', authorized_at: new Date().toISOString(), authorized_by: artist_email, updated_at: new Date().toISOString() },
      }).catch(() => null)
    }

    // Generate required documents list
    await sbRpc('fn_generate_required_documents_v1', 'registrations', {
      p_artist_email: artist_email,
      p_audit_id: audit_id || null,
    }).catch(() => null)

    // Send confirmation email
    if (RESEND_API_KEY) {
      await sendAuthConfirmationEmail({ artist_email, authorization, agreement, service_type }).catch(() => null)
    }

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'RECOVERY_SERVICE_AUTHORIZED',
      artist_email,
      service_type,
      authorization_ref: authorization?.authorization_ref,
      ip_address,
      agreement_version: authorization?.agreement_version,
    }))

    return res.status(200).json({
      ok: true,
      authorization_ref: authorization?.authorization_ref,
      service_type,
      service_title: service_title || agreement?.service_title,
      lifecycle_status: 'AUTHORIZED',
      authorized_at: authorization?.authorized_at,
      agreement_version: authorization?.agreement_version,
      estimated_recovery_low:  authorization?.estimated_recovery_low,
      estimated_recovery_high: authorization?.estimated_recovery_high,
      recovery_probability:    authorization?.recovery_probability,
      fee_rate:                authorization?.fee_rate,
      next_steps_url: `/upload-documents.html?artist_email=${enc(artist_email)}&artist_id=${enc(artist_id || '')}&audit_id=${enc(audit_id || '')}`,
    })

  } catch (err) {
    console.error('authorize-recovery-service error:', err)
    captureException(err, { route: 'authorize-recovery-service' })
    return res.status(500).json({ error: err.message })
  }
}, 'authorize-recovery-service')

async function sendAuthConfirmationEmail({ artist_email, authorization, agreement, service_type }) {
  const activityUrl = `https://musigod.com/activity.html?artist_email=${enc(artist_email)}`
  const uploadUrl   = `https://musigod.com/upload-documents.html?artist_email=${enc(artist_email)}`

  const html = `
    <div style="font-family:'Helvetica Neue',Arial,sans-serif;max-width:600px;margin:0 auto;background:#0A0A0A;color:#fff;padding:40px 32px;border-radius:8px;">
      <div style="margin-bottom:32px;">
        <span style="font-size:1.4rem;font-weight:800;letter-spacing:-0.01em;">
          <span style="color:#fff;">MUSI</span><span style="color:#E8262A;">GOD</span>
        </span>
      </div>

      <h1 style="font-size:1.5rem;font-weight:800;letter-spacing:-0.02em;margin-bottom:0.5rem;">
        Recovery service authorized.
      </h1>
      <p style="color:#999;font-size:0.88rem;margin-bottom:2rem;">
        MusiGod will begin operational steps within 1 business day.
      </p>

      <div style="background:#1A1A1A;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:1.5rem;margin-bottom:1.5rem;">
        <div style="font-size:0.6rem;font-weight:700;letter-spacing:0.15em;text-transform:uppercase;color:#555;margin-bottom:0.75rem;">Authorization Summary</div>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Authorization Ref</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;font-family:monospace;">${esc(authorization?.authorization_ref || '')}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Service</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${esc(agreement?.service_title || service_type)}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Est. Recovery</td><td style="padding:0.4rem 0;color:#22C55E;font-size:0.8rem;font-weight:700;text-align:right;">$${fmt(authorization?.estimated_recovery_low)}–$${fmt(authorization?.estimated_recovery_high)}</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Recovery Probability</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${authorization?.recovery_probability || 0}%</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">MusiGod Fee</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">15% of successful recovery only</td></tr>
          <tr><td style="padding:0.4rem 0;color:#999;font-size:0.8rem;">Agreement Version</td><td style="padding:0.4rem 0;color:#fff;font-size:0.8rem;text-align:right;">${esc(authorization?.agreement_version || 'v1.0')}</td></tr>
        </table>
      </div>

      <div style="background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-left:3px solid #22C55E;border-radius:6px;padding:1rem 1.25rem;margin-bottom:1.5rem;font-size:0.8rem;color:#999;">
        <strong style="color:#22C55E;">Disclosures acknowledged:</strong><br>
        Artists retain 100% ownership. · MusiGod earns only from successful recovery. · Standard recovery fee: 15%. · Recovery estimates are probabilistic and not guaranteed.
      </div>

      <p style="margin:24px 0;">
        <a href="${esc(uploadUrl)}" style="background:#E8262A;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;font-size:0.82rem;letter-spacing:0.05em;text-transform:uppercase;">
          Upload Required Documents
        </a>
      </p>

      <p style="font-size:0.78rem;color:#555;">
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
      subject: `Recovery service authorized — ${agreement?.service_title || service_type}`,
      html,
    }),
  })
}

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

function fmt(v) { const n = parseFloat(v)||0; if(n>=1000)return(n/1000).toFixed(0)+'K'; return n.toFixed(0); }
function enc(v) { return encodeURIComponent(String(v||'')) }
function esc(v) { return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function clean(v) { return String(v||'').trim() }
function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
