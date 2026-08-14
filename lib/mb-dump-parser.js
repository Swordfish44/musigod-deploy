'use strict';
// lib/mb-dump-parser.js
// Streaming TSV parser for MusicBrainz full-database dump files.
//
// MusicBrainz dump format:
//   - Tab-separated values, no header row
//   - \N means NULL
//   - LF line endings
//   - Files are named by table name (e.g. "recording", "work", "isrc")
//
// Dump files available at: https://musicbrainz.org/doc/MusicBrainz_Database/Download
// Typical download command:
//   wget -r -l1 --no-parent -A '*.tar.bz2' https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST/
//
// Usage:
//   const { batchStream } = require('./mb-dump-parser');
//   for await (const { batch, totalProcessed } of batchStream('./mbdump/recording', 'recording', 1000)) {
//     // batch is an array of row objects with gid, name, length_ms, etc.
//     await upsertRecordings(batch);
//   }
//
// Offset-based resume:
//   Pass startOffset to skip rows already processed.
//   Save lastOffset (= totalProcessed) to ingestion_state_v1 after each batch.

const fs   = require('fs');
const path = require('path');
const readline = require('readline');

// Column definitions per MB table name.
// Based on MusicBrainz schema: https://musicbrainz.org/doc/MusicBrainz_Database/Schema
// Column order matches the dump file byte-for-byte.
const COLUMN_DEFS = {
  artist: [
    'id','gid','name','sort_name',
    'begin_date_year','begin_date_month','begin_date_day',
    'end_date_year','end_date_month','end_date_day',
    'type','area','comment','edits_pending','last_updated','ended',
    'begin_area','end_area',
  ],
  artist_alias: [
    'id','artist','name','locale','edits_pending','last_updated',
    'type','sort_name',
    'begin_date_year','begin_date_month','begin_date_day',
    'end_date_year','end_date_month','end_date_day',
    'primary_for_locale',
  ],
  recording: [
    'id','gid','name','artist_credit','length','comment',
    'edits_pending','last_updated','video',
  ],
  release: [
    'id','gid','name','artist_credit','release_group','status',
    'packaging','language','script','barcode','comment',
    'edits_pending','quality','last_updated',
  ],
  release_group: [
    'id','gid','name','artist_credit','type','comment',
    'edits_pending','last_updated',
  ],
  work: [
    'id','gid','name','type','language','comment',
    'edits_pending','last_updated',
  ],
  isrc: ['id','recording','isrc','source','edits_pending'],
  iswc: ['id','work','iswc','source','edits_pending'],
  l_recording_work: [
    'id','link','entity0','entity1','edits_pending','last_updated',
    'link_order','entity0_credit','entity1_credit',
  ],
  l_artist_work: [
    'id','link','entity0','entity1','edits_pending','last_updated',
    'link_order','entity0_credit','entity1_credit',
  ],
  l_artist_recording: [
    'id','link','entity0','entity1','edits_pending','last_updated',
    'link_order','entity0_credit','entity1_credit',
  ],
  link: [
    'id','link_type',
    'begin_date_year','begin_date_month','begin_date_day',
    'end_date_year','end_date_month','end_date_day',
    'attribute_count','created','last_updated',
  ],
  link_type: [
    'id','parent','child_order','gid','entity_type0','entity_type1',
    'name','description','link_phrase','reverse_link_phrase',
    'long_link_phrase','priority','last_updated','is_deprecated',
    'has_dates','entity0_cardinality','entity1_cardinality',
  ],
};

function parseValue(v) {
  if (v === '\\N' || v === undefined) return null;
  return v;
}

// Parse a single TSV line into an object keyed by column name.
function parseLine(line, columns) {
  const parts = line.split('\t');
  const obj = {};
  for (let i = 0; i < columns.length; i++) {
    obj[columns[i]] = parseValue(parts[i]);
  }
  return obj;
}

// Transform a raw MB dump row into a staging-table-compatible object.
// Converts internal integer IDs to null (GUIDsare in 'gid' column).
function transformArtist(row) {
  const beginParts = [row.begin_date_year, row.begin_date_month, row.begin_date_day].filter(Boolean);
  const endParts   = [row.end_date_year,   row.end_date_month,   row.end_date_day].filter(Boolean);
  return {
    mb_artist_id:     row.gid,
    name:             row.name,
    sort_name:        row.sort_name,
    comment:          row.comment,
    ended:            row.ended === 't' || row.ended === '1' || row.ended === true,
    begin_date:       beginParts.length ? beginParts.join('-') : null,
    end_date:         endParts.length   ? endParts.join('-')   : null,
    mb_last_updated:  row.last_updated  ? new Date(row.last_updated).toISOString() : null,
    ingestion_source: 'dump',
    provenance:       { source: 'musicbrainz', data_license: 'CC0' },
  };
}

function transformRecording(row) {
  return {
    mb_recording_id:  row.gid,
    title:            row.name,
    length_ms:        row.length ? parseInt(row.length, 10) : null,
    comment:          row.comment,
    video:            row.video === 't' || row.video === '1' || row.video === true,
    mb_last_updated:  row.last_updated ? new Date(row.last_updated).toISOString() : null,
    ingestion_source: 'dump',
    provenance:       { source: 'musicbrainz', data_license: 'CC0' },
  };
}

function transformWork(row) {
  return {
    mb_work_id:       row.gid,
    title:            row.name,
    comment:          row.comment,
    mb_last_updated:  row.last_updated ? new Date(row.last_updated).toISOString() : null,
    ingestion_source: 'dump',
    provenance:       { source: 'musicbrainz', data_license: 'CC0' },
  };
}

function transformRelease(row) {
  return {
    mb_release_id:    row.gid,
    title:            row.name,
    barcode:          row.barcode,
    comment:          row.comment,
    mb_last_updated:  row.last_updated ? new Date(row.last_updated).toISOString() : null,
    ingestion_source: 'dump',
    provenance:       { source: 'musicbrainz', data_license: 'CC0' },
  };
}

function transformReleaseGroup(row) {
  return {
    mb_release_group_id: row.gid,
    title:               row.name,
    // secondary_types lives in a separate MB junction table, not in the dump row.
    // Schema requires NOT NULL; default to empty array.
    secondary_types:     [],
    comment:             row.comment,
    ingestion_source:    'dump',
    provenance:          { source: 'musicbrainz', data_license: 'CC0' },
  };
}

// Shared date-part assembler for linked-entity transformers.
function buildDate(year, month, day) {
  const parts = [year, month, day].filter(Boolean);
  return parts.length ? parts.join('-') : null;
}

// Normalize an ISWC string to the bare T+10-digit form (strips hyphens and dots).
// Different sources (Genius, Discogs, MB dump, collecting societies) write ISWCs
// with/without the standard T-NNNNNNNNN-C punctuation. Strip to canonical before
// any corpus write or lookup so the (mb_work_id, iswc) conflict key is stable.
function normalizeISWC(s) {
  if (!s) return null;
  return s.toUpperCase().replace(/[-.\s]/g, '');
}

// Transformers for linked entities — require an idMap (Map<intId, gid>) built
// from the parent dump file via buildIdMap(). Return null when the integer FK
// cannot be resolved; batchStream() skips null rows automatically.

function transformISRC(row, idMap) {
  const gid = idMap ? idMap.get(row.recording) : null;
  if (!gid) return null;
  const isrc = row.isrc ? row.isrc.toUpperCase().replace(/[-\s]/g, '') : null;
  if (!isrc) return null;
  return { mb_recording_id: gid, isrc };
}

function transformISWC(row, idMap) {
  const gid = idMap ? idMap.get(row.work) : null;
  if (!gid) return null;
  if (!row.iswc) return null;
  return { mb_work_id: gid, iswc: normalizeISWC(row.iswc) };
}

function transformArtistAlias(row, idMap) {
  const gid = idMap ? idMap.get(row.artist) : null;
  if (!gid) return null;
  if (!row.name) return null;
  return {
    mb_artist_id:  gid,
    alias_name:    row.name,
    alias_type:    row.type   || null,
    locale:        row.locale || null,
    primary_alias: row.primary_for_locale === 't' || row.primary_for_locale === '1',
    begin_date:    buildDate(row.begin_date_year, row.begin_date_month, row.begin_date_day),
    end_date:      buildDate(row.end_date_year,   row.end_date_month,   row.end_date_day),
  };
}

const TRANSFORMERS = {
  artist:        transformArtist,
  artist_alias:  transformArtistAlias,
  recording:     transformRecording,
  work:          transformWork,
  release:       transformRelease,
  release_group: transformReleaseGroup,
  isrc:          transformISRC,
  iswc:          transformISWC,
};

// Stream the dump file line by line, yielding batches of staging-ready objects.
// startOffset: number of rows to skip (for resume). 0 = start from beginning.
// idMap: Map<intId, gid> required for FK-linked entity types (isrc, iswc, artist_alias).
//        Rows whose FK cannot be resolved return null from the transformer and are skipped.
async function* batchStream(filePath, entityType, batchSize = 1000, startOffset = 0, idMap = null) {
  const columns = COLUMN_DEFS[entityType];
  if (!columns) throw new Error(`mb-dump-parser: unknown entity type "${entityType}". Known: ${Object.keys(COLUMN_DEFS).join(', ')}`);

  const transformer = TRANSFORMERS[entityType];
  const absPath = path.resolve(filePath);

  if (!fs.existsSync(absPath)) {
    throw new Error(`mb-dump-parser: dump file not found: ${absPath}`);
  }

  const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  // Entity types that have no gid column — skip the gid guard for these.
  const noGidTypes = new Set(['isrc', 'iswc', 'artist_alias']);

  let batch = [];
  let lineNum = 0;
  let totalProcessed = 0;

  for await (const line of rl) {
    lineNum++;
    if (!line || line.startsWith('--') || line.startsWith('#') || line.trim() === '') continue;

    // Skip rows before startOffset (resume from checkpoint)
    if (lineNum <= startOffset) continue;

    let row;
    try {
      row = parseLine(line, columns);
    } catch (err) {
      console.warn(`[mb-dump-parser] line ${lineNum} parse error: ${err.message}`);
      continue;
    }

    // Skip rows without a valid gid (malformed MB rows), unless type has no gid column.
    if (!row.gid && !noGidTypes.has(entityType)) continue;

    const transformed = transformer ? transformer(row, idMap) : row;
    // Transformers for FK-linked entities return null when the FK cannot be resolved.
    if (transformed === null) continue;

    batch.push(transformed);
    totalProcessed++;

    if (batch.length >= batchSize) {
      yield { batch, totalProcessed, lineNum };
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield { batch, totalProcessed, lineNum };
  }
}

// Build a Map<intId(string), gid(string)> from a dump file.
// Used to resolve integer FK columns in linked-entity dump files (isrc, iswc, artist_alias).
// entityType must be a type that has both 'id' and 'gid' columns (e.g. 'recording', 'work', 'artist').
async function buildIdMap(filePath, entityType) {
  const map = new Map();
  for await (const { row } of rawStream(filePath, entityType)) {
    if (row.id && row.gid) map.set(row.id, row.gid);
  }
  return map;
}

// Raw stream without transformation (useful for relationship tables needing ID lookups)
async function* rawStream(filePath, entityType, startOffset = 0) {
  const columns = COLUMN_DEFS[entityType];
  if (!columns) throw new Error(`mb-dump-parser: unknown entity type "${entityType}"`);

  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) throw new Error(`mb-dump-parser: file not found: ${absPath}`);

  const stream = fs.createReadStream(absPath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let lineNum = 0;
  for await (const line of rl) {
    lineNum++;
    if (!line || line.startsWith('--') || line.startsWith('#') || line.trim() === '') continue;
    if (lineNum <= startOffset) continue;
    try {
      yield { row: parseLine(line, columns), lineNum };
    } catch (err) {
      console.warn(`[mb-dump-parser] line ${lineNum} error: ${err.message}`);
    }
  }
}

module.exports = { batchStream, rawStream, buildIdMap, parseLine, COLUMN_DEFS, TRANSFORMERS, normalizeISWC };
