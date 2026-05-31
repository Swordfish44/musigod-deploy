const { captureException, withSentry } = require('./_sentry')
const { STATUS, correlationId, log, safeLogAuditEvent, safeUpsertAuditStatus } = require('./_fulfillment')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const RESEND_API_KEY = process.env.RESEND_API_KEY
const OPS_EMAIL = process.env.OPS_EMAIL || process.env.VA_EMAIL || 'support@musigod.com'
const FROM_EMAIL = process.env.FROM_EMAIL || 'MusiGod <noreply@musigod.com>'
const RIGHTS_AUDIT_WEBHOOK_URL = process.env.RIGHTS_AUDIT_WEBHOOK_URL || 'https://musigod-n8n.onrender.com/webhook/rights-audit-started'

module.exports = withSentry(async function handler(req, res) {
  const requestId = correlationId('rights_audit_start')
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key is not configured' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ error: 'Invalid request body' })
  }

  const payload = normalizePayload(body, req)
  const validationError = validate(payload)
  if (validationError) return res.status(400).json({ error: validationError })

  try {
    // Step 1: Create audit record
    const audit = await createAudit(payload)
    log('info', 'RIGHTS_AUDIT_CREATED', {
      request_id: requestId,
      audit_id: audit.audit_id,
      artist_email: payload.email,
    })

    await safeUpsertAuditStatus({
      audit_id: audit.audit_id,
      email: payload.email,
      current_status: STATUS.PENDING_PAYMENT,
      status_message: 'Audit request received. Payment is required to unlock full review.',
      estimated_completion: 'Payment unlocks the next-step review queue.',
    })

    await safeLogAuditEvent({
      audit_id: audit.audit_id,
      event_type: 'audit_intake_created',
      severity: 'info',
      source_system: 'api',
      correlation_id: requestId,
      payload: { email: payload.email, artist_name: payload.artist_name },
    })

    // Step 2: Create Stripe checkout session immediately
    const baseUrl = resolveBaseUrl(req)
    let checkoutUrl = null
    let stripeSessionId = null
    let checkoutError = null

    try {
      const { url, sessionId } = await createStripeCheckoutSession({
        auditId: audit.audit_id,
        email: payload.email,
        baseUrl,
        requestId,
      })
      checkoutUrl = url
      stripeSessionId = sessionId
      log('info', 'RIGHTS_AUDIT_CHECKOUT_SESSION_CREATED', {
        request_id: requestId,
        audit_id: audit.audit_id,
        artist_email: payload.email,
        stripe_session_id: stripeSessionId,
        checkout_url_present: Boolean(checkoutUrl),
        redirect_target: `${baseUrl}/audit-status?id=${encodeURIComponent(audit.audit_id)}&session_id=${stripeSessionId}`,
        email_type: 'pre_payment_payment_required',
      })

      await safeUpsertAuditStatus({
        audit_id: audit.audit_id,
        email: payload.email,
        stripe_session_id: stripeSessionId,
        current_status: STATUS.PENDING_PAYMENT,
        status_message: 'Checkout session created. Awaiting Stripe payment confirmation.',
        estimated_completion: 'Payment confirmation usually posts within one minute.',
      })

      await safeLogAuditEvent({
        audit_id: audit.audit_id,
        event_type: 'checkout_session_created',
        severity: 'info',
        source_system: 'stripe',
        correlation_id: requestId,
        payload: { stripe_session_id: stripeSessionId, checkout_session_created: true },
      })
    } catch (err) {
      checkoutError = safeErrorMessage(err)
      log('warn', 'RIGHTS_AUDIT_CHECKOUT_SESSION_FAILED', {
        request_id: requestId,
        audit_id: audit.audit_id,
        artist_email: payload.email,
        message: checkoutError,
      })
    }

    // Step 3: Send side-effect emails. Pre-payment email ALWAYS includes payment CTA.
    const sideEffects = await Promise.allSettled([
      notifyN8n(audit),
      sendIntakeEmail({
        to: payload.email,
        auditId: audit.audit_id,
        artistName: payload.artist_name,
        checkoutUrl,
        baseUrl,
        requestId,
      }),
      sendEmail({
        to: OPS_EMAIL,
        subject: `Rights audit requested: ${payload.artist_name}`,
        html: `<p>New rights audit request.</p><p><strong>Audit ID:</strong> ${audit.audit_id}<br><strong>Artist:</strong> ${payload.artist_name}<br><strong>Email:</strong> ${payload.email}<br><strong>Catalog:</strong> ${payload.catalog_size}</p>`,
      }),
    ])

    sideEffects.forEach((result, idx) => {
      const label = ['intake_n8n_dispatch', 'artist_intake_email', 'ops_intake_email'][idx]
      if (result.status === 'fulfilled') {
        log('info', 'RIGHTS_AUDIT_SIDE_EFFECT_OK', { request_id: requestId, audit_id: audit.audit_id, label })
      } else {
        log('warn', 'RIGHTS_AUDIT_SIDE_EFFECT_FAILED', {
          request_id: requestId,
          audit_id: audit.audit_id,
          label,
          message: safeErrorMessage(result.reason),
        })
      }
    })

    // Return checkout_url so the frontend can redirect immediately.
    // If Stripe session creation failed, return the status_url fallback; the intake email
    // also contains the checkout link so the artist is never without a payment path.
    return res.status(200).json({
      audit_id: audit.audit_id,
      status: audit.status,
      created_at: audit.created_at,
      checkout_url: checkoutUrl || null,
      checkout_error: checkoutUrl ? null : checkoutError,
      status_url: `/audit-status?id=${encodeURIComponent(audit.audit_id)}`,
    })
  } catch (err) {
    log('error', 'RIGHTS_AUDIT_START_FAILED', { request_id: requestId, message: safeErrorMessage(err) })
    console.error('start-rights-audit error:', err)
    captureException(err, {
      route: 'start-rights-audit',
      method: req.method,
      path: req.url,
      statusCode: 500,
    })
    return res.status(500).json({ error: 'Rights audit could not be started' })
  }
}, 'start-rights-audit')

// ---------------------------------------------------------------------------
// Stripe checkout session creation (self-contained, no external module dep)
// ---------------------------------------------------------------------------
async function createStripeCheckoutSession({ auditId, email, baseUrl, requestId }) {
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY
  const PRICE_ID = process.env.STRIPE_RIGHTS_AUDIT_UNLOCK_PRICE_ID

  if (!STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured')
  if (!PRICE_ID) throw new Error('STRIPE_RIGHTS_AUDIT_UNLOCK_PRICE_ID is not configured')

  const successUrl = `${baseUrl}/audit-status?id=${encodeURIComponent(auditId)}&session_id={CHECKOUT_SESSION_ID}`
  const cancelUrl = `${baseUrl}/rights-audit.html?audit_id=${encodeURIComponent(auditId)}&checkout_cancelled=1`

  const params = new URLSearchParams()
  params.append('mode', 'payment')
  params.append('line_items[0][price]', PRICE_ID)
  params.append('line_items[0][quantity]', '1')
  params.append('metadata[audit_id]', auditId)
  params.append('metadata[email]', email)
  params.append('metadata[plan]', 'rights_audit_unlock')
  params.append('metadata[product_type]', 'rights_audit_unlock')
  params.append('customer_email', email)
  params.append('success_url', successUrl)
  params.append('cancel_url', cancelUrl)

  log('info', 'STRIPE_CHECKOUT_URLS_RESOLVED', {
    request_id: requestId,
    audit_id: auditId,
    artist_email: email,
    base_url: baseUrl,
    success_url: successUrl,
    cancel_url: cancelUrl,
  })

  const stripeRes = await fetch('https://api.stripe.com/v1/checkout/sessions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  })

  const session = await stripeRes.json()
  if (!stripeRes.ok) {
    throw new Error(`Stripe checkout session failed: ${session.error?.message || stripeRes.status}`)
  }

  return { url: session.url, sessionId: session.id }
}

// ---------------------------------------------------------------------------
// Pre-payment intake email — ALWAYS contains payment CTA
// ---------------------------------------------------------------------------
async function sendIntakeEmail({ to, auditId, artistName, checkoutUrl, baseUrl, requestId }) {
  const statusUrl = `${baseUrl}/audit-status?id=${encodeURIComponent(auditId)}`
  const payUrl = checkoutUrl || statusUrl  // fallback to status page if Stripe failed

  const payBlock = checkoutUrl
    ? `<p style="margin:24px 0;">
         <a href="${escapeHtml(checkoutUrl)}"
            style="background:#c8102e;color:#fff;padding:14px 28px;border-radius:6px;text-decoration:none;font-weight:700;display:inline-block;">
           Pay $1 and unlock audit
         </a>
       </p>
       <p>Or paste this link in your browser if the button does not work:<br>
          <a href="${escapeHtml(checkoutUrl)}">${escapeHtml(checkoutUrl)}</a></p>`
    : `<p><strong>Note:</strong> Secure checkout could not be created automatically. Return to
       <a href="https://musigod.com/rights-audit.html?audit_id=${encodeURIComponent(auditId)}">musigod.com/rights-audit.html</a>
       and click "UNLOCK FULL AUDIT" to pay.</p>`

  const html = `
    <p>Hi ${escapeHtml(artistName)},</p>
    <p>MusiGod received your rights audit intake request.</p>
    <p><strong>Audit ID:</strong> <code>${escapeHtml(auditId)}</code></p>
    <p><strong>Your audit has NOT started yet.</strong> Processing begins only after the $1 payment is confirmed by Stripe.</p>
    <p>Complete your payment now to unlock the full review:</p>
    ${payBlock}
    <p>After payment, you will be redirected to your audit status page showing:
      Payment received · Audit unlocked · Current status · What happens next · Estimated turnaround.
    </p>
    <p>If you have already paid, <a href="${escapeHtml(statusUrl)}">check your audit status here</a>.</p>
    <p>Questions? Reply to this email or contact <a href="mailto:support@musigod.com">support@musigod.com</a>.</p>
  `

  log('info', 'RIGHTS_AUDIT_INTAKE_EMAIL_SENDING', {
    request_id: requestId,
    audit_id: auditId,
    artist_email: to,
    checkout_url_present: Boolean(checkoutUrl),
    email_type: 'pre_payment_payment_required',
    redirect_target: checkoutUrl || statusUrl,
  })

  await sendEmail({
    to,
    subject: 'Complete your MusiGod rights audit payment',
    html,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function normalizePayload(body, req) {
  return {
    artist_name: clean(body.artist_name),
    legal_name: clean(body.legal_name),
    email: clean(body.email).toLowerCase(),
    phone: clean(body.phone),
    pro_affiliation: clean(body.pro_affiliation),
    publisher_name: clean(body.publisher_name),
    catalog_size: clean(body.catalog_size),
    released_music: clean(body.released_music),
    platforms: normalizeList(body.platforms),
    rights_concerns: normalizeList(body.rights_concerns),
    notes: clean(body.notes),
    source: clean(body.source) || 'rights-audit.html',
    ip_address: clean(req.headers['x-forwarded-for']).split(',')[0] || null,
    user_agent: clean(req.headers['user-agent']) || null,
  }
}

function validate(payload) {
  if (!payload.artist_name) return 'artist_name is required'
  if (!payload.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payload.email)) return 'Valid email is required'
  if (!payload.catalog_size) return 'catalog_size is required'
  if (!payload.released_music) return 'released_music is required'
  if (!payload.rights_concerns.length) return 'At least one rights concern is required'
  return null
}

async function createAudit(payload) {
  const rows = await sbFetch('rights_audits_v1', 'public', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      status: 'NEW',
      artist_name: payload.artist_name,
      legal_name: payload.legal_name || null,
      email: payload.email,
      phone: payload.phone || null,
      pro_affiliation: payload.pro_affiliation || null,
      publisher_name: payload.publisher_name || null,
      catalog_size: payload.catalog_size,
      released_music: payload.released_music,
      platforms: payload.platforms,
      rights_concerns: payload.rights_concerns,
      notes: payload.notes || null,
      source: payload.source,
      ip_address: payload.ip_address,
      user_agent: payload.user_agent,
      metadata: {
        submitted_at: new Date().toISOString(),
      },
    },
  })
  if (!rows?.[0]?.audit_id) throw new Error('Rights audit insert returned no audit_id')
  return rows[0]
}

async function notifyN8n(audit) {
  if (!RIGHTS_AUDIT_WEBHOOK_URL) return
  const response = await fetch(RIGHTS_AUDIT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      event: 'rights_audit.started',
      audit_id: audit.audit_id,
      status: audit.status,
      artist_name: audit.artist_name,
      legal_name: audit.legal_name,
      email: audit.email,
      phone: audit.phone,
      catalog_size: audit.catalog_size,
      released_music: audit.released_music,
      platforms: audit.platforms,
      rights_concerns: audit.rights_concerns,
      submitted_at: audit.created_at,
    }),
  })
  if (!response.ok) throw new Error(`Rights audit intake n8n failed: ${response.status}`)
}

async function sendEmail({ to, subject, html }) {
  if (!RESEND_API_KEY || !to) return
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: FROM_EMAIL, to, subject, html }),
  })
  if (!response.ok) throw new Error(`Resend failed: ${response.status}`)
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
  if (options.prefer) headers.Prefer = options.prefer

  const response = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`Supabase ${options.method || 'GET'} ${path} failed: ${response.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function resolveBaseUrl(req) {
  const candidates = [
    req.headers.origin,
    forwardedOrigin(req),
    envUrl(process.env.PUBLIC_SITE_URL),
    envUrl(process.env.SITE_URL),
    'https://musigod.com',
  ]
  return candidates.map(normalizeBaseUrl).find(Boolean) || 'https://musigod.com'
}

function forwardedOrigin(req) {
  const host = clean(req.headers['x-forwarded-host'] || req.headers.host).split(',')[0]
  if (!host) return ''
  const proto = clean(req.headers['x-forwarded-proto']).split(',')[0] || (host.includes('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

function envUrl(value) {
  return clean(value)
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(clean(value))
    if (!['http:', 'https:'].includes(url.protocol)) return ''
    if (!isAllowedHost(url)) return ''
    return `${url.protocol}//${url.host}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

function isAllowedHost(url) {
  const host = url.hostname.toLowerCase()
  if (host === 'musigod.com' || host === 'www.musigod.com') return url.protocol === 'https:'
  if (host.endsWith('.vercel.app')) return url.protocol === 'https:'
  if (host === 'localhost' || host === '127.0.0.1') return true
  return false
}

function normalizeList(value) {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean).slice(0, 20)
  return clean(value).split(',').map(clean).filter(Boolean).slice(0, 20)
}

function clean(value) {
  return String(value || '').trim()
}

function escapeHtml(value) {
  return clean(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function safeErrorMessage(err) {
  return clean(err?.message || String(err)).slice(0, 500)
}

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

