module.exports = async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).json({
    sentryDsn: process.env.SENTRY_PUBLIC_DSN || '',
    environment: process.env.VERCEL_ENV || 'production',
  })
}
