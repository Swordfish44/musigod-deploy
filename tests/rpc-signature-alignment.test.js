'use strict';
// tests/rpc-signature-alignment.test.js
//
// Static test: confirms that the parameter names the API code sends to PostgREST
// exactly match the parameter names declared in the migration SQL.
//
// This test requires NO network calls and NO database access.
// It guards against the class of bug where a PGRST202 is silently produced
// because a code refactor renames a parameter on one side but not the other.
//
// Run: node tests/rpc-signature-alignment.test.js

const fs   = require('fs');
const path = require('path');
const assert = require('assert');

const MIGRATION = path.join(__dirname, '..', 'supabase', 'migrations', '20260724_registration_readiness_v1.sql');

// ─── Parse parameter names from migration SQL ─────────────────────────────────

function parseFunctionParams(sql, functionName) {
  // Match the CREATE OR REPLACE FUNCTION block for this function name,
  // capture the parameter list between the opening ( and the first ) that
  // is not inside a nested parens (e.g., type arrays).
  const fnRe = new RegExp(
    `CREATE\\s+OR\\s+REPLACE\\s+FUNCTION\\s+(?:public\\.)?${functionName}\\s*\\(([^)]+)\\)`,
    'i'
  );
  const m = sql.match(fnRe);
  if (!m) return null;
  const paramBlock = m[1];
  // Each parameter is "name type [DEFAULT ...]", separated by commas.
  // Extract just the name (first word of each param).
  return paramBlock
    .split(',')
    .map(p => p.trim().split(/\s+/)[0].toLowerCase())
    .filter(Boolean);
}

// ─── API-side parameter names (source of truth = code, verified manually) ────
// These must stay in sync with:
//   api/evaluate-readiness.js  → sbRpc('rpc_upsert_readiness_decision', {...})
//   api/get-readiness.js       → sbRpc('rpc_get_readiness_summary', {...})

const API_PARAMS = {
  rpc_upsert_readiness_decision: [
    'p_catalog_track_id',
    'p_destination',
    'p_decision',
    'p_ruleset_version',
    'p_blockers',
    'p_warnings',
    'p_evidence_summary',
  ],
  rpc_get_readiness_summary: [
    'p_artist_name',
    'p_track_ids',
  ],
};

// ─── Parse API-side params from source files ──────────────────────────────────
// Verify that the hardcoded API_PARAMS above actually appear in the source files.

function parseRpcBodyFromSource(filePath, rpcName) {
  const src = fs.readFileSync(filePath, 'utf8');
  // Find the sbRpc call for this function name and grab the object body keys.
  const rpcCallRe = new RegExp(`sbRpc\\s*\\(\\s*['"\`]${rpcName}['"\`]\\s*,\\s*\\{([^}]+)\\}`, 's');
  const m = src.match(rpcCallRe);
  if (!m) return null;
  const body = m[1];
  // Extract property keys from "  key: value," lines
  return (body.match(/^\s+(\w+)\s*:/mg) || [])
    .map(l => l.trim().replace(/:$/, ''));
}

// ─── Test runner ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function ok(msg) { console.log(`  ✅ ${msg}`); passed++; }
function fail(msg, detail = '') {
  console.error(`  ❌ FAIL: ${msg}${detail ? '\n     ' + detail : ''}`);
  failed++;
}

function checkAlignment(functionName, sqlParams, apiParams) {
  if (!sqlParams) {
    fail(`${functionName}: not found in migration SQL — was the function name changed?`);
    return;
  }

  const missing  = sqlParams.filter(p => !apiParams.includes(p));
  const extra    = apiParams.filter(p => !sqlParams.includes(p));

  if (missing.length === 0 && extra.length === 0) {
    ok(`${functionName}: ${apiParams.length} params aligned (SQL ↔ API)`);
  } else {
    if (missing.length) {
      fail(
        `${functionName}: param(s) in SQL but NOT sent by API → PostgREST PGRST202`,
        `Missing from API call: ${missing.join(', ')}`
      );
    }
    if (extra.length) {
      fail(
        `${functionName}: param(s) sent by API but NOT in SQL → PostgREST PGRST202`,
        `Extra in API call:    ${extra.join(', ')}`
      );
    }
  }
}

function checkSourceMatchesExpected(functionName, sourceParams, expectedParams) {
  if (!sourceParams) {
    fail(`${functionName}: sbRpc call not found in source file — check hardcoded API_PARAMS`);
    return;
  }
  const missing = expectedParams.filter(p => !sourceParams.includes(p));
  const extra   = sourceParams.filter(p => !expectedParams.includes(p));
  if (missing.length === 0 && extra.length === 0) {
    ok(`${functionName}: hardcoded API_PARAMS matches actual source code`);
  } else {
    fail(
      `${functionName}: hardcoded API_PARAMS is out of sync with source — update this test`,
      [
        missing.length ? `In API_PARAMS but not in source: ${missing.join(', ')}` : '',
        extra.length   ? `In source but not in API_PARAMS: ${extra.join(', ')}` : '',
      ].filter(Boolean).join('\n     ')
    );
  }
}

function main() {
  console.log('');
  console.log('═══ RPC Signature Alignment Test ═══');

  // Load migration SQL
  let sql;
  try {
    sql = fs.readFileSync(MIGRATION, 'utf8');
  } catch (e) {
    fail(`Cannot read migration file: ${MIGRATION}`, e.message);
    console.error(`\n1 failed`);
    process.exit(1);
  }
  console.log(`  Migration: ${path.basename(MIGRATION)}`);
  console.log('');

  // [1] Parse SQL signatures
  console.log('[1] Parse function signatures from migration SQL');
  const sqlParams = {};
  for (const fn of Object.keys(API_PARAMS)) {
    sqlParams[fn] = parseFunctionParams(sql, fn);
    if (sqlParams[fn]) {
      ok(`Parsed ${fn}: (${sqlParams[fn].join(', ')})`);
    } else {
      fail(`${fn} not found in migration SQL`);
    }
  }

  // [2] Verify hardcoded API_PARAMS match actual source files
  console.log('');
  console.log('[2] Verify hardcoded API_PARAMS matches actual source file sbRpc calls');
  const evalSrc = path.join(__dirname, '..', 'api', 'evaluate-readiness.js');
  const readSrc = path.join(__dirname, '..', 'api', 'get-readiness.js');

  const upsertSource  = parseRpcBodyFromSource(evalSrc, 'rpc_upsert_readiness_decision');
  const summarySource = parseRpcBodyFromSource(readSrc, 'rpc_get_readiness_summary');

  checkSourceMatchesExpected('rpc_upsert_readiness_decision', upsertSource,  API_PARAMS.rpc_upsert_readiness_decision);
  checkSourceMatchesExpected('rpc_get_readiness_summary',     summarySource, API_PARAMS.rpc_get_readiness_summary);

  // [3] Alignment check: SQL ↔ API
  console.log('');
  console.log('[3] SQL parameter names ↔ API parameter names');
  for (const fn of Object.keys(API_PARAMS)) {
    checkAlignment(fn, sqlParams[fn], API_PARAMS[fn]);
  }

  // [4] Reload migration exists
  console.log('');
  console.log('[4] Reload migration file exists');
  const reloadMig = path.join(__dirname, '..', 'supabase', 'migrations', '20260725_reload_schema.sql');
  try {
    const content = fs.readFileSync(reloadMig, 'utf8');
    if (content.includes('pg_notify') && content.includes('pgrst')) {
      ok('20260725_reload_schema.sql exists and contains pg_notify pgrst call');
    } else {
      fail('20260725_reload_schema.sql exists but does not contain expected pg_notify call');
    }
  } catch {
    fail('20260725_reload_schema.sql not found — schema reload migration is missing');
  }

  // Summary
  console.log('');
  console.log('─────────────────────────────────────────────────────');
  const total = passed + failed;
  console.log(`${total} assertions | ${passed} passed | ${failed} failed`);
  if (failed > 0) {
    console.error('\nFAIL: parameter name mismatch(es) will cause PGRST202 in production');
    process.exit(1);
  } else {
    console.log('\nPASS: all RPC parameter names are aligned');
  }
}

main();
