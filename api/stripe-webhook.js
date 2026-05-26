const crypto = require('crypto')
const { captureException, withSentry } = require('./_sentry')
const { STATUS, correlationId, log, safeLogAuditEvent, safeUpsertAuditStatus } = require('./_fulfillment')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <support@musigod.com>'
const RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL = process.env.N8N_RIGHTS_AUDIT_WEBHOOK_URL
const RIGHTS_AUDIT_PLAN_VALUES = new Set(['rights_audit_unlock', 'rights_audit', 'audit_unlock'])

module.exports = withSentry(async function handler(req, res) {
  const requestId = correlationId('stripe_webhook')
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
      await safeLogAuditEvent({
        audit_id: event.data.object?.metadata?.audit_id || null,
        event_type: 'webhook_received',
        severity: 'info',
        source_system: 'stripe',
        correlation_id: requestId,
        payload: { stripe_event_id: event.id, stripe_event_type: event.type },
      })
      log('info', 'STRIPE_WEBHOOK_RECEIVED', { request_id: requestId, stripe_event_id: event.id, stripe_event_type: event.type })
      await handleCheckoutComplete(event.data.object, requestId)
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

  console.info('WEBHOOK_RETURNING_200', {
    stripeEventType: event?.type,
    stripeEventId: event?.id,
  })
  res.status(200).json({ received: true })
}, 'stripe-webhook')

async function handleCheckoutComplete(session, requestId) {
  const artistId = session.metadata?.artist_id
  const plan = session.metadata?.plan
  const productType = session.metadata?.product_type

  console.info('ENTERED_CHECKOUT_COMPLETED', {
    stripe_session_id: session.id,
    payment_status: session.payment_status,
    mode: session.mode,
  })
  console.info('SESSION_METADATA', {
    stripe_session_id: session.id,
    metadata: session.metadata || {},
  })
  console.info('PLAN_VALUE', {
    stripe_session_id: session.id,
    plan: clean(plan) || null,
    product_type: clean(productType) || null,
  })

  if (isRightsAuditUnlockSession(session)) {
    await handleRightsAuditUnlock(session, requestId)
    return
  }
  if (!artistId) {
    console.info('Checkout session completed without artist_id; registration update skipped', {
      stripe_session_id: session.id,
      plan: clean(plan) || null,
      product_type: clean(productType) || null,
    })
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
  const values = [
    session.metadata?.plan,
    session.metadata?.product_type,
  ].map(value => clean(value))
  return values.some(value => RIGHTS_AUDIT_PLAN_VALUES.has(value))
}

async function handleRightsAuditUnlock(session, requestId = correlationId('rights_audit_fulfillment')) {
  const auditId = clean(session.metadata?.audit_id)
  const sessionId = clean(session.id)
  if (!auditId) {
    const message = 'Rights audit unlock missing audit_id'
    console.error('FULFILLMENT_ERROR', {
      stripe_session_id: sessionId,
      message,
    })
    throw new Error(message)
  }
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
  await safeUpsertAuditStatus({
    audit_id: auditId,
    stripe_session_id: sessionId,
    current_status: STATUS.PAID,
    status_message: 'Stripe payment confirmed. Preparing fulfillment.',
    estimated_completion: 'Most paid audits move into review within 1 business day.',
  })
  await safeLogAuditEvent({
    audit_id: auditId,
    event_type: 'checkout_success',
    severity: 'info',
    source_system: 'stripe',
    correlation_id: requestId,
    payload: { stripe_session_id: sessionId, payment_status: session.payment_status || null },
  })

  const existingRows = await sbGetWithSchema(
    'public',
    `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=audit_id,email,artist_name,paid_status,next_steps_email_sent_at,fulfilled_at,n8n_fulfillment_sent_at,n8n_fulfillment_status&limit=1`
  )
  const audit = existingRows?.[0]
  if (!audit) {
    const message = `Rights audit not found for paid unlock: ${auditId}`
    console.error('FULFILLMENT_ERROR', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      message,
    })
    throw new Error(message)
  }
  console.info('AUDIT_LOOKUP_SUCCESS', {
    audit_id: auditId,
    stripe_session_id: sessionId,
    paid_status: audit.paid_status || null,
    fulfillment_status: audit.fulfillment_status || null,
    next_steps_email_sent_at: audit.next_steps_email_sent_at || null,
    fulfilled_at: audit.fulfilled_at || null,
    n8n_fulfillment_status: audit.n8n_fulfillment_status || null,
  })

  const recipient = resolveRightsAuditRecipient(audit, session)
  logFulfillment('recipient_resolved', {
    audit_id: auditId,
    stripe_session_id: sessionId,
    recipient_email: recipient || null,
    recipient_source: recipientSource(audit, session),
  })
  if (!recipient) {
    const message = 'No valid artist email found for paid rights audit fulfillment'
    console.error('FULFILLMENT_ERROR', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      message,
    })
    await markFulfillmentFailure(auditId, 'FAILED', message)
    throw new Error(message)
  }

  const paidAt = session.created ? new Date(session.created * 1000).toISOString() : new Date().toISOString()
  try {
    await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
      paid_status: 'PAID',
      paid_at: paidAt,
      stripe_session_id: sessionId,
      stripe_customer_email: recipient,
      fulfillment_status: audit.next_steps_email_sent_at ? 'EMAIL_SENT' : 'PAYMENT_CONFIRMED',
      fulfillment_error: null,
    })
    await safeUpsertAuditStatus({
      audit_id: auditId,
      email: recipient,
      stripe_session_id: sessionId,
      current_status: STATUS.FULFILLMENT_QUEUED,
      status_message: 'Payment confirmed. Sending next steps and queueing fulfillment.',
      estimated_completion: 'Initial review usually begins within 1 business day.',
      fulfillment_queued_at: new Date().toISOString(),
    })
    await safeLogAuditEvent({
      audit_id: auditId,
      event_type: 'fulfillment_queued',
      severity: 'info',
      source_system: 'fulfillment',
      correlation_id: requestId,
      payload: { stripe_session_id: sessionId, recipient_email: recipient },
    })

    console.info('BEFORE_FULFILLMENT', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      recipient_email: recipient,
      resend_configured: Boolean(RESEND_API_KEY),
      n8n_configured: Boolean(RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL),
    })

    let emailSent = Boolean(audit.next_steps_email_sent_at)
    let emailSentAt = audit.next_steps_email_sent_at || null
    if (emailSent) {
      logFulfillment('email_already_sent', { audit_id: auditId, stripe_session_id: sessionId, recipient_email: recipient })
      await safeLogAuditEvent({
        audit_id: auditId,
        event_type: 'resend_success',
        severity: 'info',
        source_system: 'resend',
        correlation_id: requestId,
        payload: { recipient_email: recipient, status: 'ALREADY_SENT' },
      })
      console.info('FULFILLMENT_EMAIL_SENT', {
        audit_id: auditId,
        stripe_session_id: sessionId,
        recipient_email: recipient,
        next_steps_email_sent_at: emailSentAt,
        status: 'ALREADY_SENT',
      })
      console.info('AFTER_RESEND', {
        audit_id: auditId,
        stripe_session_id: sessionId,
        recipient_email: recipient,
        status: 'ALREADY_SENT',
      })
    } else {
      await sendRightsAuditNextStepsEmail(audit, session, recipient)
      emailSent = true
      emailSentAt = new Date().toISOString()
      await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
        next_steps_email_sent_at: emailSentAt,
        fulfillment_status: 'EMAIL_SENT',
        fulfillment_error: null,
      })
      logFulfillment('email_sent', { audit_id: auditId, stripe_session_id: sessionId, recipient_email: recipient })
      console.info('FULFILLMENT_EMAIL_SENT', {
        audit_id: auditId,
        stripe_session_id: sessionId,
        recipient_email: recipient,
        next_steps_email_sent_at: emailSentAt,
      })
      await safeLogAuditEvent({
        audit_id: auditId,
        event_type: 'unlock_email_sent',
        severity: 'info',
        source_system: 'resend',
        correlation_id: requestId,
        payload: { recipient_email: recipient, next_steps_email_sent_at: emailSentAt },
      })
      console.info('AFTER_RESEND', {
        audit_id: auditId,
        stripe_session_id: sessionId,
        recipient_email: recipient,
        status: 'SENT',
      })
    }

    await safeUpsertAuditStatus({
      audit_id: auditId,
      email: recipient,
      stripe_session_id: sessionId,
      current_status: STATUS.PROCESSING,
      status_message: 'Payment confirmed and next-step email sent. Fulfillment processing is underway.',
      estimated_completion: 'MusiGod reviews paid audits within 1 business day.',
      processing_started_at: new Date().toISOString(),
    })

    const n8nAlreadyOk = audit.n8n_fulfillment_sent_at && String(audit.n8n_fulfillment_status || '').startsWith('OK_')
    const n8nStatus = n8nAlreadyOk
      ? { ok: true, attempted: false, status: audit.n8n_fulfillment_status || 'ALREADY_SENT', message: null }
      : await notifyRightsAuditPaymentConfirmed(audit, session, recipient, paidAt, requestId)
    console.info('AFTER_N8N', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      status: n8nStatus.status,
      ok: n8nStatus.ok,
      attempted: n8nStatus.attempted,
    })

    const fulfilledAt = new Date().toISOString()
    const finalStatus = n8nStatus.ok ? 'FULFILLED' : 'FULFILLED_EMAIL_ONLY'
    await sbPatchWithSchema('public', `rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}`, {
      fulfilled_at: fulfilledAt,
      fulfillment_status: finalStatus,
      fulfillment_error: n8nStatus.ok ? null : n8nStatus.message,
      next_steps_email_sent_at: emailSentAt,
      n8n_fulfillment_sent_at: n8nStatus.ok && n8nStatus.attempted ? fulfilledAt : audit.n8n_fulfillment_sent_at || null,
      n8n_fulfillment_status: n8nStatus.status,
    })

    if (!n8nStatus.ok) {
      await safeUpsertAuditStatus({
        audit_id: auditId,
        email: recipient,
        stripe_session_id: sessionId,
        current_status: STATUS.ACTION_REQUIRED,
        status_message: 'Payment and artist email are complete. Internal automation needs staff attention.',
        estimated_completion: 'MusiGod can continue manually while automation is corrected.',
        last_error: n8nStatus.message,
        n8n_retry_count: Number(audit.n8n_retry_count || 0) + 1,
      })
      await safeLogAuditEvent({
        audit_id: auditId,
        event_type: 'fulfillment_failure',
        severity: 'warn',
        source_system: 'n8n',
        correlation_id: requestId,
        payload: { n8n_status: n8nStatus.status, message: n8nStatus.message },
      })
      console.warn('N8N_FAILURE_NON_FATAL', {
        audit_id: auditId,
        stripe_session_id: sessionId,
        n8n_fulfillment_status: n8nStatus.status,
        fulfillment_error: n8nStatus.message,
      })
    } else {
      await safeUpsertAuditStatus({
        audit_id: auditId,
        email: recipient,
        stripe_session_id: sessionId,
        current_status: STATUS.COMPLETED,
        status_message: 'Payment confirmed, email sent, and fulfillment workflow completed.',
        estimated_completion: 'Review is active. Watch your email for follow-up.',
        completed_at: fulfilledAt,
      })
      await safeLogAuditEvent({
        audit_id: auditId,
        event_type: 'fulfillment_completed',
        severity: 'info',
        source_system: 'fulfillment',
        correlation_id: requestId,
        payload: { n8n_status: n8nStatus.status, email_sent: emailSent },
      })
    }

    console.info('FULFILLMENT_COMPLETE', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      recipient_email: recipient,
      email_sent: emailSent,
      n8n_status: n8nStatus.status,
      fulfillment_status: finalStatus,
    })
    logFulfillment('complete', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      recipient_email: recipient,
      email_sent: emailSent,
      n8n_status: n8nStatus.status,
    })
  } catch (err) {
    const message = safeErrorMessage(err)
    console.error('FULFILLMENT_ERROR', {
      audit_id: auditId,
      stripe_session_id: sessionId,
      message,
    })
    await safeLogAuditEvent({
      audit_id: auditId,
      event_type: message.toLowerCase().includes('resend') ? 'resend_failure' : 'fulfillment_failure',
      severity: 'error',
      source_system: message.toLowerCase().includes('resend') ? 'resend' : 'fulfillment',
      correlation_id: requestId,
      payload: { stripe_session_id: sessionId, message },
    })
    await safeUpsertAuditStatus({
      audit_id: auditId,
      stripe_session_id: sessionId,
      current_status: STATUS.FAILED_RETRYING,
      status_message: 'Fulfillment hit an error and will be reviewed by MusiGod operations.',
      estimated_completion: 'MusiGod operations will retry or complete manually.',
      last_error: message,
    })
    await markFulfillmentFailure(auditId, 'FAILED', message)
    throw err
  }
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

  const auditId = clean(audit.audit_id || session.metadata?.audit_id)
  const recipientEmail = clean(email)
  const statusUrl = buildRightsAuditStatusUrl(auditId, session)
  const artistName = escapeHtml(audit.artist_name || 'artist')
  const html = `
    <p><strong>Payment received. Your MusiGod Rights Audit has started.</strong></p>
    <p><strong>Audit ID:</strong> ${escapeHtml(auditId)}</p>
    <p><strong>Next step:</strong> use the link below to check status and unlock the next steps for your paid audit.</p>
    <p><a href="${escapeHtml(statusUrl)}">Check your audit status and next steps</a></p>
    <p><strong>Turnaround:</strong> MusiGod begins paid audit review within 1 business day. Watch your email for follow-up questions or action items.</p>
    <p>Reply to this email with distributor, PRO, publishing admin, SoundExchange, or label-access details MusiGod should use to verify missing registrations and royalty recovery opportunities.</p>
    <p>MusiGod will review missing registrations, DSP claim issues, publishing gaps, neighboring rights problems, recovery opportunities, and your action plan.</p>
    <p>Keep this email for your records. If anything looks wrong, reply to this email or contact support.</p>
    <p>Artist: ${artistName}</p>
  `

  logFulfillment('resend_request', {
    audit_id: auditId,
    stripe_session_id: session.id,
    recipient_email: recipientEmail,
    resend_configured: Boolean(RESEND_API_KEY),
    final_redirect_target: statusUrl,
  })

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: recipientEmail,
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
  return { ok: true, status: response.status }
}

function buildRightsAuditStatusUrl(auditId, session) {
  const fallback = new URL('https://musigod.com/audit-status')
  fallback.searchParams.set('id', auditId)
  if (session.id) fallback.searchParams.set('session_id', session.id)

  try {
    const successUrl = clean(session.success_url)
    if (!successUrl) return fallback.toString()
    const url = new URL(successUrl)
    if (!url.pathname.includes('/audit-status')) return fallback.toString()
    url.searchParams.set('id', auditId)
    if (session.id) url.searchParams.set('session_id', session.id)
    return url.toString()
  } catch {
    return fallback.toString()
  }
}

async function notifyRightsAuditPaymentConfirmed(audit, session, email, paidAt, requestId) {
  console.info('N8N_URL_CONFIGURED', {
    configured: Boolean(RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL),
  })

  if (!RIGHTS_AUDIT_PAYMENT_WEBHOOK_URL) {
    logFulfillment('n8n_skipped', {
      audit_id: audit.audit_id || session.metadata?.audit_id,
      stripe_session_id: session.id,
      n8n_configured: false,
    })
    await safeLogAuditEvent({
      audit_id: audit.audit_id || session.metadata?.audit_id,
      event_type: 'n8n_dispatch_skipped',
      severity: 'warn',
      source_system: 'n8n',
      correlation_id: requestId,
      payload: { reason: 'N8N_RIGHTS_AUDIT_WEBHOOK_URL missing' },
    })
    return { ok: true, attempted: false, status: 'NOT_CONFIGURED', message: null }
  }

  try {
    await safeLogAuditEvent({
      audit_id: audit.audit_id || session.metadata?.audit_id,
      event_type: 'n8n_dispatch',
      severity: 'info',
      source_system: 'n8n',
      correlation_id: requestId,
      payload: { stripe_session_id: session.id },
    })
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
        status_url: buildRightsAuditStatusUrl(audit.audit_id || session.metadata?.audit_id || '', session),
        correlation_id: requestId,
      }),
    })
    console.info('N8N_RESPONSE_STATUS', {
      audit_id: audit.audit_id || session.metadata?.audit_id,
      stripe_session_id: session.id,
      status: response.status,
      ok: response.ok,
    })
    logFulfillment('n8n_response', {
      audit_id: audit.audit_id || session.metadata?.audit_id,
      stripe_session_id: session.id,
      status: response.status,
      ok: response.ok,
    })
    if (!response.ok) {
      await safeLogAuditEvent({
        audit_id: audit.audit_id || session.metadata?.audit_id,
        event_type: 'n8n_retry',
        severity: 'warn',
        source_system: 'n8n',
        correlation_id: requestId,
        payload: { stripe_session_id: session.id, status: response.status },
      })
      console.warn('N8N_FAILURE_NON_FATAL', {
        audit_id: audit.audit_id || session.metadata?.audit_id,
        stripe_session_id: session.id,
        status: response.status,
      })
      return { ok: false, attempted: true, status: `FAILED_${response.status}`, message: `n8n webhook failed: ${response.status}` }
    }
    await safeLogAuditEvent({
      audit_id: audit.audit_id || session.metadata?.audit_id,
      event_type: 'n8n_dispatch_success',
      severity: 'info',
      source_system: 'n8n',
      correlation_id: requestId,
      payload: { stripe_session_id: session.id, status: response.status },
    })
    return { ok: true, attempted: true, status: `OK_${response.status}`, message: null }
  } catch (err) {
    const message = safeErrorMessage(err)
    console.warn('n8n rights audit payment webhook error:', message)
    console.warn('N8N_FAILURE_NON_FATAL', {
      audit_id: audit.audit_id || session.metadata?.audit_id,
      stripe_session_id: session.id,
      status: 'FAILED',
      message,
    })
    await safeLogAuditEvent({
      audit_id: audit.audit_id || session.metadata?.audit_id,
      event_type: 'n8n_retry',
      severity: 'warn',
      source_system: 'n8n',
      correlation_id: requestId,
      payload: { stripe_session_id: session.id, message },
    })
    return { ok: false, attempted: true, status: 'FAILED', message }
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
