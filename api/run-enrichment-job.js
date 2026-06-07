// api/run-enrichment-job.js
// Called by n8n webhook ONLY — not exposed to browser.
// Does the actual MusicBrainz enrichment, writes progress + result to Supabase.
// maxDuration: 300s (set in vercel.json)

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

async function sbPatch(table, schema, id, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}?id=eq.${id}`, {
    method:  'PATCH',
    headers: {
      'Content-Type':   'application/json',
      'Accept-Profile': schema,
      'Content-Profile':schema,
      'apikey':         SB_KEY,
      'Authorization':  `Bearer ${SB_KEY}`,
      'Prefer':         'return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[run-job] sbPatch failed: ${res.status} ${text}`);
  }
}

async function setProgress(job_id, pct, label) {
  await sbPatch('catalog_enrichments_v1', 'catalog', job_id, {
    status:         'RUNNING',
    progress_pct:   pct,
    progress_label: label,
  });
}

module.exports = async function handler(req, res) {
  // Only accept from n8n (shared secret or internal call)
  const token = req.headers['x-enrich-token'];
  if (process.env.N8N_ENRICH_TOKEN && token !== process.env.N8N_ENRICH_TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { job_id, artistName, publisherName, publisherIPI, maxReleases } = req.body || {};

  if (!job_id || !artistName) {
    return res.status(400).json({ error: 'job_id and artistName required' });
  }

  // Acknowledge immediately so n8n doesn't time out
  res.status(202).json({ job_id, accepted: true });

  // Run enrichment in background (after response sent)
  ;(async () => {
    try {
      await setProgress(job_id, 5, 'Looking up artist in MusicBrainz…');

      const catalog = await enrichArtistCatalog(artistName, {
        maxReleases: maxReleases || 30,
        onProgress: async ({ current, total, title }) => {
          const pct = Math.round(5 + (current / total) * 80);
          await setProgress(job_id, pct, `Processing release ${current}/${total}: ${title}`);
        },
      });

      await setProgress(job_id, 88, 'Generating registration CSVs…');

      const ascapCSV  = generateASCAPCSV(catalog.enrichedTracks, publisherName, publisherIPI);
      const bmiCSV    = generateBMICSV(catalog.enrichedTracks, publisherName, publisherIPI);
      const mlcCSV    = generateMLCCSV(catalog.enrichedTracks, publisherName, publisherIPI);
      const masterCSV = generateMasterCatalogCSV(catalog.enrichedTracks);
      const gapsReport= generateGapsReport(catalog.enrichedTracks);

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

      await sbPatch('catalog_enrichments_v1', 'catalog', job_id, {
        status:         'DONE',
        progress_pct:   100,
        progress_label: `Done — ${catalog.totalTracks} tracks enriched`,
        result,
      });

      console.log(`[run-job] job_id=${job_id} DONE — ${catalog.totalTracks} tracks`);
    } catch (err) {
      console.error(`[run-job] job_id=${job_id} ERROR:`, err.message);
      await sbPatch('catalog_enrichments_v1', 'catalog', job_id, {
        status:        'ERROR',
        error_message: err.message,
        progress_label:'Enrichment failed',
      });
    }
  })();
};
