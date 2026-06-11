// api/save-writer-override.js
// POST { artistName, trackTitle, writers: [{name, role}] }
// Upserts a manual writer override — used when automated enrichment can't find credits.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

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

  const { artistName, trackTitle, writers } = req.body || {};
  if (!artistName || !trackTitle) {
    return res.status(400).json({ error: 'artistName and trackTitle required' });
  }
  if (!Array.isArray(writers) || writers.length === 0) {
    return res.status(400).json({ error: 'writers must be a non-empty array' });
  }

  // Validate writer shape
  const clean = writers
    .filter(w => w && typeof w.name === 'string' && w.name.trim())
    .map(w => ({ name: w.name.trim(), role: (w.role || 'writer').trim() }));

  if (!clean.length) return res.status(400).json({ error: 'No valid writer entries' });

  try {
    const sbRes = await fetch(`${SB_URL}/rest/v1/catalog_writer_overrides`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'apikey':        SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Prefer':        'resolution=merge-duplicates,return=representation',
      },
      body: JSON.stringify({ artist_name: artistName, track_title: trackTitle, writers: clean }),
    });

    if (!sbRes.ok) {
      const txt = await sbRes.text();
      console.error('[save-override] Supabase error:', sbRes.status, txt);
      return res.status(500).json({ error: `DB error: ${sbRes.status}` });
    }

    const rows = await sbRes.json();
    console.log(`[save-override] saved: "${artistName}" / "${trackTitle}" →`, clean.map(w => w.name).join(', '));
    return res.status(200).json({ ok: true, override: rows[0] || null });
  } catch (err) {
    console.error('[save-override]', err.message);
    return res.status(500).json({ error: err.message });
  }
};
