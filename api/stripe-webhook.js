const crypto = require('crypto')
const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <support@musigod.com>'
const RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL = process.env.N8N_RIGHTS_AUDIT_WEBHOOK_URL || process.env.RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const rawBody = await getRawBody(req)
  const sig = req.headers['stripe-signature']

  if (!verifySignature(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET)) {
    console.error('Stripe signature verification failed')
    return res.status(400).json({ error: 'Invalid signature' })
  }

  let event
  try {
    event = JSON.parse(rawBody.toString())
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' })
  }

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
      console.info('Stripe webhook ignored event', { eventType: event.type, eventId: event.id })
    }
  } catch (e) {
    console.error('Webhook handler error:', e)
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

  res.status(200).json({ received: true })
}, 'stripe-webhook')

async function handleCheckoutComplete(session) {
  const artistId = session.metadata?.artist_id
  const plan = session.metadata?.plan
  const productType = session.metadata?.product_type

  if (productType === 'rights_audit_unlock' || plan === 'rights_audit_unlock') {
    await handleRightsAuditUnlock(session)
    return
  }
  if (!artistId) return

  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    plan_status: 'ACTIVE',
    plan_type: plan,
  })
}

async function handleRightsAuditUnlock(session) {
  const auditId = clean(session.metadata?.audit_id)
  const sessionId = clean(session.id)
  if (!auditId) throw new Error('Rights audit unlock missing audit_id')
  if (session.payment_status && session.payment_status !== 'paid') {
    console.info('Rights audit checkout not paid; fulfillment skipped', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      payment_status: session.payment_status,
    })
    return
  }

  logFulfillment('started', {
    audit_id: auditId,
    stripe_session_id: sessionId,
    resend_configured: Boolean(RESEND_API_KEY),
    n8n_configured: Boolean(RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL),
  })

  const existingRows = await sbGetWithSchema(
    'public',
    `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,email,artist_name,paid_status,next_steps_email_sent_at,fulfilled_at,n8n_fulfillment_sent_at,n8n_fulfillment_status&limit=1`
  )
  const audit = existingRows?.[0]
  if (!audit) throw new Error(`Rights audit not found for paid unlock: ${auditId}`)

  const recipient = resolveRightsAuditRecipient(audit, session)
  logFulfillment('recipient_resolved', {
    audit_id: auditId,
    stripe_session_id: sessionId,
    recipient_email: recipient || null,
    recipient_source: recipientSource(audit, session),
  })
  if (!recipient) {
    await markFulfillmentFailure(auditId, 'EMAIL_FAILED', 'No valid artist email found for paid rights audit fulfillment')
    throw new Error('No valid artist email found for paid rights audit fulfillment')
  }

  const paidAt = session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString()
  await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
    paid_status: 'PAID',
    paid_at: paidAt,
    stripe_session_id: sessionId,
    stripe_customer_email: recipient,
    fulfillment_status: audit.next_steps_email_sent_at ? 'EMAIL_SENT' : 'PAYMENT_CONFIRMED',
    fulfillment_error: null,
  })

  let emailSent = Boolean(audit.next_steps_email_sent_at)
  if (emailSent) {
    logFulfillment('email_already_sent', { audit_id: auditId, stripe_session_id: sessionId, recipient_email: recipient })
  } else {
    try {
      await sendRightsAuditNextStepsEmail(audit, session, recipient)
      emailSent = true
      const sentAt = new Date().toISOString()
      await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
        next_steps_email_sent_at: sentAt,
        fulfillment_status: 'EMAIL_SENT',
        fulfillment_error: null,
      })
      logFulfillment('email_sent', { audit_id: auditId, stripe_session_id: sessionId, recipient_email: recipient })
    } catch (err) {
      const message = safeErrorMessage(err)
      await markFulfillmentFailure(auditId, 'EMAIL_FAILED', message)
      throw err
    }
  }

  const n8nStatus = audit.n8n_fulfillment_sent_at
    ? { ok: true, attempted: false, status: audit.n8n_fulfillment_status || 'ALREADY_SENT', message: null }
    : await notifyRightsAuditPaymentConfirmed(audit, session, recipient, paidAt)
  const fulfilledAt = new Date().toISOString()
  await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
    fulfilled_at: fulfilledAt,
    fulfillment_status: n8nStatus.ok ? 'FULFILLED' : 'EMAIL_SENT_N8N_WARNING',
    fulfillment_error: n8nStatus.ok ? null : n8nStatus.message,
    n8n_fulfillment_sent_at: n8nStatus.attempted ? fulfilledAt : audit.n8n_fulfillment_sent_at || null,
    n8n_fulfillment_status: n8nStatus.status,
  })

  logFulfillment('complete', {
    audit_id: auditId,
    stripe_session_id: sessionId,
    recipient_email: recipient,
    email_sent: emailSent,
    n8n_status: n8nStatus.status,
  })
}

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
  await sbPatch(`registrations_v1?artist_id=eq.${artistId}`, {
    plan_status: 'SUSPENDED',
  })
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

async function sbPatch(path, data) {
  return sbPatchWithSchema('registrations', path, data)
}

async function sbGetWithSchema(schema, path) {
  const res = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'GET',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
  })
  const text = await res.text()
  if (!res.ok) {
    console.error('Supabase GET error:', res.status, text)
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
    console.error('Supabase PATCH error:', res.status, text)
    throw new Error(`Supabase PATCH failed: ${res.status}`)
  }
}

async function sendRightsAuditNextStepsEmail(audit, session, email) {
  if (!RESEND_API_KEY) throw new Error('RESEND_API_KEY is not configured')

  const auditId = audit.audit_id || session.metadata?.audit_id
  const unlockUrl = `https://musigod.com/rights-audit.html?audit_id=${encodeURIComponent(auditId)}&email=${encodeURIComponent(email)}&unlock=success`
  const artistName = escapeHtml(audit.artist_name || 'artist')
  const html = `
    <p>Your full MusiGod Rights Audit has been unlocked.</p>
    <p><strong>Audit ID:</strong> ${escapeHtml(auditId)}</p>
    <p>Next step: open your audit link below and reply to this email with any distributor, PRO, publishing admin, SoundExchange, or label-access details MusiGod should use to verify missing registrations and royalty recovery opportunities.</p>
    <p><a href="${unlockUrl}">Open your unlocked MusiGod Rights Audit</a></p>
    <p>MusiGod will review your catalog for missing registrations, DSP claim issues, publishing gaps, neighboring rights problems, recovery opportunities, and your action plan.</p>
    <p>Artist: ${artistName}</p>
  `

  logFulfillment('resend_request', {
    audit_id: auditId,
    stripe_session_id: session.id,
    recipient_email: email,
    resend_configured: Boolean(RESEND_API_KEY),
  })

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: email,
      subject: 'Your MusiGod Rights Audit next steps',
      html,
    }),
  })

  logFulfillment('resend_response', {
    audit_id: auditId,
    stripe_session_id: session.id,
    status: response.status,
    ok: response.ok,
  })

  if (!response.ok) {
    const body = await safeJson(response)
    const code = clean(body?.name || body?.error?.code || body?.code || `HTTP_${response.status}`)
    const message = clean(body?.message || body?.error?.message || `Resend request failed with status ${response.status}`)
    console.error('Resend rights audit email failed:', { status: response.status, code, message })
    throw new Error(`Resend failed ${response.status}: ${code || message}`)
  }
}

async function notifyRightsAuditPaymentConfirmed(audit, session, email, paidAt) {
  if (!RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL) {
    logFulfillment('n8n_skipped', {
      audit_id: audit.audit_id || session.metadata?.audit_id,
      stripe_session_id: session.id,
      n8n_configured: false,
    })
    return { ok: true, attempted: false, status: 'NOT_CONFIGURED', message: null }
  }

  try {
    const response = await fetch(RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        event: 'rights_audit.payment_confirmed',
        audit_id: audit.audit_id || session.metadata?.audit_id,
        email,
        paid_status: 'PAID',
        stripe_session_id: session.id,
        stripe_customer_email: email,
        paid_at: paidAt,
      }),
    })
    logFulfillment('n8n_response', {
      audit_id: audit.audit_id || session.metadata?.audit_id,
      stripe_session_id: session.id,
      status: response.status,
      ok: response.ok,
    })
    if (!response.ok) {
      return { ok: false, attempted: true, status: `FAILED_${response.status}`, message: `n8n webhook failed: ${response.status}` }
    }
    return { ok: true, attempted: true, status: `OK_${response.status}`, message: null }
  } catch (err) {
    const message = safeErrorMessage(err)
    console.warn('n8n rights audit payment webhook error:', message)
    return { ok: false, attempted: true, status: 'ERROR', message }
  }
}

async function markFulfillmentFailure(auditId, status, message) {
  await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
    fulfillment_status: status,
    fulfillment_error: message,
  })
}

function resolveRightsAuditRecipient(audit, session) {
  const candidates = [
    audit?.email,
    session.metadata?.email,
    session.customer_details?.email,
    session.customer_email,
  ]
  return candidates.map(value => clean(value).toLowerCase()).find(isEmail) || ''
}

function recipientSource(audit, session) {
  if (isEmail(clean(audit?.email))) return 'audit.email'
  if (isEmail(clean(session.metadata?.email))) return 'session.metadata.email'
  if (isEmail(clean(session.customer_details?.email))) return 'session.customer_details.email'
  if (isEmail(clean(session.customer_email))) return 'session.customer_email'
  return 'none'
}

function isEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean(value))
}

function logFulfillment(checkpoint, data) {
  console.info('rights_audit_fulfillment', {
    checkpoint,
    ...data,
  })
}

async function safeJson(response) {
  try {
    return await response.json()
  } catch {
    return null
  }
}

function safeErrorMessage(err) {
  return clean(err?.message || String(err)).slice(0, 500)
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function clean(value) {
  return String(value || '').trim()
}

function sbReadHeaders() {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Accept-Profile': 'registrations',
  }
}

function verifySignature(payload, header, secret) {
  if (!header || !secret) return false
  const parts = {}
  header.split(',').forEach(p => {
    const idx = p.indexOf('=')
    parts[p.slice(0, idx)] = p.slice(idx + 1)
  })
  const { t, v1 } = parts
  if (!t || !v1) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${t}.${payload}`, 'utf8')
    .digest('hex')

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
