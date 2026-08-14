'use strict';
// scripts/restore-regressed-writers.js
//
// Restores writer credits to the 31 Esham tracks that regressed to 0 writers
// in the July 8 pilot. Writer names come ONLY from the June 19 enrichment job
// result stored in catalog_enrichments_v1.result — the authoritative production
// record. No data is inferred or fabricated.
//
// Usage:
//   SUPABASE_SERVICE_KEY=<key> node scripts/restore-regressed-writers.js
//
// Dry-run (reads + analysis only, zero DB writes):
//   DRY_RUN=1 SUPABASE_SERVICE_KEY=<key> node scripts/restore-regressed-writers.js
//
// Classification:
//   EXACT_MATCH  — current writer identity set equals authoritative set (normalized)
//   WOULD_PATCH  — auth has writers current is missing; no contradictions
//   CONFLICT     — auth and current diverge in both directions (manual review needed)
//   UNRESOLVED   — track not found in authoritative CSV

const fs   = require('fs');
const path = require('path');

const SB_URL  = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY  = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
const DRY_RUN = !!(process.env.DRY_RUN || process.env.DRY);

const MANIFEST = JSON.parse(
  fs.readFileSync(path.join(__dirname, '..', 'enrichment_recovery_manifest.json'), 'utf8')
);

// ─── Authentication ──────────────────────────────────────────────────────────
// sb_secret_ keys are opaque API keys — send only in apikey header.
// eyJ... keys are JWTs — send in both apikey and Authorization: Bearer.
// IS_JWT is evaluated lazily inside hdr() so this module can be required
// without a key present (e.g. for unit tests of pure functions).

function hdr(extra = {}) {
  const headers = {
    apikey: SB_KEY,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...extra,
  };
  if (SB_KEY && SB_KEY.startsWith('eyJ')) headers.Authorization = `Bearer ${SB_KEY}`;
  return headers;
}

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function sbGet(table, params = '') {
  const url = `${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const r = await fetch(url, { headers: hdr() });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`GET ${table} HTTP ${r.status}: ${body.slice(0, 300)}`);
  }
  return r.json();
}

async function sbPatch(table, filter, body) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: hdr({ Prefer: 'return=representation' }),
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error(`PATCH ${table} HTTP ${r.status}: ${txt.slice(0, 300)}`);
  }
  return r.json();
}

// ─── Writer identity normalization ───────────────────────────────────────────
// Mirrors lib/writer-merge-policy.js normalizeWriterName so comparisons are
// consistent with the merge policy the rest of the pipeline uses.

function normalizeWriterName(name) {
  return (name || '').toLowerCase().trim().replace(/[^a-z0-9]/g, '');
}

function writerNormSet(writers) {
  return new Set(
    (Array.isArray(writers) ? writers : [])
      .map(w => normalizeWriterName(w.name || ''))
      .filter(Boolean)
  );
}

// ─── CSV parser ───────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.split('\n').map(l => l.trimEnd()).filter(Boolean);
  const rows = lines.map(parseLine);
  if (rows.length < 2) return { headers: rows[0] || [], records: [] };
  const headers = rows[0];
  const records = rows.slice(1).map(fields => {
    const obj = {};
    headers.forEach((h, i) => { obj[h] = fields[i] ?? ''; });
    return obj;
  });
  return { headers, records };
}

function parseLine(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {
    if (line[i] === '"') {
      let val = '';
      i++;
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { val += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { val += line[i++]; }
      }
      if (i < line.length && line[i] === ',') i++;
      fields.push(val);
    } else {
      let val = '';
      while (i < line.length && line[i] !== ',') val += line[i++];
      if (i < line.length) i++;
      fields.push(val);
    }
  }
  return fields;
}

// ─── Classification ───────────────────────────────────────────────────────────
// Compares the normalized writer identity set currently in the DB against the
// authoritative set from the June 19 CSV. Rules (strict):
//
//  EXACT_MATCH  — sets are equal: same cardinality, every normalized identity matches.
//                 A current superset is NOT an exact match.
//  WOULD_PATCH  — current is a proper subset of authoritative (current has no
//                 identities absent from auth; auth has at least one not in current).
//  CONFLICT     — any current-only identity exists (superset or bidirectional divergence).
//                 Requires manual review before any write.
//  UNRESOLVED   — determined by the caller (no authoritative record found in CSV);
//                 classify() is not called for these tracks.

function classify(currentWriters, authWriters) {
  const curSet  = writerNormSet(currentWriters);
  const authSet = writerNormSet(authWriters);

  const missingFromCurrent = [...authSet].filter(n => !curSet.has(n)); // in auth, not in current
  const extraInCurrent     = [...curSet].filter(n => !authSet.has(n)); // in current, not in auth

  if (extraInCurrent.length === 0 && missingFromCurrent.length === 0) return 'EXACT_MATCH';
  if (extraInCurrent.length === 0 && missingFromCurrent.length > 0)   return 'WOULD_PATCH';
  return 'CONFLICT'; // any current-only identity: superset or bidirectional
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!SB_KEY) {
    console.error('FAIL: SUPABASE_SERVICE_KEY (or SUPABASE_SERVICE_ROLE_KEY) is required');
    process.exit(1);
  }

  console.log('');
  console.log('════ Esham Regressed Writer Recovery ════');
  console.log(`Target:    ${SB_URL}`);
  console.log(`Auth:      ${SB_KEY.startsWith('eyJ') ? 'JWT (apikey + Authorization: Bearer)' : 'opaque key (apikey only)'}`);
  console.log(`Mode:      ${DRY_RUN ? 'DRY-RUN — zero DB writes' : 'LIVE'}`);
  console.log(`Manifest:  ${MANIFEST.regressed.length} regressed tracks`);
  console.log('');

  // ── Phase 0: Export before-state backup ──────────────────────────────────
  console.log('[Phase 0] Exporting before-state backup');

  const idList = MANIFEST.regressed.map(r => `"${r.id}"`).join(',');
  let currentRows;
  try {
    currentRows = await sbGet(
      'catalog_enriched_tracks_v1',
      `id=in.(${idList})&select=id,track_title,release_title,writers,enriched,enrichment_source,enrichment_error,recording_mbid,updated_at`
    );
  } catch (err) {
    console.error(`  ❌ FAIL (Phase 0 GET): ${err.message}`);
    process.exit(1);
  }

  console.log(`  HTTP 200 — ${currentRows.length} row(s) returned`);

  const backupPath = path.join(
    __dirname, '..',
    `esham_writer_recovery_before_${Date.now()}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ exportedAt: new Date().toISOString(), rows: currentRows }, null, 2)
  );
  console.log(`  ✅ Backup: ${path.basename(backupPath)}`);

  const currentByID = Object.fromEntries(currentRows.map(r => [r.id, r]));
  const missingFromDB = MANIFEST.regressed.filter(r => !currentByID[r.id]);
  if (missingFromDB.length > 0) {
    missingFromDB.forEach(r =>
      console.error(`  ❌ UUID not in DB: ${r.id}  "${r.track_title}"`)
    );
    process.exit(1);
  }
  console.log(`  ✅ All ${MANIFEST.regressed.length} UUIDs confirmed in DB`);

  // ── Phase 1: Find the authoritative June 2026 Esham job ──────────────────
  console.log('');
  console.log('[Phase 1] Locating authoritative June 2026 enrichment job');

  const jobs = await sbGet(
    'catalog_enrichments_v1',
    `artist_name=ilike.*sham*&status=eq.DONE&created_at=lt.2026-07-01&order=created_at.desc&limit=10&select=id,artist_name,created_at,status`
  );

  if (!jobs.length) {
    console.error('  ❌ FAIL: No DONE Esham jobs before 2026-07-01 in catalog_enrichments_v1');
    process.exit(1);
  }
  jobs.forEach(j =>
    console.log(`  Candidate: ${j.id}  ${j.created_at}  artist="${j.artist_name}"`)
  );

  let bestJob = null;
  let bestCSVType = null;
  let bestRecords = null;

  for (const job of jobs) {
    const [full] = await sbGet(
      'catalog_enrichments_v1',
      `id=eq.${job.id}&select=id,created_at,result`
    );
    if (!full?.result) { console.log(`  ${job.id}: no result JSONB`); continue; }

    const masterContent = full.result?.files?.master?.content;
    const bmiContent    = full.result?.files?.bmi?.content;
    const content       = masterContent || bmiContent;
    if (!content) { console.log(`  ${job.id}: result has no CSV content`); continue; }

    const csvType = masterContent ? 'master' : 'bmi';
    const { records } = parseCSV(content);
    const withData = records.filter(r => {
      const w = csvType === 'master' ? r['Writers'] : r['Writer Name'];
      return w && w.trim() && w !== 'UNKNOWN - VERIFY';
    });
    console.log(`  ${job.id}: ${records.length} CSV rows, ${withData.length} with writer data (${csvType})`);

    if (!bestJob || withData.length > (bestRecords?.filter(r => {
      const w = bestCSVType === 'master' ? r['Writers'] : r['Writer Name'];
      return w && w.trim() && w !== 'UNKNOWN - VERIFY';
    }).length || 0)) {
      bestJob = full;
      bestCSVType = csvType;
      bestRecords = records;
    }
  }

  if (!bestJob) {
    console.error('  ❌ FAIL: No usable job result — cannot recover without authoritative source');
    process.exit(1);
  }
  console.log(`  ✅ Using job ${bestJob.id} (${bestJob.created_at}) — ${bestCSVType} CSV`);

  // ── Phase 2: Build lookup maps from CSV ───────────────────────────────────
  console.log('');
  console.log('[Phase 2] Parsing authoritative writer data from CSV');

  const byMBID     = new Map();  // recording_mbid → [{name, role, source}]
  const byTitleRel = new Map();  // "lower(title)|lower(release)" → [{name, role, source}]

  if (bestCSVType === 'master') {
    for (const rec of bestRecords) {
      const writersRaw = (rec['Writers'] || '').trim();
      if (!writersRaw || writersRaw === 'UNKNOWN - VERIFY') continue;

      const names  = writersRaw.split(';').map(s => s.trim()).filter(Boolean);
      const roles  = (rec['Writer Roles'] || '').split(';').map(s => s.trim());
      const writers = names.map((name, i) => ({
        name,
        role:   roles[i] || 'CA',
        source: 'recovered_from_csv',
      }));

      const mbid = (rec['Recording MBID'] || '').trim();
      if (mbid) byMBID.set(mbid, writers);

      const key = `${(rec['Track Title'] || '').trim().toLowerCase()}|${(rec['Release Title'] || '').trim().toLowerCase()}`;
      byTitleRel.set(key, writers);
    }
  } else {
    // BMI: one row per writer
    for (const rec of bestRecords) {
      const writerName = (rec['Writer Name'] || '').trim();
      if (!writerName || writerName === 'UNKNOWN - VERIFY') continue;

      const key = `${(rec['Title'] || '').trim().toLowerCase()}|${(rec['Album/Release'] || '').trim().toLowerCase()}`;
      if (!byTitleRel.has(key)) byTitleRel.set(key, []);
      const arr = byTitleRel.get(key);
      if (!arr.some(w => w.name === writerName)) {
        arr.push({ name: writerName, role: rec['Writer Role'] || 'CA', source: 'recovered_from_csv' });
      }
    }
  }

  console.log(`  ✅ ${byMBID.size} entries indexed by Recording MBID`);
  console.log(`  ✅ ${byTitleRel.size} entries indexed by title+release`);

  // ── Phase 3: Classify each of the 31 tracks ──────────────────────────────
  console.log('');
  console.log('[Phase 3] Classifying all 31 regressed tracks');

  const classified = MANIFEST.regressed.map(m => {
    const cur = currentByID[m.id];
    const curWriters = Array.isArray(cur.writers) ? cur.writers : [];

    // Look up authoritative writers
    const mbid     = (cur.recording_mbid || '').trim();
    const titleKey = `${(cur.track_title || '').toLowerCase()}|${(cur.release_title || '').toLowerCase()}`;

    let authWriters = null;
    let matchedBy   = null;

    if (mbid && byMBID.has(mbid)) {
      authWriters = byMBID.get(mbid);
      matchedBy   = `mbid:${mbid}`;
    } else if (byTitleRel.has(titleKey)) {
      authWriters = byTitleRel.get(titleKey);
      matchedBy   = `title+release`;
    }

    if (!authWriters) {
      return { m, cur, curWriters, authWriters: [], matchedBy: null, status: 'UNRESOLVED' };
    }

    const status = classify(curWriters, authWriters);
    return { m, cur, curWriters, authWriters, matchedBy, status };
  });

  const byStatus = {
    EXACT_MATCH:  classified.filter(c => c.status === 'EXACT_MATCH'),
    WOULD_PATCH:  classified.filter(c => c.status === 'WOULD_PATCH'),
    CONFLICT:     classified.filter(c => c.status === 'CONFLICT'),
    UNRESOLVED:   classified.filter(c => c.status === 'UNRESOLVED'),
  };

  console.log(`  EXACT_MATCH: ${byStatus.EXACT_MATCH.length}`);
  console.log(`  WOULD_PATCH: ${byStatus.WOULD_PATCH.length}`);
  console.log(`  CONFLICT:    ${byStatus.CONFLICT.length}`);
  console.log(`  UNRESOLVED:  ${byStatus.UNRESOLVED.length}`);

  // ── Phase 4: Dry-run plan / live patch ───────────────────────────────────
  console.log('');
  console.log(`[Phase 4] ${DRY_RUN ? 'Dry-run plan (zero DB writes)' : 'Applying WOULD_PATCH repairs'}`);

  const patchResults = {}; // id → { ok: bool, error? }

  for (const c of byStatus.WOULD_PATCH) {
    if (DRY_RUN) {
      patchResults[c.cur.id] = { ok: true, dryRun: true };
      continue;
    }
    try {
      await sbPatch('catalog_enriched_tracks_v1', `id=eq.${c.cur.id}`, {
        writers:            c.authWriters,
        enriched:           true,
        enrichment_source:  'recovered_from_csv',
        recovered_from_csv: true,
        enrichment_error:   null,
      });
      patchResults[c.cur.id] = { ok: true };
    } catch (err) {
      patchResults[c.cur.id] = { ok: false, error: err.message };
      console.error(`  ❌ PATCH FAILED "${c.cur.track_title}": ${err.message}`);
    }
  }

  if (DRY_RUN && byStatus.WOULD_PATCH.length > 0) {
    console.log(`  ${byStatus.WOULD_PATCH.length} WOULD_PATCH tracks identified — no writes made`);
  } else if (!DRY_RUN) {
    const ok  = Object.values(patchResults).filter(r => r.ok).length;
    const bad = Object.values(patchResults).filter(r => !r.ok).length;
    console.log(`  ${ok} patched successfully, ${bad} failed`);
  }

  // ── Phase 5: Track-by-track report ───────────────────────────────────────
  console.log('');
  console.log('════ Track-by-Track Report ════');
  console.log('');

  for (const c of classified) {
    const icon = c.status === 'EXACT_MATCH' ? '✅' :
                 c.status === 'WOULD_PATCH' ? '🔧' :
                 c.status === 'CONFLICT'    ? '⚠️ ' :
                                              '❓';

    const curNames  = c.curWriters.map(w => w.name).join(', ')  || '(none)';
    const authNames = c.authWriters.map(w => w.name).join(', ') || '(none)';

    let action;
    if (c.status === 'EXACT_MATCH') {
      action = 'no action — current matches authoritative';
    } else if (c.status === 'WOULD_PATCH') {
      const pr = patchResults[c.cur.id];
      if (DRY_RUN)       action = 'would replace current writers with authoritative set';
      else if (pr?.ok)   action = 'patched ✅';
      else               action = `patch failed ❌: ${pr?.error || 'unknown'}`;
    } else if (c.status === 'CONFLICT') {
      action = 'no action — manual review required';
    } else {
      action = 'no action — not in authoritative CSV';
    }

    console.log(`${icon} [${c.status}]  "${c.cur.track_title}"  (${c.cur.release_title}, ${c.m.release_year})`);
    console.log(`   Current writers:      ${curNames}`);
    console.log(`   Authoritative writers:${authNames === '(none)' ? ' (none)' : ' ' + authNames}`);
    console.log(`   Planned action:       ${action}`);
    if (c.matchedBy) console.log(`   Matched by:           ${c.matchedBy}`);
    console.log('');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('─────────────────────────────────────────────────────────────');
  console.log(`Total in manifest:  31`);
  console.log(`EXACT_MATCH:        ${byStatus.EXACT_MATCH.length}  (current = authoritative — no action)`);
  console.log(`WOULD_PATCH:        ${byStatus.WOULD_PATCH.length}  (${DRY_RUN ? 'dry-run — would restore' : 'patched'})`);
  console.log(`CONFLICT:           ${byStatus.CONFLICT.length}  (diverges both ways — manual review)`);
  console.log(`UNRESOLVED:         ${byStatus.UNRESOLVED.length}  (not in June 19 CSV)`);
  console.log(`Backup:             ${path.basename(backupPath)}`);
  console.log('');

  if (DRY_RUN) {
    console.log('DRY-RUN complete — zero DB writes made.');
    console.log('To apply: re-run without DRY_RUN=1');
  }

  const patchFailed = Object.values(patchResults).filter(r => !r.ok && !r.dryRun).length;
  if (patchFailed > 0) {
    console.error(`\nFAIL: ${patchFailed} patch(es) failed`);
    process.exit(1);
  }
}

// Export pure functions so tests can import without running main().
if (require.main === module) {
  main().catch(err => {
    console.error('Uncaught error:', err.message);
    process.exit(1);
  });
}

module.exports = { classify, normalizeWriterName, writerNormSet };
