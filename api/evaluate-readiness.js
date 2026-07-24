// api/evaluate-readiness.js
// POST /api/evaluate-readiness
//
// Authorized, idempotent reevaluation endpoint.
// Fetches tracks from catalog_enriched_tracks_v1, merges split validation
// status from catalog_writer_splits_v1, runs the deterministic evaluation
// engine, and upserts results to registration_readiness_v1.
//
// Does NOT submit anything to any external society.
// Requires x-admin-key header.
//
// Body (JSON):
//   { artist_id, artist_name, catalog_track_id, destinations }
// At least one of artist_id, artist_name, or catalog_track_id is required.
// destinations: optional array subset of DESTINATIONS; defaults to all 5.

const { evaluateReadiness, DESTINATIONS } = require('../lib/registration-readiness');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

function sbFetch(path, opts = {}) {
  const headers = {
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Content-Type': 'application/json',
    ...opts.headers,
  };
  return fetch(`${SB_URL}/rest/v1/${path}`, { ...opts, headers });
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
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const adminKey = req.headers['x-admin-key'];
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { artist_id, artist_name, catalog_track_id, destinations } = req.body || {};

  if (!artist_id && !artist_name && !catalog_track_id) {
    return res.status(400).json({ error: 'artist_id, artist_name, or catalog_track_id required' });
  }

  const targetDestinations = Array.isArray(destinations) && destinations.length > 0
    ? destinations.filter(d => DESTINATIONS.includes(d))
    : DESTINATIONS;

  if (targetDestinations.length === 0) {
    return res.status(400).json({ error: 'No valid destinations specified', valid: DESTINATIONS });
  }

  try {
    // 1. Fetch tracks
    const params = new URLSearchParams();
    params.set('select', 'id,artist_name,track_title,isrcs,iswc,writers,enriched,enrichment_source,enrichment_error');
    params.set('limit', '1000');

    if (catalog_track_id) {
      params.set('id', `eq.${catalog_track_id}`);
    } else if (artist_id) {
      // Resolve artist_name from artist_id via artists schema
      const artistRes = await sbFetch(
        `artists_v1?id=eq.${artist_id}&select=artist_name`,
        { headers: { 'Accept-Profile': 'artists' } }
      );
      const artists = artistRes.ok ? await artistRes.json() : [];
      const resolvedName = artists[0]?.artist_name;
      if (!resolvedName) {
        return res.status(404).json({ error: 'Artist not found' });
      }
      params.set('artist_name', `ilike.${resolvedName}`);
    } else {
      params.set('artist_name', `ilike.${artist_name}`);
    }

    const trackRes = await sbFetch(`catalog_enriched_tracks_v1?${params}`);
    if (!trackRes.ok) {
      const text = await trackRes.text();
      return res.status(502).json({ error: 'Failed to fetch tracks', detail: text.slice(0, 300) });
    }
    const tracks = await trackRes.json();
    if (!tracks.length) {
      return res.status(404).json({ error: 'No tracks found' });
    }

    // 2. Fetch validated splits for these tracks (to check splits_validated)
    const trackIds = tracks.map(t => t.id);
    const splitParams = new URLSearchParams();
    splitParams.set('artist_id', artist_id ? `eq.${artist_id}` : 'not.is.null');
    splitParams.set('validated', 'eq.true');
    splitParams.set('select', 'track_title,validated');
    const splitRes = await sbFetch(`catalog_writer_splits_v1?${splitParams}`);
    const splitRows = splitRes.ok ? await splitRes.json() : [];
    const validatedTitles = new Set(
      (Array.isArray(splitRows) ? splitRows : [])
        .filter(r => r.validated)
        .map(r => (r.track_title || '').toLowerCase().trim())
    );

    // 3. Evaluate each track × destination
    const decisions = [];
    const errors = [];

    for (const track of tracks) {
      const mergedTrack = {
        ...track,
        splits_validated: validatedTitles.has((track.track_title || '').toLowerCase().trim()),
        // Fields not yet in schema — default to null (no fabrication)
        master_rights_holder: null,
        publisher_ipi:        null,
        publisher_name:       null,
        territory:            null,
        society_mandate:      null,
        existing_registration_id: null,
        requires_amendment:   false,
      };

      for (const dest of targetDestinations) {
        const decision = evaluateReadiness(mergedTrack, dest);

        // Persist via SECURITY DEFINER RPC
        const rpcRes = await sbRpc('rpc_upsert_readiness_decision', {
          p_catalog_track_id:  track.id,
          p_destination:       dest,
          p_decision:          decision.decision,
          p_ruleset_version:   decision.ruleset_version,
          p_blockers:          decision.blockers,
          p_warnings:          decision.warnings,
          p_evidence_summary:  decision.evidence_summary,
        });

        if (!rpcRes.ok) {
          const errText = await rpcRes.text();
          errors.push({ track_id: track.id, destination: dest, error: errText.slice(0, 200) });
        } else {
          decisions.push({
            catalog_track_id: track.id,
            track_title:      track.track_title,
            destination:      dest,
            decision:         decision.decision,
            blocker_count:    decision.blockers.filter(b => b.severity === 'BLOCKING').length,
          });
        }
      }
    }

    console.log(`[evaluate-readiness] tracks=${tracks.length} decisions=${decisions.length} errors=${errors.length}`);

    return res.status(200).json({
      evaluated: decisions.length,
      errors: errors.length,
      tracks_evaluated: tracks.length,
      decisions,
      ...(errors.length > 0 ? { evaluation_errors: errors } : {}),
    });

  } catch (err) {
    console.error('[evaluate-readiness] error:', err.message);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
};
