// api/submit-statement.js
// MusiGod — Royalty Statement Ingestion API
// POST /api/submit-statement

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const baseHeaders = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_SERVICE_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Accept-Profile': 'royalties',
  'Content-Profile': 'royalties',
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
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
  } = req.body;

  if (!artist_id || !source_code || !statement_period_start || !statement_period_end || !line_items?.length) {
    return res.status(400).json({
      error: 'Missing required fields: artist_id, source_code, statement_period_start, statement_period_end, line_items',
    });
  }

  try {
    // 1. Resolve source_id from source_code
    const sourceRes = await fetch(
      `${SUPABASE_URL}/rest/v1/statement_sources_v1?source_code=eq.${encodeURIComponent(source_code)}&select=id`,
      { headers: baseHeaders }
    );
    const sources = await sourceRes.json();
    if (!sources?.length) {
      return res.status(400).json({ error: `Unknown source_code: ${source_code}` });
    }
    const source_id = sources[0].id;

    // 2. Enrich line items — calculate 15% fee on recovery items only
    const MGS_FEE_RATE = 0.15;
    let total_gross = 0;
    let total_recovery_fee = 0;

    const enrichedItems = line_items.map(item => {
      const gross = parseFloat(item.gross_amount_usd) || 0;
      const is_recovery = item.is_recovery || false;
      const fee = is_recovery ? parseFloat((gross * MGS_FEE_RATE).toFixed(4)) : 0;
      const net = parseFloat((gross - fee).toFixed(4));
      total_gross += gross;
      total_recovery_fee += fee;
      return {
        artist_id,
        statement_id: null, // filled in after statement insert
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
      };
    });

    total_gross = parseFloat(total_gross.toFixed(4));
    total_recovery_fee = parseFloat(total_recovery_fee.toFixed(4));
    const net_to_artist = parseFloat((total_gross - total_recovery_fee).toFixed(4));

    // 3. Insert statement batch
    const stmtRes = await fetch(`${SUPABASE_URL}/rest/v1/statements_v1`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Prefer': 'return=representation' },
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
      }),
    });

    const stmtBody = await stmtRes.json();
    if (!stmtRes.ok || !stmtBody?.[0]?.id) {
      return res.status(500).json({ error: 'Failed to create statement record', detail: stmtBody });
    }
    const statement_id = stmtBody[0].id;

    // 4. Insert line items with statement_id
    const itemsPayload = enrichedItems.map(item => ({ ...item, statement_id }));
    const lineRes = await fetch(`${SUPABASE_URL}/rest/v1/statement_line_items_v1`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify(itemsPayload),
    });

    if (!lineRes.ok) {
      const err = await lineRes.text();
      return res.status(500).json({ error: 'Failed to insert line items', detail: err });
    }

    // 5. Queue disbursement
    const disbRes = await fetch(`${SUPABASE_URL}/rest/v1/disbursement_queue_v1`, {
      method: 'POST',
      headers: { ...baseHeaders, 'Prefer': 'return=minimal' },
      body: JSON.stringify({
        artist_id,
        statement_id,
        period_label: `${statement_period_start} → ${statement_period_end}`,
        gross_amount_usd: total_gross,
        mgs_fee_usd: total_recovery_fee,
        net_to_artist_usd: net_to_artist,
        status: 'PENDING',
      }),
    });

    if (!disbRes.ok) {
      const err = await disbRes.text();
      return res.status(500).json({ error: 'Failed to queue disbursement', detail: err });
    }

    return res.status(200).json({
      success: true,
      statement_id,
      total_gross_usd: total_gross.toFixed(2),
      mgs_fee_usd: total_recovery_fee.toFixed(2),
      net_to_artist_usd: net_to_artist.toFixed(2),
      line_items_ingested: enrichedItems.length,
    });

  } catch (err) {
    console.error('[submit-statement] error:', err);
    return res.status(500).json({ error: 'Internal server error', detail: err.message });
  }
}
