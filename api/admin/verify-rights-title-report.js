'use strict'

// Temporary production verifier for Rights Title Report v1.
// Uses the existing admin authentication boundary and invokes the deployed
// report handler internally with the known Esham catalog UUID. No credentials
// or environment-variable values are returned.

const { withSentry } = require('../_sentry')
const { authenticate } = require('../_registration-auth')
const rightsTitleHandler = require('../get-rights-title-report')

const ESHAM_TRACK_ID = '4bcf28eb-35b6-49e7-a981-a435b9166e90'

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const actor = await authenticate(req, { admin: true })
  if (!actor?.admin) return res.status(401).json({ error: 'Admin authentication required' })

  const originalUrl = req.url
  req.url = `/api/get-rights-title-report?id=${ESHAM_TRACK_ID}`
  try {
    return await rightsTitleHandler(req, res)
  } finally {
    req.url = originalUrl
  }
})
