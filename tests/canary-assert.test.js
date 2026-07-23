'use strict';
// Tests for scripts/canary-assert.js
// Runs the script as a child process with controlled env vars and asserts
// exit codes and output. No live DB or network required.

const { spawnSync } = require('child_process');
const path = require('path');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'canary-assert.js');

let passed = 0;
let failed = 0;

function assert(label, condition, detail) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

function run(env) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

(async () => {
  console.log('=== canary-assert.test.js ===\n');

  // ── PASS cases ─────────────────────────────────────────────────────────────

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '22', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[1] PASS — nominal: synced=22, failed=0, status=DONE');
    assert('exit code 0', r.status === 0, `got ${r.status}`);
    assert('stdout contains PASS', r.stdout.includes('PASS'));
    assert('stderr is empty', r.stderr === '', `stderr: ${r.stderr.trim()}`);
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '1', CANARY_FAILED: '0', CANARY_TRACKS: '1' });
    console.log('[2] PASS — minimal valid: synced=1, failed=0');
    assert('exit code 0', r.status === 0, `got ${r.status}`);
    assert('stdout contains PASS', r.stdout.includes('PASS'));
  }

  // ── FAIL cases ──────────────────────────────────────────────────────────────

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '20', CANARY_FAILED: '2', CANARY_TRACKS: '22' });
    console.log('[3] FAIL — graphSyncFailed > 0: synced=20, failed=2');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains FAIL', r.stderr.includes('FAIL'));
    assert('stderr mentions graphSyncFailed count', r.stderr.includes('2'));
    assert('stdout does not contain PASS', !r.stdout.includes('PASS'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '0', CANARY_FAILED: '22', CANARY_TRACKS: '22' });
    console.log('[4] FAIL — total graph failure: synced=0, failed=22');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains FAIL', r.stderr.includes('FAIL'));
  }

  {
    const r = run({ CANARY_STATUS: 'ERROR', CANARY_SYNCED: '22', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[5] FAIL — status=ERROR (API-level failure)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains FAIL', r.stderr.includes('FAIL'));
    assert('stderr mentions status', r.stderr.toLowerCase().includes('status'));
  }

  {
    const r = run({ CANARY_STATUS: '', CANARY_SYNCED: '22', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[6] FAIL — status missing/empty (HTTP error body or jq failure)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains FAIL', r.stderr.includes('FAIL'));
  }

  {
    const r = run({ CANARY_STATUS: 'null', CANARY_SYNCED: 'null', CANARY_FAILED: 'null', CANARY_TRACKS: 'null' });
    console.log('[7] FAIL — all fields null (malformed JSON or HTTP error response)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr or stdout is not PASS', !r.stdout.includes('PASS'));
  }

  // ── INCONCLUSIVE cases (fail closed) ────────────────────────────────────────

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: 'null', CANARY_FAILED: 'null', CANARY_TRACKS: '22' });
    console.log('[8] INCONCLUSIVE — graphSynced=null graphSyncFailed=null (fields absent from HTTP response)');
    assert('exit code 1 (fail closed)', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
    assert('stderr does not say PASS', !r.stderr.includes('PASS'));
    assert('stdout does not say PASS', !r.stdout.includes('PASS'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '', CANARY_FAILED: '', CANARY_TRACKS: '22' });
    console.log('[9] INCONCLUSIVE — fields entirely missing (empty string from unset step output)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '0', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[10] INCONCLUSIVE — synced=0 failed=0 (catalog already current, no tracks processed)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
    assert('stderr mentions "already current" or "no tracks"', r.stderr.includes('current') || r.stderr.includes('no tracks'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: 'abc', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[11] INCONCLUSIVE — graphSynced non-numeric ("abc")');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '22.5', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[12] INCONCLUSIVE — graphSynced float "22.5" (not a bare integer)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '22', CANARY_FAILED: 'null', CANARY_TRACKS: '22' });
    console.log('[13] INCONCLUSIVE — graphSynced numeric but graphSyncFailed null (partial response)');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
  }

  {
    const r = run({ CANARY_STATUS: 'DONE', CANARY_SYNCED: '-1', CANARY_FAILED: '0', CANARY_TRACKS: '22' });
    console.log('[14] INCONCLUSIVE — graphSynced negative ("-1") — not a valid non-negative integer');
    assert('exit code 1', r.status === 1, `got ${r.status}`);
    assert('stderr contains INCONCLUSIVE', r.stderr.includes('INCONCLUSIVE'));
  }

  // Timeout and curl error are handled at the curl step before assert runs;
  // at the assert level they arrive as empty/null fields — covered by [8] and [9].

  console.log('\n──────────────────────────────────────────────────');
  const total = passed + failed;
  if (failed > 0) {
    console.error(`${total} assertions | ${passed} passed | ${failed} FAILED`);
    process.exit(1);
  } else {
    console.log(`${total} assertions | ${total} passed`);
    process.exit(0);
  }
})();
