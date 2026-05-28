const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <support@musigod.com>'
const CRON_SECRET = process.env.CRON_SECRET

module.exports = withSentry(async function handler(req, res) {
  // Allow Vercel cron (GET) or manual POST with secret
  const authHeader = req.headers['authorization'] || ''
  const isVercelCron = req.headers['x-vercel-cron'] === '1'
  const isManual = authHeader === `Bearer ${CRON_SECRET}` && CRON_SECRET

  if (!isVercelCron && !isManual) {
    return res.status(401).json({ error: 'Unauthorized' })
  }
  if (!SB_KEY) return res.status(500).json({ error: 'Not configured' })

  const now = new Date()
  const results = { day2: [], day4: [], errors: [] }

  try {
    // ── Day 2: in-progress reassurance ──────────────────────────────────
    // Criteria: paid_at between 40-56 hours ago, day2_email_sent_at IS NULL
    const day2Cutoff = new Date(now.getTime() - 40 * 60 * 60 * 1000).toISOString()
    const day2Max    = new Date(now.getTime() - 56 * 60 * 60 * 1000).toISOString()

    const day2Audits = await sbGet(
      `rights_audits_v1?paid_status=eq.PAID&day2_email_sent_at=is.null&paid_at=lte.${day2Cutoff}&paid_at=gte.${day2Max}&select=audit_id,artist_name,email,paid_at&limit=50`,
      'public'
    )

    for (const audit of (day2Audits || [])) {
      try {
        await sendDay2Email(audit)
        await sbPatch(
          `rights_audits_v1?audit_id=eq.${encodeURIComponent(audit.audit_id)}`,
          { day2_email_sent_at: now.toISOString() },
          'public'
        )
        console.log(JSON.stringify({ event: 'drip_day2_sent', audit_id: audit.audit_id, email: audit.email }))
        results.day2.push(audit.audit_id)
      } catch (err) {
        console.error(JSON.stringify({ event: 'drip_day2_error', audit_id: audit.audit_id, error: err?.message }))
        results.errors.push({ audit_id: audit.audit_id, day: 2, error: err?.message })
      }
    }

    // ── Day 4: findings almost ready ────────────────────────────────────
    // Criteria: paid_at between 88-104 hours ago, day4_email_sent_at IS NULL
    const day4Cutoff = new Date(now.getTime() - 88 * 60 * 60 * 1000).toISOString()
    const day4Max    = new Date(now.getTime() - 104 * 60 * 60 * 1000).toISOString()

    const day4Audits = await sbGet(
      `rights_audits_v1?paid_status=eq.PAID&day4_email_sent_at=is.null&paid_at=lte.${day4Cutoff}&paid_at=gte.${day4Max}&select=audit_id,artist_name,email,paid_at&limit=50`,
      'public'
    )

    for (const audit of (day4Audits || [])) {
      try {
        await sendDay4Email(audit)
        await sbPatch(
          `rights_audits_v1?audit_id=eq.${encodeURIComponent(audit.audit_id)}`,
          { day4_email_sent_at: now.toISOString() },
          'public'
        )
        console.log(JSON.stringify({ event: 'drip_day4_sent', audit_id: audit.audit_id, email: audit.email }))
        results.day4.push(audit.audit_id)
      } catch (err) {
        console.error(JSON.stringify({ event: 'drip_day4_error', audit_id: audit.audit_id, error: err?.message }))
        results.errors.push({ audit_id: audit.audit_id, day: 4, error: err?.message })
      }
    }

    console.log(JSON.stringify({ event: 'drip_cron_complete', day2_sent: results.day2.length, day4_sent: results.day4.length, errors: results.errors.length }))
    return res.status(200).json({ ok: true, ...results })

  } catch (err) {
    console.error(JSON.stringify({ event: 'drip_cron_error', error: err?.message }))
    captureException(err, { route: 'send-audit-drip' })
    return res.status(500).json({ error: 'Drip cron failed' })
  }
}, 'send-audit-drip')

// ── EMAIL TEMPLATES ─────────────────────────────────────────────────────────

async function sendDay2Email(audit) {
  const artistName = escapeHtml(audit.artist_name || 'artist')
  const statusUrl  = `https://musigod.com/audit-status.html?audit_id=${encodeURIComponent(audit.audit_id)}`

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#080808;color:#e8e8e8;font-family:Arial,sans-serif;margin:0;padding:32px 16px">
<div style="max-width:540px;margin:0 auto;background:#0c0c0c;border:1px solid rgba(200,16,46,0.2);border-radius:8px;overflow:hidden">
  <div style="background:rgba(200,16,46,0.06);border-bottom:1px solid rgba(200,16,46,0.15);padding:18px 32px">
    <span style="font-size:22px;font-weight:700;letter-spacing:0.12em;color:#fff">MUSI<span style="color:#C8102E">GOD</span></span>
  </div>
  <div style="padding:32px">
    <div style="width:44px;height:44px;border-radius:50%;background:rgba(240,160,32,0.1);border:1px solid rgba(240,160,32,0.3);display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:20px">&#128269;</div>
    <h1 style="font-size:18px;color:#fff;margin:0 0 10px;letter-spacing:0.06em">YOUR AUDIT IS IN PROGRESS</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Hi ${artistName} — just a quick update. Your MusiGod Rights Audit is actively being reviewed by our team.
    </p>

    <div style="background:rgba(240,160,32,0.04);border:1px solid rgba(240,160,32,0.14);border-left:3px solid #f0a020;border-radius:5px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#f0a020;font-size:11px;letter-spacing:0.08em;display:block;margin-bottom:8px">&#128336; WHAT WE'RE DOING RIGHT NOW</strong>
      Our team is currently checking:<br><br>
      &bull; PRO registration status and songwriter splits<br>
      &bull; SoundExchange and neighboring rights enrollment<br>
      &bull; DSP profile ownership and metadata integrity<br>
      &bull; YouTube Content ID claim coverage<br>
      &bull; Historical royalty collection gaps
    </div>

    <div style="background:rgba(200,16,46,0.04);border:1px solid rgba(200,16,46,0.12);border-radius:5px;padding:14px 18px;margin-bottom:28px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#C8102E;font-size:11px;letter-spacing:0.08em;display:block;margin-bottom:8px">&#9889; SPEED UP YOUR REVIEW</strong>
      Reply to this email with any of the following and we'll prioritize your file:<br><br>
      &bull; Your distributor name and account email<br>
      &bull; PRO member ID (ASCAP, BMI, SESAC, etc.)<br>
      &bull; Known registration gaps or disputes<br>
      &bull; Label or publishing deal details
    </div>

    <p style="color:#aaa;font-size:14px;line-height:1.7;margin:0 0 24px">
      Your full findings are expected within <strong style="color:#ddd">1–3 more business days.</strong> We'll email you the moment your audit report is ready.
    </p>

    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr><td style="text-align:center">
        <a href="${statusUrl}" style="display:inline-block;background:#C8102E;color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.1em;padding:13px 28px;border-radius:4px;font-weight:700">CHECK AUDIT STATUS &#8594;</a>
      </td></tr>
    </table>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:18px;font-size:12px;color:#555;line-height:1.7">
      Questions? Reply to this email or contact <a href="mailto:support@musigod.com" style="color:#C8102E;text-decoration:none">support@musigod.com</a><br>
      Audit ID: <span style="font-family:monospace;color:#444">${escapeHtml(audit.audit_id)}</span>
    </div>
  </div>
</div>
</body>
</html>`

  return sendEmail({
    to: audit.email,
    subject: `Your MusiGod audit is in progress — update from the team`,
    html,
  })
}

async function sendDay4Email(audit) {
  const artistName = escapeHtml(audit.artist_name || 'artist')
  const statusUrl  = `https://musigod.com/audit-status.html?audit_id=${encodeURIComponent(audit.audit_id)}`

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#080808;color:#e8e8e8;font-family:Arial,sans-serif;margin:0;padding:32px 16px">
<div style="max-width:540px;margin:0 auto;background:#0c0c0c;border:1px solid rgba(200,16,46,0.2);border-radius:8px;overflow:hidden">
  <div style="background:rgba(200,16,46,0.06);border-bottom:1px solid rgba(200,16,46,0.15);padding:18px 32px">
    <span style="font-size:22px;font-weight:700;letter-spacing:0.12em;color:#fff">MUSI<span style="color:#C8102E">GOD</span></span>
  </div>
  <div style="padding:32px">
    <div style="width:44px;height:44px;border-radius:50%;background:rgba(34,197,94,0.1);border:1px solid rgba(34,197,94,0.3);display:flex;align-items:center;justify-content:center;font-size:20px;margin-bottom:20px">&#127941;</div>
    <h1 style="font-size:18px;color:#fff;margin:0 0 10px;letter-spacing:0.06em">YOUR FINDINGS ARE ALMOST READY</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Hi ${artistName} — great news. Your MusiGod Rights Audit review is in its final stage. Your findings report will be delivered within the next <strong style="color:#ddd">24 hours.</strong>
    </p>

    <div style="background:rgba(34,197,94,0.04);border:1px solid rgba(34,197,94,0.14);border-left:3px solid #22c55e;border-radius:5px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#22c55e;font-size:11px;letter-spacing:0.08em;display:block;margin-bottom:8px">&#9989; WHAT YOUR REPORT WILL INCLUDE</strong>
      &bull; Every registration gap we identified<br>
      &bull; Estimated royalty recovery opportunities<br>
      &bull; Priority action items ranked by impact<br>
      &bull; Specific platforms and organizations to contact<br>
      &bull; Your recommended MusiGod recovery plan
    </div>

    <div style="background:rgba(200,16,46,0.04);border:1px solid rgba(200,16,46,0.12);border-radius:5px;padding:14px 18px;margin-bottom:28px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#C8102E;font-size:11px;letter-spacing:0.08em;display:block;margin-bottom:8px">&#128161; WHILE YOU WAIT</strong>
      If you haven't already — reply to this email with your distributor login, PRO member ID, or any known catalog issues. It's not too late to add context that could improve your findings.
    </div>

    <p style="color:#aaa;font-size:14px;line-height:1.7;margin:0 0 28px">
      Watch for an email from <strong style="color:#ddd">support@musigod.com</strong> with the subject line <em style="color:#ddd">"Your MusiGod Audit Findings."</em> Check spam if you don't see it within 24 hours.
    </p>

    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr><td style="text-align:center">
        <a href="${statusUrl}" style="display:inline-block;background:#C8102E;color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.1em;padding:13px 28px;border-radius:4px;font-weight:700">VIEW AUDIT STATUS &#8594;</a>
      </td></tr>
    </table>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:18px;font-size:12px;color:#555;line-height:1.7">
      Questions? Reply to this email or contact <a href="mailto:support@musigod.com" style="color:#C8102E;text-decoration:none">support@musigod.com</a><br>
      Audit ID: <span style="font-family:monospace;color:#444">${escapeHtml(audit.audit_id)}</span>
    </div>
  </div>
</div>
</body>
</html>`

  return sendEmail({
    to: audit.email,
    subject: `Your MusiGod audit findings are almost ready`,
    html,
  })
}

// ── HELPERS ─────────────────────────────────────────────────────────────────

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) throw new Error('Resend not configured or no recipient')
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Resend failed ${res.status}: ${body.slice(0, 200)}`)
  }
}

async function sbGet(path, schema) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Supabase GET failed: ${res.status} ${text.slice(0, 200)}`)
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
    throw new Error(`Supabase PATCH failed: ${res.status} ${text.slice(0, 200)}`)
  }
}

function escapeHtml(v) {
  return String(v || '').trim()
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
