module.exports = async function handler(req, res) {
  const paypalEnabled = String(process.env.PAYPAL_BILLING_ENABLED || '').trim().toLowerCase() === 'true'
  const requestedProvider = String(process.env.PAYMENT_CHECKOUT_PROVIDER || 'stripe').trim().toLowerCase()
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    sentryDsn: process.env.SENTRY_PUBLIC_DSN || '',
    environment: process.env.VERCEL_ENV || 'production',
    checkoutProvider: requestedProvider === 'paypal' && paypalEnabled ? 'paypal' : 'stripe',
    paypalBillingEnabled: paypalEnabled,
    requestedProvider,
    build: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
  })
}
