'use strict';
// tests/intake-tokens.test.js
// Unit tests for lib/intake-tokens.js and lib/intake-rate-limit.js
// Zero DB calls, zero network. All pure-function paths only.

const {
  TOKEN_TYPES,
  TOKEN_TTL,
  generateRawToken,
  hashToken,
  buildTokenRecord,
  verifyToken,
  buildConsumptionUpdate,
  buildRevocationUpdate,
} = require('../lib/intake-tokens')

const { checkRateLimit, _clearStore } = require('../lib/intake-rate-limit')

let passed = 0
let failed = 0

function assert(label, got, expected) {
  if (got === expected) {
    console.log(`  ✓ [${++passed}] ${label}`)
  } else {
    console.error(`  ✗ [${++failed + passed - 1}] FAIL: ${label}`)
    console.error(`      expected: ${JSON.stringify(expected)}`)
    console.error(`      got:      ${JSON.stringify(got)}`)
  }
}

function assertDeep(label, got, expected) {
  const g = JSON.stringify(got)
  const e = JSON.stringify(expected)
  if (g === e) {
    console.log(`  ✓ [${++passed}] ${label}`)
  } else {
    console.error(`  ✗ [${++failed + passed - 1}] FAIL: ${label}`)
    console.error(`      expected: ${e}`)
    console.error(`      got:      ${g}`)
  }
}

function assertThrows(label, fn, expectedSubstring) {
  try {
    fn()
    console.error(`  ✗ [${++failed + passed - 1}] FAIL (no throw): ${label}`)
  } catch (err) {
    if (!expectedSubstring || err.message.includes(expectedSubstring)) {
      console.log(`  ✓ [${++passed}] ${label}`)
    } else {
      console.error(`  ✗ [${++failed + passed - 1}] FAIL (wrong error): ${label}`)
      console.error(`      expected message to include: "${expectedSubstring}"`)
      console.error(`      got: "${err.message}"`)
    }
  }
}

// ── Section 1: generateRawToken ───────────────────────────────────────────────
console.log('\n── generateRawToken ──')

const t1 = generateRawToken()
const t2 = generateRawToken()

assert('returns a non-empty string', typeof t1, 'string')
assert('length is 43 chars (32 bytes base64url)', t1.length, 43)
assert('each call produces a different token', t1 === t2, false)
assert('contains only base64url chars', /^[A-Za-z0-9_-]+$/.test(t1), true)

// ── Section 2: hashToken ──────────────────────────────────────────────────────
console.log('\n── hashToken ──')

const raw = generateRawToken()
const h1  = hashToken(raw)
const h2  = hashToken(raw)

assert('produces a 64-char hex string', h1.length, 64)
assert('is deterministic for the same input', h1, h2)
assert('two different tokens produce different hashes', hashToken(generateRawToken()) === h1, false)
assert('output is lowercase hex', /^[a-f0-9]+$/.test(h1), true)
assertThrows('throws on empty string', () => hashToken(''), 'rawToken must be a non-empty string')
assertThrows('throws on null',         () => hashToken(null), 'rawToken must be a non-empty string')

// ── Section 3: buildTokenRecord ───────────────────────────────────────────────
console.log('\n── buildTokenRecord ──')

const rawDoc = generateRawToken()
const recDoc = buildTokenRecord({
  rawToken:     rawDoc,
  tokenType:    'document_upload',
  artistEmail:  'Artist@Test.com',
  artistId:     'abc-123',
  engagementId: 'eng-001',
  createdBy:    'operator',
  auditNote:    'pilot test',
})

assert('token_hash stored (not raw)', recDoc.token_hash, hashToken(rawDoc))
assert('raw token not in record', recDoc.rawToken, undefined)
assert('token_hash is 64 hex chars', recDoc.token_hash.length, 64)
assert('token_type set correctly', recDoc.token_type, 'document_upload')
assert('artist_email is lowercased', recDoc.artist_email, 'artist@test.com')
assert('artist_id preserved', recDoc.artist_id, 'abc-123')
assert('engagement_id preserved', recDoc.engagement_id, 'eng-001')
assert('used_at starts null', recDoc.used_at, null)
assert('consumed_by starts null', recDoc.consumed_by, null)
assert('revoked_at starts null', recDoc.revoked_at, null)
assert('created_by preserved', recDoc.created_by, 'operator')
assert('audit_note preserved', recDoc.audit_note, 'pilot test')
assert('expires_at is in the future',
  new Date(recDoc.expires_at) > new Date(), true)

// Check TTL: document_upload = 24h
const expectedExpiry = Date.now() + TOKEN_TTL.document_upload * 1000
const actualExpiry   = new Date(recDoc.expires_at).getTime()
assert('document_upload expires in ~24h (within 5s margin)',
  Math.abs(actualExpiry - expectedExpiry) < 5000, true)

// agreement_sign TTL
const rawSign = generateRawToken()
const recSign = buildTokenRecord({
  rawToken: rawSign, tokenType: 'agreement_sign',
  artistEmail: 'a@b.com', createdBy: 'system',
})
const signExpiry = new Date(recSign.expires_at).getTime()
const expectedSignExpiry = Date.now() + TOKEN_TTL.agreement_sign * 1000
assert('agreement_sign expires in ~72h (within 5s margin)',
  Math.abs(signExpiry - expectedSignExpiry) < 5000, true)

assertThrows('throws on unknown tokenType',
  () => buildTokenRecord({ rawToken: raw, tokenType: 'bad', artistEmail: 'a@b.com', createdBy: 'x' }),
  'unknown tokenType')
assertThrows('throws on missing artistEmail',
  () => buildTokenRecord({ rawToken: raw, tokenType: 'document_upload', artistEmail: '', createdBy: 'x' }),
  'artistEmail is required')
assertThrows('throws on missing createdBy',
  () => buildTokenRecord({ rawToken: raw, tokenType: 'document_upload', artistEmail: 'a@b.com', createdBy: '' }),
  'createdBy is required')
assertThrows('throws on missing rawToken',
  () => buildTokenRecord({ rawToken: '', tokenType: 'document_upload', artistEmail: 'a@b.com', createdBy: 'x' }),
  'rawToken is required')

// ── Section 4: verifyToken — happy path ───────────────────────────────────────
console.log('\n── verifyToken — valid cases ──')

const rawV = generateRawToken()
const recV = buildTokenRecord({
  rawToken: rawV, tokenType: 'document_upload',
  artistEmail: 'esham@musigod.com', engagementId: 'eng-pilot',
  createdBy: 'operator',
})

const okFull = verifyToken(rawV, recV, {
  artistEmail: 'esham@musigod.com',
  tokenType:   'document_upload',
  engagementId: 'eng-pilot',
})
assert('full-match returns valid', okFull.valid, true)
assert('full-match reason is OK',  okFull.reason, 'OK')

const okNoScope = verifyToken(rawV, recV, {})
assert('no-scope options also valid', okNoScope.valid, true)

const okEmailCaseInsensitive = verifyToken(rawV, recV, {
  artistEmail: 'ESHAM@MUSIGOD.COM',
})
assert('artist_email match is case-insensitive', okEmailCaseInsensitive.valid, true)

// ── Section 5: verifyToken — failure cases ────────────────────────────────────
console.log('\n── verifyToken — rejection cases ──')

assert('rejects missing token',
  verifyToken('', recV, {}).valid, false)
assert('rejects missing record',
  verifyToken(rawV, null, {}).valid, false)
assert('rejects wrong raw token (hash mismatch)',
  verifyToken(generateRawToken(), recV, {}).valid, false)
assert('rejects wrong token type',
  verifyToken(rawV, recV, { tokenType: 'agreement_sign' }).valid, false)
assert('rejects wrong artist email',
  verifyToken(rawV, recV, { artistEmail: 'other@example.com' }).valid, false)
assert('rejects wrong engagement_id',
  verifyToken(rawV, recV, { engagementId: 'wrong-eng' }).valid, false)

// Revoked token
const revoked = { ...recV, revoked_at: new Date().toISOString() }
assert('rejects revoked token', verifyToken(rawV, revoked, {}).valid, false)
assert('revoked reason', verifyToken(rawV, revoked, {}).reason, 'Token has been revoked')

// Used token
const used = { ...recV, used_at: new Date().toISOString() }
assert('rejects already-used token', verifyToken(rawV, used, {}).valid, false)
assert('used reason', verifyToken(rawV, used, {}).reason, 'Token has already been used')

// Expired token
const expired = { ...recV, expires_at: new Date(Date.now() - 1000).toISOString() }
assert('rejects expired token', verifyToken(rawV, expired, {}).valid, false)
assert('expired reason', verifyToken(rawV, expired, {}).reason, 'Token has expired')

// ── Section 6: buildConsumptionUpdate ─────────────────────────────────────────
console.log('\n── buildConsumptionUpdate ──')

const cu = buildConsumptionUpdate('upload-artist-document')
assert('sets used_at', typeof cu.used_at, 'string')
assert('sets consumed_by', cu.consumed_by, 'upload-artist-document')
assert('used_at is recent', new Date(cu.used_at) > new Date(Date.now() - 1000), true)

const cuDefault = buildConsumptionUpdate()
assert('consumed_by defaults to api', cuDefault.consumed_by, 'api')

// ── Section 7: buildRevocationUpdate ──────────────────────────────────────────
console.log('\n── buildRevocationUpdate ──')

const rv = buildRevocationUpdate('operator-admin', 'artist withdrew')
assert('sets revoked_at', typeof rv.revoked_at, 'string')
assert('sets revoked_by', rv.revoked_by, 'operator-admin')
assert('sets revocation_reason', rv.revocation_reason, 'artist withdrew')

assertThrows('throws on missing revokedBy',
  () => buildRevocationUpdate(''),
  'revokedBy is required')

// ── Section 8: TOKEN_TYPES constants ──────────────────────────────────────────
console.log('\n── TOKEN_TYPES ──')

assert('DOCUMENT_UPLOAD value', TOKEN_TYPES.DOCUMENT_UPLOAD, 'document_upload')
assert('AGREEMENT_SIGN value',  TOKEN_TYPES.AGREEMENT_SIGN,  'agreement_sign')

// ── Section 9: rate limiter ───────────────────────────────────────────────────
console.log('\n── checkRateLimit ──')

_clearStore()

const rl1 = checkRateLimit('ip-test', { windowSecs: 60, maxRequests: 3 })
assert('first call allowed', rl1.allowed, true)
assert('remaining after 1st', rl1.remaining, 2)

const rl2 = checkRateLimit('ip-test', { windowSecs: 60, maxRequests: 3 })
assert('second call allowed', rl2.allowed, true)
assert('remaining after 2nd', rl2.remaining, 1)

const rl3 = checkRateLimit('ip-test', { windowSecs: 60, maxRequests: 3 })
assert('third call allowed', rl3.allowed, true)
assert('remaining after 3rd', rl3.remaining, 0)

const rl4 = checkRateLimit('ip-test', { windowSecs: 60, maxRequests: 3 })
assert('fourth call blocked', rl4.allowed, false)
assert('retryAfterSecs is positive', rl4.retryAfterSecs > 0, true)

const rl5 = checkRateLimit('different-ip', { windowSecs: 60, maxRequests: 3 })
assert('different key is independent', rl5.allowed, true)

_clearStore()
const rlNew = checkRateLimit('ip-fresh', { windowSecs: 60, maxRequests: 5 })
assert('fresh window after clear', rlNew.allowed, true)
assert('remaining after clear', rlNew.remaining, 4)

// ── Section 10: idempotency / edge cases ──────────────────────────────────────
console.log('\n── Edge cases ──')

// Engagement-scoped token with null engagement_id in record should accept any engagement
const rawAny = generateRawToken()
const recAny = buildTokenRecord({
  rawToken: rawAny, tokenType: 'document_upload',
  artistEmail: 'any@test.com', engagementId: null, createdBy: 'op',
})
const anyEngResult = verifyToken(rawAny, recAny, {
  artistEmail: 'any@test.com', engagementId: 'some-engagement',
})
assert('token with null engagement_id accepts any engagement', anyEngResult.valid, true)

// Token record with specific engagement must reject different engagement
const rawScoped = generateRawToken()
const recScoped = buildTokenRecord({
  rawToken: rawScoped, tokenType: 'document_upload',
  artistEmail: 'scoped@test.com', engagementId: 'eng-A', createdBy: 'op',
})
assert('scoped token rejects wrong engagement',
  verifyToken(rawScoped, recScoped, { engagementId: 'eng-B' }).valid, false)
assert('scoped token accepts correct engagement',
  verifyToken(rawScoped, recScoped, { engagementId: 'eng-A' }).valid, true)

// ── Results ───────────────────────────────────────────────────────────────────
console.log(`\n── Results: ${passed} passed, ${failed} failed ──\n`)
if (failed > 0) {
  console.error(`${failed} test(s) failed.`)
  process.exit(1)
}
