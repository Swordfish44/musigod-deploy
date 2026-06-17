// sync-esham-to-graph.js
// Syncs Esham's enriched catalog directly into the rights graph
// Writes directly to graph/works schema tables via Accept-Profile headers
// Run: node scripts/sync-esham-to-graph.js

const KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InV5a3prcm5vZXRjbGRldXh6cXl5Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUzMDYxOSwiZXhwIjoyMDkzMTA2NjE5fQ.jmBLX9VwFvFT4rc3lzqSJS9hFjis2QxRkmWpFizQtKk'
const SB  = 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const H   = { 'apikey': KEY, 'Authorization': 'Bearer ' + KEY }

async function get(path, schema) {
  const headers = { ...H }
  if (schema) headers['Accept-Profile'] = schema
  const r = await fetch(`${SB}/rest/v1/${path}`, { headers })
  const t = await r.text()
  if (!r.ok) throw new Error(`GET ${path}: ${r.status} ${t.slice(0,200)}`)
  return JSON.parse(t)
}

async function ins(table, schema, row, upsertOn) {
  const headers = {
    ...H,
    'Content-Type': 'application/json',
    'Accept-Profile': schema,
    'Content-Profile': schema,
    'Prefer': upsertOn ? 'resolution=merge-duplicates,return=representation' : 'return=representation',
  }
  const url = upsertOn ? `${SB}/rest/v1/${table}?on_conflict=${upsertOn}` : `${SB}/rest/v1/${table}`
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(row) })
  const t = await r.text()
  if (!r.ok) throw new Error(`INSERT ${schema}.${table}: ${r.status} ${t.slice(0,300)}`)
  const d = JSON.parse(t)
  return Array.isArray(d) ? d[0] : d
}

async function upsertNode({ node_type, label, external_id, external_id_ns, properties = {} }) {
  if (external_id) {
    const ex = await get(`graph_nodes_v1?external_id=eq.${encodeURIComponent(external_id)}&external_id_ns=eq.${encodeURIComponent(external_id_ns)}&select=id&limit=1`)
    if (ex[0]?.id) return ex[0].id
  }
  const row = await ins('nodes', 'graph', { node_type, label, external_id, external_id_ns, properties }, 'external_id,external_id_ns')
  return row.id
}

async function upsertEdge({ from_node_id, to_node_id, edge_type, share_numerator = null, share_denominator = 100, confidence = 0.9, confidence_sources = [], provenance_ref = null, properties = {} }) {
  const ex = await get(`graph_edges_v1?from_node_id=eq.${from_node_id}&to_node_id=eq.${to_node_id}&edge_type=eq.${edge_type}&status=eq.active&select=id&limit=1`)
  if (ex[0]?.id) return ex[0].id
  const row = await ins('edges', 'graph', { from_node_id, to_node_id, edge_type, share_numerator, share_denominator, confidence, confidence_sources, provenance_ref, properties, status: 'active' })
  return row.id
}

function parseCSV(text) {
  const lines = text.trim().split('\n')
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''))
  return lines.slice(1).map(line => {
    const vals = []; let cur = ''; let inQ = false
    for (const ch of line) {
      if (ch === '"') { inQ = !inQ }
      else if (ch === ',' && !inQ) { vals.push(cur.trim()); cur = '' }
      else cur += ch
    }
    vals.push(cur.trim())
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] || '']))
  }).filter(r => r['Track Title'])
}

function slug(str) { return (str || '').toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 50) }

async function main() {
  console.log('MusiGod Rights Graph — Esham Catalog Sync\n')

  const jobs = await get('catalog_enrichments_v1?status=eq.DONE&order=created_at.desc&limit=1&select=id,result')
  const job  = jobs[0]
  const csv  = job.result.files.master.content
  const tracks = parseCSV(csv)
  console.log('Job:', job.id)
  console.log('Tracks:', tracks.length, '\n')

  console.log('Creating artist + creator nodes...')
  const artistId = await upsertNode({ node_type: 'artist', label: 'Esham', external_id: 'esham-reel-life', external_id_ns: 'musigod_artist', properties: { legal_name: 'Esham Smith', stage_name: 'Esham', country: 'US', pro_performance: 'BMI' } })
  console.log('Artist node:', artistId)

  const creatorId = await upsertNode({ node_type: 'creator', label: 'Esham Smith', external_id: 'creator_esham-reel-life', external_id_ns: 'musigod_artist', properties: { legal_name: 'Esham Smith', pro_performance: 'BMI' } })
  console.log('Creator node:', creatorId)

  await upsertEdge({ from_node_id: artistId, to_node_id: creatorId, edge_type: 'alias_of', confidence: 1.0, confidence_sources: ['self_reported'], provenance_ref: 'esham_onboarding' })
  console.log('Artist -> Creator edge\n')

  const terr = await get('graph_nodes_v1?node_type=eq.territory&external_id=eq.US&select=id&limit=1')
  const usId = terr[0]?.id
  console.log('US territory:', usId, '\n')

  console.log(`Syncing ${tracks.length} tracks...\n`)
  let synced = 0; let errors = 0

  for (const t of tracks) {
    const title   = t['Track Title']
    const release = t['Release Title'] || ''
    const year    = t['Year'] || ''
    const isrc    = t['ISRC'] || ''
    const iswc    = t['ISWC'] || ''
    const key     = slug(title)

    try {
      const workId = await upsertNode({ node_type: 'work', label: title, external_id: 'esham_work_' + key, external_id_ns: 'musigod_catalog', properties: { title, release_title: release, year, iswc: iswc || null } })
      const recId  = await upsertNode({ node_type: 'recording', label: title, external_id: isrc || ('esham_rec_' + key), external_id_ns: isrc ? 'isrc' : 'musigod_catalog', properties: { title, isrc: isrc || null, release_title: release } })
      await upsertEdge({ from_node_id: workId,    to_node_id: recId,   edge_type: 'has_recording',   confidence: 1.0,  confidence_sources: ['musicbrainz'] })
      await upsertEdge({ from_node_id: artistId,  to_node_id: recId,   edge_type: 'performed',       confidence: 1.0,  confidence_sources: ['musicbrainz'] })
      await upsertEdge({ from_node_id: creatorId, to_node_id: workId,  edge_type: 'wrote',           confidence: 0.85, confidence_sources: ['self_reported'], share_numerator: 100, share_denominator: 100, provenance_ref: 'musicbrainz_enrichment', properties: { role: 'composer_lyricist' } })
      await upsertEdge({ from_node_id: creatorId, to_node_id: workId,  edge_type: 'owns_publishing', confidence: 0.85, confidence_sources: ['self_reported'], share_numerator: 100, share_denominator: 100, properties: { right_type: 'all' } })
      synced++
      process.stdout.write(`  ${synced}/${tracks.length} — ${title.slice(0,50)}\n`)
    } catch (e) {
      errors++
      console.error(`  ERR [${title}]: ${e.message}`)
    }
  }

  console.log('\n' + '─'.repeat(55))
  console.log('Synced: ', synced)
  console.log('Errors: ', errors)

  const nodes = await get('graph_nodes_v1?select=node_type')
  const c = {}; nodes.forEach(n => c[n.node_type] = (c[n.node_type] || 0) + 1)
  console.log('\nGraph node counts:')
  Object.entries(c).forEach(([k,v]) => console.log(`  ${k}: ${v}`))

  const edges = await get('graph_edges_v1?select=edge_type&status=eq.active')
  const e = {}; edges.forEach(n => e[n.edge_type] = (e[n.edge_type] || 0) + 1)
  console.log('\nGraph edge counts:')
  Object.entries(e).forEach(([k,v]) => console.log(`  ${k}: ${v}`))

  console.log('\nEsham catalog is live in the MusiGod rights graph.')
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1) })
