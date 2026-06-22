// api/partner/resolve-rights.js
// GET /api/partner/resolve-rights?isrc=US...  OR  ?iswc=T...  OR  ?id=<uuid>
//
// Read-only endpoint. Returns ownership graph traversal for a work/recording:
// writers, publishers, splits, PRO registration status, and enrichment data.
// Auth: X-Partner-Key header (hashed against partners_v1.api_key_hash).
// Rate limit: per partners_v1.rate_limit_per_min, tracked in-memory per instance.
// Audit: every call logged to partner_api_calls_v1 regardless of outcome.
//
// No money movement. No consent state writes. Agent-buildable per CLAUDE.md.

const crypto = require('crypto');

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// ─── In-process rate limit store ─────────────────────────────────────────────
// Simple sliding window per partner_id. Resets on cold start (Vercel serverless),
// which is acceptable for MVP — upgrade to Redis/Supabase when needed.
const rateLimitWindows = new Map(); // partner_id → [timestamp, ...]

function checkRateLimit(partnerId, limitPerMin) {
  const now = Date.now();
  const windowMs = 60_000;
  const calls = (rateLimitWindows.get(partnerId) || []).filter(t => now - t < windowMs);
  if (calls.length >= limitPerMin) return false;
  calls.push(now);
  rateLimitWindows.set(partnerId, calls);
  return true;
}

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function sbGet(table, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Accept':        'application/json',
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase ${table}: ${res.status} — ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function sbInsert(table, row) {
  const res = await fetch(`${SB_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: {
      'apikey':        SB_KEY,
      'Authorization': `Bearer ${SB_KEY}`,
      'Content-Type':  'application/json',
      'Prefer':        'return=minimal',
    },
    body: JSON.stringify(row),
  });
  // Audit logging — don't throw if insert fails, just warn
  if (!res.ok) {
    const text = await res.text();
    console.warn(`[resolve-rights] audit insert failed: ${res.status} — ${text.slice(0, 200)}`);
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────
function hashApiKey(key) {
  return crypto.createHash('sha256').update(key).digest('hex');
}

async function authenticatePartner(rawKey) {
  if (!rawKey) return null;
  const hash = hashApiKey(rawKey);
  const rows = await sbGet('partners_v1', {
    api_key_hash: `eq.${hash}`,
    active:       'eq.true',
    select:       'id,partner_name,rate_limit_per_min',
    limit:        '1',
  });
  return rows[0] || null;
}

// ─── Rights resolution ────────────────────────────────────────────────────────
async function resolveByISRC(isrc) {
  // 1. Find recording in works_recordings_v1
  const recordings = await sbGet('works_recordings_v1', {
    isrc:   `eq.${isrc.toUpperCase()}`,
    select: 'node_id,isrc,title,version_title,duration_seconds,release_date,album_title,track_number,master_rights_holder,neighboring_rights_registered,musicbrainz_recording_id,composition_node_id',
    limit:  '1',
  });
  if (!recordings.length) return null;
  const recording = recordings[0];

  // 2. Find composition linked to recording
  let composition = null;
  if (recording.composition_node_id) {
    const comps = await sbGet('works_compositions_v1', {
      node_id: `eq.${recording.composition_node_id}`,
      select:  'node_id,iswc,title,ascap_id,bmi_id,sesac_id,mlc_work_id,musicbrainz_id,public_domain,copyright_year,copyright_claimant',
      limit:   '1',
    });
    composition = comps[0] || null;
  }

  return buildResponse({ recording, composition, lookupType: 'isrc', lookupValue: isrc });
}

async function resolveByISWC(iswc) {
  // 1. Find composition
  const comps = await sbGet('works_compositions_v1', {
    iswc:   `eq.${iswc.toUpperCase()}`,
    select: 'node_id,iswc,title,ascap_id,bmi_id,sesac_id,mlc_work_id,musicbrainz_id,public_domain,copyright_year,copyright_claimant',
    limit:  '1',
  });
  if (!comps.length) return null;
  const composition = comps[0];

  // 2. Find recordings for this composition
  const recordings = await sbGet('works_recordings_v1', {
    composition_node_id: `eq.${composition.node_id}`,
    select:              'node_id,isrc,title,version_title,duration_seconds,release_date,album_title,track_number,master_rights_holder',
    limit:               '20',
  });

  return buildResponse({ composition, recordings, lookupType: 'iswc', lookupValue: iswc });
}

async function resolveByMusiGodId(id) {
  // MusiGod internal UUID — try enriched_tracks_v1 first (most data for indie catalog)
  const tracks = await sbGet('catalog_enriched_tracks_v1', {
    id:     `eq.${id}`,
    select: 'id,artist_name,artist_mbid,track_title,release_title,release_year,recording_mbid,isrcs,iswc,writers,enriched,enrichment_source',
    limit:  '1',
  });
  if (!tracks.length) return null;
  const track = tracks[0];

  // Try to bridge to formal graph tables via recording_mbid / ISRC
  let recording = null, composition = null;
  if (track.isrcs && track.isrcs.length) {
    const recs = await sbGet('works_recordings_v1', {
      isrc:   `eq.${track.isrcs[0]}`,
      select: 'node_id,isrc,title,duration_seconds,release_date,album_title,master_rights_holder,composition_node_id',
      limit:  '1',
    });
    recording = recs[0] || null;
    if (recording?.composition_node_id) {
      const comps = await sbGet('works_compositions_v1', {
        node_id: `eq.${recording.composition_node_id}`,
        select:  'node_id,iswc,title,ascap_id,bmi_id,sesac_id,mlc_work_id,public_domain',
        limit:   '1',
      });
      composition = comps[0] || null;
    }
  }

  return buildResponse({ track, recording, composition, lookupType: 'musigod_id', lookupValue: id });
}

async function fetchSplits(compositionNodeId) {
  if (!compositionNodeId) return [];
  return sbGet('rights_split_allocations_v1', {
    split_sheet_node_id: `eq.${compositionNodeId}`,
    select:              'id,role,share_percent,right_type,territory_scope,confirmed_by_party,confirmed_at',
    order:               'share_percent.desc',
  });
}

async function fetchRegistrations(nodeId) {
  if (!nodeId) return [];
  return sbGet('rights_registrations_v1', {
    work_node_id: `eq.${nodeId}`,
    select:       'registration_type,registration_number,registration_date,registrar,status,territory_node_id',
    order:        'registration_date.desc',
  });
}

function buildResponse({ track, recording, composition, recordings, lookupType, lookupValue }) {
  const response = {
    musigod_version: '1.0',
    resolved_at:     new Date().toISOString(),
    lookup:          { type: lookupType, value: lookupValue },
    work: null,
    recordings: [],
    writers: [],
    splits: [],
    registrations: [],
    consent: {
      ai_licensing: 'unknown', // Lane A ships this — placeholder per spec
      note: 'AI-licensing consent state requires Lane A (consent ledger). Coming Q3 2026.',
    },
    gaps: [],
  };

  // Populate from enriched track (indie catalog path)
  if (track) {
    response.work = {
      source:       'musigod_enriched',
      musigod_id:   track.id,
      title:        track.track_title,
      artist:       track.artist_name,
      artist_mbid:  track.artist_mbid || null,
      release:      track.release_title || null,
      release_year: track.release_year || null,
      iswc:         track.iswc || composition?.iswc || null,
      isrcs:        track.isrcs || [],
      enriched:     track.enriched,
      enrichment_source: track.enrichment_source || null,
    };
    if (Array.isArray(track.writers) && track.writers.length) {
      response.writers = track.writers.map(w => ({
        name:   w.name,
        mbid:   w.mbid || null,
        ipi:    w.ipi  || null,
        role:   w.role || 'writer',
        source: w.source || null,
      }));
    }
  }

  // Supplement/override from formal graph tables when available
  if (composition) {
    response.work = {
      ...(response.work || {}),
      source:       'musigod_graph',
      iswc:         composition.iswc || response.work?.iswc || null,
      ascap_id:     composition.ascap_id || null,
      bmi_id:       composition.bmi_id   || null,
      sesac_id:     composition.sesac_id || null,
      mlc_work_id:  composition.mlc_work_id || null,
      musicbrainz_id: composition.musicbrainz_id || null,
      public_domain:  composition.public_domain  || false,
      copyright_year: composition.copyright_year || null,
    };
  }

  if (recording) {
    response.recordings = [{
      isrc:                  recording.isrc,
      title:                 recording.title,
      version_title:         recording.version_title || null,
      duration_seconds:      recording.duration_seconds || null,
      release_date:          recording.release_date || null,
      album_title:           recording.album_title || null,
      master_rights_holder:  recording.master_rights_holder || null,
    }];
  } else if (Array.isArray(recordings) && recordings.length) {
    response.recordings = recordings.map(r => ({
      isrc:                 r.isrc,
      title:                r.title,
      version_title:        r.version_title || null,
      duration_seconds:     r.duration_seconds || null,
      release_date:         r.release_date || null,
      album_title:          r.album_title || null,
      master_rights_holder: r.master_rights_holder || null,
    }));
  }

  // Gap detection
  if (!response.work?.iswc)             response.gaps.push('missing_iswc');
  if (!response.writers.length)         response.gaps.push('missing_writers');
  if (!response.recordings.length && !response.work?.isrcs?.length)
                                        response.gaps.push('missing_isrc');
  if (!response.splits.length)          response.gaps.push('splits_not_confirmed');
  if (!response.registrations.length)   response.gaps.push('no_pro_registrations');

  return response;
}

// ─── Handler ──────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Partner-Key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'GET only' });

  const t0 = Date.now();
  const url = new URL(req.url, 'https://musigod.com');

  const rawKey = req.headers['x-partner-key'] || url.searchParams.get('api_key');
  const isrc   = url.searchParams.get('isrc');
  const iswc   = url.searchParams.get('iswc');
  const id     = url.searchParams.get('id');

  let partner = null;
  let httpStatus = 200;
  let workFound  = false;
  let errorMsg   = null;
  let identifierType = isrc ? 'isrc' : iswc ? 'iswc' : id ? 'musigod_id' : null;
  let identifierValue = isrc || iswc || id || null;

  try {
    // Auth
    partner = await authenticatePartner(rawKey);
    if (!partner) {
      httpStatus = 401;
      throw new Error('Invalid or missing X-Partner-Key');
    }

    // Rate limit
    if (!checkRateLimit(partner.id, partner.rate_limit_per_min)) {
      httpStatus = 429;
      throw new Error(`Rate limit exceeded: ${partner.rate_limit_per_min} req/min`);
    }

    // Input validation
    if (!isrc && !iswc && !id) {
      httpStatus = 400;
      throw new Error('Provide one of: isrc, iswc, or id');
    }

    // Resolve
    let result = null;
    if (isrc)     result = await resolveByISRC(isrc);
    else if (iswc) result = await resolveByISWC(iswc);
    else           result = await resolveByMusiGodId(id);

    if (!result) {
      httpStatus = 404;
      workFound  = false;
      return res.status(404).json({
        error:   'work_not_found',
        message: `No work found for ${identifierType}=${identifierValue}`,
        lookup:  { type: identifierType, value: identifierValue },
      });
    }

    workFound = true;

    // Enrich with splits + registrations if we have composition node
    const compNodeId = result.work?.node_id || null;
    if (compNodeId) {
      result.splits        = await fetchSplits(compNodeId);
      result.registrations = await fetchRegistrations(compNodeId);
    }

    return res.status(200).json(result);

  } catch (err) {
    errorMsg = err.message;
    if (!httpStatus || httpStatus === 200) httpStatus = 500;
    console.error(`[resolve-rights] ${httpStatus} ${err.message}`);
    return res.status(httpStatus).json({ error: err.message });

  } finally {
    // Audit log — fire and forget, never block response
    sbInsert('partner_api_calls_v1', {
      partner_id:      partner?.id      || null,
      partner_name:    partner?.partner_name || null,
      endpoint:        'resolve-rights',
      identifier_type: identifierType,
      identifier:      identifierValue,
      http_status:     httpStatus,
      response_ms:     Date.now() - t0,
      work_found:      workFound,
      error_message:   errorMsg,
    }).catch(() => {}); // already warned inside sbInsert
  }
};
