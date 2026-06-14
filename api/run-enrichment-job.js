// api/run-enrichment-job.js
// Called synchronously by n8n. Runs full enrichment and returns the complete
// result in the response body. n8n then writes DONE + result to Supabase.
// maxDuration: 300s (vercel.json)

const { enrichArtistCatalog } = require('../lib/enrich-catalog');
const {
  generateASCAPCSV,
  generateBMICSV,
  generateMLCCSV,
  generateMasterCatalogCSV,
  generateGapsReport,
} = require('../lib/generate-registration-files');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function sbPatch(job_id, body) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enrichments_v1?id=eq.${job_id}`, {
    method: 'PATCH',
    headers: {
      'Content-Type':    'application/json',
      
      
      'apikey':          SB_KEY,
      'Authorization':   `Bearer ${SB_KEY}`,
      'Prefer':          'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    console.error(`[run-job] sbPatch ${res.status}: ${txt}`);
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-enrich-token, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Accept either the n8n token or the admin key (so you can test manually too)
  const token    = req.headers['x-enrich-token'];
  const adminKey = req.headers['x-admin-key'];
  const validToken    = process.env.N8N_ENRICH_TOKEN && token === process.env.N8N_ENRICH_TOKEN;
  const validAdmin    = process.env.AUDIT_ADMIN_KEY  && adminKey === process.env.AUDIT_ADMIN_KEY;
  const tokenRequired = !!(process.env.N8N_ENRICH_TOKEN || process.env.AUDIT_ADMIN_KEY);
  if (tokenRequired && !validToken && !validAdmin) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { job_id, artistName, publisherName = 'MusiGod Publishing Administration', publisherIPI = '', maxReleases = 30 } = req.body || {};

  if (!job_id || !artistName) {
    return res.status(400).json({ error: 'job_id and artistName required' });
  }

  console.log(`[run-job] START job_id=${job_id} artist="${artistName}" maxReleases=${maxReleases}`);

  // Mark RUNNING immediately
  await sbPatch(job_id, { status: 'RUNNING', progress_pct: 5, progress_label: 'Looking up artist in MusicBrainz…' });

  try {
    const catalog = await enrichArtistCatalog(artistName, {
      maxReleases,
      onProgress: async ({ current, total, title }) => {
        const pct = Math.round(5 + (current / total) * 80);
        await sbPatch(job_id, {
          status:         'RUNNING',
          progress_pct:   pct,
          progress_label: `Processing release ${current}/${total}: ${title}`,
        });
      },
    });

    await sbPatch(job_id, { status: 'RUNNING', progress_pct: 88, progress_label: 'Generating registration CSVs…' });

    const ascapCSV   = generateASCAPCSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const bmiCSV     = generateBMICSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const mlcCSV     = generateMLCCSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const masterCSV  = generateMasterCatalogCSV(catalog.enrichedTracks);
    const gapsReport = generateGapsReport(catalog.enrichedTracks);

    const result = {
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
    };

    // Write final result to Supabase
    await sbPatch(job_id, {
      status:         'DONE',
      progress_pct:   100,
      progress_label: `Done — ${catalog.totalTracks} tracks enriched`,
      result,
    });

    console.log(`[run-job] DONE job_id=${job_id} tracks=${catalog.totalTracks}`);

    return res.status(200).json({ job_id, status: 'DONE', totalTracks: catalog.totalTracks });

  } catch (err) {
    console.error(`[run-job] ERROR job_id=${job_id}:`, err.message);
    await sbPatch(job_id, {
      status:         'ERROR',
      error_message:  err.message,
      progress_label: 'Enrichment failed',
    });
    return res.status(500).json({ job_id, status: 'ERROR', error: err.message });
  }
};
