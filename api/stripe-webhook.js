const crypto = require('crypto')
const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <support@musigod.com>'
const RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL = process.env.N8N_RIGHTS_AUDIT_WEBHOOK_URL
const RIGHTS_AUDIT_PLAN_VALUES = new Set(['rights_audit_unlock', 'rights_audit', 'audit_unlock'])

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const rawBody = await getRawBody(req)
  const sig = req.headers['stripe-signature']

  if (!verifySignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error(JSON.stringify({ event: 'webhook_sig_failed', ts: new Date().toISOString() }))
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event
  try {
    event = JSON.parse(rawBody.toString())
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

  console.log(JSON.stringify({
    event: 'webhook_verified',
    stripe_event_type: event.type,
    stripe_event_id: event.id,
    ts: new Date().toISOString(),
  }))

  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutComplete(event.data.object)
    } else if (event.type === 'customer.subscription.created') {
      await handleSubscriptionCreated(event.data.object)
    } else if (event.type === 'customer.subscription.updated') {
      await handleSubscriptionUpdated(event.data.object)
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object)
    } else {
      console.log(JSON.stringify({ event: 'webhook_ignored', stripe_event_type: event.type, stripe_event_id: event.id }))
    }
  } catch (e) {
    console.error(JSON.stringify({ event: 'webhook_handler_error', stripe_event_type: event?.type, stripe_event_id: event?.id, error: e?.message }))
    captureException(e, {
      route: 'stripe-webhook',
      method: req.method,
      path: req.url,
      statusCode: 500,
      stripeEventType: event?.type,
      stripeEventId: event?.id,
    })
    return res.status(500).json({ error: 'Handler failed' })
  }

  console.log(JSON.stringify({ event: 'webhook_200', stripe_event_type: event?.type, stripe_event_id: event?.id }))
  res.status(200).json({ received: true })
}, 'stripe-webhook')

async function handleCheckoutComplete(session) {
  const artistId = session.metadata?.artist_id
  const plan = session.metadata?.plan
  const productType = session.metadata?.product_type

  console.log(JSON.stringify({
    event: 'checkout_complete',
    stripe_session_id: session.id,
    payment_status: session.payment_status,
    mode: session.mode,
    plan: clean(plan) || null,
    product_type: clean(productType) || null,
  }))

  if (isRightsAuditUnlockSession(session)) {
    await handleRightsAuditUnlock(session)
    return
  }
  if (!artistId) {
    console.log(JSON.stringify({ event: 'checkout_complete_no_artist_id', stripe_session_id: session.id, plan: clean(plan) || null }))
    return
  }
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    plan_status: 'ACTIVE',
    plan_type: plan,
  })
}

function isRightsAuditUnlockSession(session) {
  const values = [session.metadata?.plan, session.metadata?.product_type].map(v => clean(v))
  return values.some(v => RIGHTS_AUDIT_PLAN_VALUES.has(v))
}

async function handleRightsAuditUnlock(session) {
  const auditId = clean(session.metadata?.audit_id)
  const sessionId = clean(session.id)

  if (!auditId) {
    const msg = 'Rights audit unlock missing audit_id'
    console.error(JSON.stringify({ event: 'fulfillment_error', stripe_session_id: sessionId, message: msg }))
    throw new Error(msg)
  }
  if (session.payment_status && session.payment_status !== 'paid') {
    console.log(JSON.stringify({ event: 'fulfillment_skipped_not_paid', audit_id: auditId, stripe_session_id: sessionId, payment_status: session.payment_status }))
    return
  }

  console.log(JSON.stringify({ event: 'fulfillment_start', audit_id: auditId, stripe_session_id: sessionId }))

  const existingRows = await sbGetWithSchema(
    'public',
    `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,email,artist_name,paid_status,fulfilled_at,fulfillment_status,next_steps_email_sent_at,n8n_fulfillment_sent_at,n8n_fulfillment_status&limit=1`
  )
  const audit = existingRows?.[0]

  if (!audit) {
    const msg = `Rights audit not found for paid unlock: ${auditId}`
    console.error(JSON.stringify({ event: 'fulfillment_error', audit_id: auditId, stripe_session_id: sessionId, message: msg }))
    throw new Error(msg)
  }

  // IDEMPOTENCY — duplicate webhook guard
  if (audit.fulfilled_at && audit.fulfillment_status === 'FULFILLED') {
    console.log(JSON.stringify({
      event: 'webhook_duplicate_ignored',
      audit_id: auditId,
      stripe_session_id: sessionId,
      fulfilled_at: audit.fulfilled_at,
      reason: 'already_fulfilled',
    }))
    return
  }

  // Partial fulfillment detected — log retry trigger
  const isRetry = !!(audit.paid_status === 'PAID' && audit.fulfillment_status && audit.fulfillment_status !== 'FULFILLED')
  if (isRetry) {
    console.log(JSON.stringify({
      event: 'fulfillment_retry_triggered',
      audit_id: auditId,
      stripe_session_id: sessionId,
      prior_fulfillment_status: audit.fulfillment_status,
      email_already_sent: !!audit.next_steps_email_sent_at,
    }))
  }

  const recipient = resolveRightsAuditRecipient(audit, session)
  if (!recipient) {
    const msg = 'No valid artist email found for paid rights audit fulfillment'
    console.error(JSON.stringify({ event: 'fulfillment_error', audit_id: auditId, stripe_session_id: sessionId, message: msg }))
    await markFulfillmentFailure(auditId, 'FAILED', msg)
    throw new Error(msg)
  }

  const paidAt = session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString()

  // Mark PAID — unblocks audit-status page immediately
  await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
    paid_status: 'PAID',
    paid_at: paidAt,
    stripe_session_id: sessionId,
    stripe_customer_email: recipient,
    fulfillment_status: 'PAYMENT_CONFIRMED',
    fulfillment_error: null,
  })
  console.log(JSON.stringify({ event: 'fulfillment_stage', stage: 'paid_marked', audit_id: auditId, stripe_session_id: sessionId }))

  try {
    // EMAIL — synchronous, must land before 200
    let emailSentAt = audit.next_steps_email_sent_at || null
    if (emailSentAt) {
      console.log(JSON.stringify({ event: 'fulfillment_stage', stage: 'email_skipped_already_sent', audit_id: auditId, stripe_session_id: sessionId, sent_at: emailSentAt }))
    } else {
      await sendRightsAuditNextStepsEmail(audit, session, recipient)
      emailSentAt = new Date().toISOString()
      await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
        next_steps_email_sent_at: emailSentAt,
        fulfillment_status: 'EMAIL_SENT',
      })
      console.log(JSON.stringify({ event: 'fulfillment_stage', stage: 'email_sent', audit_id: auditId, stripe_session_id: sessionId, recipient }))
    }

    // n8n — fire and forget, non-blocking
    fireAndForgetN8n(audit, session, recipient, paidAt, auditId, sessionId)

    // Mark fulfilled
    const fulfilledAt = new Date().toISOString()
    await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
      fulfilled_at: fulfilledAt,
      fulfillment_status: 'FULFILLED',
      fulfillment_error: null,
      next_steps_email_sent_at: emailSentAt,
    })
    console.log(JSON.stringify({
      event: 'fulfillment_complete',
      audit_id: auditId,
      stripe_session_id: sessionId,
      recipient,
      fulfilled_at: fulfilledAt,
      was_retry: isRetry,
    }))
    if (isRetry) {
      console.log(JSON.stringify({ event: 'fulfillment_retry_succeeded', audit_id: auditId, stripe_session_id: sessionId }))
    }

  } catch (err) {
    const msg = safeErrorMessage(err)
    console.error(JSON.stringify({ event: 'fulfillment_error', audit_id: auditId, stripe_session_id: sessionId, message: msg, was_retry: isRetry }))
    if (isRetry) {
      console.error(JSON.stringify({ event: 'fulfillment_retry_failed', audit_id: auditId, stripe_session_id: sessionId, message: msg }))
    }
    await markFulfillmentFailure(auditId, 'FAILED', msg)
    throw err
  }
}

// Fire-and-forget n8n — never blocks fulfillment
function fireAndForgetN8n(audit, session, email, paidAt, auditId, sessionId) {
  if (!RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL) {
    console.log(JSON.stringify({ event: 'n8n_skipped', audit_id: auditId, reason: 'not_configured' }))
    return
  }
  if (audit.n8n_fulfillment_sent_at) {
    console.log(JSON.stringify({ event: 'n8n_skipped', audit_id: auditId, reason: 'already_sent', sent_at: audit.n8n_fulfillment_sent_at }))
    return
  }
  fetch(RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'rights_audit.payment_confirmed',
      audit_id: auditId,
      email,
      paid_status: 'PAID',
      stripe_session_id: sessionId,
      stripe_customer_email: email,
      paid_at: paidAt,
    }),
  })
    .then(r => {
      const ts = new Date().toISOString()
      console.log(JSON.stringify({ event: 'n8n_response', audit_id: auditId, stripe_session_id: sessionId, status: r.status, ok: r.ok }))
      sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
        n8n_fulfillment_sent_at: ts,
        n8n_fulfillment_status: r.ok ? `OK_${r.status}` : `FAILED_${r.status}`,
      }).catch(e => console.error(JSON.stringify({ event: 'n8n_status_update_error', audit_id: auditId, error: e?.message })))
    })
    .catch(err => {
      console.error(JSON.stringify({ event: 'n8n_error', audit_id: auditId, stripe_session_id: sessionId, error: err?.message }))
    })
}

// ── SUBSCRIPTION HANDLERS ───────────────────────────────────────────────────

async function handleSubscriptionCreated(subscription) {
  const artistId = subscription.metadata?.artist_id || await artistIdByCustomer(subscription.customer)
  if (!artistId) return
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    stripe_subscription_id: subscription.id,
    plan_status: normalizeSubscriptionStatus(subscription.status),
    plan_type: subscription.metadata?.plan || undefined,
  })
}

async function handleSubscriptionUpdated(subscription) {
  const artistId = subscription.metadata?.artist_id || await artistIdByCustomer(subscription.customer)
  if (!artistId) return
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    stripe_subscription_id: subscription.id,
    plan_status: normalizeSubscriptionStatus(subscription.status),
    plan_type: subscription.metadata?.plan || undefined,
  })
}

async function handleSubscriptionDeleted(subscription) {
  const artistId = subscription.metadata?.artist_id || await artistIdByCustomer(subscription.customer)
  if (!artistId) return
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, { plan_status: 'SUSPENDED' })
}

async function artistIdByCustomer(customerId) {
  if (!customerId) return null
  const res = await fetch(
    `${SB_URL}/rest/v1/registrations_v1?stripe_customer_id=eq.${customerId}&select=artist_id&limit=1`,
    { headers: sbReadHeaders() }
  )
  const rows = await res.json()
  return rows?.[0]?.artist_id || null
}

// ── EMAIL ───────────────────────────────────────────────────────────────────

async function sendRightsAuditNextStepsEmail(audit, session, email) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured')

  const auditId = clean(audit.audit_id || session.metadata?.audit_id)
  const recipientEmail = clean(email)
  const statusUrl = `https://musigod.com/audit-status.html?audit_id=${encodeURIComponent(auditId)}`
  const artistName = escapeHtml(audit.artist_name || 'artist')

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="background:#080808;color:#e8e8e8;font-family:Arial,sans-serif;margin:0;padding:32px 16px">
<div style="max-width:540px;margin:0 auto;background:#0c0c0c;border:1px solid rgba(200,16,46,0.2);border-radius:8px;overflow:hidden">
  <div style="background:rgba(200,16,46,0.06);border-bottom:1px solid rgba(200,16,46,0.15);padding:20px 32px;display:flex;align-items:center">
    <span style="font-size:24px;font-weight:700;letter-spacing:0.12em;color:#fff">MUSI<span style="color:#C8102E">GOD</span></span>
  </div>
  <div style="padding:32px">
    <div style="width:48px;height:48px;border-radius:50%;background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);display:flex;align-items:center;justify-content:center;font-size:22px;margin-bottom:20px">&#10003;</div>
    <h1 style="font-size:20px;color:#fff;margin:0 0 10px;letter-spacing:0.06em;font-family:Arial,sans-serif">RIGHTS AUDIT UNLOCKED</h1>
    <p style="color:#aaa;font-size:15px;line-height:1.7;margin:0 0 24px">
      Hi ${artistName} — your MusiGod Rights Audit payment is confirmed. Your audit is now active and our team has been notified.
    </p>

    <div style="background:rgba(34,197,94,0.05);border:1px solid rgba(34,197,94,0.18);border-left:3px solid #22c55e;border-radius:5px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#22c55e;letter-spacing:0.06em;font-size:11px;display:block;margin-bottom:8px">&#9989; PAYMENT CONFIRMED</strong>
      Your audit is live and your team is beginning the review process. You'll receive a detailed findings email within <strong style="color:#ddd">3–5 business days</strong>.
    </div>

    <div style="background:rgba(200,16,46,0.04);border:1px solid rgba(200,16,46,0.14);border-radius:5px;padding:14px 18px;margin-bottom:24px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#C8102E;letter-spacing:0.06em;font-size:11px;display:block;margin-bottom:8px">WHAT WE'RE REVIEWING</strong>
      &bull; PRO and publishing registrations<br>
      &bull; SoundExchange and neighboring rights setup<br>
      &bull; DSP profile claims and metadata integrity<br>
      &bull; YouTube Content ID registration<br>
      &bull; Royalty collection gaps and recovery opportunities
    </div>

    <div style="background:rgba(240,160,32,0.04);border:1px solid rgba(240,160,32,0.14);border-radius:5px;padding:14px 18px;margin-bottom:28px;font-size:13px;color:#aaa;line-height:1.7">
      <strong style="color:#f0a020;letter-spacing:0.06em;font-size:11px;display:block;margin-bottom:8px">&#128336; ACTION REQUESTED</strong>
      Reply to this email with any of the following to accelerate your review:<br><br>
      &bull; Distributor name and login (DistroKid, TuneCore, etc.)<br>
      &bull; PRO member ID or login<br>
      &bull; Label or publishing agreement details<br>
      &bull; Release history or catalog spreadsheet<br>
      &bull; Known registration problems or disputes
    </div>

    <table cellpadding="0" cellspacing="0" style="width:100%;margin-bottom:24px">
      <tr>
        <td style="text-align:center">
          <a href="${statusUrl}" style="display:inline-block;background:#C8102E;color:#fff;text-decoration:none;font-size:12px;letter-spacing:0.1em;padding:14px 32px;border-radius:4px;font-weight:700;font-family:Arial,sans-serif">VIEW YOUR AUDIT STATUS &#8594;</a>
        </td>
      </tr>
    </table>

    <div style="border-top:1px solid rgba(255,255,255,0.06);padding-top:20px;font-size:12px;color:#555;line-height:1.7">
      Questions? Reply directly to this email or contact <a href="mailto:support@musigod.com" style="color:#C8102E;text-decoration:none">support@musigod.com</a><br>
      Include your Audit ID for fastest support:<br>
      <span style="font-family:monospace;color:#444;font-size:11px">${escapeHtml(auditId)}</span>
    </div>
  </div>
</div>
</body>
</html>`

  console.log(JSON.stringify({ event: 'resend_request', audit_id: auditId, recipient_email: recipientEmail }))

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: recipientEmail,
      subject: 'Your MusiGod Rights Audit is unlocked — review begins now',
      html,
    }),
  })

  console.log(JSON.stringify({ event: 'resend_response', audit_id: auditId, status: response.status, ok: response.ok }))

  if (!response.ok) {
    const body = await safeJson(response)
    const code = clean(body?.name || body?.error?.code || `HTTP_${response.status}`)
    const message = clean(body?.message || body?.error?.message || `Resend failed ${response.status}`)
    console.error(JSON.stringify({ event: 'resend_failed', audit_id: auditId, status: response.status, code, message }))
    throw new Error(`Resend failed ${response.status}: ${code || message}`)
  }
}

// ── SUPABASE ────────────────────────────────────────────────────────────────

async function sbPatch(path, data) { return sbPatchWithSchema('registrations', path, data) }

async function sbGetWithSchema(schema, path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema },
  })
  const text = await res.text()
  if (!res.ok) {
    console.error(JSON.stringify({ event: 'supabase_get_error', status: res.status, path, body: text.slice(0, 200) }))
    throw new Error(`Supabase GET failed: ${res.status}`)
  }
  return text ? JSON.parse(text) : null
}

async function sbPatchWithSchema(schema, path, data) {
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
    console.error(JSON.stringify({ event: 'supabase_patch_error', status: res.status, path, body: text.slice(0, 200) }))
    throw new Error(`Supabase PATCH failed: ${res.status}`)
  }
}

// ── HELPERS ─────────────────────────────────────────────────────────────────

async function markFulfillmentFailure(auditId, status, message) {
  await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
    fulfillment_status: status, fulfillment_error: message,
  })
}

function resolveRightsAuditRecipient(audit, session) {
  const candidates = [audit?.email, session.metadata?.email, session.customer_details?.email, session.customer_email]
  return candidates.map(v => clean(v).toLowerCase()).find(isEmail) || ''
}

function isEmail(v) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(v)) }
function clean(v) { return String(v || '').trim() }
function escapeHtml(v) {
  return clean(v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;')
}
async function safeJson(r) { try { return await r.json() } catch { return null } }
function safeErrorMessage(err) { return clean(err?.message || String(err)).slice(0, 500) }
function sbReadHeaders() { return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': 'registrations' } }

function verifySignature(payload, header, secret) {
  if (!header || !secret) return false
  const parts = {}
  header.split(',').forEach(p => { const i = p.indexOf('='); parts[p.slice(0,i)] = p.slice(i+1) })
  const { t, v1 } = parts
  if (!t || !v1) return false
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${payload}`, 'utf8').digest('hex')
  const a = Buffer.from(v1, 'hex')
  const b = Buffer.from(expected, 'hex')
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function normalizeSubscriptionStatus(status) {
  if (status === 'active' || status === 'trialing') return 'ACTIVE'
  if (status === 'past_due' || status === 'unpaid') return 'PAST_DUE'
  if (status === 'canceled' || status === 'incomplete_expired') return 'SUSPENDED'
  return String(status || 'PENDING').toUpperCase()
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
