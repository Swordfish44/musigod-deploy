'use strict'

const { captureException, withSentry } = require('./_sentry')
const paypal = require('../lib/paypal-billing')

module.exports = withSentry(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch {
    return res.status(400).json({ verified: false })
  }

  const artistId = String(body.artist_id || '')
  const subscriptionId = String(body.subscription_id || '')
  if (!artistId || !/^[A-Z0-9-]{5,64}$/i.test(subscriptionId)) {
    return res.status(400).json({ verified: false })
  }

  try {
    const subscription = await paypal.showSubscription(subscriptionId)
    const plan = paypal.planForId(subscription.plan_id)
    const verified = subscription.status === 'ACTIVE' &&
      subscription.custom_id === artistId &&
      Boolean(plan)
    return res.status(verified ? 200 : 409).json({ verified, provider: 'paypal', plan })
  } catch (error) {
    captureException(error, { route: 'verify-paypal-subscription', method: req.method, statusCode: 502 })
    return res.status(502).json({ verified: false })
  }
}, 'verify-paypal-subscription')

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}
