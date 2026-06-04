// MusiGod E2E Automated Test v2 — API-only, no direct Supabase calls
// Run: node scripts/e2e-test.js
// Requires no env vars — all calls go through musigod.com endpoints

const BASE_URL = 'https://musigod.com'
const ECHO_ID  = '86c8df13-dbc6-4846-a8da-cdbaaf386cc7'
const ECHO_EMAIL = 'swordfishlp44+testartist@proton.me'
const ADMIN_KEY = 'mg-admin-2026'

let passed = 0
let failed = 0
let skipped = 0

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌'
  console.log(`${icon} ${name}${detail ? ' — ' + detail : ''}`)
  if (status === 'PASS') passed++
  else if (status === 'FAIL') failed++
  else skipped++
}

async function post(path, body, extraHeaders = {}) {
  const r = await fetch(`${BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: JSON.stringify(body)
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: r.status, ok: r.ok, json }
}

// ─── STEP 1: register-artist (Growth plan) ────────────────────────────────────
async function step1_register() {
  try {
    const res = await post('api/register-artist', {
      legal_first_name: 'Echo',
      legal_last_name: 'Validation',
      artist_name: 'Test Artist Echo',
      email: `swordfishlp44+echo${Date.now()}@proton.me`, // unique email each run
      phone: '313-555-0199',
      plan: 'growth',
      pro: 'ASCAP',
      catalog_size: '6-20 songs',
      works_registered: 'Already released',
    })
    if (res.ok && res.json.artist_id) {
      log('PASS', 'STEP 1: register-artist (Growth)', `artist_id=${res.json.artist_id} reg_id=${res.json.registration_id}`)
      return { artist_id: res.json.artist_id, registration_id: res.json.registration_id }
    } else {
      log('FAIL', 'STEP 1: register-artist', `${res.status} ${JSON.stringify(res.json)}`)
      return null
    }
  } catch(e) { log('FAIL', 'STEP 1: register-artist', e.message); return null }
}

// ─── STEP 2: create-checkout-session ──────────────────────────────────────────
async function step2_checkout(artist_id) {
  if (!artist_id) { log('SKIP', 'STEP 2: checkout (no artist_id)'); return null }
  try {
    const res = await post('api/create-checkout-session', {
      artist_id,
      plan: 'growth',
      email: ECHO_EMAIL,
    })
    if (res.ok && res.json.url && res.json.url.includes('stripe.com')) {
      log('PASS', 'STEP 2: create-checkout-session → Stripe URL returned')
      return res.json.url
    } else {
      log('FAIL', 'STEP 2: create-checkout-session', `${res.status} ${JSON.stringify(res.json)}`)
      return null
    }
  } catch(e) { log('FAIL', 'STEP 2: create-checkout-session', e.message); return null }
}

// ─── STEP 3: admin activate ────────────────────────────────────────────────────
async function step3_activate(registration_id) {
  if (!registration_id) { log('SKIP', 'STEP 3: admin activate (no registration_id)'); return false }
  try {
    const res = await post('api/admin-registration-action',
      { registration_id, action: 'activate' },
      { 'x-admin-key': ADMIN_KEY }
    )
    if (res.ok && res.json.ok) {
      log('PASS', 'STEP 3: admin activate', `registration_id=${registration_id}`)
      return true
    } else {
      log('FAIL', 'STEP 3: admin activate', `${res.status} ${JSON.stringify(res.json)}`)
      return false
    }
  } catch(e) { log('FAIL', 'STEP 3: admin activate', e.message); return false }
}

// ─── STEP 4: submit-statement ─────────────────────────────────────────────────
async function step4_statement(artist_id) {
  if (!artist_id) { log('SKIP', 'STEP 4: submit-statement (no artist_id)'); return null }
  try {
    const res = await post('api/submit-statement', {
      artist_id,
      source: 'ASCAP',
      period_start: '2026-01-01',
      period_end: '2026-03-31',
      gross_amount: 250.00,
      currency: 'USD',
      line_items: [
        { description: 'Performance royalties Q1 2026', amount: 150.00 },
        { description: 'Digital royalties Q1 2026',     amount: 100.00 },
      ]
    })
    if (res.ok && res.json.statement_id) {
      const fee = res.json.mgs_fee_usd
      const net = res.json.net_to_artist_usd
      log('PASS', 'STEP 4: submit-statement', `gross=$250 fee=$${fee} net=$${net}`)
      return res.json.statement_id
    } else {
      log('FAIL', 'STEP 4: submit-statement', `${res.status} ${JSON.stringify(res.json)}`)
      return null
    }
  } catch(e) { log('FAIL', 'STEP 4: submit-statement', e.message); return null }
}

// ─── STEP 5: trigger-payout ───────────────────────────────────────────────────
async function step5_payout(artist_id) {
  if (!artist_id) { log('SKIP', 'STEP 5: trigger-payout (no artist_id)'); return }
  try {
    const res = await post('api/trigger-payout', { artist_id })
    // Expected: pending=1 sent=0 (no Stripe Connect account yet for new artist)
    // OR pending=0 if no disbursement queued
    if (res.ok) {
      log('PASS', 'STEP 5: trigger-payout responded OK', JSON.stringify(res.json))
    } else if (res.status === 400 || res.status === 422) {
      log('PASS', 'STEP 5: trigger-payout correctly rejected (no Connect account)', `${res.status}`)
    } else {
      log('FAIL', 'STEP 5: trigger-payout', `${res.status} ${JSON.stringify(res.json)}`)
    }
  } catch(e) { log('FAIL', 'STEP 5: trigger-payout', e.message) }
}

// ─── STEP 6: create-connect-account ──────────────────────────────────────────
async function step6_connect(artist_id) {
  if (!artist_id) { log('SKIP', 'STEP 6: create-connect-account (no artist_id)'); return }
  try {
    const res = await post('api/create-connect-account', { artist_id, email: ECHO_EMAIL })
    if (res.ok && res.json.onboarding_url) {
      log('PASS', 'STEP 6: create-connect-account → onboarding URL returned')
    } else if (res.ok && res.json.account_id) {
      log('PASS', 'STEP 6: create-connect-account → account created', `acct=${res.json.account_id}`)
    } else {
      log('FAIL', 'STEP 6: create-connect-account', `${res.status} ${JSON.stringify(res.json)}`)
    }
  } catch(e) { log('FAIL', 'STEP 6: create-connect-account', e.message) }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎵 MusiGod E2E Test v2 — Growth Plan Signup Flow')
  console.log('━'.repeat(55))
  console.log(`Target: ${BASE_URL}`)
  console.log(`Time:   ${new Date().toISOString()}`)
  console.log('━'.repeat(55) + '\n')

  const reg = await step1_register()
  const artist_id = reg?.artist_id
  const registration_id = reg?.registration_id

  await step2_checkout(artist_id)
  await step3_activate(registration_id)
  await step4_statement(artist_id)
  await step5_payout(artist_id)
  await step6_connect(artist_id)

  console.log('\n' + '━'.repeat(55))
  console.log(`Results: ${passed} passed  ${failed} failed  ${skipped} skipped`)
  if (failed === 0) {
    console.log('🏆 ALL TESTS PASSED')
  } else {
    console.log('⚠️  SOME TESTS FAILED — see above')
  }
  console.log('━'.repeat(55) + '\n')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
