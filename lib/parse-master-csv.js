// lib/parse-master-csv.js
// Parses the Master Catalog CSV produced by generateMasterCatalogCSV()
// (lib/generate-registration-files.js) back into structured track rows, so
// historical enrichment runs whose per-track data was never persisted (see
// supabase/migrations/20260619_catalog_enriched_tracks_v1.sql) can be
// recovered from the JSONB blob stored in catalog_enrichments_v1.result.
//
// Honest limitation: the Master CSV stores Writers and Writer Roles as
// ';'-joined name/role lists with no MBID or IPI per writer (those only ever
// lived in memory during the original enrichment run). Recovered rows zip
// names to roles positionally and tag mbid/ipi as null — that granularity is
// gone for historical runs. Everything else (titles, ISRCs, ISWC, MBIDs,
// enriched flag) round-trips cleanly.

// Minimal RFC4180 CSV parser — handles quoted fields, embedded commas,
// embedded newlines, and doubled-quote escaping (matches csvRow() in
// lib/generate-registration-files.js).
function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n');

  for (let i = 0; i < s.length; i++) {
    const c = s[i];

    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') { inQuotes = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  // flush trailing field/row (file may or may not end with a newline)
  if (field.length || row.length) { row.push(field); rows.push(row); }

  // drop a fully-empty trailing row (common when file ends with \n)
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') {
    rows.pop();
  }

  return rows;
}

function splitJoined(value) {
  if (!value) return [];
  return String(value).split(';').map(s => s.trim()).filter(Boolean);
}

// 'm:ss' -> seconds. Returns null if unparseable/empty.
function durationToSeconds(value) {
  if (!value) return null;
  const m = String(value).trim().match(/^(\d+):(\d{2})$/);
  if (!m) return null;
  return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

const MASTER_COLUMNS = [
  'Track Title', 'Release Title', 'Year', 'Type', 'Track #', 'Duration',
  'ISRC', 'ISWC', 'Writers', 'Writer Roles', 'Artist Credits',
  'Recording MBID', 'Release MBID', 'Enriched?', 'Issues',
];

// Returns array of row objects shaped to match what persist-enriched-tracks.js
// expects (artist_name/job_id are added by the caller, not here).
function recoverTracksFromMasterCSV(csvContent) {
  const table = parseCSV(csvContent);
  if (!table.length) return [];

  const header = table[0];
  const idx = name => header.indexOf(name);
  const colIdx = {};
  for (const col of MASTER_COLUMNS) colIdx[col] = idx(col);

  const dataRows = table.slice(1);
  const tracks = [];

  for (const r of dataRows) {
    const trackTitle = (r[colIdx['Track Title']] || '').trim();
    if (!trackTitle) continue;

    const writerNames = splitJoined(r[colIdx['Writers']]);
    const writerRoles = splitJoined(r[colIdx['Writer Roles']]);
    const writers = writerNames.map((name, i) => ({
      name,
      mbid: null,
      ipi: null,
      role: writerRoles[i] || null,
      source: 'recovered_from_csv',
    }));

    const enrichedStr = (r[colIdx['Enriched?']] || '').trim().toLowerCase();
    const issues = (r[colIdx['Issues']] || '').trim();

    tracks.push({
      releaseTitle:     r[colIdx['Release Title']] || null,
      releaseYear:      r[colIdx['Year']] || null,
      releaseType:      r[colIdx['Type']] || null,
      releaseMBID:      r[colIdx['Release MBID']] || null,
      releaseGroupMBID: null, // not present in Master CSV
      trackNumber:      r[colIdx['Track #']] || null,
      trackTitle,
      trackDuration:    durationToSeconds(r[colIdx['Duration']]),
      recordingMBID:    r[colIdx['Recording MBID']] || null,
      isrcs:            splitJoined(r[colIdx['ISRC']]),
      iswc:             r[colIdx['ISWC']] || null,
      writers,
      artistCredits:    splitJoined(r[colIdx['Artist Credits']]),
      enriched:         enrichedStr === 'yes',
      enrichmentError:  issues || null,
      enrichmentSource: writers.length ? 'recovered_from_csv' : null,
    });
  }

  return tracks;
}

module.exports = { parseCSV, recoverTracksFromMasterCSV };
