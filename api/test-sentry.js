const { captureException, flush, withSentry } = require('./_sentry')

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.ADMIN_API_KEY) return res.status(500).json({ error: 'ADMIN_API_KEY is not configured' })
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })

  const error = new Error('MusiGod Sentry production test error')
  captureException(error, {
    route: '/api/test-sentry',
    test: true,
    source: 'manual-production-check',
  })

  const flushed = await flush(5000)

  return res.status(200).json({
    ok: true,
    telemetryAttempted: true,
    sentryConfigured: Boolean(process.env.SENTRY_DSN),
    flushed,
  })
}, 'test-sentry')
