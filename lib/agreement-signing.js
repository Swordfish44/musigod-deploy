'use strict'

// Self-serve signing links for the Publishing Administration Agreement.
// Stateless HMAC tokens: no table, no operator step. A link is bound to one
// artist and expires. Secret: AGREEMENT_SIGNING_SECRET, else derived from the
// server-only Supabase service key (never sent to the browser).

const crypto = require('crypto')

const TOKEN_TTL_SECONDS = 30 * 24 * 3600

function secret() {
  const explicit = process.env.AGREEMENT_SIGNING_SECRET
  if (explicit) return explicit
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
  if (!base) throw new Error('Agreement signing secret is not configured')
  return crypto.createHash('sha256').update(`musigod:agreement-signing:${base}`).digest('hex')
}

const b64 = s => Buffer.from(s).toString('base64url')
const unb64 = s => Buffer.from(s, 'base64url').toString()
const mac = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url')

function safeEqual(a, b) {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b))
  return x.length === y.length && crypto.timingSafeEqual(x, y)
}

function createSigningToken(artistId, now = Date.now()) {
  const payload = b64(JSON.stringify({ a: artistId, e: Math.floor(now / 1000) + TOKEN_TTL_SECONDS, p: 'sign' }))
  return `${payload}.${mac(payload)}`
}

function verifySigningToken(token, now = Date.now()) {
  const [payload, sig] = String(token || '').split('.')
  if (!payload || !sig || !safeEqual(sig, mac(payload))) return null
  let claims
  try { claims = JSON.parse(unb64(payload)) } catch { return null }
  if (claims.p !== 'sign' || !claims.a || claims.e < Math.floor(now / 1000)) return null
  return claims.a
}

function receiptSignature(agreementId) {
  return mac(`receipt:${agreementId}`)
}

function verifyReceiptSignature(agreementId, sig) {
  return Boolean(agreementId && sig) && safeEqual(sig, receiptSignature(agreementId))
}

// Where signing links point. Request host when trusted, else configured site.
function siteBaseUrl(req) {
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || '').split(',')[0].trim().toLowerCase()
  if (host === 'musigod.com' || host === 'www.musigod.com' || /^[a-z0-9-]+\.vercel\.app$/.test(host)) return `https://${host}`
  if (process.env.PUBLIC_SITE_URL) return process.env.PUBLIC_SITE_URL.replace(/\/$/, '')
  if (process.env.VERCEL_ENV === 'preview' && process.env.VERCEL_BRANCH_URL) return `https://${process.env.VERCEL_BRANCH_URL}`
  return 'https://musigod.com'
}

function signingUrl(base, artistId) {
  return `${base}/agreement.html?token=${encodeURIComponent(createSigningToken(artistId))}`
}

// Never lets a signing-link problem break payment confirmation.
function optionalSigningUrl(req, artistId) {
  try { return signingUrl(siteBaseUrl(req), artistId) } catch { return null }
}

module.exports = {
  TOKEN_TTL_SECONDS,
  optionalSigningUrl,
  createSigningToken,
  verifySigningToken,
  receiptSignature,
  verifyReceiptSignature,
  siteBaseUrl,
  signingUrl,
}
