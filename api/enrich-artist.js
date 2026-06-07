// api/enrich-artist.js
// Single-function enrichment — no self-call, no n8n required.
// Runs the full MusicBrainz + Discogs enrichment synchronously,
// writing progress to Supabase so the browser can poll.
// maxDuration: 300s (vercel.json)

const { enrichArtistCatalog } = require('../lib/enrich-catalog');
const {
  generateASCAPCSV, generateBMICSV, generateMLCCSV,
  generateMasterCatalogCSV, generateGapsReport,
} = require('../lib/generate-registration-files');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function sbPost(body) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enrichments_v1`, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer':        'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`DB insert: ${res.status} — ${await res.text()}`);
  return res.json();
}

async function sbPatch(job_id, body) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enrichments_v1?id=eq.${job_id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':  'application/json',
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) console.error(`[enrich] sbPatch ${res.status}: ${await res.text().catch(()=>'')}`);
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const adminKey = req.headers['x-admin-key'];
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    artistName,
    publisherName = 'MusiGod Publishing Administration',
    publisherIPI  = '',
    maxReleases   = 30,
  } = req.body || {};

  if (!artistName) return res.status(400).json({ error: 'artistName required' });

  // 1. Create job row — return job_id immediately to the browser
  let job_id;
  try {
    const rows = await sbPost({
      artist_name:    artistName,
      publisher_name: publisherName,
      publisher_ipi:  publisherIPI || null,
      max_releases:   maxReleases,
      status:         'RUNNING',
      progress_pct:   2,
      progress_label: 'Starting enrichment…',
    });
    job_id = rows[0]?.id;
    if (!job_id) throw new Error('No id returned from insert');
  } catch (err) {
    console.error('[enrich] DB insert failed:', err.message);
    return res.status(500).json({ error: err.message });
  }

  // 2. Return job_id to browser immediately — browser starts polling
  res.status(202).json({ job_id, status: 'RUNNING' });

  // 3. Run enrichment synchronously in THIS function invocation.
  // Vercel keeps the function alive until the handler resolves,
  // even after res.json() — as long as we're in the same async call stack.
  // We use setImmediate to yield, then run the work.
  await new Promise(resolve => setImmediate(resolve));

  try {
    await sbPatch(job_id, { progress_pct: 5, progress_label: 'Looking up artist in MusicBrainz…' });

    const catalog = await enrichArtistCatalog(artistName, {
      maxReleases,
      onProgress: async ({ current, total, title }) => {
        const pct = Math.round(5 + (current / total) * 80);
        await sbPatch(job_id, {
          progress_pct:   pct,
          progress_label: `Processing release ${current}/${total}: ${title}`,
        });
      },
    });

    await sbPatch(job_id, { progress_pct: 88, progress_label: 'Generating registration CSVs…' });

    const ascapCSV   = generateASCAPCSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const bmiCSV     = generateBMICSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const mlcCSV     = generateMLCCSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const masterCSV  = generateMasterCatalogCSV(catalog.enrichedTracks);
    const gapsReport = generateGapsReport(catalog.enrichedTracks);

    await sbPatch(job_id, {
      status:         'DONE',
      progress_pct:   100,
      progress_label: `Done — ${catalog.totalTracks} tracks enriched`,
      result: {
        artistName,
        mbid:              catalog.mbid,
        totalReleases:     catalog.totalReleases,
        processedReleases: catalog.processedReleases,
        totalTracks:       catalog.totalTracks,
        gapsReport,
        files: {
          ascap:  { filename: `${artistName}_ASCAP_Registration.csv`,  content: ascapCSV },
          bmi:    { filename: `${artistName}_BMI_Registration.csv`,    content: bmiCSV },
          mlc:    { filename: `${artistName}_MLC_Registration.csv`,    content: mlcCSV },
          master: { filename: `${artistName}_Master_Catalog.csv`,      content: masterCSV },
        },
        generatedAt: catalog.generatedAt,
      },
    });

    console.log(`[enrich] DONE job_id=${job_id} tracks=${catalog.totalTracks}`);
  } catch (err) {
    console.error(`[enrich] ERROR job_id=${job_id}:`, err.message);
    await sbPatch(job_id, {
      status:         'ERROR',
      error_message:  err.message,
      progress_label: 'Enrichment failed',
    });
  }
};
