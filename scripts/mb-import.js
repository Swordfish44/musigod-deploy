'use strict';
// scripts/mb-import.js
// MusicBrainz open-data ingestion CLI.
//
// Imports MusicBrainz metadata into mb_staging.* tables in Supabase.
// Raw MB data remains in staging until entity resolution + human review
// approves promotion to the canonical MusiGod rights graph.
//
// MODES
// ─────
// API mode (default): pulls data via MB API for artists already in MusiGod.
//   Pros: works immediately, no dump download required.
//   Cons: limited to 1 req/s; for >100 artists use dump mode.
//
// Dump mode: streams local MusicBrainz TSV dump files.
//   Pros: handles tens of millions of records; restartable; no API rate limit.
//   Cons: requires downloading ~25 GB dump first (see MUSIGOD_MUSICBRAINZ_INGESTION.md).
//
// USAGE
// ─────
//   node scripts/mb-import.js --artists                        # API mode, all known artists
//   node scripts/mb-import.js --artists --artist-name "Esham" # API mode, single artist
//   node scripts/mb-import.js --recordings                     # API mode, recordings for known artists
//   node scripts/mb-import.js --works                          # API mode, works for known recordings
//   node scripts/mb-import.js --releases                       # API mode
//   node scripts/mb-import.js --relationships                  # API mode
//   node scripts/mb-import.js --resolve                        # Entity resolution only
//   node scripts/mb-import.js --all                            # All entities + resolve
//
//   # Dump mode (requires dump files in data/musicbrainz/dumps/mbdump/):
//   node scripts/mb-import.js --artists   --dump-file data/musicbrainz/dumps/mbdump/artist
//   node scripts/mb-import.js --recordings --dump-file data/musicbrainz/dumps/mbdump/recording
//
//   # Flags
//   --resume         Resume from last checkpoint
//   --dry-run        Parse and log without writing to DB
//   --batch-size N   Rows per DB write (default: 500)
//
// ENVIRONMENT
// ───────────
//   MUSICBRAINZ_DATABASE_URL   (required) postgres:// connection for external corpus DB
//   SUPABASE_URL               (defaults to uykzkrnoetcldeuxzqyy.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY  (required) for entity_matches_v1 writes + loadEnrichedTracks
//
// Architecture:
//   Corpus writes (artists, recordings, ISRCs, works, releases, …) → external PostgreSQL
//   entity_matches_v1 (human-review boundary)                       → Supabase
//
// FIRST RUN (data source)
// ───────────────────────
//   See MUSIGOD_MUSICBRAINZ_INGESTION.md for dump download instructions.
//   The real initial import command is at the end of that file.

require('dotenv').config();

const { healthCheck: corpusHealthCheck, isConfigured: corpusIsConfigured } = require('../lib/mb-corpus-db');

const {
  upsertArtists, upsertArtistAliases,
  upsertRecordings, upsertISRCs,
  upsertWorks, upsertISWCs,
  upsertReleases, upsertReleaseGroups,
  upsertRelationships,
  markIngestionStarted, markIngestionCompleted, markIngestionFailed,
  checkpointProgress, getIngestionState,
} = require('../lib/mb-staging-writer');

const { batchStream } = require('../lib/mb-dump-parser');
const { resolveAllTracks } = require('../lib/mb-entity-resolver');

// ─── Arg parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    artists:      false,
    recordings:   false,
    works:        false,
    releases:     false,
    relationships: false,
    resolve:      false,
    all:          false,
    resume:       false,
    dryRun:       false,
    dumpFile:     null,
    artistName:   null,
    batchSize:    500,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--artists':       opts.artists       = true; break;
      case '--recordings':    opts.recordings    = true; break;
      case '--works':         opts.works         = true; break;
      case '--releases':      opts.releases      = true; break;
      case '--relationships': opts.relationships = true; break;
      case '--resolve':       opts.resolve       = true; break;
      case '--all':           opts.all           = true; break;
      case '--resume':        opts.resume        = true; break;
      case '--dry-run':       opts.dryRun        = true; break;
      case '--dump-file':     opts.dumpFile      = args[++i]; break;
      case '--artist-name':   opts.artistName    = args[++i]; break;
      case '--batch-size':    opts.batchSize     = parseInt(args[++i], 10) || 500; break;
    case '--health-check':  opts.healthCheck   = true; break;
    }
  }

  if (opts.all) {
    opts.artists = opts.recordings = opts.works =
      opts.releases = opts.relationships = opts.resolve = true;
  }

  return opts;
}

// ─── MB API helpers ───────────────────────────────────────────────────────────

const MB_BASE   = 'https://musicbrainz.org/ws/2';
const UA        = 'MusiGod-DataPipeline/1.0 +https://musigod.com';
const RATE_MS   = 1100;  // MB rate limit: 1 req/sec; use 1.1s for safety
const RETRY_MS  = 10000;
const MAX_RETRY = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mbGet(path) {
  const url = `${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`;
  for (let attempt = 1; attempt <= MAX_RETRY; attempt++) {
    await sleep(RATE_MS);
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      if (attempt === MAX_RETRY) throw new Error(`MB network: ${err.message}`);
      await sleep(RETRY_MS * attempt);
      continue;
    }
    if (res.status === 503 || res.status === 429) {
      console.warn(`[mb-import] MB ${res.status} attempt ${attempt}: ${path.slice(0, 60)}`);
      if (attempt === MAX_RETRY) throw new Error(`MB rate limit exceeded: ${path.slice(0, 60)}`);
      await sleep(RETRY_MS * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`MB ${res.status}: ${path.slice(0, 80)}`);
    return res.json();
  }
}

// ─── Load known artists from catalog_enriched_tracks_v1 ──────────────────────

async function loadKnownArtists(filterName = null) {
  const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';

  let params = 'select=artist_name,artist_mbid&artist_mbid=not.is.null';
  if (filterName) params += `&artist_name=ilike.${encodeURIComponent('%' + filterName + '%')}`;

  const res = await fetch(`${SB_URL}/rest/v1/catalog_enriched_tracks_v1?${params}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`loadKnownArtists: ${res.status} ${text.slice(0, 200)}`);
  const rows = text ? JSON.parse(text) : [];

  // Deduplicate by artist_mbid
  const seen = new Map();
  for (const r of rows) {
    if (r.artist_mbid && !seen.has(r.artist_mbid)) {
      seen.set(r.artist_mbid, r.artist_name);
    }
  }
  return [...seen.entries()].map(([mbid, name]) => ({ mbid, name }));
}

// ─── API-mode: ingest one artist ─────────────────────────────────────────────

async function ingestArtistViaApi(artist, opts) {
  const { dryRun, batchSize } = opts;
  const { mbid, name } = artist;
  console.log(`\n[mb-import] Artist: ${name} (${mbid})`);

  // 1. Fetch artist details
  let artistData;
  try {
    artistData = await mbGet(`/artist/${mbid}?inc=aliases+area-rels`);
  } catch (err) {
    console.warn(`[mb-import] Artist fetch failed: ${err.message}`);
    return { artists: 0, recordings: 0, works: 0, releases: 0, isrcs: 0, iswcs: 0, relationships: 0, errors: 1 };
  }

  const stats = { artists: 0, recordings: 0, works: 0, releases: 0, isrcs: 0, iswcs: 0, relationships: 0, errors: 0 };

  // Upsert artist
  const artistRow = {
    mb_artist_id:    artistData.id,
    name:            artistData.name,
    sort_name:       artistData['sort-name'],
    artist_type:     artistData.type,
    country:         artistData.country,
    area:            artistData.area?.name,
    begin_date:      formatDate(artistData['life-span']?.begin),
    end_date:        formatDate(artistData['life-span']?.end),
    comment:         artistData.disambiguation,
    ended:           artistData['life-span']?.ended || false,
    mb_last_updated: null,
    ingestion_source: 'api',
    provenance:      { source: 'musicbrainz', data_license: 'CC0', fetched_at: new Date().toISOString() },
  };
  await upsertArtists([artistRow], dryRun);
  stats.artists++;

  // Upsert aliases
  const aliases = (artistData.aliases || []).map(a => ({
    mb_artist_id:  artistData.id,
    alias_name:    a.name,
    alias_type:    a.type,
    locale:        a.locale,
    primary_alias: a.primary || false,
    begin_date:    formatDate(a.begin),
    end_date:      formatDate(a.end),
  }));
  if (aliases.length) {
    await upsertArtistAliases(aliases, dryRun);
  }

  // 2. Fetch release groups
  const releaseGroups = [];
  let offset = 0;
  while (true) {
    let data;
    try {
      data = await mbGet(`/release-group?artist=${mbid}&limit=100&offset=${offset}`);
    } catch (err) {
      console.warn(`[mb-import] Release groups failed at offset ${offset}: ${err.message}`);
      break;
    }
    const batch = data['release-groups'] || [];
    releaseGroups.push(...batch);
    offset += batch.length;
    if (batch.length < 100) break;
  }
  console.log(`[mb-import]   ${releaseGroups.length} release groups`);

  const rgRows = releaseGroups.map(rg => ({
    mb_release_group_id: rg.id,
    title:               rg.title,
    primary_type:        rg['primary-type'],
    secondary_types:     rg['secondary-types'] || [],
    mb_artist_id:        mbid,
    first_release_date:  rg['first-release-date'] || null,
    ingestion_source:    'api',
    provenance:          { source: 'musicbrainz', data_license: 'CC0', fetched_at: new Date().toISOString() },
  }));
  if (rgRows.length) await upsertReleaseGroups(rgRows, dryRun);

  // 3. For each release group, fetch first release, then all tracks+ISRCs
  const workMbidsToFetch = new Set();

  for (const rg of releaseGroups) {
    let releaseId;
    try {
      const relData = await mbGet(`/release?release-group=${rg.id}&limit=1`);
      releaseId = relData.releases?.[0]?.id;
    } catch (err) {
      stats.errors++;
      continue;
    }
    if (!releaseId) continue;

    // Fetch release with tracks + ISRCs
    let relFull;
    try {
      relFull = await mbGet(`/release/${releaseId}?inc=recordings+isrcs+artist-credits`);
    } catch (err) {
      console.warn(`[mb-import]   Release ${releaseId} failed: ${err.message}`);
      stats.errors++;
      continue;
    }

    await upsertReleases([{
      mb_release_id:       relFull.id,
      mb_release_group_id: rg.id,
      title:               relFull.title,
      artist_credit:       flattenCredit(relFull['artist-credit']),
      mb_artist_id:        mbid,
      release_date:        relFull.date || null,
      country:             relFull.country,
      status:              relFull.status,
      barcode:             relFull.barcode,
      ingestion_source:    'api',
      provenance:          { source: 'musicbrainz', data_license: 'CC0', release_group_id: rg.id },
    }], dryRun);
    stats.releases++;

    // Extract tracks and ISRCs
    const recordingRows = [];
    const isrcRows = [];

    for (const medium of relFull.media || []) {
      for (const t of medium.tracks || []) {
        const rec = t.recording || {};
        if (!rec.id) continue;

        recordingRows.push({
          mb_recording_id:  rec.id,
          title:            t.title || rec.title,
          length_ms:        rec.length || null,
          artist_credit:    flattenCredit(rec['artist-credit']),
          mb_artist_id:     mbid,
          video:            rec.video || false,
          ingestion_source: 'api',
          provenance:       { source: 'musicbrainz', data_license: 'CC0', release_id: relFull.id, release_group_id: rg.id },
        });

        for (const isrc of (rec.isrcs || [])) {
          if (isrc) isrcRows.push({ mb_recording_id: rec.id, isrc: isrc.toUpperCase().replace(/[-\s]/g, '') });
        }
      }
    }

    if (recordingRows.length) {
      await upsertRecordings(recordingRows, dryRun);
      stats.recordings += recordingRows.length;
    }
    if (isrcRows.length) {
      await upsertISRCs(isrcRows, dryRun);
      stats.isrcs += isrcRows.length;
    }

    // Queue work lookups for recordings that may have linked works
    for (const row of recordingRows) workMbidsToFetch.add(row.mb_recording_id);
  }

  // 4. Fetch work-rels for each recording → discover linked compositions
  if (opts.works || opts.all) {
    let workCount = 0;
    for (const recMbid of workMbidsToFetch) {
      let recData;
      try {
        recData = await mbGet(`/recording/${recMbid}?inc=work-rels`);
      } catch (err) {
        stats.errors++;
        continue;
      }

      const workRels = (recData.relations || []).filter(r => r['target-type'] === 'work');
      for (const rel of workRels) {
        const work = rel.work;
        if (!work?.id) continue;

        // Fetch full work details (for ISWC + artist-rels)
        let workData;
        try {
          workData = await mbGet(`/work/${work.id}?inc=artist-rels`);
        } catch (err) {
          stats.errors++;
          continue;
        }

        await upsertWorks([{
          mb_work_id:       workData.id,
          title:            workData.title,
          work_type:        workData.type,
          language:         workData.language,
          comment:          workData.disambiguation,
          ingestion_source: 'api',
          provenance:       { source: 'musicbrainz', data_license: 'CC0' },
        }], dryRun);
        stats.works++;
        workCount++;

        // ISWCs
        const iswcRows = (workData.iswcs || []).map(iswc => ({ mb_work_id: workData.id, iswc }));
        if (iswcRows.length) {
          await upsertISWCs(iswcRows, dryRun);
          stats.iswcs += iswcRows.length;
        }

        // recording→work relationship
        await upsertRelationships([{
          source_type:      'recording',
          source_mb_id:     recMbid,
          target_type:      'work',
          target_mb_id:     workData.id,
          relationship_type: rel.type || 'performance',
          attributes:       {},
          direction:        'forward',
        }], dryRun);
        stats.relationships++;

        // artist→work relationships (composer, lyricist, etc.)
        const writerRels = (workData.relations || []).filter(r =>
          r['target-type'] === 'artist' &&
          ['composer','lyricist','writer','composer-lyricist','music','lyrics',
           'words','written by','arranger'].includes(r.type)
        );
        const relRows = writerRels
          .filter(r => r.artist?.id)
          .map(r => ({
            source_type:      'artist',
            source_mb_id:     r.artist.id,
            target_type:      'work',
            target_mb_id:     workData.id,
            relationship_type: r.type,
            attributes:       {},
            direction:        'forward',
          }));
        if (relRows.length) {
          await upsertRelationships(relRows, dryRun);
          stats.relationships += relRows.length;
        }
      }
    }
    console.log(`[mb-import]   ${workCount} works fetched`);
  }

  return stats;
}

// ─── Dump-mode: stream a TSV file ─────────────────────────────────────────────

async function ingestDumpFile(entityType, dumpFile, opts) {
  const { dryRun, batchSize, resume } = opts;
  const importMode = 'dump';

  let startOffset = 0;
  let totalProcessed = 0;
  let totalErrors = 0;

  if (resume) {
    const state = await getIngestionState(entityType, importMode);
    if (state && state.status !== 'completed') {
      startOffset = state.last_offset || 0;
      totalProcessed = state.total_processed || 0;
      console.log(`[mb-import] Resuming ${entityType} from offset ${startOffset} (${totalProcessed} already processed)`);
    }
  }

  await markIngestionStarted(entityType, importMode, { dump_file: dumpFile });

  const upsertFn = {
    artist:        upsertArtists,
    recording:     upsertRecordings,
    work:          upsertWorks,
    release:       upsertReleases,
    release_group: upsertReleaseGroups,
  }[entityType];

  if (!upsertFn) {
    throw new Error(`No upsert function for dump entity type: ${entityType}`);
  }

  try {
    for await (const { batch, totalProcessed: processed, lineNum } of batchStream(dumpFile, entityType, batchSize, startOffset)) {
      try {
        await upsertFn(batch, dryRun);
        totalProcessed += batch.length;
      } catch (err) {
        totalErrors += batch.length;
        console.error(`[mb-import] Batch write failed at line ${lineNum}: ${err.message}`);
      }

      await checkpointProgress(entityType, importMode, lineNum, null, totalProcessed, totalErrors);

      if (totalProcessed % 10000 < batchSize) {
        console.log(`[mb-import] ${entityType}: ${totalProcessed.toLocaleString()} processed, ${totalErrors} errors`);
      }
    }

    await markIngestionCompleted(entityType, importMode, { total_processed: totalProcessed, total_errors: totalErrors });
    console.log(`[mb-import] ${entityType} dump complete: ${totalProcessed.toLocaleString()} rows, ${totalErrors} errors`);
  } catch (err) {
    await markIngestionFailed(entityType, importMode, err.message);
    throw err;
  }

  return { processed: totalProcessed, errors: totalErrors };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function formatDate(d) {
  if (!d) return null;
  return String(d);
}

function flattenCredit(credits) {
  if (!credits) return null;
  return credits
    .map(c => (typeof c === 'string' ? c : c.artist?.name || ''))
    .filter(Boolean)
    .join('');
}

function summarize(allStats) {
  const totals = { artists: 0, recordings: 0, works: 0, releases: 0, isrcs: 0, iswcs: 0, relationships: 0, errors: 0 };
  for (const s of allStats) {
    for (const k of Object.keys(totals)) totals[k] += (s[k] || 0);
  }
  return totals;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs(process.argv);

  if (!opts.artists && !opts.recordings && !opts.works &&
      !opts.releases && !opts.relationships && !opts.resolve && !opts.all && !opts.healthCheck) {
    console.error([
      'Usage: node scripts/mb-import.js [entities] [flags]',
      '  Entities: --artists --recordings --works --releases --relationships --resolve --all',
      '  Flags:    --resume --dry-run --dump-file <path> --artist-name <name> --batch-size <N>',
      '            --health-check',
    ].join('\n'));
    process.exit(1);
  }

  const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!SB_KEY) {
    console.error('[mb-import] SUPABASE_SERVICE_ROLE_KEY is required');
    process.exit(1);
  }

  if (!corpusIsConfigured()) {
    console.error('[mb-import] MUSICBRAINZ_DATABASE_URL is not set. Cannot reach corpus DB.');
    process.exit(1);
  }

  const corpusOk = await corpusHealthCheck();
  if (opts.healthCheck) {
    console.log(corpusOk ? '[mb-import] Corpus DB: OK' : '[mb-import] Corpus DB: UNREACHABLE');
    process.exit(corpusOk ? 0 : 1);
  }
  if (!corpusOk) {
    console.error('[mb-import] MusicBrainz corpus DB is not reachable. Check MUSICBRAINZ_DATABASE_URL.');
    process.exit(1);
  }

  if (opts.dryRun) console.log('[mb-import] DRY RUN — no writes to database');

  const startTime = Date.now();
  const allStats = [];

  // Dump-mode: stream TSV files
  if (opts.dumpFile) {
    // Infer entity type from the requested flag
    const entityMap = {
      artists:    'artist',
      recordings: 'recording',
      works:      'work',
      releases:   'release',
    };
    for (const [flag, entityType] of Object.entries(entityMap)) {
      if (opts[flag]) {
        console.log(`[mb-import] Dump mode: ${entityType} ← ${opts.dumpFile}`);
        const result = await ingestDumpFile(entityType, opts.dumpFile, opts);
        allStats.push(result);
      }
    }

  } else {
    // API mode
    if (opts.artists || opts.recordings || opts.works || opts.releases || opts.relationships) {
      const artists = await loadKnownArtists(opts.artistName);
      if (!artists.length) {
        const hint = opts.artistName
          ? `No artists matching "${opts.artistName}" with artist_mbid in catalog_enriched_tracks_v1`
          : 'No artists with artist_mbid in catalog_enriched_tracks_v1. Run enrichment first.';
        console.warn(`[mb-import] ${hint}`);
      } else {
        console.log(`[mb-import] API mode: ${artists.length} artist(s) to process`);
        for (let i = 0; i < artists.length; i++) {
          const artist = artists[i];
          console.log(`[mb-import] [${i+1}/${artists.length}] ${artist.name}`);

          if (opts.resume) {
            const state = await getIngestionState(`artist:${artist.mbid}`, 'api');
            if (state?.status === 'completed') {
              console.log(`[mb-import]   Already completed — skipping (use without --resume to re-run)`);
              continue;
            }
          }

          await markIngestionStarted(`artist:${artist.mbid}`, 'api', { metadata: { name: artist.name } });
          try {
            const stats = await ingestArtistViaApi(artist, opts);
            await markIngestionCompleted(`artist:${artist.mbid}`, 'api', {
              total_processed: stats.recordings + stats.works + stats.releases,
              total_errors:    stats.errors,
              metadata:        stats,
            });
            allStats.push(stats);
            console.log(`[mb-import]   recordings=${stats.recordings} works=${stats.works} isrcs=${stats.isrcs} iswcs=${stats.iswcs} rels=${stats.relationships}`);
          } catch (err) {
            await markIngestionFailed(`artist:${artist.mbid}`, 'api', err.message);
            console.error(`[mb-import]   FAILED: ${err.message}`);
            allStats.push({ errors: 1 });
          }
        }
      }
    }
  }

  // Entity resolution (always last)
  if (opts.resolve) {
    console.log('\n[mb-import] Running entity resolution…');
    try {
      const resolveResult = await resolveAllTracks({
        artistName: opts.artistName,
        dryRun: opts.dryRun,
      });
      console.log(`[mb-import] Resolution: ${resolveResult.totalTracks} tracks → ${resolveResult.totalCandidates} candidates`);
    } catch (err) {
      console.error(`[mb-import] Resolution failed: ${err.message}`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const totals = summarize(allStats);
  console.log(`\n[mb-import] Done in ${elapsed}s`);
  console.log(`  Artists:       ${totals.artists}`);
  console.log(`  Recordings:    ${totals.recordings}`);
  console.log(`  Works:         ${totals.works}`);
  console.log(`  Releases:      ${totals.releases}`);
  console.log(`  ISRCs:         ${totals.isrcs}`);
  console.log(`  ISWCs:         ${totals.iswcs}`);
  console.log(`  Relationships: ${totals.relationships}`);
  if (totals.errors) console.warn(`  Errors:        ${totals.errors}`);

  if (opts.dryRun) console.log('\n[mb-import] DRY RUN complete — no data written.');
}

main().catch(err => {
  console.error('[mb-import] Fatal:', err.message);
  process.exit(1);
});
