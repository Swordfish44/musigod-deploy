const { captureException, flush, isConfigured } = require('./_sentry')

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.ADMIN_API_KEY) return res.status(500).json({ error: 'ADMIN_API_KEY is not configured' })
  if (req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })

  const error = new Error('MusiGod Sentry forced throw test')
  captureException(error, {
    route: '/api/test-sentry-throw',
    test: true,
    source: 'manual-production-check',
    sentryConfigured: isConfigured(),
  })
  await flush(5000)

  throw error
}
