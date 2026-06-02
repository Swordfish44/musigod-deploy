// api/submit-statement.js
// MusiGod — Royalty Statement Ingestion API
// POST /api/submit-statement

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY

const MGS_FEE_RATE = 0.15

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sbHeaders(schema) {
  return {
    'Content-Type': 'application/json',
    'apikey': SB_KEY,
    'Authorization': `Bearer ${SB_KEY}`,
    'Accept-Profile': schema,
    'Content-Profile': schema,
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  let body
  try {
    body = JSON.parse((await getRawBody(req)).toString())
  } catch (e) {
    return res.status(400).json({ error: 'Invalid JSON body' })
  }

  const {
    artist_id,
    source_code,
    statement_period_start,
    statement_period_end,
    received_date,
    file_url,
    file_type,
    notes,
    line_items,
  } = body

  if (!artist_id || !source_code || !statement_period_start || !statement_period_end || !Array.isArray(line_items) || !line_items.length) {
    return res.status(400).json({
      error: 'Missing required fields: artist_id, source_code, statement_period_start, statement_period_end, line_items'
    })
  }

  try {
    // 1. Resolve source_id
    const sourceRes = await fetch(
      `${SB_URL}/rest/v1/statement_sources_v1?source_code=eq.${encodeURIComponent(source_code)}&select=id`,
      { headers: sbHeaders('royalties') }
    )
    const sources = await sourceRes.json()
    if (!sources?.length) {
      return res.status(400).json({ error: `Unknown source_code: ${source_code}` })
    }
    const source_id = sources[0].id

    // 2. Enrich line items — 15% fee on recovery items only
    let total_gross = 0
    let total_recovery_fee = 0

    const enrichedItems = line_items.map(item => {
      const gross = parseFloat(item.gross_amount_usd) || 0
      const is_recovery = item.is_recovery || false
      const fee = is_recovery ? parseFloat((gross * MGS_FEE_RATE).toFixed(4)) : 0
      const net = parseFloat((gross - fee).toFixed(4))
      total_gross += gross
      total_recovery_fee += fee
      return {
        artist_id,
        song_title: item.song_title,
        isrc: item.isrc || null,
        iswc: item.iswc || null,
        royalty_type: item.royalty_type,
        territory: item.territory || 'US',
        usage_period_start: item.usage_period_start || statement_period_start,
        usage_period_end: item.usage_period_end || statement_period_end,
        gross_amount_usd: gross,
        mgs_fee_usd: fee,
        net_to_artist_usd: net,
        is_recovery,
      }
    })

    total_gross = parseFloat(total_gross.toFixed(4))
    total_recovery_fee = parseFloat(total_recovery_fee.toFixed(4))
    const net_to_artist = parseFloat((total_gross - total_recovery_fee).toFixed(4))

    // 3. Insert statement batch
    const stmtRes = await fetch(`${SB_URL}/rest/v1/statements_v1`, {
      method: 'POST',
      headers: { ...sbHeaders('royalties'), 'Prefer': 'return=representation' },
      body: JSON.stringify({
        artist_id,
        source_id,
        statement_period_start,
        statement_period_end,
        received_date: received_date || new Date().toISOString().split('T')[0],
        total_gross_usd: total_gross,
        total_songs: line_items.length,
        file_url: file_url || null,
        file_type: file_type || 'MANUAL',
        notes: notes || null,
        status: 'PENDING',
      })
    })

    const stmtBody = await stmtRes.json()
    if (!stmtRes.ok || !stmtBody?.[0]?.id) {
      return res.status(500).json({ error: 'Failed to create statement record', detail: stmtBody })
    }
    const statement_id = stmtBody[0].id

    // 4. Insert line items
    const lineRes = await fetch(`${SB_URL}/rest/v1/statement_line_items_v1`, {
      method: 'POST',
      headers: { ...sbHeaders('royalties'), 'Prefer': 'return=minimal' },
      body: JSON.stringify(enrichedItems.map(item => ({ ...item, statement_id })))
    })

    if (!lineRes.ok) {
      const err = await lineRes.text()
      return res.status(500).json({ error: 'Failed to insert line items', detail: err })
    }

    // 5. Queue disbursement
    const disbRes = await fetch(`${SB_URL}/rest/v1/disbursement_queue_v1`, {
      method: 'POST',
      headers: { ...sbHeaders('royalties'), 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        artist_id,
        statement_id,
        period_label: `${statement_period_start} → ${statement_period_end}`,
        gross_amount_usd: total_gross,
        mgs_fee_usd: total_recovery_fee,
        net_to_artist_usd: net_to_artist,
        status: 'PENDING',
      })
    })

    if (!disbRes.ok) {
      const err = await disbRes.text()
      return res.status(500).json({ error: 'Failed to queue disbursement', detail: err })
    }

    return res.status(200).json({
      success: true,
      statement_id,
      total_gross_usd: total_gross.toFixed(2),
      mgs_fee_usd: total_recovery_fee.toFixed(2),
      net_to_artist_usd: net_to_artist.toFixed(2),
      line_items_ingested: enrichedItems.length,
    })

  } catch (err) {
    console.error('[submit-statement] error:', err)
    return res.status(500).json({ error: 'Internal server error', detail: err.message })
  }
}
