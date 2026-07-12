// api/graph-sync.js
// MusiGod Rights Graph — Sync Layer
//
// Called internally after:
//   1. register-artist  → creates artist + creator nodes
//   2. submit-catalog   → creates work + recording nodes + edges
//   3. enrich-artist    → enriches nodes with ISWC/ISRC/MusicBrainz data
//
// Never called directly by the browser. Internal only.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

// ============================================================
// PUBLIC API — called from other route handlers
// ============================================================

/**
 * Called from register-artist.js after artist row is created.
 * Creates artist node + creator node + links them.
 */
async function syncArtistToGraph(artist) {
  try {
    const legalName = [artist.legal_first_name, artist.legal_last_name].filter(Boolean).join(' ')
    const displayName = artist.artist_name || legalName
    const pro = artist.meta?.pro_affiliation || null

    // 1. Upsert artist node
    const artistNodeId = await upsertNode({
      node_type: 'artist',
      label: displayName,
      external_id: artist.id,
      external_id_ns: 'musigod_artist',
      properties: {
        musigod_artist_id: artist.id,
        legal_name: legalName,
        stage_name: displayName,
        email: artist.email,
        plan_tier: artist.plan_tier,
        country: artist.country || 'US',
        city: artist.city || null,
        state: artist.state || null,
      },
    })

    // 2. Insert artist detail record
    await graphFetch('rights_artists_v1', {
      method: 'POST',
      body: {
        node_id: artistNodeId,
        legal_name: legalName,
        stage_name: displayName,
        artist_type: 'individual',
        country: artist.country || 'US',
        user_id: null, // link later when auth user exists
      },
      prefer: 'resolution=merge-duplicates,return=minimal',
      schema: 'rights',
    })

    // 3. Upsert creator node (songwriter identity — same person, different role)
    const creatorNodeId = await upsertNode({
      node_type: 'creator',
      label: legalName,
      external_id: `creator_${artist.id}`,
      external_id_ns: 'musigod_artist',
      properties: {
        musigod_artist_id: artist.id,
        legal_name: legalName,
        pro_performance: pro,
      },
    })

    // 4. Insert creator detail record
    await graphFetch('rights_creators_v1', {
      method: 'POST',
      body: {
        node_id: creatorNodeId,
        legal_name: legalName,
        display_name: displayName,
        pro_performance: pro,
        role_types: ['composer', 'lyricist'],
        user_id: null,
      },
      prefer: 'resolution=merge-duplicates,return=minimal',
      schema: 'rights',
    })

    // 5. Edge: artist node → creator node (alias_of — same human)
    await upsertEdge({
      from_node_id: artistNodeId,
      to_node_id: creatorNodeId,
      edge_type: 'alias_of',
      confidence: 1.0,
      sources: ['self_reported'],
      provenance_ref: `musigod_artist:${artist.id}`,
    })

    // 6. Find US society node and link if PRO known
    if (pro && pro !== 'UNSURE' && pro !== 'NONE') {
      const societyNodeId = await findNodeByExternalId(pro, 'pro')
      if (societyNodeId) {
        await upsertEdge({
          from_node_id: creatorNodeId,
          to_node_id: societyNodeId,
          edge_type: 'member_of_society',
          confidence: 0.9,
          sources: ['self_reported'],
          provenance_ref: `musigod_artist:${artist.id}`,
        })
      }
    }

    console.log(`[graph-sync] artist synced: artist_node=${artistNodeId} creator_node=${creatorNodeId}`)
    return { artistNodeId, creatorNodeId }

  } catch (err) {
    console.error('[graph-sync] syncArtistToGraph failed:', err.message)
    // Non-fatal — don't block registration
    return null
  }
}

/**
 * Called from submit-catalog.js after catalog rows are inserted.
 * Creates work + recording nodes and all authorship/ownership edges.
 */
async function syncCatalogToGraph(artistId, tracks) {
  if (!tracks?.length) return

  // Look up the artist's graph nodes
  const artistNodeId = await findNodeByExternalId(artistId, 'musigod_artist')
  const creatorNodeId = await findNodeByExternalId(`creator_${artistId}`, 'musigod_artist')

  // Look up US territory node
  const usNodeId = await findNodeByExternalId('US', 'iso2')

  const results = []

  for (const track of tracks) {
    try {
      const result = await syncTrackToGraph({
        track,
        artistNodeId,
        creatorNodeId,
        usNodeId,
      })
      results.push(result)
    } catch (err) {
      console.error(`[graph-sync] track sync failed: ${track.track_title}`, err.message)
    }
  }

  console.log(`[graph-sync] catalog synced: ${results.filter(Boolean).length}/${tracks.length} tracks`)
  return results
}

/**
 * Called from enrich-artist.js after enrichment completes.
 * Patches existing work/recording nodes with ISWC, ISRC, MusicBrainz IDs.
 *
 * Supports two incoming track shapes:
 *   enrichArtistCatalog() → camelCase: trackTitle, isrcs[], recordingMBID
 *   submit-catalog / bulk import → snake_case: title, isrc, catalog_id, recording_mbid
 */
async function syncEnrichmentToGraph(artistId, enrichedTracks) {
  if (!enrichedTracks?.length) return

  let patched = 0
  for (const track of enrichedTracks) {
    try {
      // Normalise field names across both incoming shapes.
      const title         = track.trackTitle      || track.title        || null
      const catalogId     = track.catalog_id      || null
      const iswc          = track.iswc            || null
      const isrc          = (track.isrcs && track.isrcs[0]) || track.isrc || null
      const recordingMbid = track.recording_mbid  || track.recordingMBID || null

      // ── Work node lookup: ISWC → catalog_id → title fingerprint ─────────────
      // These are tried in priority order; the first hit wins.
      // ISWC is the most reliable cross-source identifier for a composition.
      let workNodeId = null
      if (iswc)                 workNodeId = await findNodeByExternalId(iswc, 'iswc')
      if (!workNodeId && catalogId) workNodeId = await findNodeByExternalId(catalogId, 'musigod_catalog')
      if (!workNodeId && title)     workNodeId = await findNodeByExternalId(fingerprint(title), 'musigod_catalog')

      if (workNodeId) {
        const workPatch = {}
        if (iswc)                 workPatch.iswc             = iswc
        if (track.musicbrainz_id) workPatch.musicbrainz_id  = track.musicbrainz_id
        if (track.ascap_id)       workPatch.ascap_id         = track.ascap_id
        if (track.bmi_id)         workPatch.bmi_id           = track.bmi_id
        if (Object.keys(workPatch).length) {
          await graphFetch(`compositions?node_id=eq.${workNodeId}`, {
            method: 'PATCH',
            body: workPatch,
            schema: 'works',
          })
        }
      }

      // ── Recording node: ISRC namespace → rec_{catalogId} → title fingerprint ─
      // Patch with ISRC and/or recording MBID (Finding 1 + 2 fix).
      // ISRC goes into works.recordings.isrc — NOT into the node's external_id.
      // Recording MBID goes into works.recordings.musicbrainz_recording_id,
      // bridging catalog_enriched_tracks_v1.recording_mbid to the formal graph table.
      // Work and recording patches are independent: a missing work node does NOT
      // prevent the recording node from being updated.
      if (isrc || recordingMbid) {
        let recNodeId = null
        if (isrc)                     recNodeId = await findNodeByExternalId(isrc.toUpperCase(), 'isrc')
        if (!recNodeId && catalogId)  recNodeId = await findNodeByExternalId(`rec_${catalogId}`, 'musigod_catalog')
        if (!recNodeId && title)      recNodeId = await findNodeByExternalId(fingerprint(title), 'musigod_catalog')

        if (recNodeId) {
          const recPatch = {}
          if (isrc)          recPatch.isrc                     = isrc.toUpperCase()
          if (recordingMbid) recPatch.musicbrainz_recording_id = recordingMbid
          await graphFetch(`recordings?node_id=eq.${recNodeId}`, {
            method: 'PATCH',
            body: recPatch,
            schema: 'works',
          })
          // NOTE: we intentionally do NOT touch graph_nodes_v1.external_id or
          // external_id_ns. The MBID and ISRC are stored in works.recordings
          // columns. Changing the node's primary lookup key would permanently break
          // future findNodeByExternalId calls for this node.
        }
      }

      patched++
    } catch (err) {
      console.error(`[graph-sync] enrichment patch failed: ${track.trackTitle || track.title || '?'}`, err.message)
    }
  }

  console.log(`[graph-sync] enrichment synced: ${patched}/${enrichedTracks.length} tracks patched`)
}

// ============================================================
// INTERNAL — single track sync
// ============================================================

async function syncTrackToGraph({ track, artistNodeId, creatorNodeId, usNodeId }) {
  const catalogId = track.catalog_id
  const title = track.track_title || track.title

  // 1. Upsert work (composition) node
  const workNodeId = await upsertNode({
    node_type: 'work',
    label: title,
    external_id: catalogId || fingerprint(title),
    external_id_ns: 'musigod_catalog',
    properties: {
      catalog_id: catalogId,
      title,
      iswc: track.iswc || null,
      genre: track.genre || null,
    },
  })

  // 2. Insert composition detail record
  await graphFetch('compositions', {
    method: 'POST',
    body: {
      node_id: workNodeId,
      title,
      iswc: track.iswc || null,
      work_type: 'original',
      has_lyrics: true,
      public_domain: false,
      ascap_id: track.ascap_id || null,
      bmi_id: track.bmi_id || null,
    },
    prefer: 'resolution=merge-duplicates,return=minimal',
    schema: 'works',
  })

  // 3. Upsert recording node
  const recNodeId = await upsertNode({
    node_type: 'recording',
    label: title,
    external_id: track.isrc ? track.isrc.toUpperCase() : `rec_${catalogId}`,
    external_id_ns: track.isrc ? 'isrc' : 'musigod_catalog',
    properties: {
      catalog_id: catalogId,
      title,
      isrc: track.isrc || null,
      album_title: track.album_title || null,
    },
  })

  // 4. Insert recording detail record
  await graphFetch('recordings', {
    method: 'POST',
    body: {
      node_id: recNodeId,
      title,
      isrc: track.isrc ? track.isrc.toUpperCase() : null,
      album_title: track.album_title || null,
      ean_upc: track.upc || null,
      release_date: track.release_date || null,
      composition_node_id: workNodeId,
    },
    prefer: 'resolution=merge-duplicates,return=minimal',
    schema: 'works',
  })

  // 5. Edge: recording → work (has_recording)
  await upsertEdge({
    from_node_id: workNodeId,
    to_node_id: recNodeId,
    edge_type: 'has_recording',
    confidence: 1.0,
    sources: ['self_reported'],
    provenance_ref: catalogId,
  })

  // 6. Authorship edges — primary artist wrote/composed
  if (creatorNodeId) {
    // Parse splits to get this artist's share
    const splits = track.writer_splits || {}
    const artistName = track.artist_name || ''
    const share = extractShare(splits, artistName)

    await upsertEdge({
      from_node_id: creatorNodeId,
      to_node_id: workNodeId,
      edge_type: 'wrote',
      share_numerator: share,
      share_denominator: 100,
      confidence: 0.85,
      sources: ['self_reported'],
      provenance_ref: catalogId,
      properties: { role: 'composer_lyricist' },
    })

    // Publishing ownership
    await upsertEdge({
      from_node_id: creatorNodeId,
      to_node_id: workNodeId,
      edge_type: 'owns_publishing',
      share_numerator: share,
      share_denominator: 100,
      confidence: 0.85,
      sources: ['self_reported'],
      provenance_ref: catalogId,
      territory_ids: usNodeId ? [usNodeId] : [],
      properties: { role: 'writer_publisher', right_type: 'all' },
    })
  }

  // 7. Performance edge: artist → recording
  if (artistNodeId) {
    await upsertEdge({
      from_node_id: artistNodeId,
      to_node_id: recNodeId,
      edge_type: 'performed',
      confidence: 1.0,
      sources: ['self_reported'],
      provenance_ref: catalogId,
    })
  }

  // 8. Co-writers (if any listed)
  const writers = Array.isArray(track.writers) ? track.writers : []
  for (const writerName of writers) {
    if (!writerName) continue
    const coWriterNodeId = await upsertNode({
      node_type: 'creator',
      label: writerName,
      external_id: `cowriter_${fingerprint(writerName)}`,
      external_id_ns: 'musigod_cowriter',
      properties: { legal_name: writerName },
    })

    const coShare = extractShare(splits || {}, writerName)

    await upsertEdge({
      from_node_id: coWriterNodeId,
      to_node_id: workNodeId,
      edge_type: 'wrote',
      share_numerator: coShare,
      share_denominator: 100,
      confidence: 0.7, // lower — co-writer self-reported, not yet confirmed
      sources: ['self_reported'],
      provenance_ref: catalogId,
      properties: { role: 'co_writer', needs_confirmation: true },
    })
  }

  // 9. Link to DSP royalty sources if revenue_sources listed
  const revSources = Array.isArray(track.revenue_sources) ? track.revenue_sources : []
  for (const sourceName of revSources) {
    const dspKey = normalizeDspKey(sourceName)
    if (!dspKey) continue
    const sourceNodeId = await findNodeByExternalId(dspKey, 'dsp')
    if (sourceNodeId) {
      await upsertEdge({
        from_node_id: recNodeId,
        to_node_id: sourceNodeId,
        edge_type: 'generates_royalties_from',
        confidence: 0.8,
        sources: ['self_reported'],
        provenance_ref: catalogId,
      })
    }
  }

  return { workNodeId, recNodeId }
}

// ============================================================
// GRAPH DB HELPERS
// ============================================================

async function upsertNode({ node_type, label, external_id, external_id_ns, properties = {} }) {
  const res = await graphFetch('graph_upsert_node', {
    method: 'POST',
    rpc: true,
    body: {
      p_node_type: node_type,
      p_label: label,
      p_external_id: external_id || null,
      p_external_ns: external_id_ns || null,
      p_properties: properties,
    },
  })
  return res // returns UUID
}

async function upsertEdge({
  from_node_id, to_node_id, edge_type,
  share_numerator = null, share_denominator = 100,
  confidence = 0.9, sources = [], provenance_url = null,
  provenance_ref = null, properties = {}, territory_ids = [],
  effective_from = null, effective_until = null,
}) {
  return graphFetch('graph_upsert_edge', {
    method: 'POST',
    rpc: true,
    body: {
      p_from_node_id: from_node_id,
      p_to_node_id: to_node_id,
      p_edge_type: edge_type,
      p_share_numerator: share_numerator,
      p_share_denominator: share_denominator,
      p_confidence: confidence,
      p_sources: sources,
      p_provenance_url: provenance_url,
      p_provenance_ref: provenance_ref,
      p_properties: { ...properties, territory_ids },
      p_effective_from: effective_from,
      p_effective_until: effective_until,
    },
  })
}

async function findNodeByExternalId(externalId, ns) {
  if (!externalId) return null
  const rows = await graphFetch(
    `graph_nodes_v1?external_id=eq.${encodeURIComponent(externalId)}&external_id_ns=eq.${encodeURIComponent(ns)}&select=id&limit=1`,
    { schema: 'graph' }
  )
  return rows?.[0]?.id || null
}

async function graphFetch(pathOrTable, options = {}) {
  const { method = 'GET', body, prefer, schema = 'graph', rpc = false } = options

  const base = rpc
    ? `${SB_URL}/rest/v1/rpc/${pathOrTable}`
    : `${SB_URL}/rest/v1/${pathOrTable}`

  const headers = {
    apikey: SB_KEY,
    Authorization: `Bearer ${SB_KEY}`,
    'Accept-Profile': schema,
  }

  if (body) {
    headers['Content-Type'] = 'application/json'
    headers['Content-Profile'] = schema
  }
  if (prefer) headers['Prefer'] = prefer

  const res = await fetch(base, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  })

  const text = await res.text()
  if (!res.ok) throw new Error(`graphFetch ${method} ${pathOrTable} failed: ${res.status} ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : null
}

// ============================================================
// UTILITY
// ============================================================

function fingerprint(str) {
  return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

function extractShare(splits, name) {
  if (!splits || !name) return 50 // default 50% if unknown
  const key = Object.keys(splits).find(k =>
    k.toLowerCase().includes(name.toLowerCase().split(' ')[0])
  )
  if (!key) return 50
  const val = parseFloat(splits[key])
  return isNaN(val) ? 50 : Math.min(100, Math.max(0, val))
}

function normalizeDspKey(name) {
  const n = (name || '').toLowerCase()
  if (n.includes('spotify'))   return 'spotify'
  if (n.includes('apple'))     return 'apple'
  if (n.includes('youtube'))   return 'youtube'
  if (n.includes('amazon'))    return 'amazon'
  if (n.includes('tidal'))     return 'tidal'
  if (n.includes('tiktok'))    return 'tiktok'
  if (n.includes('pandora'))   return 'pandora'
  if (n.includes('deezer'))    return 'deezer'
  if (n.includes('sirius'))    return 'siriusxm'
  if (n.includes('iheart'))    return 'iheart'
  return null
}

module.exports = { syncArtistToGraph, syncCatalogToGraph, syncEnrichmentToGraph }
