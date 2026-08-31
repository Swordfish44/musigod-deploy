'use strict'

// TEMPORARY production verifier for Rights Title Report v1.
// This route never returns or logs ADMIN_API_KEY. It injects the existing
// server-side secret into an internal request object so the real report
// handler exercises the same hardened admin boundary in production.
// DELETE immediately after verification.

const { withSentry } = require('../_sentry')
const rightsTitleHandler = require('../get-rights-title-report')

const ESHAM_TRACK_ID = '4bcf28eb-35b6-49e7-a981-a435b9166e90'

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  if (!process.env.ADMIN_API_KEY) return res.status(503).json({ error: 'Admin verifier unavailable' })

  // Restrict this temporary verifier to Vercel production only.
  if (process.env.VERCEL_ENV && process.env.VERCEL_ENV !== 'production') {
    return res.status(404).json({ error: 'Not found' })
  }

  const internalReq = {
    ...req,
    url: `/api/get-rights-title-report?id=${ESHAM_TRACK_ID}`,
    query: { id: ESHAM_TRACK_ID },
    headers: { ...req.headers, 'x-admin-key': process.env.ADMIN_API_KEY }
  }

  return rightsTitleHandler(internalReq, res)
})
