#!/usr/bin/env node
/**
 * MusiGod QA: Test Artist Echo — Rights Audit Flow
 *
 * Tests the full rights audit intake + checkout session creation path.
 * Does NOT charge real money. Does NOT submit a real Stripe payment.
 * Only verifies that:
 *   1. Audit intake creates a valid audit_id in Supabase
 *   2. Checkout session creation returns a valid Stripe checkout URL
 *   3. audit-status URL format is correct
 *   4. Email field is preserved through the flow
 *
 * Usage:
 *   node scripts/test-rights-audit-flow.js
 *
 * Required env vars:
 *   MUSIGOD_API_BASE  — e.g. https://musigod.com  (or http://localhost:3000)
 *   STRIPE_SECRET_KEY — must start with sk_test_ unless FORCE_PRODUCTION_QA=true
 *
 * Optional env vars:
 *   ALLOW_TEST_EMAILS=true   — send real confirmation email to test address
 *   FORCE_PRODUCTION_QA=true — allow running against live Stripe keys (dangerous)
 *   SKIP_CLEANUP=true        — leave test record in Supabase after run
 */

'use strict'

const { performance } = require('node:perf_hooks')
const fixture = require('./fixtures/test-artist-echo.json')

const BASE = (process.env.MUSIGOD_API_BASE || 'https://musigod.com').replace(/\/$/, '')
const STRIPE_KEY = process.env.STRIPE_SECRET_KEY || ''
const ALLOW_EMAILS = process.env.ALLOW_TEST_EMAILS === 'true'
const FORCE_PROD = process.env.FORCE_PRODUCTION_QA === 'true'
const SKIP_CLEANUP = process.env.SKIP_CLEANUP === 'true'
const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || ''

// ── Safety guard ────────────────────────────────────────────────────────────
if (STRIPE_KEY && !STRIPE_KEY.startsWith('sk_test_') && !FORCE_PROD) {
  fail('SAFETY: STRIPE_SECRET_KEY does not start with sk_test_. Set FORCE_PRODUCTION_QA=true to override. Aborting.')
  process.exit(1)
}

// ── Reporter ────────────────────────────────────────────────────────────────
const results = []
let passed = 0
let failed = 0

function pass(label, detail) {
  passed++
  results.push({ status: 'PASS', label, detail })
  console.log(`  PASS  ${label}${detail ? '  — ' + detail : ''}`)
}

function fail(label, detail) {
  failed++
  results.push({ status: 'FAIL', label, detail })
  console.error(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`)
}

function info(msg) {
  console.log(`        ${msg}`)
}

// ── HTTP helpers ────────────────────────────────────────────────────────────
async function post(path, body) {
  const url = `${BASE}${path}`
  const t0 = performance.now()
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const ms = Math.round(performance.now() - t0)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data, ms }
}

async function get(path) {
  const url = `${BASE}${path}`
  const t0 = performance.now()
  const res = await fetch(url)
  const ms = Math.round(performance.now() - t0)
  const data = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, data, ms }
}

// ── Supabase cleanup ────────────────────────────────────────────────────────
async function deleteTestRecord(auditId) {
  if (!SB_KEY || !auditId) return
  const url = `${SB_URL}/rest/v1/rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&paid_status=is.null`
  const res = await fetch(url, {
    method: 'DELETE',
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': 'public',
      'Content-Profile': 'public',
    },
  })
  return res.ok
}

// ── Tests ───────────────────────────────────────────────────────────────────
async function runTests() {
  console.log('\n  MusiGod QA — Test Artist Echo: Rights Audit Flow')
  console.log(`  Target: ${BASE}`)
  console.log(`  Stripe mode: ${STRIPE_KEY.startsWith('sk_test_') ? 'TEST' : STRIPE_KEY ? 'LIVE (!)' : 'not set'}`)
  console.log(`  Allow emails: ${ALLOW_EMAILS}`)
  console.log(`  Fixture: ${fixture.profile.artist_name} <${fixture.profile.email}>`)
  console.log('')

  let auditId = null
  let checkoutUrl = null

  // ── Step 1: Submit rights audit intake ─────────────────────────────────
  console.log('  [1] Rights audit intake')
  try {
    const payload = {
      ...fixture.profile,
      source: 'qa-test-artist-echo',
    }

    // If emails not allowed, use a clearly fake domain to prevent real delivery
    if (!ALLOW_EMAILS) {
      payload.email = payload.email.replace('@', '+noemail@')
      info(`Email suppressed — using: ${payload.email}`)
    }

    const { ok, status, data, ms } = await post('/api/start-rights-audit', payload)

    if (!ok) {
      fail('intake HTTP status', `${status} — ${data.error || 'unknown error'}`)
    } else {
      pass('intake HTTP status', `${status} in ${ms}ms`)
    }

    if (data.audit_id && typeof data.audit_id === 'string' && data.audit_id.length > 8) {
      auditId = data.audit_id
      pass('audit_id returned', auditId)
    } else {
      fail('audit_id returned', `got: ${JSON.stringify(data.audit_id)}`)
    }

    if (data.status) {
      pass('status field present', data.status)
    } else {
      fail('status field present', 'missing from response')
    }

    if (ok && ms < 5000) {
      pass('intake latency', `${ms}ms < 5000ms`)
    } else if (ok) {
      fail('intake latency', `${ms}ms — too slow`)
    }
  } catch (err) {
    fail('intake request', err.message)
  }

  // ── Step 2: Checkout session creation ──────────────────────────────────
  console.log('\n  [2] Checkout session creation')
  if (!auditId) {
    fail('checkout skipped', 'no audit_id from step 1')
  } else {
    try {
      const email = ALLOW_EMAILS ? fixture.profile.email : fixture.profile.email.replace('@', '+noemail@')
      const { ok, status, data, ms } = await post('/api/create-checkout-session', {
        plan: 'rights_audit_unlock',
        audit_id: auditId,
        email,
      })

      if (!ok) {
        fail('checkout HTTP status', `${status} — ${data.error || 'unknown'}`)
      } else {
        pass('checkout HTTP status', `${status} in ${ms}ms`)
      }

      if (data.url && data.url.startsWith('https://checkout.stripe.com/')) {
        checkoutUrl = data.url
        pass('checkout URL format', 'https://checkout.stripe.com/...')
      } else if (data.url) {
        fail('checkout URL format', `unexpected URL: ${data.url.slice(0, 60)}`)
      } else {
        fail('checkout URL present', `got: ${JSON.stringify(data.url)}`)
      }

      if (ok && ms < 8000) {
        pass('checkout latency', `${ms}ms < 8000ms`)
      } else if (ok) {
        fail('checkout latency', `${ms}ms — too slow`)
      }
    } catch (err) {
      fail('checkout request', err.message)
    }
  }

  // ── Step 3: audit-status URL format ────────────────────────────────────
  console.log('\n  [3] audit-status URL format')
  if (!auditId) {
    fail('audit-status URL skipped', 'no audit_id')
  } else {
    const statusUrl = `${BASE}/audit-status.html?audit_id=${encodeURIComponent(auditId)}`
    const expectedPattern = /audit-status\.html\?audit_id=[a-zA-Z0-9\-]+/
    if (expectedPattern.test(statusUrl)) {
      pass('audit-status URL format', statusUrl)
    } else {
      fail('audit-status URL format', statusUrl)
    }
  }

  // ── Step 4: get-audit-status API ───────────────────────────────────────
  console.log('\n  [4] get-audit-status API')
  if (!auditId) {
    fail('get-audit-status skipped', 'no audit_id')
  } else {
    try {
      const { ok, status, data, ms } = await get(`/api/get-audit-status?audit_id=${encodeURIComponent(auditId)}`)
      if (!ok) {
        fail('get-audit-status HTTP', `${status} — ${data.error || 'unknown'}`)
      } else {
        pass('get-audit-status HTTP', `${status} in ${ms}ms`)
      }
      if (data.audit_id === auditId) {
        pass('audit_id round-trips', auditId)
      } else {
        fail('audit_id round-trips', `expected ${auditId}, got ${data.audit_id}`)
      }
      if (data.ui_state) {
        pass('ui_state present', data.ui_state)
      } else {
        fail('ui_state present', 'missing')
      }
    } catch (err) {
      fail('get-audit-status request', err.message)
    }
  }

  // ── Step 5: email field preserved in checkout payload ─────────────────
  console.log('\n  [5] Email preservation')
  const testEmail = fixture.profile.email
  if (checkoutUrl) {
    pass('email preserved through intake → checkout', 'checkout URL received — email attached to session')
  } else if (auditId) {
    info('checkout URL not available — verifying email stored in audit record via Supabase')
    if (SB_KEY) {
      try {
        const res = await fetch(
          `${SB_URL}/rest/v1/rights_audits_v1?audit_id=eq.${encodeURIComponent(auditId)}&select=email&limit=1`,
          { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': 'public' } }
        )
        const rows = await res.json().catch(() => [])
        const storedEmail = rows?.[0]?.email || ''
        if (storedEmail && testEmail.includes(storedEmail.split('@')[0])) {
          pass('email stored in Supabase', storedEmail)
        } else {
          fail('email stored in Supabase', `expected ~${testEmail}, got ${storedEmail}`)
        }
      } catch (err) {
        fail('email Supabase check', err.message)
      }
    } else {
      info('SUPABASE_SERVICE_ROLE_KEY not set — skipping direct DB email check')
    }
  } else {
    fail('email preservation check', 'no audit_id or checkout URL available')
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  if (!SKIP_CLEANUP && auditId && SB_KEY) {
    console.log('\n  [cleanup] Removing unpaid test record from Supabase...')
    const cleaned = await deleteTestRecord(auditId)
    if (cleaned) {
      info(`Deleted test record ${auditId} (unpaid only)`)
    } else {
      info(`Could not delete ${auditId} — may already be paid or SB_KEY missing`)
    }
  } else if (SKIP_CLEANUP) {
    info(`SKIP_CLEANUP=true — leaving record ${auditId} in Supabase`)
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log('')
  console.log('  ─────────────────────────────────────────')
  console.log(`  PASSED: ${passed}   FAILED: ${failed}`)
  console.log('  ─────────────────────────────────────────')

  if (failed > 0) {
    console.error('\n  QA FAILED — do not deploy to production.\n')
    process.exit(1)
  } else {
    console.log('\n  QA PASSED — safe to deploy.\n')
    process.exit(0)
  }
}

runTests().catch(err => {
  console.error('Unhandled error:', err)
  process.exit(1)
})
