'use strict'

// Artist self-serve signing of the Publishing Administration Agreement.
//   GET  ?token=...              -> agreement text + artist summary for the signing page
//   POST { token, typed_name, consent: true } -> sign, record, activate if paid
//   GET  ?receipt=<id>&sig=...   -> signed copy (HTML) used as agreement_document_url
// The agreement text is the current registrations.agreement_versions_v1 row
// for PUBLISHING_ADMIN. Nothing here writes legal wording.

const { captureException, withSentry } = require('./_sentry')
const signing = require('../lib/agreement-signing')
const entitlement = require('../lib/paid-entitlement')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const SERVICE_TYPE = 'PUBLISHING_ADMIN'

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!SB_KEY) return res.status(500).json({ error: 'Signing is not configured' })

  try {
    if (req.method === 'GET' && req.query?.receipt) return await receipt(req, res)
    if (req.method === 'GET') return await show(req, res)
    if (req.method === 'POST') return await sign(req, res)
    return res.status(405).json({ error: 'Method not allowed' })
  } catch (error) {
    captureException(error, { route: 'publishing-agreement', method: req.method, statusCode: 500 })
    console.error('publishing-agreement error:', error)
    return res.status(500).json({ error: 'Something went wrong. Please try again or contact support@musigod.com.' })
  }
}, 'publishing-agreement')

async function show(req, res) {
  const artistId = signing.verifySigningToken(req.query?.token)
  if (!artistId) return res.status(401).json({ error: 'This signing link is invalid or has expired. Check your latest MusiGod email or contact support@musigod.com.' })
  const artist = await getArtist(artistId)
  if (!artist) return res.status(404).json({ error: 'Registration not found' })
  const agreement = await currentAgreement()
  if (!agreement) return res.status(503).json({ error: 'Agreement is temporarily unavailable' })
  return res.status(200).json({
    artist: {
      legal_name: [artist.legal_first_name, artist.legal_last_name].filter(Boolean).join(' '),
      email: artist.email,
      plan: artist.plan_tier,
      paid: artist.meta?.billing_status === entitlement.PAID_AWAITING_AGREEMENT || artist.plan_status === 'ACTIVE',
    },
    already_signed: Boolean(artist.agreement_signed_at),
    agreement: { title: agreement.title, version: agreement.version, effective_date: agreement.effective_date, body_text: agreement.body_text },
  })
}

async function sign(req, res) {
  let body
  try { body = JSON.parse((await getRawBody(req)).toString() || '{}') } catch { return res.status(400).json({ error: 'Invalid request' }) }

  const artistId = signing.verifySigningToken(body.token)
  if (!artistId) return res.status(401).json({ error: 'This signing link is invalid or has expired.' })
  const typedName = String(body.typed_name || '').replace(/\s+/g, ' ').trim()
  if (typedName.length < 3 || !/\s/.test(typedName)) return res.status(400).json({ error: 'Type your full legal name (first and last) to sign.' })
  if (body.consent !== true) return res.status(400).json({ error: 'You must agree to sign electronically.' })

  const artist = await getArtist(artistId)
  if (!artist) return res.status(404).json({ error: 'Registration not found' })
  if (artist.agreement_signed_at) {
    const activation = await entitlement.activatePaidArtist(artistId)
    const fresh = await getArtist(artistId)
    return res.status(200).json({ signed: true, already_signed: true, activated: fresh?.plan_status === 'ACTIVE' || activation.activated, plan_status: fresh?.plan_status })
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 500) || null

  // Snapshot of the exact text signed + signature event + activity timeline.
  const signed = await rpc('fn_sign_agreement_v1', {
    p_artist_email: artist.email,
    p_service_type: SERVICE_TYPE,
    p_engagement_id: null,
    p_artist_id: artistId,
    p_ip_address: ip,
    p_user_agent: userAgent,
  })
  const row = Array.isArray(signed) ? signed[0] : signed
  if (!row?.id) throw new Error('fn_sign_agreement_v1 returned no agreement')

  const base = signing.siteBaseUrl(req)
  const documentUrl = `${base}/api/publishing-agreement?receipt=${encodeURIComponent(row.id)}&sig=${signing.receiptSignature(row.id)}`

  const result = await entitlement.recordPublishingAgreement({
    artistId,
    signedBy: typedName,
    documentUrl,
    signedAt: row.signed_at,
    version: row.version,
    ipAddress: ip,
  })

  console.info('PUBLISHING_AGREEMENT_SELF_SIGNED', { artist_id: artistId, agreement_ref: row.agreement_ref, activated: result.activation?.activated, plan_status: result.plan_status })
  return res.status(200).json({
    signed: true,
    activated: result.plan_status === 'ACTIVE',
    plan_status: result.plan_status,
    agreement_ref: row.agreement_ref,
    receipt_url: documentUrl,
  })
}

async function receipt(req, res) {
  const id = String(req.query.receipt || '')
  if (!signing.verifyReceiptSignature(id, req.query.sig)) return res.status(404).send('Not found')
  const rows = await sb(`signed_agreements_v1?id=eq.${encodeURIComponent(id)}&select=*&limit=1`, 'registrations')
  const row = rows?.[0]
  if (!row) return res.status(404).send('Not found')
  const artist = row.artist_id ? await getArtist(row.artist_id) : null
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.setHeader('X-Robots-Tag', 'noindex')
  return res.status(200).send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Signed agreement ${esc(row.agreement_ref)}</title>
<style>body{font:15px/1.6 Georgia,serif;max-width:760px;margin:40px auto;padding:0 16px;color:#111}pre{white-space:pre-wrap;font:inherit}.meta{font:13px/1.5 system-ui,sans-serif;border-top:1px solid #ccc;margin-top:28px;padding-top:12px;color:#333}</style>
</head><body><pre>${esc(row.full_agreement_text)}</pre>
<div class="meta"><strong>Electronically signed</strong><br>
Signed by: ${esc(artist?.agreement_signed_by || '')}<br>
Email: ${esc(row.artist_email)}<br>
Signed at: ${esc(row.signed_at)}<br>
Agreement: ${esc(row.service_type)} ${esc(row.version)} &middot; Ref ${esc(row.agreement_ref)}<br>
IP address: ${esc(row.ip_address || '')}</div></body></html>`)
}

async function getArtist(id) {
  const rows = await sb(`artists_v1?id=eq.${encodeURIComponent(id)}&select=id,email,legal_first_name,legal_last_name,plan_tier,plan_status,meta,agreement_signed_at,agreement_signed_by&limit=1`, 'artists')
  return rows?.[0] || null
}

async function currentAgreement() {
  const rows = await sb(`agreement_versions_v1?service_type=eq.${SERVICE_TYPE}&is_current=eq.true&order=created_at.desc&limit=1`, 'registrations')
  return rows?.[0] || null
}

async function sb(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': schema } })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path.split('?')[0]} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function rpc(fn, params) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Content-Profile': 'registrations', 'Accept-Profile': 'registrations' },
    body: JSON.stringify(params),
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`RPC ${fn} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function esc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
