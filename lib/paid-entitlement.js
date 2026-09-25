'use strict'

// Paid-but-unsigned artists.
// artists.artists_v1 has a DB guard: an artist cannot become ACTIVE until the
// Publishing Administration Agreement is signed. Checkout happens before
// signing, so a verified payment must be recorded without tripping the guard:
//   payment verified + agreement signed   -> plan_status ACTIVE
//   payment verified + agreement unsigned -> plan_status unchanged,
//                                            meta.billing_status = PAID_AWAITING_AGREEMENT
// Signing the agreement later calls activatePaidArtist() to finish activation.
// The legal guard itself is never bypassed.

const SB_URL = () => process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = () => process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const PAID_AWAITING_AGREEMENT = 'PAID_AWAITING_AGREEMENT'
const AGREEMENT_GUARD = /signed Publishing Administration Agreement/i

function headers(extra = {}) {
  return {
    apikey: SB_KEY(),
    Authorization: `Bearer ${SB_KEY()}`,
    'Content-Type': 'application/json',
    'Accept-Profile': 'artists',
    'Content-Profile': 'artists',
    ...extra,
  }
}

async function request(path, options = {}) {
  const response = await fetch(`${SB_URL()}/rest/v1/${path}`, { headers: headers(options.headers), ...options, headers: headers(options.headers) })
  const text = await response.text()
  if (!response.ok) {
    const err = new Error(`Supabase ${options.method || 'GET'} ${path.split('?')[0]} failed: ${response.status} ${text}`)
    err.statusCode = response.status
    err.body = text
    throw err
  }
  return text ? JSON.parse(text) : null
}

function isAgreementGuard(err) {
  return AGREEMENT_GUARD.test(String(err?.body || err?.message || ''))
}

async function getArtist(artistId) {
  const rows = await request(`artists_v1?id=eq.${encodeURIComponent(artistId)}&select=id,email,plan_status,plan_tier,meta&limit=1`)
  return rows?.[0] || null
}

async function mergeArtistMeta(artist, patch, fields = {}) {
  const meta = { ...(artist?.meta || {}), ...patch }
  await request(`artists_v1?id=eq.${encodeURIComponent(artist.id)}`, {
    method: 'PATCH',
    body: JSON.stringify({ ...fields, meta }),
  })
}

// Returns the effective entitlement: 'ACTIVE' or 'PAID_AWAITING_AGREEMENT'.
async function activateOrHoldForAgreement({ artistId, plan, provider, subscriptionId }) {
  const tier = plan ? String(plan).toUpperCase() : undefined
  const tierField = tier ? { plan_tier: tier } : {}
  try {
    await request(`artists_v1?id=eq.${encodeURIComponent(artistId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan_status: 'ACTIVE', ...tierField }),
    })
    const artist = await getArtist(artistId)
    if (artist?.meta?.billing_status) await mergeArtistMeta(artist, { billing_status: 'ACTIVE' })
    return 'ACTIVE'
  } catch (err) {
    if (!isAgreementGuard(err)) throw err
    const artist = await getArtist(artistId)
    if (!artist) throw err
    await mergeArtistMeta(artist, {
      billing_status: PAID_AWAITING_AGREEMENT,
      billing_provider: provider || null,
      billing_subscription_id: subscriptionId || null,
      billing_paid_at: artist.meta?.billing_paid_at || new Date().toISOString(),
    }, tierField)
    console.info('ARTIST_PAID_AWAITING_AGREEMENT', { artist_id: artistId, provider, subscription_id: subscriptionId })
    return PAID_AWAITING_AGREEMENT
  }
}

// Call after an agreement is signed. No-op unless payment was already received.
async function activatePaidArtist(artistId) {
  const artist = await getArtist(artistId)
  if (!artist || artist.meta?.billing_status !== PAID_AWAITING_AGREEMENT) return { activated: false, reason: 'not-paid-awaiting-agreement' }
  try {
    await request(`artists_v1?id=eq.${encodeURIComponent(artistId)}`, {
      method: 'PATCH',
      body: JSON.stringify({ plan_status: 'ACTIVE' }),
    })
  } catch (err) {
    if (isAgreementGuard(err)) return { activated: false, reason: 'agreement-still-unsigned' }
    throw err
  }
  const fresh = await getArtist(artistId)
  await mergeArtistMeta(fresh, { billing_status: 'ACTIVE', activated_at: new Date().toISOString() })
  await fetch(`${SB_URL()}/rest/v1/registrations_v1?artist_id=eq.${encodeURIComponent(artistId)}`, {
    method: 'PATCH',
    headers: { ...headers(), 'Accept-Profile': 'registrations', 'Content-Profile': 'registrations' },
    body: JSON.stringify({ plan_status: 'ACTIVE' }),
  }).catch(() => null)
  console.info('ARTIST_ACTIVATED_AFTER_AGREEMENT', { artist_id: artistId })
  return { activated: true }
}

// Records the signed Publishing Administration Agreement on the canonical
// artist (the fields the DB activation guard checks), then activates the
// artist if payment was already received.
async function recordPublishingAgreement({ artistId, signedBy, documentUrl, signedAt, version, ipAddress }) {
  const artist = await getArtist(artistId)
  if (!artist) return { ok: false, error: 'artist-not-found' }
  await request(`artists_v1?id=eq.${encodeURIComponent(artistId)}`, {
    method: 'PATCH',
    body: JSON.stringify({
      agreement_signed_at: signedAt || new Date().toISOString(),
      agreement_signed_by: signedBy,
      agreement_document_url: documentUrl,
      ...(version ? { agreement_version: version } : {}),
      ...(ipAddress ? { agreement_ip_address: ipAddress } : {}),
    }),
  })
  const activation = await activatePaidArtist(artistId)
  const fresh = await getArtist(artistId)
  return { ok: true, activation, plan_status: fresh?.plan_status, billing_status: fresh?.meta?.billing_status || null }
}

async function listPaidAwaitingAgreement() {
  return request(`artists_v1?meta->>billing_status=eq.${PAID_AWAITING_AGREEMENT}&select=id,email,legal_first_name,legal_last_name,artist_name,plan_tier,plan_status,meta&order=created_at.asc&limit=200`)
}

async function findArtistIdByEmail(email) {
  if (!email) return null
  const rows = await request(`artists_v1?email=eq.${encodeURIComponent(String(email).trim().toLowerCase())}&select=id&limit=1`)
  return rows?.[0]?.id || null
}

module.exports = {
  PAID_AWAITING_AGREEMENT,
  isAgreementGuard,
  activateOrHoldForAgreement,
  activatePaidArtist,
  findArtistIdByEmail,
  recordPublishingAgreement,
  listPaidAwaitingAgreement,
}
