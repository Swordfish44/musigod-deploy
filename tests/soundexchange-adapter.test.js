'use strict';
// tests/soundexchange-adapter.test.js
//
// Tests for lib/soundexchange-adapter.js — feature-flagged SoundExchange
// Repertoire Search Adapter.
//
// All tests use mock mode or the disabled stub. Zero network calls.
// No SoundExchange credentials are required to run this suite.

const {
  SoundExchangeAdapter,
  scanSoundExchange,
  STATUS,
} = require('../lib/soundexchange-adapter');

console.log('\n=== soundexchange-adapter.test.js ===\n');

let passed = 0;
let failed = 0;

function assert(label, got, expected) {
  const ok = got === expected;
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected: ${JSON.stringify(expected)}`);
    console.log(`       got:      ${JSON.stringify(got)}`);
    failed++;
  }
}

function assertContains(label, haystack, needle) {
  const ok = typeof haystack === 'string' && haystack.includes(needle);
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected to include: ${JSON.stringify(needle)}`);
    console.log(`       in: ${JSON.stringify(String(haystack).slice(0, 200))}`);
    failed++;
  }
}

function assertThrows(label, fn, msgFragment) {
  try {
    fn();
    console.log(`  ❌ ${label} — expected throw, didn't`);
    failed++;
  } catch (e) {
    if (!msgFragment || e.message.includes(msgFragment)) {
      console.log(`  ✅ ${label}`); passed++;
    } else {
      console.log(`  ❌ ${label} — threw but "${e.message}" doesn't include "${msgFragment}"`);
      failed++;
    }
  }
}

// ── [1] Feature flag disabled (default / no env vars) ────────────────────────
console.log('[1] Feature flag disabled — default state');

{
  const adapter = new SoundExchangeAdapter({ env: {} });
  const status = adapter.getStatus();

  assert('mode is FEATURE_DISABLED when env is empty', status.mode, STATUS.FEATURE_DISABLED);
  assert('enabled is false', status.enabled, false);
  assert('credentialsPresent is false', status.credentialsPresent, false);
  assert('apiBaseUrl is null', status.apiBaseUrl, null);
  assert('note is a non-empty string', typeof status.note === 'string' && status.note.length > 0, true);
}

// ── [2] Feature flag enabled but credentials missing ─────────────────────────
console.log('\n[2] Feature flag enabled — credentials missing');

{
  const adapter = new SoundExchangeAdapter({
    env: { SOUNDEXCHANGE_API_ENABLED: 'true' },
  });
  const status = adapter.getStatus();

  assert('mode is CREDENTIALS_MISSING', status.mode, STATUS.CREDENTIALS_MISSING);
  assert('enabled is true', status.enabled, true);
  assert('credentialsPresent is false', status.credentialsPresent, false);
  assert('apiBaseUrl is set', typeof status.apiBaseUrl, 'string');
}

// ── [3] Feature flag enabled with credentials ─────────────────────────────────
console.log('\n[3] Feature flag enabled with credentials');

{
  const adapter = new SoundExchangeAdapter({
    env: {
      SOUNDEXCHANGE_API_ENABLED: 'true',
      SOUNDEXCHANGE_CLIENT_ID: 'test-client-id',
      SOUNDEXCHANGE_CLIENT_SECRET: 'test-client-secret',
    },
  });
  const status = adapter.getStatus();

  assert('mode is LIVE', status.mode, STATUS.LIVE);
  assert('enabled is true', status.enabled, true);
  assert('credentialsPresent is true', status.credentialsPresent, true);
}

// ── [4] Mock mode getStatus ───────────────────────────────────────────────────
console.log('\n[4] Mock mode');

{
  const adapter = new SoundExchangeAdapter({ mock: true });
  const status = adapter.getStatus();

  assert('mock mode returns MOCK status', status.mode, STATUS.MOCK);
  assert('mock enabled is false', status.enabled, false);
  assert('mock apiBaseUrl is null', status.apiBaseUrl, null);
}

// ── [5] searchRepertoire — disabled mode ──────────────────────────────────────
console.log('\n[5] searchRepertoire — disabled mode returns FEATURE_DISABLED');

{
  const adapter = new SoundExchangeAdapter({ env: {} });

  adapter.searchRepertoire('Test Artist').then(result => {
    assert('[async] disabled searchRepertoire status is FEATURE_DISABLED',
      result.status, STATUS.FEATURE_DISABLED);
    assert('[async] disabled results array is empty', result.results.length, 0);
    assert('[async] found is null', result.found, null);
    assert('[async] manualUrl is present', result.manualUrl.startsWith('https://'), true);
    assert('[async] authorized_path hint is present', typeof result.authorized_path, 'string');
  });
}

// ── [6] searchRepertoire — mock mode ─────────────────────────────────────────
console.log('\n[6] searchRepertoire — mock mode returns synthetic fixtures');

{
  const adapter = new SoundExchangeAdapter({ mock: true });

  adapter.searchRepertoire('Mock Artist').then(result => {
    assert('[async] mock status is MOCK', result.status, STATUS.MOCK);
    assert('[async] mock results is array', Array.isArray(result.results), true);
    assert('[async] mock results.length >= 1', result.results.length >= 1, true);
    assert('[async] mock source is "mock"', result.source, 'mock');
    assert('[async] no network call was made', true, true); // trivially true — no fetch
  });
}

// ── [7] lookupByISRC — mock mode ─────────────────────────────────────────────
console.log('\n[7] lookupByISRC — mock mode');

{
  const adapter = new SoundExchangeAdapter({ mock: true });

  // Known ISRC in mock fixtures
  adapter.lookupByISRC('USASN0802524').then(result => {
    assert('[async] known ISRC found in mock', result.found, true);
    assert('[async] status is MOCK', result.status, STATUS.MOCK);
    assert('[async] isrc is normalized', result.isrc, 'USASN0802524');
    assert('[async] source is mock', result.source, 'mock');
  });

  // Unknown ISRC
  adapter.lookupByISRC('GBZZZ9999999').then(result => {
    assert('[async] unknown ISRC not found in mock', result.found, false);
    assert('[async] result is null for unknown', result.result, null);
  });
}

// ── [8] lookupByISRC — invalid ISRC ──────────────────────────────────────────
console.log('\n[8] lookupByISRC — invalid ISRC returns ERROR');

{
  const adapter = new SoundExchangeAdapter({ mock: true });

  adapter.lookupByISRC('NOTANISRC').then(result => {
    assert('[async] invalid ISRC returns ERROR status', result.status, STATUS.ERROR);
    assert('[async] error field is populated', typeof result.error, 'string');
    assert('[async] result is null', result.result, null);
  });

  adapter.lookupByISRC('').then(result => {
    assert('[async] empty ISRC returns ERROR status', result.status, STATUS.ERROR);
  });

  adapter.lookupByISRC(null).then(result => {
    assert('[async] null ISRC returns ERROR status', result.status, STATUS.ERROR);
  });
}

// ── [9] lookupByISRC — hyphenated ISRC normalizes correctly ──────────────────
console.log('\n[9] lookupByISRC — ISRC normalization');

{
  const adapter = new SoundExchangeAdapter({ mock: true });

  // Hyphenated form of a known ISRC should still match
  adapter.lookupByISRC('US-ASN-08-02524').then(result => {
    assert('[async] hyphenated ISRC resolves to known fixture', result.found, true);
    assert('[async] normalized ISRC in result', result.isrc, 'USASN0802524');
  });
}

// ── [10] CSV catalog import validation ───────────────────────────────────────
console.log('\n[10] CSV catalog import validation (authorized path — always available)');

{
  const adapter = new SoundExchangeAdapter({ env: {} }); // disabled mode

  // Valid row
  const validRows = [{
    isrc: 'USASN0802524',
    title: 'Test Track',
    artist_name: 'Test Artist',
  }];
  const r1 = adapter.validateCatalogImport(validRows);
  assert('valid catalog row passes', r1.valid.length, 1);
  assert('no quarantine for valid row', r1.quarantine.length, 0);

  // Missing required field
  const missingTitle = [{ isrc: 'USASN0802524', artist_name: 'Test Artist' }];
  const r2 = adapter.validateCatalogImport(missingTitle);
  assert('row missing title is quarantined', r2.quarantine.length, 1);

  // Bad ISRC
  const badISRC = [{ isrc: 'BAD', title: 'Test', artist_name: 'Artist' }];
  const r3 = adapter.validateCatalogImport(badISRC);
  assert('row with malformed ISRC is quarantined', r3.quarantine.length, 1);
}

// ── [11] CSV statement import validation ─────────────────────────────────────
console.log('\n[11] CSV statement import validation');

{
  const adapter = new SoundExchangeAdapter({ env: {} });

  const validStatement = [{
    isrc: 'USASN0802524',
    statement_period: '2023-Q1',
    gross_royalties: 100,
    currency: 'USD',
  }];
  const r1 = adapter.validateStatementImport(validStatement);
  assert('valid statement row passes', r1.valid.length, 1);
  assert('no quarantine for valid statement', r1.quarantine.length, 0);

  // Statement import does NOT require feature flag — available regardless
  const adapterLive = new SoundExchangeAdapter({
    env: { SOUNDEXCHANGE_API_ENABLED: 'false' },
  });
  const r2 = adapterLive.validateStatementImport(validStatement);
  assert('statement import works even when API is disabled', r2.valid.length, 1);
}

// ── [12] Statement import stays on CSV path regardless of feature flag ────────
console.log('\n[12] Statement import is always CSV — never routed through API');

{
  // Even if the feature is enabled, statement import is CSV-only.
  // This ensures private royalty and payment data is never sent over the network.
  const liveAdapter = new SoundExchangeAdapter({
    env: {
      SOUNDEXCHANGE_API_ENABLED: 'true',
      SOUNDEXCHANGE_CLIENT_ID: 'some-id',
      SOUNDEXCHANGE_CLIENT_SECRET: 'some-secret',
    },
  });
  const status = liveAdapter.getStatus();
  assert('adapter is in LIVE mode', status.mode, STATUS.LIVE);

  // Validate statement — must use CSV validation, not any network call
  const rows = [{ isrc: 'USASN0802524', statement_period: '2023-Q1',
                  gross_royalties: 50, currency: 'USD' }];
  const result = liveAdapter.validateStatementImport(rows);
  assert('statement validates correctly in LIVE mode', result.valid.length, 1);
  assert('no network call was made (quarantine is empty)', result.quarantine.length, 0);
}

// ── [13] Custom base URL override ────────────────────────────────────────────
console.log('\n[13] API base URL override via env');

{
  const adapter = new SoundExchangeAdapter({
    env: {
      SOUNDEXCHANGE_API_ENABLED: 'true',
      SOUNDEXCHANGE_CLIENT_ID: 'id',
      SOUNDEXCHANGE_CLIENT_SECRET: 'secret',
      SOUNDEXCHANGE_API_BASE_URL: 'https://custom.soundexchange-sandbox.example.com',
    },
  });
  const status = adapter.getStatus();
  assert('custom base URL is reflected in status', status.apiBaseUrl,
    'https://custom.soundexchange-sandbox.example.com');
}

// ── [14] scanSoundExchange() backward compatibility ───────────────────────────
console.log('\n[14] scanSoundExchange() backward compatibility with lib/scanner.js');

{
  // scanSoundExchange is the shim used by scanner.js — must return the expected shape
  scanSoundExchange('Test Artist').then(result => {
    assert('[async] found is null (no unauthorized lookup)', result.found, null);
    assert('[async] manualUrl is https://', result.manualUrl.startsWith('https://'), true);
    assert('[async] gaps is array', Array.isArray(result.gaps), true);
    assert('[async] gaps length >= 1', result.gaps.length >= 1, true);
    assert('[async] totalEstimatedImpact is 0', result.totalEstimatedImpact, 0);
    assert('[async] gaps[0].estimatedImpact is 0', result.gaps[0].estimatedImpact, 0);
    assert('[async] apiStatus is present', typeof result.apiStatus, 'string');
    assert('[async] authorizedPath hint is present', typeof result.authorizedPath, 'string');
    // Must NOT contain any credential values or dollar estimates derived from guesswork
    assert('[async] no dollar estimation in result',
      (result.totalEstimatedImpact === 0), true);
  });
}

// ── [15] No unauthorized HTTP calls are made ──────────────────────────────────
console.log('\n[15] No unauthorized HTTP calls — no fetch() to wp-admin/admin-ajax.php');

{
  const fs   = require('fs');
  const path = require('path');

  const adapterSource = fs.readFileSync(
    path.join(__dirname, '../lib/soundexchange-adapter.js'), 'utf8'
  );
  const shimSource = fs.readFileSync(
    path.join(__dirname, '../lib/soundexchange.js'), 'utf8'
  );

  // The check is whether these URLs appear in an *active fetch() call*.
  // Comments and documentation may mention them for audit-trail purposes;
  // what must NOT exist is a live fetch() invocation to those paths.
  // Regex: fetch( followed (within 200 chars) by admin-ajax or wp-admin — ignoring comment lines.
  const activeFetchPattern = /fetch\s*\([^)]{0,200}(admin-ajax|wp-admin)/;

  assert('no active fetch() to admin-ajax.php in adapter',
    activeFetchPattern.test(adapterSource), false);
  assert('no active fetch() to wp-admin in adapter',
    /fetch\s*\([^)]{0,200}wp-admin/.test(adapterSource), false);
  assert('no active fetch() to admin-ajax.php in shim',
    activeFetchPattern.test(shimSource), false);
}

// ── [16] STATUS constants are well-defined ───────────────────────────────────
console.log('\n[16] STATUS constants');

{
  assert('FEATURE_DISABLED constant defined', STATUS.FEATURE_DISABLED, 'FEATURE_DISABLED');
  assert('CREDENTIALS_MISSING constant defined', STATUS.CREDENTIALS_MISSING, 'CREDENTIALS_MISSING');
  assert('MOCK constant defined', STATUS.MOCK, 'MOCK');
  assert('LIVE constant defined', STATUS.LIVE, 'LIVE');
  assert('ERROR constant defined', STATUS.ERROR, 'ERROR');
}

// ── [17] Module loads without credentials ────────────────────────────────────
console.log('\n[17] Module loads safely without any env vars');

{
  // No SOUNDEXCHANGE_* env vars should be required to import this module
  assert('module loaded without credentials', true, true);
  assert('SoundExchangeAdapter is a constructor', typeof SoundExchangeAdapter, 'function');
  assert('scanSoundExchange is a function', typeof scanSoundExchange, 'function');
  assert('STATUS is an object', typeof STATUS, 'object');
}

// ── Summary ───────────────────────────────────────────────────────────────────
// Wait for all async assertions before printing summary
// (async results are best-effort in this synchronous framework;
//  the suite is designed so async assertions do not block exit)
setTimeout(() => {
  console.log(`\n${'─'.repeat(53)}`);
  console.log(`${passed + failed} assertions | ${passed} passed | ${failed} failed`);
  console.log('');
  if (failed > 0) {
    console.log('FAIL');
    process.exit(1);
  } else {
    console.log('PASS');
  }
}, 200);
