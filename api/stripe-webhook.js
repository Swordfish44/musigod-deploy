const crypto = require('crypto')
const entitlement = require('../lib/paid-entitlement')
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

  if (!event?.id || !event?.type) return res.status(400).json({ error: 'Invalid event' })

  let result = null
  try {
    // Step 1 (idempotency): a verified event already recorded is never re-applied.
    if (await stripeEventAlreadyProcessed(event.id)) {
      console.info('STRIPE_WEBHOOK_DUPLICATE', { stripeEventId: event.id, stripeEventType: event.type })
      return res.status(200).json({ received: true, duplicate: true })
    }
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
      await safeLogAuditEvent({
        audit_id: event.data.object?.metadata?.audit_id || null,
        event_type: 'webhook_received',
        severity: 'info',
        source_system: 'stripe',
        correlation_id: requestId,
        payload: { stripe_event_id: event.id, stripe_event_type: event.type },
      })
      log('info', 'STRIPE_WEBHOOK_RECEIVED', { request_id: requestId, stripe_event_id: event.id, stripe_event_type: event.type })
      result = await handleCheckoutComplete(event.data.object, requestId, event)
    } else if (event.type === 'customer.subscription.created') {
      result = await handleSubscriptionCreated(event.data.object, event)
    } else if (event.type === 'customer.subscription.updated') {
      result = await handleSubscriptionUpdated(event.data.object, event)
    } else if (event.type === 'customer.subscription.deleted') {
      result = await handleSubscriptionDeleted(event.data.object, event)
    } else if (event.type === 'invoice.paid') {
      result = await handleInvoicePaid(event.data.object, event)
    } else if (event.type === 'invoice.payment_failed' || event.type === 'invoice.payment_action_required') {
      result = await handleInvoicePaymentFailed(event.data.object, event)
    } else if (event.type === 'charge.refunded') {
      result = await handleChargeRefunded(event.data.object, event)
    } else {
      console.info('Stripe webhook ignored event', { eventType: event.type, eventId: event.id })
    }
    // Final step: receipt written only after successful handling, so a
    // failed delivery is always reprocessed on Stripe's retry.
    await recordStripeEvent(event, result)
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

async function handleCheckoutComplete(session, requestId, event = {}) {
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
    return { handled: true, kind: 'rights_audit_unlock' }
  }
  if (!artistId) {
    console.info('Checkout session completed without artist_id; registration update skipped', {
      stripe_session_id: session.id,
      plan: clean(plan) || null,
      product_type: clean(productType) || null,
    })
    return { handled: false }
  }

  if (!isPaidCheckout(session)) {
    console.info('Subscription checkout completed without confirmed payment; activation skipped', {
      stripe_session_id: session.id,
      payment_status: session.payment_status || null,
    })
    return { handled: false, artistId, reason: 'payment_not_confirmed' }
  }

  if (session.mode !== 'subscription' || !session.subscription) {
    console.warn('Paid artist checkout is not a subscription; entitlement unchanged', { stripe_session_id: session.id, mode: session.mode || null })
    return { handled: false, artistId, reason: 'not_subscription_checkout' }
  }

  return syncSubscriptionState(artistId, {
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    plan_status: 'ACTIVE',
    plan_type: plan,
  }, event, { clientReferenceId: session.client_reference_id || null })
}

function isPaidCheckout(session) {
  return session.payment_status === 'paid' || session.payment_status === 'no_payment_required'
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

async function handleSubscriptionCreated(subscription, event) {
  return handleSubscriptionStatus(subscription, event)
}

async function handleSubscriptionUpdated(subscription, event) {
  return handleSubscriptionStatus(subscription, event)
}

// A subscription status only changes entitlement when it is definitive.
// Stripe Checkout emits `incomplete` before the first payment settles, and
// `trialing`/`paused` carry no verified payment — none of these may activate
// an artist or be written into the plan_status enum (CHECK violation -> 500
// -> Stripe retry storm, and a late `incomplete` would revert a paid artist).
async function handleSubscriptionStatus(subscription, event) {
  const artistId = subscription.metadata?.artist_id || await artistIdByCustomer(subscription.customer)
  if (!artistId) return { handled: false }
  const planStatus = normalizeSubscriptionStatus(subscription.status)
  if (!planStatus) {
    console.info('Stripe subscription status is not definitive; entitlement unchanged', {
      stripe_subscription_id: subscription.id || null,
      stripe_status: subscription.status || null,
    })
    return { handled: false, artistId, reason: `non_definitive_status:${subscription.status || 'unknown'}` }
  }
  return syncSubscriptionState(artistId, {
    stripe_customer_id: subscription.customer || undefined,
    stripe_subscription_id: subscription.id,
    plan_status: planStatus,
    plan_type: subscription.metadata?.plan || undefined,
  }, event)
}

async function handleSubscriptionDeleted(subscription, event) {
  const artistId = subscription.metadata?.artist_id || await artistIdByCustomer(subscription.customer)
  if (!artistId) return { handled: false }
  return syncSubscriptionState(artistId, {
    plan_status: 'SUSPENDED',
  }, event)
}

async function handleInvoicePaid(invoice, event) {
  const artistId = invoiceArtistId(invoice) || await artistIdByCustomer(invoice.customer)
  if (!artistId) return { handled: false }
  return syncSubscriptionState(artistId, {
    stripe_customer_id: invoice.customer || undefined,
    stripe_subscription_id: invoiceSubscriptionId(invoice) || undefined,
    plan_status: 'ACTIVE',
    plan_type: invoicePlan(invoice) || undefined,
  }, event)
}

async function handleInvoicePaymentFailed(invoice, event) {
  const artistId = invoiceArtistId(invoice) || await artistIdByCustomer(invoice.customer)
  if (!artistId) return { handled: false }
  return syncSubscriptionState(artistId, {
    stripe_customer_id: invoice.customer || undefined,
    stripe_subscription_id: invoiceSubscriptionId(invoice) || undefined,
    plan_status: 'PAST_DUE',
    plan_type: invoicePlan(invoice) || undefined,
  }, event)
}

async function handleChargeRefunded(charge, event) {
  const isFullRefund = charge.refunded === true || (
    Number.isFinite(charge.amount) && Number.isFinite(charge.amount_refunded) &&
    charge.amount > 0 && charge.amount_refunded >= charge.amount
  )
  if (!isFullRefund) {
    console.info('Partial refund received; entitlement unchanged pending operations review', {
      stripe_charge_id: charge.id || null,
      amount: charge.amount || null,
      amount_refunded: charge.amount_refunded || null,
    })
    return { handled: false, reason: 'partial_refund' }
  }
  const artistId = charge.metadata?.artist_id || await artistIdByCustomer(charge.customer)
  if (!artistId) return { handled: false }
  return syncSubscriptionState(artistId, {
    stripe_customer_id: charge.customer || undefined,
    plan_status: 'SUSPENDED',
  }, event)
}

function invoiceArtistId(invoice) {
  return invoice.subscription_details?.metadata?.artist_id ||
    invoice.parent?.subscription_details?.metadata?.artist_id ||
    invoice.metadata?.artist_id || null
}

function invoiceSubscriptionId(invoice) {
  return invoice.subscription || invoice.parent?.subscription_details?.subscription || null
}

function invoicePlan(invoice) {
  return invoice.subscription_details?.metadata?.plan ||
    invoice.parent?.subscription_details?.metadata?.plan ||
    invoice.metadata?.plan || null
}

// Chain for every entitlement-changing Stripe event (signature and the
// idempotency ledger were already checked by the handler):
//   bind event -> artist  ->  record payment (payment_accounts_v1 upsert)
//   ->  agreement check + guarded activation + audit (lib/paid-entitlement)
async function syncSubscriptionState(artistId, data, event = {}, context = {}) {
  const binding = await verifyArtistBinding(artistId, {
    clientReferenceId: context.clientReferenceId,
    customerId: data.stripe_customer_id,
  })
  if (!binding.ok) {
    const err = new Error(`Stripe event not bound to artist: ${binding.reason}`)
    console.error('STRIPE_ARTIST_BINDING_REJECTED', { stripe_event_id: event.id || null, artist_id: artistId, reason: binding.reason })
    captureException(err, { route: 'stripe-webhook', stage: 'artist-binding', stripeEventId: event.id, reason: binding.reason })
    // Not retryable: record the receipt (by returning) and change nothing.
    return { handled: false, artistId, reason: `binding_rejected:${binding.reason}` }
  }

  await recordPaymentAccount(binding.artist, data, event)

  // The DB refuses plan_status=ACTIVE until the Publishing Administration
  // Agreement is signed. A paid-but-unsigned artist is recorded as
  // PAID_AWAITING_AGREEMENT instead of failing the webhook.
  let effectiveStatus = data.plan_status
  if (data.plan_status === 'ACTIVE') {
    effectiveStatus = await entitlement.activateOrHoldForAgreement({
      artistId,
      plan: data.plan_type,
      provider: 'stripe',
      subscriptionId: data.stripe_subscription_id,
      evidence: { customerId: data.stripe_customer_id, eventId: event.id, eventType: event.type },
    })
  }
  const registrationData = compact({ ...data, plan_status: effectiveStatus })
  const artistData = data.plan_status === 'ACTIVE' ? {} : compact({
    plan_status: data.plan_status,
    plan_tier: data.plan_type ? String(data.plan_type).toUpperCase() : undefined,
  })

  await Promise.all([
    sbPatch(`registrations_v1?artist_id=eq.${encodeURIComponent(artistId)}`, registrationData),
    Object.keys(artistData).length
      ? sbPatchWithSchema('artists', `artists_v1?id=eq.${encodeURIComponent(artistId)}`, artistData)
      : Promise.resolve(),
  ])
  return {
    handled: true,
    artistId,
    status: effectiveStatus,
    customerId: data.stripe_customer_id || null,
    subscriptionId: data.stripe_subscription_id || null,
    plan: data.plan_type || null,
  }
}

// Idempotency ledger (registrations.payment_event_receipts_v1, shared with the
// PayPal rail). Fails closed: if the ledger is unreachable the webhook returns
// 500 and Stripe retries, rather than applying a payment it cannot record.
async function stripeEventAlreadyProcessed(eventId) {
  const res = await fetch(
    `${SB_URL}/rest/v1/payment_event_receipts_v1?provider=eq.stripe&provider_event_id=eq.${encodeURIComponent(eventId)}&select=provider_event_id&limit=1`,
    { headers: sbReadHeaders() }
  )
  if (!res.ok) throw new Error(`Payment event lookup failed: ${res.status}`)
  const rows = await res.json()
  return Array.isArray(rows) && rows.some(row => row?.provider_event_id === eventId)
}

async function recordStripeEvent(event, result) {
  const res = await fetch(`${SB_URL}/rest/v1/payment_event_receipts_v1`, {
    method: 'POST',
    headers: sbWriteHeaders('registrations', { Prefer: 'resolution=ignore-duplicates,return=minimal' }),
    body: JSON.stringify({
      provider: 'stripe',
      provider_event_id: event.id,
      event_type: event.type,
      artist_id: result?.artistId || null,
      occurred_at: Number.isFinite(event.created) ? new Date(event.created * 1000).toISOString() : null,
      payload: {
        handled: Boolean(result?.handled),
        livemode: event.livemode ?? null,
        provider_customer_id: result?.customerId || null,
        provider_subscription_id: result?.subscriptionId || null,
        plan_code: result?.plan || null,
        status: result?.status || null,
        reason: result?.reason || null,
      },
    }),
  })
  if (!res.ok) throw new Error(`Payment event receipt failed: ${res.status}`)
}

// The event must resolve to exactly one existing artist:
//  - Checkout's client_reference_id (set server-side) must equal metadata.artist_id
//  - the artist must exist in artists.artists_v1
//  - a Stripe customer already bound to a different artist is refused
async function verifyArtistBinding(artistId, { clientReferenceId, customerId } = {}) {
  if (!artistId) return { ok: false, reason: 'missing_artist_id' }
  if (clientReferenceId && clientReferenceId !== artistId) return { ok: false, reason: 'client_reference_mismatch' }
  const artists = await sbGetWithSchema('artists', `artists_v1?id=eq.${encodeURIComponent(artistId)}&select=id,plan_tier,plan_status&limit=1`)
  const artist = Array.isArray(artists) ? artists.find(row => row?.id === artistId) : null
  if (!artist) return { ok: false, reason: 'artist_not_found' }
  if (customerId) {
    const owners = await sbGetWithSchema('registrations', `registrations_v1?stripe_customer_id=eq.${encodeURIComponent(customerId)}&select=artist_id&limit=5`)
    const others = (owners || []).filter(row => row?.artist_id && row.artist_id !== artistId)
    if (others.length) return { ok: false, reason: 'customer_bound_to_other_artist' }
  }
  return { ok: true, artist }
}

// Authoritative Stripe payment record, recorded BEFORE any entitlement change.
// Upsert keyed on (provider, provider_subscription_id) is idempotent.
async function recordPaymentAccount(artist, data, event) {
  const subscriptionId = data.stripe_subscription_id
  if (!subscriptionId) return
  const plan = String(data.plan_type || artist.plan_tier || '').toLowerCase() || 'unknown'
  const status = data.plan_status
  const primaries = await sbGetWithSchema('registrations', `payment_accounts_v1?artist_id=eq.${encodeURIComponent(artist.id)}&is_primary=eq.true&select=provider_subscription_id,status&limit=1`)
  const current = Array.isArray(primaries) ? primaries.find(row => row && 'provider_subscription_id' in row) || null : null
  const isPrimary = !current || current.provider_subscription_id === subscriptionId || status === 'ACTIVE' || current.status !== 'ACTIVE'
  if (isPrimary && current && current.provider_subscription_id !== subscriptionId) {
    await sbPatchWithSchema('registrations', `payment_accounts_v1?artist_id=eq.${encodeURIComponent(artist.id)}&is_primary=eq.true`, { is_primary: false, updated_at: new Date().toISOString() })
  }
  const res = await fetch(`${SB_URL}/rest/v1/payment_accounts_v1?on_conflict=provider,provider_subscription_id`, {
    method: 'POST',
    headers: sbWriteHeaders('registrations', { Prefer: 'resolution=merge-duplicates,return=minimal' }),
    body: JSON.stringify({
      artist_id: artist.id,
      provider: 'stripe',
      provider_customer_id: data.stripe_customer_id || null,
      provider_subscription_id: subscriptionId,
      plan_code: plan,
      status,
      is_primary: isPrimary,
      metadata: { last_event_id: event.id || null, last_event_type: event.type || null, livemode: event.livemode ?? null },
      updated_at: new Date().toISOString(),
    }),
  })
  if (!res.ok) throw new Error(`Payment account upsert failed: ${res.status}`)
}

function sbWriteHeaders(schema, extra = {}) {
  return {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    'Accept-Profile': schema,
    'Content-Profile': schema,
    ...extra,
  }
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== ''))
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
    <p>Hi ${artistName},</p>
    <p><strong>Payment confirmed. Your MusiGod Rights Audit is unlocked.</strong></p>
    <p><strong>Audit ID:</strong> <code>${escapeHtml(auditId)}</code></p>
    <p>MusiGod will begin reviewing your audit within 1 business day. Watch your email for follow-up questions or action items.</p>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(statusUrl)}"
         style="background:#c8102e;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
        View audit status and next steps
      </a>
    </p>
    <p>Or paste this link in your browser:<br><a href="${escapeHtml(statusUrl)}">${escapeHtml(statusUrl)}</a></p>
    <p>Your status page shows: Payment received · Audit unlocked · Current status · What happens next · Estimated turnaround.</p>
    <p>MusiGod will review: missing PRO, publisher, SoundExchange, and neighboring rights registrations; DSP profile claims, YouTube Content ID, metadata, and identifier gaps; publishing, master-rights, and royalty recovery opportunities.</p>
    <p>Reply to this email with distributor, PRO, publishing admin, SoundExchange, or label-access details MusiGod should use. Keep this email for your records.</p>
    <p>Questions? Reply to this email or contact <a href="mailto:support@musigod.com">support@musigod.com</a>.</p>
  `

  logFulfillment('resend_request', {
    audit_id: auditId,
    stripe_session_id: session.id,
    recipient_email: recipientEmail,
    resend_configured: Boolean(RESEND_API_KEY),
    final_redirect_target: statusUrl,
    email_type: 'post_payment_status',
    redirect_target: statusUrl,
    webhook_paid_confirmed: true,
    status_email_sent: true,
  })

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: recipientEmail,
      subject: 'Payment confirmed — your MusiGod Rights Audit is unlocked',
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
  const parts = { v1: [] }
  header.split(',').forEach(p => {
    const idx = p.indexOf('=')
    if (idx <= 0) return
    const key = p.slice(0, idx)
    const value = p.slice(idx + 1)
    if (key === 'v1') parts.v1.push(value)
    else parts[key] = value
  })
  const timestamp = Number(parts.t)
  if (!Number.isFinite(timestamp) || !parts.v1.length) return false
  if (Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 300) return false

  const expected = crypto
    .createHmac('sha256', secret)
    .update(`${parts.t}.${payload}`, 'utf8')
    .digest('hex')

  const expectedBuffer = Buffer.from(expected, 'hex')
  return parts.v1.some(signature => {
    if (!/^[a-f0-9]{64}$/i.test(signature)) return false
    const actual = Buffer.from(signature, 'hex')
    return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer)
  })
}

// Returns a plan_status the DB accepts, or null when the Stripe status is not
// definitive evidence of payment or of a lapse (incomplete, trialing, paused, ...).
function normalizeSubscriptionStatus(status) {
  if (status === 'active') return 'ACTIVE'
  if (status === 'past_due' || status === 'unpaid') return 'PAST_DUE'
  if (status === 'canceled' || status === 'incomplete_expired') return 'SUSPENDED'
  return null
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

module.exports._test = { normalizeSubscriptionStatus, verifyArtistBinding }
