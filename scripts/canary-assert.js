'use strict';
// Called by the workflow canary job: node scripts/canary-assert.js
// Reads CANARY_STATUS/SYNCED/FAILED/TRACKS from env (set from step outputs).
// Exit 0 = PASS. Exit 1 = FAIL or INCONCLUSIVE. Never silently passes.
//
// PASS requires:
//   status === 'DONE'
//   graphSynced  is a non-negative integer >= 1
//   graphSyncFailed is a non-negative integer === 0
//
// Any null, missing, empty, or non-numeric graph field → INCONCLUSIVE (exit 1).
// graphSynced === 0 with no failures → INCONCLUSIVE (no tracks verified).

const status = process.env.CANARY_STATUS || '';
const synced = process.env.CANARY_SYNCED || '';
const failed = process.env.CANARY_FAILED || '';
const tracks = process.env.CANARY_TRACKS || '';

function isNonNegInt(s) {
  return /^\d+$/.test(s);
}

console.log(`status=${status}  graphSynced=${synced}  graphSyncFailed=${failed}  totalTracks=${tracks}`);

if (status !== 'DONE') {
  process.stderr.write(`FAIL: expected status=DONE, got "${status}"\n`);
  process.exit(1);
}

if (!isNonNegInt(synced) || !isNonNegInt(failed)) {
  process.stderr.write(
    `INCONCLUSIVE: graphSynced="${synced}" graphSyncFailed="${failed}" — ` +
    `field missing, null, or non-numeric. ` +
    `Enrichment API did not return graph sync counts in the HTTP response. ` +
    `Cannot verify graph sync. Fail closed.\n`
  );
  process.exit(1);
}

const syncedN = parseInt(synced, 10);
const failedN = parseInt(failed, 10);

if (failedN > 0) {
  process.stderr.write(`FAIL: graphSyncFailed=${failedN} — ${failedN} track(s) failed to sync to graph\n`);
  process.exit(1);
}

if (syncedN === 0) {
  process.stderr.write(
    `INCONCLUSIVE: graphSynced=0 graphSyncFailed=0 — ` +
    `no tracks were synced. Cannot verify the graph sync path executed. ` +
    `Catalog may already be current. Fail closed.\n`
  );
  process.exit(1);
}

process.stdout.write(`PASS: graphSynced=${syncedN} graphSyncFailed=${failedN} totalTracks=${tracks}\n`);
process.exit(0);
