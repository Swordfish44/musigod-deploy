// api/get-readiness.js
// GET /api/get-readiness
//
// Read-only admin API for registration readiness data.
// No writes. No external calls. Requires x-admin-key.
//
// Query params (at least one target required):
//   catalog_track_id  — single track decisions (all destinations)
//   artist_name       — all decisions for artist's tracks
//   artist_id         — resolves to artist_name, then queries
//
// Optional modifiers:
//   destination       — filter to a single destination
//   decision          — filter to READY | BLOCKED | NEEDS_REVIEW | NOT_APPLICABLE
//   summary=true      — return decision counts only (no row details)
//   include_blockers=true — include blocker arrays in list responses

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

function sbFetch(path, extraHeaders = {}) {
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Accept': 'application/json',
    ...extraHeaders,
  };
  return fetch(`${SB_URL}/rest/v1/${path}`, { headers });
}

function sbRpc(name, body) {
  return fetch(`${SB_URL}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      'apikey': SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' });

  const adminKey = req.headers['x-admin-key'];
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const url = new URL(req.url, 'https://musigod.com');
  const catalogTrackId  = url.searchParams.get('catalog_track_id');
  const artistName      = url.searchParams.get('artist_name');
  const artistId        = url.searchParams.get('artist_id');
  const destination     = url.searchParams.get('destination');
  const decision        = url.searchParams.get('decision');
  const summary         = url.searchParams.get('summary') === 'true';
  const includeBlockers = url.searchParams.get('include_blockers') !== 'false';

  if (!catalogTrackId && !artistName && !artistId) {
    return res.status(400).json({ error: 'catalog_track_id, artist_name, or artist_id required' });
  }

  try {
    // Resolve track IDs
    let trackIds = null;
    let resolvedArtistName = artistName;

    if (catalogTrackId) {
      // Single track — query directly
      const params = new URLSearchParams();
      params.set('catalog_track_id', `eq.${catalogTrackId}`);
      if (destination) params.set('destination', `eq.${destination}`);
      if (decision) params.set('decision', `eq.${decision}`);
      const select = includeBlockers
        ? 'id,catalog_track_id,destination,decision,evaluated_at,ruleset_version,blockers,warnings,evidence_summary'
        : 'id,catalog_track_id,destination,decision,evaluated_at,ruleset_version,evidence_summary';
      params.set('select', select);
      params.set('order', 'destination.asc');

      const r = await sbFetch(`registration_readiness_v1?${params}`);
      if (!r.ok) {
        return res.status(502).json({ error: 'DB error', detail: (await r.text()).slice(0, 200) });
      }
      const rows = await r.json();
      return res.status(200).json({ decisions: rows, total: rows.length });
    }

    // Resolve artist
    if (artistId && !resolvedArtistName) {
      const artistRes = await sbFetch(
        `artists_v1?id=eq.${artistId}&select=artist_name`,
        { 'Accept-Profile': 'artists' }
      );
      const artists = artistRes.ok ? await artistRes.json() : [];
      resolvedArtistName = artists[0]?.artist_name;
      if (!resolvedArtistName) {
        return res.status(404).json({ error: 'Artist not found' });
      }
    }

    // Get track IDs for artist
    const trackParams = new URLSearchParams();
    trackParams.set('artist_name', `ilike.${resolvedArtistName}`);
    trackParams.set('select', 'id');
    trackParams.set('limit', '2000');
    const trackRes = await sbFetch(`catalog_enriched_tracks_v1?${trackParams}`);
    if (!trackRes.ok) {
      return res.status(502).json({ error: 'Failed to fetch tracks' });
    }
    const trackRows = await trackRes.json();
    if (!trackRows.length) {
      return res.status(404).json({ error: 'No tracks found for artist', artist_name: resolvedArtistName });
    }
    trackIds = trackRows.map(t => t.id);

    // Summary mode — use aggregate RPC
    if (summary) {
      const rpcRes = await sbRpc('rpc_get_readiness_summary', {
        p_artist_name: resolvedArtistName,
        p_track_ids: null,
      });
      if (!rpcRes.ok) {
        return res.status(502).json({ error: 'Summary RPC failed', detail: (await rpcRes.text()).slice(0, 200) });
      }
      const summaryData = await rpcRes.json();
      return res.status(200).json({
        artist_name: resolvedArtistName,
        total_tracks: trackIds.length,
        ...summaryData,
      });
    }

    // Full list mode — query readiness for these track IDs
    const inList = trackIds.map(id => `"${id}"`).join(',');
    const params = new URLSearchParams();
    params.set('catalog_track_id', `in.(${inList})`);
    if (destination) params.set('destination', `eq.${destination}`);
    if (decision) params.set('decision', `eq.${decision}`);
    const select = includeBlockers
      ? 'id,catalog_track_id,destination,decision,evaluated_at,ruleset_version,blockers,warnings,evidence_summary'
      : 'id,catalog_track_id,destination,decision,evaluated_at,ruleset_version';
    params.set('select', select);
    params.set('order', 'catalog_track_id.asc,destination.asc');
    params.set('limit', '5000');

    const readinessRes = await sbFetch(`registration_readiness_v1?${params}`);
    if (!readinessRes.ok) {
      return res.status(502).json({ error: 'DB error', detail: (await readinessRes.text()).slice(0, 200) });
    }
    const rows = await readinessRes.json();

    const notEvaluated = trackIds.length - new Set(rows.map(r => r.catalog_track_id)).size;

    return res.status(200).json({
      artist_name:    resolvedArtistName,
      total_tracks:   trackIds.length,
      evaluated:      rows.length,
      not_evaluated:  notEvaluated,
      decisions:      rows,
    });

  } catch (err) {
    console.error('[get-readiness] error:', err.message);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
