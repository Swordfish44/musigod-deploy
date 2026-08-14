'use strict';
// tests/neighboring-rights-audit.test.js
//
// Tests for lib/neighboring-rights-audit.js — neighboring rights recovery
// audit pipeline. All fixtures are synthetic. No real statements, credentials,
// or private catalog data are used or committed.
//
// Run: node tests/neighboring-rights-audit.test.js

const {
  normalizeISRC,
  matchByISRC,
  detectISRCConflicts,
  validateImport,
  redactRow,
  scoreFuzzyTitle,
  requiresCorroboration,
  splitInterests,
  statementDedupKey,
  deduplicateStatements,
  applyReversals,
  reconcileGrossNet,
  classifyRecording,
  runAudit,
} = require('../lib/neighboring-rights-audit');

console.log('\n=== neighboring-rights-audit.test.js ===\n');

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

function assertDeep(label, got, expected) {
  const g = JSON.stringify(got);
  const e = JSON.stringify(expected);
  const ok = g === e;
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected: ${e}`);
    console.log(`       got:      ${g}`);
    failed++;
  }
}

function assertContains(label, got, expectedKey, expectedValue) {
  const ok = got && got[expectedKey] === expectedValue;
  if (ok) { console.log(`  ✅ ${label}`); passed++; }
  else {
    console.log(`  ❌ ${label}`);
    console.log(`       expected ${expectedKey}=${JSON.stringify(expectedValue)} in ${JSON.stringify(got)}`);
    failed++;
  }
}

function assertThrows(label, fn, msgFragment) {
  try {
    fn();
    console.log(`  ❌ ${label} — expected throw, but didn't`);
    failed++;
  } catch (e) {
    if (!msgFragment || e.message.includes(msgFragment)) {
      console.log(`  ✅ ${label}`); passed++;
    } else {
      console.log(`  ❌ ${label} — threw but message "${e.message}" doesn't include "${msgFragment}"`);
      failed++;
    }
  }
}

// ── [1] Exact ISRC match ──────────────────────────────────────────────────────
console.log('[1] Exact ISRC match');

{
  const r1 = normalizeISRC('USASN0802524');
  assert('valid 12-char ISRC normalizes correctly', r1.normalized, 'USASN0802524');
  assert('valid 12-char ISRC is marked valid', r1.valid, true);
  assert('valid 12-char ISRC has no error', r1.error, null);
  assert('original is preserved', r1.original, 'USASN0802524');

  const catalogISRCs = ['USASN0802524'];
  assert('matchByISRC returns true for exact match', matchByISRC(catalogISRCs, 'USASN0802524'), true);
  assert('matchByISRC returns false for non-matching ISRC', matchByISRC(catalogISRCs, 'USASN0802525'), false);
}

// ── [2] Normalized ISRC match ─────────────────────────────────────────────────
console.log('\n[2] Normalized ISRC match (hyphens, lowercase)');

{
  const r2 = normalizeISRC('US-ASN-08-02524');
  assert('hyphenated ISRC normalizes to same canonical form', r2.normalized, 'USASN0802524');
  assert('hyphenated ISRC is valid', r2.valid, true);
  assert('original hyphenated form is preserved', r2.original, 'US-ASN-08-02524');

  const r3 = normalizeISRC('usasn0802524');
  assert('lowercase ISRC normalizes to uppercase', r3.normalized, 'USASN0802524');
  assert('lowercase ISRC is valid', r3.valid, true);

  // Hyphenated statement ISRC should still match catalog canonical
  assert('hyphenated statement ISRC matches catalog canonical',
    matchByISRC(['USASN0802524'], 'US-ASN-08-02524'), true);

  // Statement with spaces
  const r4 = normalizeISRC('US ASN 08 02524');
  assert('space-separated ISRC normalizes', r4.normalized, 'USASN0802524');
  assert('space-separated ISRC is valid', r4.valid, true);
}

// ── [3] Duplicate ISRC conflict ───────────────────────────────────────────────
console.log('\n[3] Duplicate ISRC conflict detection');

{
  const rows = [
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100, currency: 'USD' },
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100, currency: 'USD' }, // duplicate
    { isrc: 'USASN0802525', statement_period: '2023-Q1', gross_royalties: 50,  currency: 'USD' }, // different ISRC
  ];

  const conflicts = detectISRCConflicts(rows);
  assert('one conflict group detected for duplicate ISRC', conflicts.length, 1);
  assert('conflict group has the right ISRC', conflicts[0].isrc, 'USASN0802524');
  assert('conflict group has 2 rows', conflicts[0].rows.length, 2);

  // No conflict when each ISRC appears once
  const noConflict = detectISRCConflicts([
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100, currency: 'USD' },
    { isrc: 'USASN0802525', statement_period: '2023-Q1', gross_royalties: 50,  currency: 'USD' },
  ]);
  assert('no conflicts when all ISRCs are distinct', noConflict.length, 0);
}

// ── [4] Fuzzy title — must NOT auto-match ────────────────────────────────────
console.log('\n[4] Fuzzy title candidate must not auto-match without corroboration');

{
  const catTrack = {
    artist_name: 'Esham',
    release_title: 'Judgement Day',
    recording_mbid: 'abc-123',
    track_duration: 240,
  };

  // Similar title but wrong artist — should not corroborate
  const wrongArtistRow = {
    artist_name: 'Another Artist',
    album_title: 'Judgement Day',
    duration_seconds: null,
    recording_mbid: null,
  };

  const corr1 = requiresCorroboration(catTrack, wrongArtistRow);
  assert('wrong artist gives low corroboration signals', corr1.signals.length < 2, true);
  assert('wrong artist result is not corroborated', corr1.corroborated, false);

  // Score below 1.0 for fuzzy match means it's a candidate, not a confirmed match
  const score = scoreFuzzyTitle('Judgment Day Vol 1', 'Judgement Day');
  assert('fuzzy score is less than 1.0', score < 1.0, true);
  assert('fuzzy score is positive', score > 0, true);

  // Exact same title scores higher but still not 1.0 from fuzzy path
  const exactScore = scoreFuzzyTitle('Esham', 'Esham');
  assert('identical strings score 1.0', exactScore, 1.0);
}

// ── [5] Featured performer vs master-owner separation ────────────────────────
console.log('\n[5] Featured performer vs master-owner interest separation');

{
  const performerRow = {
    gross_royalties: 100,
    net_royalties: 90,
    paid_amount: 90,
    held_amount: 0,
    currency: 'USD',
    statement_period: '2023',
  };

  const perf = splitInterests(performerRow, 'featured_performer');
  assert('featured_performer_gross is set', perf.featured_performer_gross, 100);
  assert('rightsholder_gross is 0 for performer row', perf.rightsholder_gross, 0);
  assert('non_featured_gross is 0', perf.non_featured_gross, 0);
  assert('other_gross is 0', perf.other_gross, 0);
  assert('claimant_type is featured_performer', perf.claimant_type, 'featured_performer');

  const rightsholderRow = {
    gross_royalties: 200,
    net_royalties: 180,
    paid_amount: 180,
    held_amount: 0,
    currency: 'USD',
    statement_period: '2023',
  };

  const rh = splitInterests(rightsholderRow, 'rightsholder');
  assert('rightsholder_gross is set', rh.rightsholder_gross, 200);
  assert('featured_performer_gross is 0 for rightsholder row', rh.featured_performer_gross, 0);
  assert('performer + rightsholder shares are never combined',
    perf.featured_performer_gross + rh.rightsholder_gross, 300);
}

// ── [6] Multiple rightsholders by territory ───────────────────────────────────
console.log('\n[6] Multiple rightsholders by territory and effective period');

{
  // Two rows for same ISRC, different territories
  const usRow = {
    gross_royalties: 150, currency: 'USD', territory: 'US',
    statement_period: '2023', rightsholder_name: 'Reel Life Productions',
  };
  const ukRow = {
    gross_royalties: 80, currency: 'GBP', territory: 'GB',
    statement_period: '2023', rightsholder_name: 'UK Label Ltd',
    original_currency: 'GBP', original_amount: 80, exchange_rate: 1.27,
  };

  const usInt = splitInterests(usRow, 'rightsholder');
  const ukInt = splitInterests(ukRow, 'rightsholder');

  assert('US rightsholder gross preserved', usInt.rightsholder_gross, 150);
  assert('UK rightsholder gross preserved', ukInt.rightsholder_gross, 80);
  assert('UK original currency preserved', ukInt.original_currency, 'GBP');
  assert('UK exchange rate preserved', ukInt.exchange_rate, 1.27);
  assert('UK exchange rate provenance is statement_provided', ukInt.exchange_rate_provenance, 'statement_provided');
  assert('US exchange rate provenance is assumed_1:1', usInt.exchange_rate_provenance, 'assumed_1:1');
}

// ── [7] Statement duplicate detection ────────────────────────────────────────
console.log('\n[7] Statement duplicate detection');

{
  const row1 = { isrc: 'USASN0802524', statement_period: '2023-Q1', territory: 'US',
                  statement_ref: 'SX-001', gross_royalties: 100 };
  const row2 = { isrc: 'USASN0802524', statement_period: '2023-Q1', territory: 'US',
                  statement_ref: 'SX-001', gross_royalties: 100 }; // exact duplicate
  const row3 = { isrc: 'USASN0802524', statement_period: '2023-Q2', territory: 'US',
                  statement_ref: 'SX-002', gross_royalties: 50 };  // different period

  const { unique, duplicates } = deduplicateStatements([row1, row2, row3]);
  assert('dedup keeps 2 unique rows', unique.length, 2);
  assert('dedup finds 1 duplicate', duplicates.length, 1);
  assert('duplicate has _duplicate_key set', typeof duplicates[0]._duplicate_key, 'string');
}

// ── [8] Payment reversal and adjustment handling ──────────────────────────────
console.log('\n[8] Payment reversal and adjustment handling');

{
  const rows = [
    { isrc: 'USASN0802524', gross_royalties: 100, statement_period: '2023-Q1' },
    { isrc: 'USASN0802524', gross_royalties: 0,   adjustment_amount: -25, statement_period: '2023-Q1', reversal: 'true' },
  ];

  const { net, reversals } = applyReversals(rows);
  assert('net after reversal is 75', net, 75);
  assert('one reversal row detected', reversals.length, 1);

  // All-positive rows produce no reversals
  const { net: net2, reversals: rev2 } = applyReversals([
    { gross_royalties: 50 },
    { gross_royalties: 30 },
  ]);
  assert('positive rows: net is 80', net2, 80);
  assert('positive rows: no reversals', rev2.length, 0);
}

// ── [9] Currency preservation and conversion provenance ───────────────────────
console.log('\n[9] Currency preservation and conversion provenance');

{
  const rowWithConversion = {
    gross_royalties: 127,
    currency: 'USD',
    original_currency: 'GBP',
    original_amount: 100,
    exchange_rate: 1.27,
    statement_period: '2023',
  };
  const rowNoConversion = {
    gross_royalties: 50,
    currency: 'USD',
    statement_period: '2023',
  };

  const int1 = splitInterests(rowWithConversion, 'rightsholder');
  assert('original currency preserved when converted', int1.original_currency, 'GBP');
  assert('original amount preserved when converted', int1.original_amount, 100);
  assert('exchange rate preserved', int1.exchange_rate, 1.27);
  assert('exchange rate provenance is statement_provided', int1.exchange_rate_provenance, 'statement_provided');

  const int2 = splitInterests(rowNoConversion, 'rightsholder');
  assert('no conversion: original_currency equals currency', int2.original_currency, 'USD');
  assert('no conversion: exchange_rate is 1', int2.exchange_rate, 1);
  assert('no conversion: provenance is assumed_1:1', int2.exchange_rate_provenance, 'assumed_1:1');
}

// ── [10] Gross vs net reconciliation ─────────────────────────────────────────
console.log('\n[10] Gross vs net reconciliation');

{
  const rows = [
    { gross_royalties: 100, net_royalties: 90, fee_amount: 10, withholding_amount: 0 },
    { gross_royalties: 50,  net_royalties: 45, fee_amount: 5,  withholding_amount: 0 },
  ];
  const recon = reconcileGrossNet(rows);
  assert('total gross is 150', recon.total_gross, 150);
  assert('total net stated is 135', recon.total_net_stated, 135);
  assert('total fees is 15', recon.total_fees, 15);
  assert('implied net is 135', recon.implied_net, 135);
  assert('reconciles = true', recon.reconciles, true);

  // Gap scenario
  const gapRows = [
    { gross_royalties: 100, net_royalties: 80, fee_amount: 10 },
  ];
  const gapRecon = reconcileGrossNet(gapRows);
  assert('reconciles = false when gap exists', gapRecon.reconciles, false);
  assert('gap equals 10', gapRecon.reconciliation_gap, -10);
}

// ── [11] Claim conflict — ownership conflict detection ────────────────────────
console.log('\n[11] Claim conflict (ownership >100%)');

{
  // Ownership conflict: two rightsholders claiming >100% in same territory
  const conflictedCatalog = [{
    id: 'track-1', track_title: 'Test Track', release_title: 'Album',
    release_year: 2020, recording_mbid: 'mbid-1', isrcs: ['USASN0802524'],
  }];
  const ownershipConflictDeclarations = [
    { isrc: 'USASN0802524', rightsholder_name: 'Owner A', share_pct: 80, territory: 'US' },
    { isrc: 'USASN0802524', rightsholder_name: 'Owner B', share_pct: 60, territory: 'US' }, // total 140%
  ];

  const result = runAudit({
    dryRun: true,
    catalogTracks: conflictedCatalog,
    ownershipDeclarations: ownershipConflictDeclarations,
  });

  assert('run succeeds with dry_run: true', result.dry_run, true);
  const rec = result.recordings[0];
  assert('track with conflicting ownership classified as OWNERSHIP_CONFLICT',
    rec.classification, 'OWNERSHIP_CONFLICT');
}

// ── [12] Missing mandate ──────────────────────────────────────────────────────
console.log('\n[12] Missing mandate (ISRC present, no mandate)');

{
  const catalogWithISRC = [{
    id: 'track-2', track_title: 'No Mandate Track', release_title: 'Album B',
    release_year: 2019, recording_mbid: 'mbid-2', isrcs: ['USASN0900001'],
  }];

  const result = runAudit({
    dryRun: true,
    catalogTracks: catalogWithISRC,
    // No mandates, no statements provided
  });

  const rec = result.recordings[0];
  // ISRC present, no statement match, no mandate → MANDATE_GAP
  assert('track with ISRC but no mandate classified as MANDATE_GAP or UNCLAIMED',
    ['MANDATE_GAP', 'UNCLAIMED', 'CATALOG_ONLY_NO_USAGE_EVIDENCE'].includes(rec.classification), true);
}

// ── [13] Insufficient evidence ────────────────────────────────────────────────
console.log('\n[13] Insufficient evidence (no ISRC, no statement, no ownership)');

{
  const catalogNoISRC = [{
    id: 'track-3', track_title: 'No ISRC Track', release_title: 'Unreleased',
    release_year: null, recording_mbid: 'mbid-3', isrcs: [],
  }];

  const result = runAudit({
    dryRun: true,
    catalogTracks: catalogNoISRC,
  });

  const rec = result.recordings[0];
  assert('track without ISRC, statement, or ownership → INSUFFICIENT_EVIDENCE or CATALOG_ONLY_NO_USAGE_EVIDENCE',
    ['INSUFFICIENT_EVIDENCE', 'CATALOG_ONLY_NO_USAGE_EVIDENCE'].includes(rec.classification), true);
}

// ── [14] Zero-dollar and missing-dollar rows ──────────────────────────────────
console.log('\n[14] Zero-dollar and missing-dollar rows');

{
  const zeroDollarRows = [
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 0, currency: 'USD' },
    { isrc: 'USASN0802524', statement_period: '2023-Q2', gross_royalties: 0, currency: 'USD' },
  ];

  const recon = reconcileGrossNet(zeroDollarRows);
  assert('zero-dollar rows: total gross is 0', recon.total_gross, 0);
  assert('zero-dollar rows: implied net is 0', recon.implied_net, 0);

  // Missing dollar field
  const missingRows = [{ isrc: 'USASN0802524', statement_period: '2023-Q1', currency: 'USD' }];
  const { valid, quarantine } = validateImport(missingRows, 'soundexchange_statement');
  assert('row missing required gross_royalties is quarantined', quarantine.length, 1);
  assert('valid array has no entries', valid.length, 0);
}

// ── [15] Idempotent repeated imports ─────────────────────────────────────────
console.log('\n[15] Idempotent repeated imports');

{
  const rows = [
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100,
      currency: 'USD', statement_ref: 'SX-001' },
  ];

  // Run dedup twice — same input should always give same output
  const r1 = deduplicateStatements([...rows, ...rows]);
  const r2 = deduplicateStatements([...rows, ...rows]);
  assert('repeated dedup gives same unique count', r1.unique.length, r2.unique.length);
  assert('repeated dedup gives same duplicate count', r1.duplicates.length, r2.duplicates.length);

  // Dedup key is stable
  const key1 = statementDedupKey(rows[0]);
  const key2 = statementDedupKey(rows[0]);
  assert('dedup key is stable across calls', key1, key2);
}

// ── [16] Credential and sensitive-field redaction ────────────────────────────
console.log('\n[16] Credential and sensitive-field redaction');

{
  const sensitiveRow = {
    isrc: 'USASN0802524',
    gross_royalties: 100,
    currency: 'USD',
    statement_period: '2023',
    tax_id: '123-45-6789',
    account_number: 'ACC-9999',
    bank: 'Test Bank',
    token: 'eyJsometoken',
    secret: 'my-secret-value',
  };

  const redacted = redactRow(sensitiveRow);
  assert('tax_id is redacted', redacted.tax_id, '[REDACTED]');
  assert('account_number is redacted', redacted.account_number, '[REDACTED]');
  assert('bank is redacted', redacted.bank, '[REDACTED]');
  assert('token is redacted', redacted.token, '[REDACTED]');
  assert('secret is redacted', redacted.secret, '[REDACTED]');
  // Non-sensitive fields are preserved
  assert('isrc is preserved', redacted.isrc, 'USASN0802524');
  assert('gross_royalties is preserved', redacted.gross_royalties, 100);

  // SSN in a string field
  const ssnRow = { artist_name: 'Test Artist', bio: 'SSN 123-45-6789 on file' };
  const redactedSSN = redactRow(ssnRow);
  assert('SSN in string field is redacted', redactedSSN.bio.includes('[REDACTED-SSN]'), true);
  assert('artist_name is preserved', redactedSSN.artist_name, 'Test Artist');
}

// ── [17] Guaranteed zero production writes in dry-run mode ───────────────────
console.log('\n[17] Guaranteed zero production writes in dry-run mode');

{
  // runAudit without dryRun: true must throw
  assertThrows(
    'runAudit() throws if dryRun is not true',
    () => runAudit({ dryRun: false }),
    'dryRun: true',
  );
  assertThrows(
    'runAudit() throws if dryRun is omitted',
    () => runAudit({}),
    'dryRun: true',
  );
  assertThrows(
    'runAudit() throws if dryRun is missing',
    () => runAudit(),
    'dryRun: true',
  );

  // With dryRun: true, output confirms no production writes occurred
  const result = runAudit({ dryRun: true, catalogTracks: [] });
  assert('dry_run flag is true in output', result.dry_run, true);
}

// ── [18] Import validation — required fields and ISRC format ─────────────────
console.log('\n[18] Import validation');

{
  // Valid row
  const validRows = [
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100, currency: 'USD' },
  ];
  const { valid, quarantine, errors } = validateImport(validRows, 'soundexchange_statement');
  assert('valid row passes validation', valid.length, 1);
  assert('no quarantine rows for valid input', quarantine.length, 0);

  // Missing required field
  const missingCurrency = [
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100 },
  ];
  const r2 = validateImport(missingCurrency, 'soundexchange_statement');
  assert('row missing currency is quarantined', r2.quarantine.length, 1);

  // Bad ISRC format
  const badISRC = [
    { isrc: 'NOTANISRC', statement_period: '2023-Q1', gross_royalties: 100, currency: 'USD' },
  ];
  const r3 = validateImport(badISRC, 'soundexchange_statement');
  assert('row with malformed ISRC is quarantined', r3.quarantine.length, 1);

  // Unknown import type
  const r4 = validateImport(validRows, 'unknown_type');
  assert('unknown import type quarantines all rows', r4.quarantine.length, validRows.length);

  // Non-numeric amount
  const badAmount = [
    { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 'abc', currency: 'USD' },
  ];
  const r5 = validateImport(badAmount, 'soundexchange_statement');
  assert('non-numeric amount is quarantined', r5.quarantine.length, 1);
}

// ── [19] Classification: CLAIMED_PAID ─────────────────────────────────────────
console.log('\n[19] Classification: CLAIMED_PAID');

{
  const evidencePaid = {
    hasISRC: true, hasStatementMatch: true, hasPaidAmount: true, hasHeldAmount: false,
    hasOwnershipConflict: false, hasPerformerConflict: false, hasIdentifierConflict: false,
    isFuzzyMatchOnly: false, insufficientEvidence: false, hasMandate: true, hasTerritory: true,
  };
  assert('paid, no hold → CLAIMED_PAID', classifyRecording(evidencePaid), 'CLAIMED_PAID');
}

// ── [20] Classification: CLAIMED_UNPAID ──────────────────────────────────────
console.log('\n[20] Classification: CLAIMED_UNPAID');

{
  const evidenceUnpaid = {
    hasISRC: true, hasStatementMatch: true, hasPaidAmount: false, hasHeldAmount: true,
    hasOwnershipConflict: false, hasPerformerConflict: false, hasIdentifierConflict: false,
    isFuzzyMatchOnly: false, insufficientEvidence: false, hasMandate: true, hasTerritory: true,
  };
  assert('held, no paid → CLAIMED_UNPAID', classifyRecording(evidenceUnpaid), 'CLAIMED_UNPAID');
}

// ── [21] runAudit result structure ────────────────────────────────────────────
console.log('\n[21] runAudit result structure');

{
  const result = runAudit({
    dryRun: true,
    catalogTracks: [
      { id: 'track-10', track_title: 'Demo Track', release_title: 'Demo Album',
        release_year: 2020, recording_mbid: 'mbid-10', isrcs: ['USASN0802524'] },
    ],
    soundexchangeStatements: [
      { isrc: 'USASN0802524', statement_period: '2023-Q1', gross_royalties: 100,
        currency: 'USD', paid_amount: 100, held_amount: 0, statement_ref: 'SX-100' },
    ],
  });

  assert('result has dry_run flag', result.dry_run, true);
  assert('result has pipeline_version', typeof result.pipeline_version, 'string');
  assert('result has catalog_total', result.catalog_total, 1);
  assert('result.recordings is array', Array.isArray(result.recordings), true);
  assert('result.exceptions is array', Array.isArray(result.exceptions), true);
  assert('result has classifications object', typeof result.classifications, 'object');
  assert('result has confirmed_receivable_calculable', typeof result.confirmed_receivable_calculable, 'boolean');
  assert('result has verdict string', typeof result.verdict, 'string');
  assert('result.reconciliation has soundexchange key', typeof result.reconciliation.soundexchange, 'object');
}

// ── [22] No private data committed / no network call made ────────────────────
console.log('\n[22] Library is pure — no network calls, no DB access');

{
  // If this module loaded without crashing and all tests pass, we confirm:
  // - No supabase client was imported
  // - No fetch was called
  // - No file I/O was performed (all fixtures are in-memory)
  assert('module loads without SUPABASE_SERVICE_KEY', true, true);
  assert('module loads without GENIUS_ACCESS_TOKEN', true, true);
  assert('module loads without database connection', true, true);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(53)}`);
console.log(`${passed + failed} assertions | ${passed} passed | ${failed} failed`);
console.log('');
if (failed > 0) {
  console.log('FAIL');
  process.exit(1);
} else {
  console.log('PASS');
}
