// api/enrich-artist.js
// TRIGGER ONLY — inserts a job row and fires n8n webhook.
// Returns { job_id } immediately. Browser polls /api/get-enrichment-status.

const SB_URL     = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY     = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const N8N_ENRICH = process.env.N8N_ENRICH_WEBHOOK; // set in Vercel env
const N8N_BASE   = 'https://musigod-n8n.onrender.com';

async function sbPost(table, schema, body) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept-Profile': schema,
      'Content-Profile': schema,
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Prefer': 'return=representation',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase POST ${table}: ${res.status} — ${text}`);
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

  // 1. Insert job row → get job_id
  let rows;
  try {
    rows = await sbPost('catalog_enrichments_v1', 'catalog', {
      artist_name:    artistName,
      publisher_name: publisherName,
      publisher_ipi:  publisherIPI || null,
      max_releases:   maxReleases,
      status:         'PENDING',
    });
  } catch (err) {
    console.error('[enrich-trigger] Supabase insert failed:', err.message);
    return res.status(500).json({ error: `Failed to create enrichment job: ${err.message}` });
  }

  const job_id = rows[0]?.id;
  if (!job_id) return res.status(500).json({ error: 'Job insert returned no id' });

  // 2. Fire n8n webhook (fire-and-forget — don't await response)
  const webhookUrl = N8N_ENRICH || `${N8N_BASE}/webhook/catalog-enrich`;
  fetch(webhookUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ job_id, artistName, publisherName, publisherIPI, maxReleases }),
  }).catch(err => console.error('[enrich-trigger] n8n fire failed:', err.message));

  console.log(`[enrich-trigger] job_id=${job_id} artist="${artistName}" webhook fired`);

  return res.status(202).json({ job_id, status: 'PENDING' });
};
