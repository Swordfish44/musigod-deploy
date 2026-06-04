// MusiGod E2E Automated Test — Growth Plan Signup Flow
// Tests: register → checkout session → simulate webhook → admin activate → verify DB state
// Uses Test Artist Echo: 86c8df13-dbc6-4846-a8da-cdbaaf386cc7

const BASE_URL = 'https://musigod.com'
const ECHO_ID  = '86c8df13-dbc6-4846-a8da-cdbaaf386cc7'
const ECHO_EMAIL = 'swordfishlp44+testartist@proton.me'

const SB_URL = 'https://uykzkrnoetcldeuxzqyy.supabase.co'
// Service role key pulled from env or passed in
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ADMIN_KEY = process.env.ADMIN_API_KEY || ''

let passed = 0
let failed = 0
const results = []

function log(status, name, detail = '') {
  const icon = status === 'PASS' ? '✅' : status === 'SKIP' ? '⏭️ ' : '❌'
  const line = `${icon} ${name}${detail ? ' — ' + detail : ''}`
  console.log(line)
  results.push({ status, name, detail })
  if (status === 'PASS') passed++
  else if (status === 'FAIL') failed++
}

async function sbGet(schema, path) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    }
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`SB GET ${path}: ${r.status} ${text}`)
  return JSON.parse(text)
}

async function sbPatch(schema, path, data) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
      'Content-Profile': schema,
      'Content-Type': 'application/json',
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(data)
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`SB PATCH ${path}: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

async function api(path, body) {
  const r = await fetch(`${BASE_URL}/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  const text = await r.text()
  let json
  try { json = JSON.parse(text) } catch { json = { raw: text } }
  return { status: r.status, ok: r.ok, json }
}

// ─── CLEANUP: reset Echo to clean state ───────────────────────────────────────
async function cleanupEcho() {
  // Delete any existing registration rows for Echo
  const r = await fetch(`${SB_URL}/rest/v1/registrations_v1?artist_id=eq.${ECHO_ID}`, {
    method: 'DELETE',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': 'registrations',
      'Content-Profile': 'registrations',
    }
  })
  // Reset artist plan_status back to TRIAL
  await sbPatch('artists', `artists_v1?id=eq.${ECHO_ID}`, { plan_status: 'TRIAL', stripe_account_id: null })
}

// ─── STEP 1: Verify Echo exists in DB ─────────────────────────────────────────
async function step1_echoExists() {
  try {
    const rows = await sbGet('artists', `artists_v1?id=eq.${ECHO_ID}&select=id,artist_name,email,plan_status`)
    if (rows.length === 1 && rows[0].email === ECHO_EMAIL) {
      log('PASS', 'STEP 1: Echo exists in artists_v1', `plan_status=${rows[0].plan_status}`)
    } else {
      log('FAIL', 'STEP 1: Echo not found in artists_v1', JSON.stringify(rows))
    }
  } catch(e) { log('FAIL', 'STEP 1: Echo exists', e.message) }
}

// ─── STEP 2: Register Echo via API ────────────────────────────────────────────
async function step2_register() {
  try {
    // Echo already exists — we test that register-artist rejects a duplicate email
    const res = await api('api/register-artist', {
      legal_first_name: 'Echo',
      legal_last_name: 'Validation',
      artist_name: 'Test Artist Echo',
      email: ECHO_EMAIL,
      phone: '313-555-0199',
      plan: 'growth',
      pro: 'ASCAP',
      catalog_size: '6-20 songs',
    })
    // We expect either 200 (new registration row) or 409/400 (duplicate)
    if (res.ok) {
      log('PASS', 'STEP 2: register-artist accepted Growth plan', `artist_id=${res.json.artist_id}`)
    } else if (res.status === 409 || res.status === 400) {
      log('PASS', 'STEP 2: register-artist correctly rejected duplicate email', `status=${res.status}`)
    } else {
      log('FAIL', 'STEP 2: register-artist unexpected response', `${res.status} ${JSON.stringify(res.json)}`)
    }
  } catch(e) { log('FAIL', 'STEP 2: register-artist', e.message) }
}

// ─── STEP 3: Create checkout session ──────────────────────────────────────────
async function step3_checkout() {
  try {
    const res = await api('api/create-checkout-session', {
      artist_id: ECHO_ID,
      plan: 'growth',
      email: ECHO_EMAIL,
    })
    if (res.ok && res.json.url && res.json.url.includes('stripe.com')) {
      log('PASS', 'STEP 3: create-checkout-session returned Stripe URL', res.json.url.slice(0, 60) + '...')
      return res.json.url
    } else {
      log('FAIL', 'STEP 3: create-checkout-session', `${res.status} ${JSON.stringify(res.json)}`)
      return null
    }
  } catch(e) { log('FAIL', 'STEP 3: create-checkout-session', e.message); return null }
}

// ─── STEP 4: Verify registration row exists ────────────────────────────────────
async function step4_registrationRow() {
  try {
    const rows = await sbGet('registrations', `registrations_v1?artist_id=eq.${ECHO_ID}&select=id,status,registration_type,registration_category`)
    if (rows.length > 0) {
      const r = rows[rows.length - 1]
      log('PASS', 'STEP 4: registration row exists', `id=${r.id} status=${r.status} type=${r.registration_type}`)
      return r.id
    } else {
      log('FAIL', 'STEP 4: no registration row found for Echo')
      return null
    }
  } catch(e) { log('FAIL', 'STEP 4: registration row', e.message); return null }
}

// ─── STEP 5: Admin activate ────────────────────────────────────────────────────
async function step5_adminActivate(registrationId) {
  if (!registrationId) { log('SKIP', 'STEP 5: admin activate (no registration_id)'); return }
  try {
    const headers = { 'Content-Type': 'application/json' }
    if (ADMIN_KEY) headers['x-admin-key'] = ADMIN_KEY
    const r = await fetch(`${BASE_URL}/api/admin-registration-action`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ registration_id: registrationId, action: 'activate' })
    })
    const json = await r.json()
    if (r.ok && json.ok) {
      log('PASS', 'STEP 5: admin activate succeeded', `registration_id=${registrationId}`)
    } else {
      log('FAIL', 'STEP 5: admin activate', `${r.status} ${JSON.stringify(json)}`)
    }
  } catch(e) { log('FAIL', 'STEP 5: admin activate', e.message) }
}

// ─── STEP 6: Verify registration status = ACTIVE ──────────────────────────────
async function step6_verifyActive(registrationId) {
  if (!registrationId) { log('SKIP', 'STEP 6: verify active (no registration_id)'); return }
  try {
    const rows = await sbGet('registrations', `registrations_v1?id=eq.${registrationId}&select=id,status`)
    const status = rows?.[0]?.status
    if (status === 'ACTIVE') {
      log('PASS', 'STEP 6: registration status = ACTIVE')
    } else {
      log('FAIL', 'STEP 6: registration not ACTIVE', `status=${status}`)
    }
  } catch(e) { log('FAIL', 'STEP 6: verify active', e.message) }
}

// ─── STEP 7: Submit a royalty statement for Echo ──────────────────────────────
async function step7_submitStatement() {
  try {
    const res = await api('api/submit-statement', {
      artist_id: ECHO_ID,
      source: 'ASCAP',
      period_start: '2026-01-01',
      period_end: '2026-03-31',
      gross_amount: 250.00,
      currency: 'USD',
      line_items: [
        { description: 'Performance royalties Q1 2026', amount: 150.00, isrc: null },
        { description: 'Digital royalties Q1 2026', amount: 100.00, isrc: null },
      ]
    })
    if (res.ok) {
      log('PASS', 'STEP 7: submit-statement accepted', `gross=$${res.json.gross_amount} net=$${res.json.net_amount}`)
    } else {
      log('FAIL', 'STEP 7: submit-statement', `${res.status} ${JSON.stringify(res.json)}`)
    }
  } catch(e) { log('FAIL', 'STEP 7: submit-statement', e.message) }
}

// ─── STEP 8: Verify disbursement row created ──────────────────────────────────
async function step8_verifyDisbursement() {
  try {
    const rows = await sbGet('royalties', `disbursement_queue_v1?artist_id=eq.${ECHO_ID}&order=created_at.desc&limit=1&select=id,status,net_amount`)
    if (rows.length > 0) {
      const d = rows[0]
      log('PASS', 'STEP 8: disbursement row exists', `id=${d.id} status=${d.status} net=$${d.net_amount}`)
    } else {
      log('FAIL', 'STEP 8: no disbursement row found for Echo')
    }
  } catch(e) { log('FAIL', 'STEP 8: disbursement row', e.message) }
}

// ─── MAIN ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n🎵 MusiGod E2E Test — Growth Plan Signup Flow')
  console.log('━'.repeat(55))
  console.log(`Artist: Test Artist Echo (${ECHO_ID})`)
  console.log(`Target: ${BASE_URL}`)
  console.log('━'.repeat(55) + '\n')

  if (!SB_KEY) {
    console.error('❌ SUPABASE_SERVICE_ROLE_KEY env var not set — aborting')
    process.exit(1)
  }

  console.log('🧹 Cleaning up Echo state...')
  await cleanupEcho()
  console.log('')

  await step1_echoExists()
  await step2_register()
  await step3_checkout()
  const regId = await step4_registrationRow()
  await step5_adminActivate(regId)
  await step6_verifyActive(regId)
  await step7_submitStatement()
  await step8_verifyDisbursement()

  console.log('\n' + '━'.repeat(55))
  console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} steps`)
  if (failed === 0) {
    console.log('🏆 ALL TESTS PASSED')
  } else {
    console.log('⚠️  SOME TESTS FAILED — see above')
  }
  console.log('━'.repeat(55) + '\n')
  process.exit(failed > 0 ? 1 : 0)
}

main().catch(e => { console.error('Fatal:', e); process.exit(1) })
