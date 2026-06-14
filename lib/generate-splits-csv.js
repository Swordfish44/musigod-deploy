// lib/generate-splits-csv.js
// Split-aware registration CSV generators.
// writer.split_pct = writer's share of the writer's 50% (values sum to 100 per track).
// Actual CSV share = (split_pct / 100) * 50 = writer's % of total work.
// Falls back to equal division when split_pct is absent.

function csvRow(fields) {
  return fields.map(f => {
    const s = (f == null ? '' : String(f)).replace(/"/g, '""')
    return /[,"\n\r]/.test(s) ? `"${s}"` : s
  }).join(',')
}

// Returns each writer's share of the TOTAL work (as a number, 2dp).
// Publisher always takes the remaining 50%.
function computeShares(writers) {
  const hasSplits = writers.length > 0 && writers.every(w => w.split_pct != null)
  if (hasSplits) {
    return writers.map(w => parseFloat(((w.split_pct / 100) * 50).toFixed(2)))
  }
  const eq = writers.length > 0 ? parseFloat((50 / writers.length).toFixed(2)) : 50
  return writers.map(() => eq)
}

function splitName(fullName) {
  const parts = (fullName || '').trim().split(' ')
  const last = parts.length > 1 ? parts.pop() : ''
  return { first: parts.join(' '), last }
}

// ── ASCAP ────────────────────────────────────────────────────────────────────
function generateASCAPCSV(tracks, publisherName, publisherIPI) {
  const header = [
    'Work Title','Alternate Title','ISWC','Duration (seconds)',
    'Writer 1 Last Name','Writer 1 First Name','Writer 1 IPI','Writer 1 Role','Writer 1 Share %',
    'Writer 2 Last Name','Writer 2 First Name','Writer 2 IPI','Writer 2 Role','Writer 2 Share %',
    'Writer 3 Last Name','Writer 3 First Name','Writer 3 IPI','Writer 3 Role','Writer 3 Share %',
    'Publisher Name','Publisher IPI','Publisher Share %',
    'Release Title','Release Year','ISRC','Notes',
  ]
  const lines = [csvRow(header)]

  for (const track of tracks) {
    if (!track.trackTitle) continue

    const raw    = track.writers.slice(0, 3)
    const shares = computeShares(raw)
    // pad to 3 for CSV columns
    const writers = [...raw]
    while (writers.length < 3) writers.push({ name: '', ipi: '', role: '' })
    const pads = [...shares]
    while (pads.length < 3) pads.push('')

    const w = writers.map(wr => splitName(wr.name))
    lines.push(csvRow([
      track.trackTitle, '', track.iswc || '', track.trackDuration || '',
      w[0].last, w[0].first, writers[0].ipi || '', writers[0].role || 'CA', writers[0].name ? pads[0] : '',
      w[1].last, w[1].first, writers[1].ipi || '', writers[1].role || 'CA', writers[1].name ? pads[1] : '',
      w[2].last, w[2].first, writers[2].ipi || '', writers[2].role || 'CA', writers[2].name ? pads[2] : '',
      publisherName || '', publisherIPI || '', 50,
      track.releaseTitle || '', track.releaseYear || '',
      (track.isrcs || [])[0] || '',
      track.enriched ? '' : 'NEEDS WRITER VERIFICATION',
    ]))
  }

  return lines.join('\n') + '\n'
}

// ── BMI ──────────────────────────────────────────────────────────────────────
function generateBMICSV(tracks, publisherName, publisherIPI) {
  const header = [
    'Title','ISWC','Duration',
    'Writer Name','Writer IPI','Writer PRO','Writer Role','Writer Ownership %',
    'Publisher Name','Publisher IPI','Publisher Ownership %',
    'Album/Release','Release Year','ISRC','Verification Needed',
  ]
  const lines = [csvRow(header)]

  for (const track of tracks) {
    if (!track.trackTitle) continue

    const writers = track.writers.length > 0
      ? track.writers
      : [{ name: 'UNKNOWN - VERIFY', ipi: '', role: 'CA' }]
    const shares = computeShares(writers)
    const dur = track.trackDuration
      ? `${Math.floor(track.trackDuration / 60)}:${String(track.trackDuration % 60).padStart(2, '0')}`
      : ''

    writers.forEach((w, i) => {
      lines.push(csvRow([
        track.trackTitle, track.iswc || '', dur,
        w.name || '', w.ipi || '', 'BMI', w.role || 'CA', shares[i],
        publisherName || '', publisherIPI || '', 50,
        track.releaseTitle || '', track.releaseYear || '',
        (track.isrcs || [])[0] || '',
        track.enriched ? 'No' : 'YES - MISSING WRITER DATA',
      ]))
    })
  }

  return lines.join('\n') + '\n'
}

// ── MLC ──────────────────────────────────────────────────────────────────────
function generateMLCCSV(tracks, publisherName, publisherIPI) {
  const header = [
    'Work Title','ISWC','Songwriter Name','Songwriter IPI','Songwriter Role',
    'Songwriter Share','Publisher Name','Publisher IPI','Publisher Share',
    'ISRC','Album Title','Release Year','Duration (seconds)','Notes',
  ]
  const lines = [csvRow(header)]

  for (const track of tracks) {
    if (!track.trackTitle) continue

    const writers = track.writers.length > 0
      ? track.writers
      : [{ name: 'UNKNOWN', ipi: '', role: 'CA' }]
    const shares = computeShares(writers)

    for (const isrc of (track.isrcs && track.isrcs.length ? track.isrcs : [''])) {
      writers.forEach((w, i) => {
        lines.push(csvRow([
          track.trackTitle, track.iswc || '',
          w.name || '', w.ipi || '', w.role || 'CA', shares[i],
          publisherName || '', publisherIPI || '', 50,
          isrc, track.releaseTitle || '', track.releaseYear || '',
          track.trackDuration || '',
          track.enriched ? '' : 'WRITER DATA INCOMPLETE - VERIFY',
        ]))
      })
    }
  }

  return lines.join('\n') + '\n'
}

module.exports = { generateASCAPCSV, generateBMICSV, generateMLCCSV }
