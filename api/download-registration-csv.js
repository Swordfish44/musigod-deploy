// api/download-registration-csv.js
// GET /api/download-registration-csv?artist_id=<uuid>&format=ascap|bmi|mlc
//
// 1. Look up artist name from artists_v1
// 2. Fetch latest DONE enrichment from catalog_enrichments_v1
// 3. Parse stored master CSV to reconstruct track list
// 4. Fetch custom splits from catalog_writer_splits_v1
// 5. Merge splits into tracks (overrides equal-split defaults)
// 6. Generate split-aware CSV and return as downloadable file

const { generateASCAPCSV, generateBMICSV, generateMLCCSV } = require('../lib/generate-splits-csv');
const { assertExportReady } = require('../lib/generate-registration-files');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const VALID_FORMATS = new Set(['ascap', 'bmi', 'mlc'])

function sbGet(path, schema) {
  const headers = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` }
  if (schema) headers['Accept-Profile'] = schema
  return fetch(`${SB_URL}/rest/v1/${path}`, { headers })
}

// Parse a single CSV row handling quoted fields
function parseCSVRow(row) {
  const fields = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < row.length; i++) {
    const ch = row[i]
    if (ch === '"') {
      if (inQuotes && row[i + 1] === '"') { current += '"'; i++ }
      else inQuotes = !inQuotes
    } else if (ch === ',' && !inQuotes) {
      fields.push(current); current = ''
    } else {
      current += ch
    }
  }
  fields.push(current)
  return fields
}

// Reconstruct enrichedTracks from the stored master catalog CSV.
// Master CSV columns (0-indexed):
// 0 Track Title, 1 Release Title, 2 Year, 3 Type, 4 Track #, 5 Duration,
// 6 ISRC, 7 ISWC, 8 Writers (;-sep), 9 Writer Roles (;-sep),
// 10 Artist Credits, 11 Recording MBID, 12 Release MBID, 13 Enriched?, 14 Issues
function parseMasterCSV(csvContent) {
  const lines = (csvContent || '').split('\n').filter(l => l.trim())
  if (lines.length < 2) return []
  const [, ...rows] = lines  // skip header
  return rows.map(row => {
    const f = parseCSVRow(row)
    const writerNames = f[8] ? f[8].split('; ').filter(Boolean) : []
    const writerRoles = f[9] ? f[9].split('; ')                  : []
    return {
      trackTitle:    f[0] || null,
      releaseTitle:  f[1] || null,
      releaseYear:   f[2] || null,
      releaseType:   f[3] || null,
      trackNumber:   f[4] || null,
      trackDuration: null,  // stored as "M:SS" string; not needed for CSV generation
      isrcs:         f[6] ? f[6].split('; ').filter(Boolean) : [],
      iswc:          f[7] || null,
      writers:       writerNames.map((name, i) => ({
        name,
        role:      writerRoles[i] || 'writer',
        mbid:      null,
        ipi:       null,
        split_pct: null,  // will be overridden by stored splits below
      })),
      enriched:      f[13] === 'Yes',
    }
  })
}

// Merge stored splits into the reconstructed track list.
// Splits are keyed by lowercase track title.
function mergeSplits(tracks, splitsRows) {
  const splitsMap = new Map()
  for (const s of splitsRows) {
    splitsMap.set((s.track_title || '').toLowerCase().trim(), s.writers)
  }
  return tracks.map(track => {
    const key = (track.trackTitle || '').toLowerCase().trim()
    const customWriters = splitsMap.get(key)
    if (!customWriters || !customWriters.length) return track
    return {
      ...track,
      writers: customWriters.map(w => ({
        name:      w.name,
        role:      w.role || 'writer',
        ipi:       w.ipi || null,
        split_pct: w.split_pct,
        mbid:      null,
      })),
    }
  })
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const { artist_id, format = 'ascap' } = req.query
  if (!artist_id) return res.status(400).json({ error: 'artist_id required' })
  if (!VALID_FORMATS.has(format)) {
    return res.status(400).json({ error: 'format must be ascap, bmi, or mlc' })
  }

  try {
    // 1. Look up artist name
    const artistRes = await sbGet(
      `artists_v1?id=eq.${artist_id}&select=artist_name,legal_first_name,legal_last_name`,
      'artists'
    )
    const artists = await artistRes.json()
    if (!Array.isArray(artists) || !artists[0]) {
      return res.status(404).json({ error: 'Artist not found' })
    }
    const a = artists[0]
    const artistName = a.artist_name || `${a.legal_first_name} ${a.legal_last_name}`.trim()

    // 2. Fetch latest DONE enrichment
    const enrichRes = await sbGet(
      `catalog_enrichments_v1?artist_name=eq.${encodeURIComponent(artistName)}&status=eq.DONE&order=created_at.desc&limit=1&select=result,artist_name`
    )
    const enrichRows = await enrichRes.json()
    if (!Array.isArray(enrichRows) || !enrichRows[0]?.result) {
      return res.status(404).json({ error: `No completed enrichment found for "${artistName}"` })
    }
    const result = enrichRows[0].result
    const publisherName = result.publisherName || 'MusiGod Publishing Administration'
    const publisherIPI  = result.publisherIPI  || ''

    if (!result.files?.master?.content) {
      return res.status(500).json({ error: 'Enrichment result is missing master CSV' })
    }

    // 3. Parse master CSV → track list
    const tracks = parseMasterCSV(result.files.master.content)
    if (!tracks.length) {
      return res.status(500).json({ error: 'Master CSV parsed to 0 tracks' })
    }

    // 4. Fetch stored splits
    const splitsRes = await sbGet(
      `catalog_writer_splits_v1?artist_id=eq.${artist_id}&order=track_title.asc`
    )
    const splitsRows = splitsRes.ok ? await splitsRes.json() : []

    // 5. Merge splits
    const mergedTracks = mergeSplits(tracks, Array.isArray(splitsRows) ? splitsRows : [])
    const splitsApplied = mergedTracks.filter(t =>
      t.writers.some(w => w.split_pct != null)
    ).length

    // 5b. Readiness gate — fetch current readiness decisions for this artist + destination.
    // The reconstructed tracks have no catalog_track_id, so we resolve via
    // catalog_enriched_tracks_v1 (title-keyed) then join to registration_readiness_v1.
    const destMap = { ascap: 'ASCAP', bmi: 'BMI', mlc: 'MLC' }
    const destName = destMap[format]
    const titleReadinessMap = new Map()
    try {
      const catalogTracksRes = await sbGet(
        `catalog_enriched_tracks_v1?artist_name=ilike.${encodeURIComponent(artistName)}&select=id,track_title&limit=2000`
      )
      if (catalogTracksRes.ok) {
        const catalogTrackRows = await catalogTracksRes.json()
        if (Array.isArray(catalogTrackRows) && catalogTrackRows.length > 0) {
          const catalogIds = catalogTrackRows.map(t => `"${t.id}"`).join(',')
          const rRes = await sbGet(
            `registration_readiness_v1?catalog_track_id=in.(${catalogIds})&destination=eq.${destName}&select=catalog_track_id,decision,blockers,evidence_summary`
          )
          if (rRes.ok) {
            const rRows = await rRes.json()
            for (const row of (Array.isArray(rRows) ? rRows : [])) {
              const title = (row.evidence_summary?.track_title || '').toLowerCase().trim()
              if (title) titleReadinessMap.set(title, row)
            }
          }
        }
      }
    } catch (_) {
      // Readiness lookup failed — titleReadinessMap remains empty → assertExportReady blocks
    }
    try {
      assertExportReady(mergedTracks, titleReadinessMap)
    } catch (guardErr) {
      if (guardErr.code === 'EXPORT_BLOCKED') {
        return res.status(400).json({
          error: 'Export blocked: not all tracks are READY for registration',
          destination: destName,
          blocked_count: guardErr.nonReady.length,
          blocked_tracks: guardErr.nonReady,
        })
      }
      throw guardErr
    }

    // 6. Generate CSV
    let csvContent, filename
    if (format === 'ascap') {
      csvContent = generateASCAPCSV(mergedTracks, publisherName, publisherIPI)
      filename   = `${artistName}_ASCAP_Registration_splits.csv`
    } else if (format === 'bmi') {
      csvContent = generateBMICSV(mergedTracks, publisherName, publisherIPI)
      filename   = `${artistName}_BMI_Registration_splits.csv`
    } else {
      csvContent = generateMLCCSV(mergedTracks, publisherName, publisherIPI)
      filename   = `${artistName}_MLC_Registration_splits.csv`
    }

    console.log(`[download-csv] artist="${artistName}" format=${format} tracks=${tracks.length} splits_applied=${splitsApplied}`)

    res.setHeader('Content-Type', 'text/csv; charset=utf-8')
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    return res.status(200).send(csvContent)

  } catch (err) {
    console.error('[download-csv] error:', err.message)
    return res.status(500).json({ error: 'Internal server error', detail: err.message })
  }
}
