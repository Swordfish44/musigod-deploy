// api/enrich-artist.js
// TRIGGER — inserts job row, fires n8n webhook (or falls back to direct call).
// Returns { job_id } immediately. Browser polls /api/get-enrichment-status.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// N8N_ENRICH_WEBHOOK: set this in Vercel env to your n8n webhook URL.
// If not set, falls back to calling /api/run-enrichment-job directly
// (works fine for manual/admin use; n8n gives you async progress).
const N8N_ENRICH_WEBHOOK = process.env.N8N_ENRICH_WEBHOOK;
const SELF_BASE          = process.env.VERCEL_URL
  ? `https://${process.env.VERCEL_URL}`
  : 'https://musigod.com';

async function sbPost(body) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enrichments_v1`, {
    method: 'POST',
    headers: {
      'Content-Type':    'application/json',
      
      
      'apikey':          SB_KEY,
      'Authorization':   `Bearer ${SB_KEY}`,
      'Prefer':          'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase insert failed: ${res.status} — ${text}`);
  }
  return res.json();
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

  // 1. Insert job row
  let rows;
  try {
    rows = await sbPost({
      artist_name:    artistName,
      publisher_name: publisherName,
      publisher_ipi:  publisherIPI || null,
      max_releases:   maxReleases,
      status:         'PENDING',
    });
  } catch (err) {
    console.error('[enrich-trigger] DB insert failed:', err.message);
    return res.status(500).json({ error: err.message });
  }

  const job_id = rows[0]?.id;
  if (!job_id) return res.status(500).json({ error: 'Job insert returned no id' });

  // 2. Fire worker — n8n webhook if configured, otherwise direct self-call
  const workerPayload = JSON.stringify({ job_id, artistName, publisherName, publisherIPI, maxReleases });

  if (N8N_ENRICH_WEBHOOK) {
    // Fire-and-forget to n8n — n8n calls /api/run-enrichment-job synchronously
    fetch(N8N_ENRICH_WEBHOOK, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    workerPayload,
    }).catch(err => console.error('[enrich-trigger] n8n fire failed:', err.message));
    console.log(`[enrich-trigger] job_id=${job_id} fired to n8n`);
  } else {
    // No n8n — call run-enrichment-job on the same deployment directly.
    // This is still async from the browser's perspective (browser polls).
    // Note: Vercel will kill this after 300s; fine for up to ~10 releases.
    const adminKeyHeader = process.env.AUDIT_ADMIN_KEY || '';
    fetch(`${SELF_BASE}/api/run-enrichment-job`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-admin-key':  adminKeyHeader,
      },
      body: workerPayload,
    }).catch(err => console.error('[enrich-trigger] direct worker call failed:', err.message));
    console.log(`[enrich-trigger] job_id=${job_id} fired direct (no n8n configured)`);
  }

  return res.status(202).json({ job_id, status: 'PENDING' });
};
