// lib/generate-registration-files.js
// Takes enriched catalog data and generates bulk registration CSV files
// for ASCAP, BMI, and The MLC

// CSV escaping — no external dependency needed
function csvRow(fields) {
  return fields.map(f => {
    const s = (f == null ? '' : String(f)).replace(/"/g, '""');
    return /[,"\n\r]/.test(s) ? `"${s}"` : s;
  }).join(',');
}
function stringify(rows, { header, columns } = {}) {
  const lines = [];
  if (header && columns) {
    lines.push(csvRow(columns.map(c => c.header)));
  }
  for (const row of rows) {
    lines.push(csvRow(columns ? columns.map(c => row[c.key]) : row));
  }
  return lines.join('\n') + '\n';
}

// ── ASCAP BULK REGISTRATION FORMAT ────────────────────────────────────────
// ASCAP accepts bulk work registration via their ACE system
// Required fields: Title, Writers (name + IPI), Publishers, ISWC, Duration
function generateASCAPCSV(tracks, publisherName, publisherIPI) {
  const rows = [];

  // ASCAP header row
  rows.push([
    'Work Title',
    'Alternate Title',
    'ISWC',
    'Duration (seconds)',
    'Writer 1 Last Name',
    'Writer 1 First Name',
    'Writer 1 IPI',
    'Writer 1 Role',
    'Writer 1 Share %',
    'Writer 2 Last Name',
    'Writer 2 First Name',
    'Writer 2 IPI',
    'Writer 2 Role',
    'Writer 2 Share %',
    'Writer 3 Last Name',
    'Writer 3 First Name',
    'Writer 3 IPI',
    'Writer 3 Role',
    'Writer 3 Share %',
    'Publisher Name',
    'Publisher IPI',
    'Publisher Share %',
    'Release Title',
    'Release Year',
    'ISRC',
    'Notes',
  ]);

  for (const track of tracks) {
    if (!track.trackTitle) continue;

    const writers = track.writers.slice(0, 3);
    const writerShare = writers.length > 0 ? Math.floor(50 / writers.length) : 50;

    // Pad writers to 3
    while (writers.length < 3) writers.push({ name: '', mbid: '', role: '', ipi: '' });

    const splitName = (fullName) => {
      const parts = (fullName || '').trim().split(' ');
      const last = parts.length > 1 ? parts.pop() : '';
      return { first: parts.join(' '), last };
    };

    const w1 = splitName(writers[0]?.name);
    const w2 = splitName(writers[1]?.name);
    const w3 = splitName(writers[2]?.name);

    rows.push([
      track.trackTitle,
      '', // alternate title
      track.iswc || '',
      track.trackDuration || '',
      w1.last,
      w1.first,
      writers[0]?.ipi || '',
      writers[0]?.role || 'CA', // CA = composer/author
      writers[0]?.name ? writerShare : '',
      w2.last,
      w2.first,
      writers[1]?.ipi || '',
      writers[1]?.role || 'CA',
      writers[1]?.name ? writerShare : '',
      w3.last,
      w3.first,
      writers[2]?.ipi || '',
      writers[2]?.role || 'CA',
      writers[2]?.name ? writerShare : '',
      publisherName || '',
      publisherIPI || '',
      '50', // publisher gets 50% by default
      track.releaseTitle || '',
      track.releaseYear || '',
      (track.isrcs || [])[0] || '',
      track.enriched ? '' : 'NEEDS WRITER VERIFICATION',
    ]);
  }

  return stringify(rows);
}

// ── BMI BULK REGISTRATION FORMAT ──────────────────────────────────────────
// BMI accepts bulk via their Title Registration system
function generateBMICSV(tracks, publisherName, publisherIPI) {
  const rows = [];

  rows.push([
    'Title',
    'ISWC',
    'Duration',
    'Writer Name',
    'Writer IPI',
    'Writer PRO',
    'Writer Role',
    'Writer Ownership %',
    'Publisher Name',
    'Publisher IPI',
    'Publisher Ownership %',
    'Album/Release',
    'Release Year',
    'ISRC',
    'Verification Needed',
  ]);

  for (const track of tracks) {
    if (!track.trackTitle) continue;

    const writers = track.writers.length > 0 ? track.writers : [{ name: 'UNKNOWN - VERIFY', ipi: '', role: 'CA' }];
    const writerShare = Math.floor(50 / writers.length);

    for (const writer of writers) {
      rows.push([
        track.trackTitle,
        track.iswc || '',
        track.trackDuration ? `${Math.floor(track.trackDuration / 60)}:${String(track.trackDuration % 60).padStart(2, '0')}` : '',
        writer.name || '',
        writer.ipi || '',
        'BMI',
        writer.role || 'CA',
        writerShare,
        publisherName || '',
        publisherIPI || '',
        50,
        track.releaseTitle || '',
        track.releaseYear || '',
        (track.isrcs || [])[0] || '',
        track.enriched ? 'No' : 'YES - MISSING WRITER DATA',
      ]);
    }
  }

  return stringify(rows);
}

// ── MLC BULK REGISTRATION FORMAT ──────────────────────────────────────────
// The MLC accepts bulk work registration via their portal CSV upload
function generateMLCCSV(tracks, publisherName, publisherIPI) {
  const rows = [];

  rows.push([
    'Work Title',
    'ISWC',
    'Songwriter Name',
    'Songwriter IPI',
    'Songwriter Role',
    'Songwriter Share',
    'Publisher Name',
    'Publisher IPI',
    'Publisher Share',
    'ISRC',
    'Album Title',
    'Release Year',
    'Duration (seconds)',
    'Notes',
  ]);

  for (const track of tracks) {
    if (!track.trackTitle) continue;

    const writers = track.writers.length > 0
      ? track.writers
      : [{ name: 'UNKNOWN', ipi: '', role: 'CA' }];
    const writerShare = (50 / writers.length).toFixed(2);

    for (const isrc of (track.isrcs.length ? track.isrcs : [''])) {
      for (const writer of writers) {
        rows.push([
          track.trackTitle,
          track.iswc || '',
          writer.name || '',
          writer.ipi || '',
          writer.role || 'CA',
          writerShare,
          publisherName || '',
          publisherIPI || '',
          (50 / writers.length).toFixed(2),
          isrc,
          track.releaseTitle || '',
          track.releaseYear || '',
          track.trackDuration || '',
          track.enriched ? '' : 'WRITER DATA INCOMPLETE - VERIFY',
        ]);
      }
    }
  }

  return stringify(rows);
}

// ── MASTER CATALOG SPREADSHEET ────────────────────────────────────────────
// Full enriched catalog for internal VA review
function generateMasterCatalogCSV(tracks) {
  const rows = [];

  rows.push([
    'Track Title',
    'Release Title',
    'Year',
    'Type',
    'Track #',
    'Duration',
    'ISRC',
    'ISWC',
    'Writers',
    'Writer Roles',
    'Artist Credits',
    'Recording MBID',
    'Release MBID',
    'Enriched?',
    'Issues',
  ]);

  for (const track of tracks) {
    const issues = [];
    if (!track.writers.length) issues.push('NO WRITER DATA');
    if (!track.isrcs.length) issues.push('NO ISRC');
    if (!track.iswc) issues.push('NO ISWC');
    if (!track.enriched) issues.push('NOT ENRICHED');

    rows.push([
      track.trackTitle || '',
      track.releaseTitle || '',
      track.releaseYear || '',
      track.releaseType || '',
      track.trackNumber || '',
      track.trackDuration ? `${Math.floor(track.trackDuration / 60)}:${String(track.trackDuration % 60).padStart(2, '0')}` : '',
      (track.isrcs || []).join('; '),
      track.iswc || '',
      track.writers.map(w => w.name).join('; '),
      track.writers.map(w => w.role).join('; '),
      (track.artistCredits || []).join('; '),
      track.recordingMBID || '',
      track.releaseMBID || '',
      track.enriched ? 'Yes' : 'No',
      issues.join(', '),
    ]);
  }

  return stringify(rows);
}

// ── GAPS REPORT ───────────────────────────────────────────────────────────
function generateGapsReport(tracks) {
  const noWriter = tracks.filter(t => !t.writers.length);
  const noISRC = tracks.filter(t => !t.isrcs.length);
  const noISWC = tracks.filter(t => !t.iswc);
  const needsVerify = tracks.filter(t => !t.enriched);

  return {
    totalTracks: tracks.length,
    missingWriters: noWriter.length,
    missingISRC: noISRC.length,
    missingISWC: noISWC.length,
    needsVerification: needsVerify.length,
    readyToRegister: tracks.filter(t => t.writers.length > 0).length,
    missingWriterTracks: noWriter.slice(0, 20).map(t => `${t.releaseTitle} — ${t.trackTitle}`),
  };
}

module.exports = {
  generateASCAPCSV,
  generateBMICSV,
  generateMLCCSV,
  generateMasterCatalogCSV,
  generateGapsReport,
};
