// api/get-enriched-tracks.js
// GET /api/get-enriched-tracks?artist_name=Esham&limit=500
//
// Thin authenticated proxy to catalog_enriched_tracks_v1.
// Returns structured per-track rows — NOT re-parsed CSV.
// Auth: same x-admin-key pattern as get-enrichment-status.js.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

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

  const url         = new URL(req.url, 'https://musigod.com');
  const artistName  = url.searchParams.get('artist_name');
  const jobId       = url.searchParams.get('job_id');
  const limit       = Math.min(parseInt(url.searchParams.get('limit') || '500', 10), 1000);

  if (!artistName && !jobId) {
    return res.status(400).json({ error: 'artist_name or job_id required' });
  }

  // Build PostgREST filter
  const params = new URLSearchParams();
  params.set('select', 'id,artist_name,artist_mbid,release_title,release_year,release_type,release_mbid,track_number,track_title,track_duration,recording_mbid,isrcs,iswc,writers,artist_credits,enriched,enrichment_source,enrichment_error,created_at,updated_at');
  params.set('order', 'release_year.asc,track_title.asc');
  params.set('limit', String(limit));

  if (artistName) params.set('artist_name', `ilike.${artistName}`);
  if (jobId)      params.set('job_id', `eq.${jobId}`);

  try {
    const sbRes = await fetch(`${SB_URL}/rest/v1/catalog_enriched_tracks_v1?${params}`, {
      headers: {
        'apikey':        SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Accept':        'application/json',
      },
    });

    if (!sbRes.ok) {
      const text = await sbRes.text();
      console.error(`[get-enriched-tracks] Supabase error ${sbRes.status}: ${text}`);
      return res.status(502).json({ error: `Supabase error: ${sbRes.status}`, detail: text.slice(0, 300) });
    }

    const tracks = await sbRes.json();
    return res.status(200).json({ tracks, total: tracks.length });
  } catch (err) {
    console.error('[get-enriched-tracks] unexpected error:', err.message);
    return res.status(500).json({ error: err.message });
  }
};
