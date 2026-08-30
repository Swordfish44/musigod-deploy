'use strict'
// api/get-rights-title-report.js
// GET /api/get-rights-title-report?isrc=... | ?iswc=... | ?id=<catalog_enriched_tracks_v1 UUID>
//
// Composes MusiGod's Rights Title Report from the three existing evidence
// subsystems without changing any of them:
//
//   - the partner graph  (works_recordings_v1 / works_compositions_v1 /
//     rights_split_allocations_v1 / rights_registrations_v1) — same tables
//     api/partner/resolve-rights.js already reads.
//
//   - the evidence graph (graph_nodes_v1 / graph_evidence_v1 /
//     graph_identifiers_v1 / graph_investigations_v1) — bridged in via
//     graph_catalog_links_v1 wherever the two graphs share a
//     catalog_enriched_tracks_v1 row. Where isrc/iswc lookups can't be
//     traced to a catalog_enriched_tracks_v1 row directly, this falls back
//     to a best-effort identifier match and is honest about it in the
//     `identity_bridge` field of the response rather than silently omitting
//     evidence-graph data.
//
//   - AI-licensing consent (ai_consent_v1, via fn_get_consent_state_v1) —
//     keyed to the EVIDENCE graph node id, not the partner graph node id.
//     ai_consent_v1.work_id references public.graph_nodes_v1(id) per
//     migration 20260622000000_ai_consent_ledger.sql. resolve-rights.js
//     currently passes the partner-graph node id into this same RPC; this
//     endpoint uses the bridged evidence-graph id instead, since that is the
//     id space the consent table actually references. Flagged explicitly in
//     the response and in the roadmap — needs live-schema confirmation.
//
// Read-only. No schema change. No writes to royalties/legal/consent tables.
// Admin-authenticated (X-Admin-Key), matching api/contract-intelligence.js's
// auth pattern — this is an internal/diagnostic tool for now, not the public
// partner API. No Supabase JS client, raw fetch only, per CLAUDE.md.
//
// See MUSIGOD_RIGHTS_TITLE_REPORT_ROADMAP.md, Phase 1, for the full spec
// this implements and what's intentionally out of scope for v1 (master-
// ownership splits, chain-of-title events, beneficial/legal ownership
// distinction, confidence-tier collapsing methodology).

const { withSentry } = require('./_sentry')
const { authenticate } = require('./_registration-auth')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

async function sbGet(table, params) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${SB_URL}/rest/v1/${table}?${qs}`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, Accept: 'application/json' },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Supabase ${table}: ${res.status} — ${text.slice(0, 200)}`)
  }
  return res.json()
}

async function sbRpc(fn, body) {
  const res = await fetch(`${SB_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) return null // missing/failing RPC treated as "not available", never a hard error here
  return res.json()
}

// ─── Step 1: resolve identity in the partner graph (mirrors resolve-rights.js) ─────

async function resolvePartnerGraph({ isrc, iswc, id }) {
  if (isrc) {
    const recordings = await sbGet('works_recordings_v1', {
      isrc: `eq.${isrc.toUpperCase()}`,
      select: 'node_id,isrc,title,version_title,duration_seconds,release_date,album_title,track_number,master_rights_holder,musicbrainz_recording_id,composition_node_id',
      limit: '1',
    })
    if (!recordings.length) return { recording: null, recordings: [], composition: null, track: null }
    const recording = recordings[0]
    let composition = null
    if (recording.composition_node_id) {
      const comps = await sbGet('works_compositions_v1', {
        node_id: `eq.${recording.composition_node_id}`,
        select: 'node_id,iswc,title,ascap_id,bmi_id,sesac_id,mlc_work_id,musicbrainz_id,public_domain,copyright_year,copyright_claimant',
        limit: '1',
      })
      composition = comps[0] || null
    }
    return { recording, recordings, composition, track: null }
  }

  if (iswc) {
    const comps = await sbGet('works_compositions_v1', {
      iswc: `eq.${iswc.toUpperCase()}`,
      select: 'node_id,iswc,title,ascap_id,bmi_id,sesac_id,mlc_work_id,musicbrainz_id,public_domain,copyright_year,copyright_claimant',
      limit: '1',
    })
    if (!comps.length) return { recording: null, recordings: [], composition: null, track: null }
    const composition = comps[0]
    const recordings = await sbGet('works_recordings_v1', {
      composition_node_id: `eq.${composition.node_id}`,
      select: 'node_id,isrc,title,version_title,duration_seconds,release_date,album_title,track_number,master_rights_holder',
      limit: '20',
    })
    return { recording: recordings[0] || null, recordings, composition, track: null }
  }

  if (id) {
    const tracks = await sbGet('catalog_enriched_tracks_v1', {
      id: `eq.${id}`,
      select: 'id,artist_name,artist_mbid,track_title,release_title,release_year,recording_mbid,isrcs,iswc,writers,enriched,enrichment_source',
      limit: '1',
    })
    if (!tracks.length) return { recording: null, recordings: [], composition: null, track: null }
    const track = tracks[0]
    let recording = null, composition = null
    if (track.isrcs && track.isrcs.length) {
      const recs = await sbGet('works_recordings_v1', {
        isrc: `eq.${track.isrcs[0]}`,
        select: 'node_id,isrc,title,duration_seconds,release_date,album_title,master_rights_holder,composition_node_id',
        limit: '1',
      })
      recording = recs[0] || null
      if (recording?.composition_node_id) {
        const comps = await sbGet('works_compositions_v1', {
          node_id: `eq.${recording.composition_node_id}`,
          select: 'node_id,iswc,title,ascap_id,bmi_id,sesac_id,mlc_work_id,public_domain',
          limit: '1',
        })
        composition = comps[0] || null
      }
    }
    return { recording, recordings: recording ? [recording] : [], composition, track }
  }

  return { recording: null, recordings: [], composition: null, track: null }
}

// ─── Step 2: bridge to the evidence graph via graph_catalog_links_v1 ───────────────

async function findCatalogTrackId({ isrc, iswc, track }) {
  if (track) return { trackId: track.id, method: 'direct' }

  if (isrc) {
    const rows = await sbGet('catalog_enriched_tracks_v1', {
      isrcs: `cs.{${isrc.toUpperCase()}}`,
      select: 'id',
      limit: '1',
    })
    if (rows.length) return { trackId: rows[0].id, method: 'heuristic_isrc_match' }
  }

  if (iswc) {
    const rows = await sbGet('catalog_enriched_tracks_v1', {
      iswc: `eq.${iswc.toUpperCase()}`,
      select: 'id',
      limit: '1',
    })
    if (rows.length) return { trackId: rows[0].id, method: 'heuristic_iswc_match' }
  }

  return { trackId: null, method: 'none' }
}

async function loadEvidenceGraph(trackId) {
  if (!trackId) return null

  const links = await sbGet('graph_catalog_links_v1', {
    track_id: `eq.${trackId}`,
    select: 'node_id,node_role,confidence,linked_at,linked_by',
  })
  if (!links.length) return null

  const nodeIds = [...new Set(links.map((l) => l.node_id))]
  const compositionLink = links.find((l) => l.node_role === 'composition')

  const [evidenceRows, identifierRows, investigationRows] = await Promise.all([
    sbGet('graph_evidence_v1', {
      subject_node_id: `in.(${nodeIds.join(',')})`,
      status: 'neq.retracted',
      select: 'id,subject_node_id,object_node_id,claim_type,claim_value,source_type,confidence,confidence_rationale,status,superseded_by,created_at',
      order: 'confidence.desc',
    }),
    sbGet('graph_identifiers_v1', {
      node_id: `in.(${nodeIds.join(',')})`,
      is_active: 'eq.true',
      select: 'node_id,namespace,value,source_type,confidence,observed_at',
    }),
    sbGet('graph_investigations_v1', {
      subject_node_id: `in.(${nodeIds.join(',')})`,
      status: 'in.(open,in_progress,needs_data)',
      select: 'id,subject_node_id,secondary_node_id,investigation_type,status,priority,title,findings,recommended_action,generated_by,created_at',
    }),
  ])

  return {
    links,
    compositionNodeId: compositionLink?.node_id || null,
    evidenceRows,
    identifierRows,
    investigationRows,
  }
}

// ─── Step 3: AI consent, keyed to the evidence-graph composition node ──────────────

async function loadConsent(evidenceGraphCompositionNodeId) {
  if (!evidenceGraphCompositionNodeId) {
    return {
      state: { ai_training: 'unset', ai_generation: 'unset', nil_use: 'unset' },
      note: 'no_evidence_graph_bridge — cannot key consent lookup to the id space ai_consent_v1 references',
    }
  }
  const rows = await sbRpc('fn_get_consent_state_v1', { p_work_id: evidenceGraphCompositionNodeId })
  if (!Array.isArray(rows) || !rows.length) {
    return { state: { ai_training: 'unset', ai_generation: 'unset', nil_use: 'unset' }, note: 'rpc_unavailable_or_empty' }
  }
  const byType = {}
  for (const row of rows) byType[row.consent_type] = row.effective_status
  return {
    state: {
      ai_training: byType.ai_training || 'unset',
      ai_generation: byType.ai_generation || 'unset',
      nil_use: byType.nil_use || 'unset',
    },
    note: null,
  }
}

// ─── Step 4: compose ownership assertions, preserving conflicts rather than collapsing ─

function buildOwnershipAssertions({ splits, evidenceRows }) {
  const assertions = []

  for (const s of splits || []) {
    assertions.push({
      party: null, // rights_split_allocations_v1 (as queried today) doesn't carry a party name — gap, see roadmap
      role: s.role,
      share_percent: s.share_percent,
      right_type: s.right_type,
      territory: s.territory_scope,
      confirmed_by_party: s.confirmed_by_party,
      confirmed_at: s.confirmed_at,
      source: 'rights_split_allocations_v1',
      confidence: s.confirmed_by_party ? 1.0 : 0.5,
    })
  }

  const ownershipEvidence = (evidenceRows || []).filter((e) =>
    ['ownership_share', 'writing_credit', 'publishing_credit'].includes(e.claim_type)
  )
  for (const e of ownershipEvidence) {
    assertions.push({
      party: e.claim_value?.credited_name || null,
      role: e.claim_value?.role || e.claim_type,
      share_percent: e.claim_value?.share_percent ?? null,
      right_type: e.claim_value?.right_type || null,
      territory: e.claim_value?.territory || null,
      confirmed_by_party: e.source_type === 'artist_submission' || e.source_type === 'admin_manual',
      confirmed_at: null,
      source: `graph_evidence_v1:${e.source_type}`,
      confidence: e.confidence,
      status: e.status,
      evidence_id: e.id,
    })
  }

  return assertions
}

function determineResolutionState({ investigationRows, evidenceRows }) {
  const hasOpenConflict = (investigationRows || []).some(
    (i) => i.investigation_type === 'ownership_conflict' && i.status === 'open'
  )
  const hasDisputedEvidence = (evidenceRows || []).some((e) => e.status === 'disputed')
  if (hasOpenConflict || hasDisputedEvidence) return 'contested'

  const hasUnresolvedGap = (investigationRows || []).some((i) => i.status === 'open' || i.status === 'needs_data')
  if (hasUnresolvedGap) return 'incomplete'

  // v1 default: nothing is auto-promoted to "confirmed" without an explicit human/
  // authoritative signal. See roadmap Phase 5 for the confidence-tier work this defers to.
  return 'unresolved_pending_review'
}

// ─── Handler ─────────────────────────────────────────────────────────────────────

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })
  if (!SB_KEY) return res.status(503).json({ error: 'Rights Title Report database access is not configured' })

  const actor = await authenticate(req, { admin: true })
  if (!actor) return res.status(401).json({ error: 'Authenticated MusiGod admin session required' })

  const url = new URL(req.url, 'https://musigod.com')
  const isrc = url.searchParams.get('isrc')
  const iswc = url.searchParams.get('iswc')
  const id = url.searchParams.get('id')

  if (!isrc && !iswc && !id) {
    return res.status(400).json({ error: 'Provide one of: isrc, iswc, or id' })
  }

  try {
    const { recording, recordings, composition, track } = await resolvePartnerGraph({ isrc, iswc, id })
    if (!recording && !composition && !track) {
      return res.status(404).json({
        error: 'work_not_found',
        message: `No work found for ${isrc ? 'isrc' : iswc ? 'iswc' : 'id'}=${isrc || iswc || id}`,
      })
    }

    const compNodeId = composition?.node_id || null
    const { trackId, method: bridgeMethod } = await findCatalogTrackId({ isrc, iswc, track })
    const evidenceGraph = await loadEvidenceGraph(trackId)

    const splits = compNodeId
      ? await sbGet('rights_split_allocations_v1', {
          split_sheet_node_id: `eq.${compNodeId}`,
          select: 'id,role,share_percent,right_type,territory_scope,confirmed_by_party,confirmed_at',
          order: 'share_percent.desc',
        })
      : []

    const registrations = compNodeId
      ? await sbGet('rights_registrations_v1', {
          work_node_id: `eq.${compNodeId}`,
          select: 'registration_type,registration_number,registration_date,registrar,status,territory_node_id',
          order: 'registration_date.desc',
        })
      : []

    const consent = await loadConsent(evidenceGraph?.compositionNodeId || null)
    const ownershipAssertions = buildOwnershipAssertions({ splits, evidenceRows: evidenceGraph?.evidenceRows })
    const resolutionState = determineResolutionState({
      investigationRows: evidenceGraph?.investigationRows,
      evidenceRows: evidenceGraph?.evidenceRows,
    })

    const gaps = []
    if (!composition?.iswc && !track?.iswc) gaps.push('missing_iswc')
    if (!recording && !(recordings || []).length && !(track?.isrcs || []).length) gaps.push('missing_isrc')
    if (!splits.length) gaps.push('splits_not_confirmed')
    if (!registrations.length) gaps.push('no_pro_registrations')
    if (!evidenceGraph) gaps.push('identity_bridge_incomplete') // the finding this endpoint exists to surface
    if (evidenceGraph && !(evidenceGraph.evidenceRows || []).length) gaps.push('no_evidence_graph_data')

    return res.status(200).json({
      musigod_version: '1.0-title-report-draft',
      resolved_at: new Date().toISOString(),
      lookup: { type: isrc ? 'isrc' : iswc ? 'iswc' : 'musigod_id', value: isrc || iswc || id },

      work: {
        title: composition?.title || track?.track_title || recording?.title || null,
        artist: track?.artist_name || null,
        iswc: composition?.iswc || track?.iswc || null,
        isrcs: track?.isrcs || (recording ? [recording.isrc] : (recordings || []).map((r) => r.isrc)),
        public_domain: composition?.public_domain || false,
        source: composition || recording ? 'musigod_graph' : 'musigod_enriched',
      },

      identity_bridge: {
        catalog_track_id: trackId,
        method: bridgeMethod,
        evidence_graph_nodes_found: evidenceGraph?.links?.length || 0,
      },

      ownership: {
        assertions: ownershipAssertions,
        resolution_state: resolutionState,
        note:
          'v1 draft — master-ownership splits, chain-of-title events, and beneficial/legal ownership ' +
          'distinction are not yet modeled. See MUSIGOD_RIGHTS_TITLE_REPORT_ROADMAP.md Phase 1/2.',
      },

      registrations,

      identifiers: evidenceGraph?.identifierRows || [],

      open_investigations: (evidenceGraph?.investigationRows || []).map((i) => ({
        type: i.investigation_type,
        priority: i.priority,
        title: i.title,
        findings: i.findings,
        recommended_action: i.recommended_action,
        generated_by: i.generated_by,
      })),

      consent: {
        ...consent.state,
        note:
          consent.note ||
          'Looked up against the evidence-graph node id (what ai_consent_v1 actually references), ' +
          'not the partner-graph id resolve-rights.js currently passes to the same RPC. See roadmap ' +
          'Executive Summary, finding 2 — needs live-schema confirmation.',
      },

      gaps,

      human_confirmed: ownershipAssertions.length > 0 && ownershipAssertions.every((a) => a.confirmed_by_party),
    })
  } catch (err) {
    console.error('[get-rights-title-report]', err.message)
    return res.status(500).json({ error: err.message })
  }
}, 'get-rights-title-report')
