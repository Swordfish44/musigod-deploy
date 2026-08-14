'use strict';
// api/issue-intake-token.js
// Operator-only endpoint to issue a single-use intake token.
// Requires x-admin-key header matching ADMIN_API_KEY.
//
// POST body:
//   { token_type, artist_email, artist_id?, engagement_id?, audit_note? }
//
// Response (200):
//   { token, token_type, artist_email, expires_at, engagement_id }
//
// The raw token is returned exactly ONCE in this response.
// The caller (operator) embeds it in a secure portal URL delivered to the artist.
// It is never sent in plaintext email and is not recoverable from the DB.

const { captureException, withSentry } = require('./_sentry')
const {
  generateRawToken,
  buildTokenRecord,
  TOKEN_TYPES,
} = require('../lib/intake-tokens')

const SB_URL        = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY        = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

const SCHEMA = 'registrations'
const TABLE  = 'intake_upload_tokens_v1'

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  // Require admin auth — no token issuance without it
  if (!ADMIN_API_KEY) return res.status(500).json({ error: 'ADMIN_API_KEY not configured' })
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  let body
  try { body = JSON.parse((await getRawBody(req)).toString()) }
  catch { return res.status(400).json({ error: 'Invalid request body' }) }

  const tokenType    = String(body.token_type   || '').trim()
  const artistEmail  = String(body.artist_email || '').trim().toLowerCase()
  const artistId     = String(body.artist_id    || '').trim() || null
  const engagementId = String(body.engagement_id || '').trim() || null
  const auditNote    = String(body.audit_note   || '').trim()

  if (!Object.values(TOKEN_TYPES).includes(tokenType)) {
    return res.status(400).json({
      error: `token_type must be one of: ${Object.values(TOKEN_TYPES).join(', ')}`,
    })
  }
  if (!artistEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(artistEmail)) {
    return res.status(400).json({ error: 'Valid artist_email is required' })
  }

  try {
    const rawToken = generateRawToken()
    const record   = buildTokenRecord({
      rawToken,
      tokenType,
      artistEmail,
      artistId,
      engagementId,
      createdBy:  'operator',
      auditNote,
    })

    // Insert token record — hash only, never the raw token
    await sbInsert(TABLE, SCHEMA, record)

    // Return raw token exactly once
    return res.status(200).json({
      token:         rawToken,
      token_type:    record.token_type,
      artist_email:  record.artist_email,
      engagement_id: record.engagement_id,
      expires_at:    record.expires_at,
      audit_note:    record.audit_note,
      warning:       'Store this token securely. It cannot be retrieved again. Embed it in a portal URL — do not send it in plaintext email.',
    })

  } catch (err) {
    captureException(err, { route: 'issue-intake-token' })
    return res.status(500).json({ error: 'Failed to issue token' })
  }
}, 'issue-intake-token')

async function sbInsert(table, schema, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      apikey:            SB_KEY,
      Authorization:     `Bearer ${SB_KEY}`,
      'Content-Type':    'application/json',
      'Accept-Profile':  schema,
      'Content-Profile': schema,
      Prefer:            'return=minimal',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Token insert failed: ${res.status} ${text}`)
  }
}

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end',  () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function setCors(req, res) {
  // Admin endpoint: no CORS relaxation — only same-origin operator dashboard
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
