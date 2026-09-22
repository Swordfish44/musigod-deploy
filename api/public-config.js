module.exports = async function handler(req, res) {
  const paypalEnabled = process.env.PAYPAL_BILLING_ENABLED === 'true'
  const requestedProvider = String(process.env.PAYMENT_CHECKOUT_PROVIDER || 'stripe').toLowerCase()
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'public, max-age=60')
  res.status(200).json({
    sentryDsn: process.env.SENTRY_PUBLIC_DSN || '',
    environment: process.env.VERCEL_ENV || 'production',
    checkoutProvider: requestedProvider === 'paypal' && paypalEnabled ? 'paypal' : 'stripe',
    paypalBillingEnabled: paypalEnabled,
  })
}
