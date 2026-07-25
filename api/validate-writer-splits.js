// POST /api/validate-writer-splits
// Marks one existing split row validated after explicit admin evidence review.
// Does not submit registrations or call any external society.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.AUDIT_ADMIN_KEY) {
    return res.status(503).json({ error: 'Admin authorization is not configured' });
  }
  if (req.headers['x-admin-key'] !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!sbKey) {
    return res.status(503).json({ error: 'Database authorization is not configured' });
  }

  let body;
  try {
    body = JSON.parse((await getRawBody(req)).toString());
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const {
    artist_id,
    track_title,
    expected_updated_at,
    validated_by,
    evidence_ref,
  } = body || {};

  if (!artist_id || !track_title || !expected_updated_at || !validated_by || !evidence_ref) {
    return res.status(400).json({
      error: 'artist_id, track_title, expected_updated_at, validated_by, and evidence_ref are required',
    });
  }

  const rpcRes = await fetch(`${SB_URL}/rest/v1/rpc/rpc_validate_writer_splits`, {
    method: 'POST',
    headers: {
      'apikey': sbKey,
      'Authorization': `Bearer ${sbKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      p_artist_id: artist_id,
      p_track_title: track_title,
      p_expected_updated_at: expected_updated_at,
      p_validated_by: validated_by,
      p_evidence_ref: evidence_ref,
    }),
  });

  const text = await rpcRes.text();
  let result;
  try { result = JSON.parse(text); } catch { result = { detail: text }; }

  if (!rpcRes.ok) {
    const conflict = text.includes('changed after review');
    return res.status(conflict ? 409 : 400).json({
      error: conflict ? 'Split row changed after review' : 'Split validation failed',
      detail: result,
    });
  }

  return res.status(200).json({ success: true, validation: result });
};
