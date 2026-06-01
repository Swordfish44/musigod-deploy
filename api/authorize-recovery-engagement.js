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

  const { artist_email, artist_id, audit_id, service_type, service_title } = body

  if (!artist_email) return res.status(400).json({ error: 'artist_email is required' })
  if (!service_type) return res.status(400).json({ error: 'service_type is required' })

  const SERVICE_CATALOG = {
    PUBLISHING_ADMIN: {
      title: 'MusiGod Publishing Administration',
      desc: 'MusiGod will serve as your publishing administrator — registering all works, collecting all royalty streams, and recovering back royalties. You retain 100% ownership.',
    },
    MLC_REGISTRATION: {
      title: 'MLC Registration & Claims',
      desc: 'MusiGod will register your works with the Mechanical Licensing Collective and file retroactive mechanical royalty claims.',
    },
    PRO_VERIFICATION: {
      title: 'PRO Registration Verification & Correction',
      desc: 'MusiGod will audit and correct your PRO registrations across ASCAP, BMI, and SESAC.',
    },
    NEIGHBORING_RIGHTS: {
      title: 'Neighboring Rights Registration',
      desc: 'MusiGod will register your sound recordings with SoundExchange and international neighboring rights societies.',
    },
    FOREIGN_COLLECTION: {
      title: 'International Collection Setup',
      desc: 'MusiGod will establish sub-publishing relationships with international collection societies for foreign royalty recovery.',
    },
  }

  const svc = SERVICE_CATALOG[service_type] || {
    title: service_title || service_type,
    desc: 'Recovery service authorized by artist.',
  }

  try {
    // Create engagement via RPC
    const engagement = await sbRpc('fn_create_recovery_engagement_v1', 'registrations', {
      p_artist_email:     artist_email,
      p_service_type:     service_type,
      p_service_title:    svc.title,
      p_service_desc:     svc.desc,
      p_artist_id:        artist_id || null,
      p_audit_id:         audit_id || null,
      p_recovery_case_id: null,
    })

    // Mark as authorized immediately
    await sbFetch(`recovery_engagements_v1?id=eq.${enc(engagement.id)}`, 'registrations', {
      method: 'PATCH',
      body: {
        status:         'AUTHORIZED',
        authorized_at:  new Date().toISOString(),
        authorized_by:  artist_email,
        updated_at:     new Date().toISOString(),
      },
    })

    // Send confirmation email
    if (RESEND_API_KEY) {
      await sendAuthEmail({ artist_email, engagement, svc })
    }

    console.info(JSON.stringify({
      ts: new Date().toISOString(),
      event: 'ENGAGEMENT_AUTHORIZED',
      artist_email,
      service_type,
      engagement_ref: engagement.engagement_ref,
      estimated_recovery_high: engagement.estimated_recovery_high,
    }))

    return res.status(200).json({
      ok: true,
      engagement_ref: engagement.engagement_ref,
      service_type,
      service_title: svc.title,
      status: 'AUTHORIZED',
    })

  } catch (err) {
    console.error('authorize-recovery-engagement error:', err)
    captureException(err, { route: 'authorize-recovery-engagement' })
    return res.status(500).json({ error: err.message })
  }
}, 'authorize-recovery-engagement')

async function sendAuthEmail({ artist_email, engagement, svc }) {
  const statusUrl = `https://musigod.com/activity.html?artist_email=${enc(artist_email)}`
  const html = `
    <p>MusiGod received your recovery engagement authorization.</p>
    <p><strong>Service:</strong> ${esc(svc.title)}<br>
    <strong>Engagement Ref:</strong> <code>${esc(engagement.engagement_ref)}</code><br>
    <strong>Estimated Recovery:</strong> $${fmt(engagement.estimated_recovery_low)}–$${fmt(engagement.estimated_recovery_high)}<br>
    <strong>Recovery Probability:</strong> ${engagement.recovery_probability}%</p>
    <p>${esc(svc.desc)}</p>
    <p>MusiGod will begin operational steps within 1 business day. You will receive updates as work progresses.</p>
    <p style="margin:24px 0;">
      <a href="${esc(statusUrl)}"
         style="background:#E8262A;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
        Track Progress
      </a>
    </p>
    <p>MusiGod Publishing Administration · Artists keep ownership.</p>
  `
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: artist_email,
      subject: `Recovery engagement authorized — ${svc.title}`,
      html,
    }),
  })
  if (!r.ok) console.warn('Auth email failed:', r.status)
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

function fmt(v) {
  const n = parseFloat(v) || 0
  if (n >= 1000) return (n/1000).toFixed(0) + 'K'
  return n.toFixed(0)
}
function enc(v) { return encodeURIComponent(v) }
function esc(v) { return String(v||'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])) }
function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}
