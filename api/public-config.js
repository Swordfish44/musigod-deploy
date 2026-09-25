module.exports = async function handler(req, res) {
  const paypalEnabled = String(process.env.PAYPAL_BILLING_ENABLED || '').trim().toLowerCase() === 'true'
  const requestedProvider = String(process.env.PAYMENT_CHECKOUT_PROVIDER || 'stripe').trim().toLowerCase()
  res.setHeader('Content-Type', 'application/json')
  res.setHeader('Cache-Control', 'no-store')
  res.status(200).json({
    sentryDsn: process.env.SENTRY_PUBLIC_DSN || '',
    environment: process.env.VERCEL_ENV || 'production',
    checkoutProvider: selectProvider(requestedProvider, paypalEnabled),
    paypalBillingEnabled: paypalEnabled,
    requestedProvider,
    build: process.env.VERCEL_GIT_COMMIT_SHA || 'local',
  })
}

// Production keeps whatever PAYMENT_CHECKOUT_PROVIDER says (default stripe).
// Preview deployments with PayPal billing enabled in sandbox mode always use
// PayPal sandbox, so a Preview can never route a test checkout to Stripe.
function selectProvider(requestedProvider, paypalEnabled) {
  if (!paypalEnabled) return 'stripe'
  const env = String(process.env.VERCEL_ENV || '').trim().toLowerCase()
  const paypalMode = String(process.env.PAYPAL_ENV || '').trim().toLowerCase()
  if (env === 'preview' && paypalMode !== 'live') return 'paypal'
  return requestedProvider === 'paypal' ? 'paypal' : 'stripe'
}
