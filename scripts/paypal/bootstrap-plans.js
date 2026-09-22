'use strict'

const crypto = require('crypto')
const { apiBase, accessToken } = require('../../lib/paypal-billing')

const TIERS = Object.freeze([
  { code: 'starter', name: 'MusiGod Starter', amount: '79.00', env: 'PAYPAL_STARTER_PLAN_ID' },
  { code: 'growth', name: 'MusiGod Growth', amount: '129.00', env: 'PAYPAL_GROWTH_PLAN_ID' },
  { code: 'pro', name: 'MusiGod Pro', amount: '179.00', env: 'PAYPAL_PRO_PLAN_ID' },
  { code: 'label', name: 'MusiGod Enterprise', amount: '699.00', env: 'PAYPAL_LABEL_PLAN_ID' },
])

function productPayload() {
  return {
    name: 'MusiGod Publishing Administration',
    description: 'Music publishing administration, neighboring-rights administration, and catalog intelligence software services.',
    type: 'SERVICE',
    home_url: 'https://musigod.com',
  }
}

function planPayload(productId, tier) {
  return {
    product_id: productId,
    name: tier.name,
    description: `${tier.name} monthly software and rights-administration service`,
    status: 'ACTIVE',
    billing_cycles: [{
      frequency: { interval_unit: 'MONTH', interval_count: 1 },
      tenure_type: 'REGULAR',
      sequence: 1,
      total_cycles: 0,
      pricing_scheme: {
        fixed_price: { value: tier.amount, currency_code: 'USD' },
      },
    }],
    payment_preferences: {
      auto_bill_outstanding: true,
      setup_fee_failure_action: 'CANCEL',
      payment_failure_threshold: 2,
    },
    quantity_supported: false,
  }
}

async function paypalPost(path, body, requestKey, fetchImpl = fetch) {
  const token = await accessToken(fetchImpl)
  const requestId = crypto.createHash('sha256').update(requestKey).digest('hex').slice(0, 36)
  const response = await fetchImpl(`${apiBase()}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      'PayPal-Request-Id': requestId,
    },
    body: JSON.stringify(body),
  })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    const detail = payload.details?.[0]?.description || payload.message || `HTTP ${response.status}`
    throw new Error(`PayPal bootstrap failed: ${detail}`)
  }
  return payload
}

async function execute(fetchImpl = fetch) {
  if (process.env.PAYPAL_ENV === 'live' && !process.argv.includes('--allow-live')) {
    throw new Error('Live PayPal bootstrap requires the explicit --allow-live flag')
  }
  const product = await paypalPost(
    '/v1/catalogs/products',
    productPayload(),
    `musigod:${process.env.PAYPAL_ENV || 'sandbox'}:catalog-product:v1`,
    fetchImpl
  )
  if (!product.id) throw new Error('PayPal did not return a product ID')

  const planIds = {}
  for (const tier of TIERS) {
    const plan = await paypalPost(
      '/v1/billing/plans',
      planPayload(product.id, tier),
      `musigod:${process.env.PAYPAL_ENV || 'sandbox'}:${tier.code}:monthly:v1`,
      fetchImpl
    )
    if (!plan.id || plan.status !== 'ACTIVE') {
      throw new Error(`PayPal did not create an active ${tier.code} plan`)
    }
    planIds[tier.env] = plan.id
  }
  return { productId: product.id, planIds }
}

function printDryRun() {
  const previewProductId = 'PROD-PAYPAL-WILL-GENERATE'
  console.log(JSON.stringify({
    mode: 'DRY_RUN',
    environment: process.env.PAYPAL_ENV || 'sandbox',
    product: productPayload(),
    plans: TIERS.map(tier => ({ env: tier.env, payload: planPayload(previewProductId, tier) })),
    next: 'Set sandbox PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET, then rerun with --execute.',
  }, null, 2))
}

if (require.main === module) {
  if (!process.argv.includes('--execute')) {
    printDryRun()
  } else {
    execute().then(result => {
      console.log(JSON.stringify({
        mode: 'EXECUTED',
        environment: process.env.PAYPAL_ENV || 'sandbox',
        product_id: result.productId,
        vercel_environment_variables: result.planIds,
      }, null, 2))
    }).catch(error => {
      console.error(error.message)
      process.exitCode = 1
    })
  }
}

module.exports = { TIERS, productPayload, planPayload, paypalPost, execute }
