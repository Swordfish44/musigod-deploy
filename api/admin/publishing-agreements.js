'use strict'

// Admin-only: record a signed Publishing Administration Agreement for an
// artist and activate them if their payment was already received.
//   GET  -> artists who have paid but not yet had an agreement recorded
//   POST { artist_id | email, signed_by, document_url, signed_at?, version? }
// Fails closed: no ADMIN_API_KEY => 503; wrong key => 401.

const crypto = require('crypto')
const { captureException, withSentry } = require('../_sentry')
const entitlement = require('../../lib/paid-entitlement')

function adminKeyValid(given) {
  const expected = process.env.ADMIN_API_KEY
  if (!expected || !given) return false
  const a = Buffer.from(String(given)); const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.ADMIN_API_KEY) return res.status(503).json({ error: 'Admin access is not configured' })
  if (!adminKeyValid(req.headers['x-admin-key'])) return res.status(401).json({ error: 'Unauthorized' })
  if (!(process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY)) {
    return res.status(500).json({ error: 'Supabase service key not configured' })
  }

  try {
    if (req.method === 'GET') {
      return res.status(200).json({ artists: await entitlement.listPaidAwaitingAgreement() || [] })
    }

    let body
    try { body = JSON.parse((await getRawBody(req)).toString() || '{}') } catch { return res.status(400).json({ error: 'Invalid JSON' }) }

    const signedBy = String(body.signed_by || '').trim()
    const documentUrl = String(body.document_url || '').trim()
    const signedAt = body.signed_at ? new Date(body.signed_at) : null
    if (signedBy.length < 2) return res.status(400).json({ error: 'signed_by (full legal name of signer) is required' })
    if (!/^https:\/\/\S+$/i.test(documentUrl)) return res.status(400).json({ error: 'document_url must be an https link to the signed agreement' })
    if (signedAt && Number.isNaN(signedAt.getTime())) return res.status(400).json({ error: 'signed_at must be a valid date' })

    let artistId = String(body.artist_id || '').trim()
    if (!artistId && body.email) artistId = await entitlement.findArtistIdByEmail(body.email)
    if (!/^[0-9a-f-]{36}$/i.test(artistId || '')) return res.status(404).json({ error: 'Artist not found' })

    const result = await entitlement.recordPublishingAgreement({
      artistId,
      signedBy,
      documentUrl,
      signedAt: signedAt ? signedAt.toISOString() : undefined,
      version: body.version ? String(body.version).slice(0, 40) : undefined,
    })
    if (!result.ok) return res.status(404).json({ error: 'Artist not found' })
    console.info('PUBLISHING_AGREEMENT_RECORDED', { artist_id: artistId, activated: result.activation?.activated, plan_status: result.plan_status })
    return res.status(200).json({ artist_id: artistId, ...result })
  } catch (error) {
    captureException(error, { route: 'admin/publishing-agreements', method: req.method, statusCode: 500 })
    return res.status(500).json({ error: 'Could not record agreement' })
  }
}, 'admin/publishing-agreements')

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

module.exports.adminKeyValid = adminKeyValid
