// api/get-enrichment-status.js
// GET /api/get-enrichment-status?job_id=<uuid>

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function sbGet(query) {
  const res = await fetch(`${SB_URL}/rest/v1/catalog_enrichments_v1?${query}`, {
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase GET: ${res.status} — ${text}`);
  }
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  const adminKey = req.headers['x-admin-key'];
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url    = new URL(req.url, 'https://musigod.com');
  const job_id = url.searchParams.get('job_id');
  const artist = url.searchParams.get('artist');
  const latest = url.searchParams.get('latest');

  // ?artist=X&latest=1 — return most recent job for that artist (used by frontend probe)
  if (!job_id && artist && latest) {
    try {
      const rows = await sbGet(
        `artist_name=eq.${encodeURIComponent(artist)}&order=created_at.desc&limit=1&select=id,status,progress_pct,progress_label,result,error_message,created_at,updated_at`
      );
      if (!rows?.length) return res.status(404).json({ error: 'No job found for artist' });
      const job = rows[0];
      return res.status(200).json({
        job_id: job.id, status: job.status,
        progress_pct: job.progress_pct || 0, progress_label: job.progress_label || null,
        result: job.result || null, error_message: job.error_message || null,
        created_at: job.created_at, updated_at: job.updated_at,
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (!job_id) return res.status(400).json({ error: 'job_id required' });

  try {
    const rows = await sbGet(
      `id=eq.${encodeURIComponent(job_id)}&select=id,status,progress_pct,progress_label,result,error_message,created_at,updated_at&limit=1`
    );

    if (!rows?.length) return res.status(404).json({ error: 'Job not found' });
    const job = rows[0];

    return res.status(200).json({
      job_id:         job.id,
      status:         job.status,
      progress_pct:   job.progress_pct || 0,
      progress_label: job.progress_label || null,
      result:         job.result || null,
      error_message:  job.error_message || null,
      created_at:     job.created_at,
      updated_at:     job.updated_at,
    });
  } catch (err) {
    console.error('[get-enrichment-status] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
