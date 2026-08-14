// api/set-ai-consent.js
// POST /api/set-ai-consent
//
// Sets AI-licensing consent state for a work. Called from:
//   - Artist portal (artist opts in/out via UI)
//   - Admin panel (manual override)
//   - Bulk import (future: CSV/API ingestion)
//
// Auth: x-admin-key header checked against AUDIT_ADMIN_KEY env var.
//       Endpoint fails CLOSED: if AUDIT_ADMIN_KEY is not configured,
//       every request is rejected with 401.
//
// Per CLAUDE.md: this touches consent state — PR only, human merges.
// This file is the write path. The read path is fn_get_consent_state_v1()
// called by api/partner/resolve-rights.js.
//
// Raw fetch only. No Supabase JS client.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const VALID_CONSENT_TYPES  = ['ai_training', 'ai_generation', 'nil_use'];
const VALID_CONSENT_STATES = ['granted', 'denied', 'unset'];

// Best-effort: find the primary rightsholder node for a work via graph edges.
// Tries work-as-recording (direct performed_by) then work-as-composition
// (recorded_as → recording → performed_by). Returns UUID or null.
// Caller-supplied granted_by is NEVER used — only this server-side lookup.
async function resolveGrantedBy(workId) {
  const headers = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };
  try {
    // Try: workId is a recording node → has performed_by edge to artist
    let r = await fetch(
      `${SB_URL}/rest/v1/graph_edges_v1?from_node_id=eq.${workId}&edge_type=eq.performed_by&select=to_node_id&limit=1`,
      { headers }
    );
    if (r.ok) {
      const edges = await r.json();
      if (edges[0]?.to_node_id) return edges[0].to_node_id;
    }
    // Try: workId is a composition node → recorded_as → recording → performed_by → artist
    r = await fetch(
      `${SB_URL}/rest/v1/graph_edges_v1?from_node_id=eq.${workId}&edge_type=eq.recorded_as&select=to_node_id&limit=1`,
      { headers }
    );
    if (r.ok) {
      const compEdges = await r.json();
      const recNode = compEdges[0]?.to_node_id;
      if (recNode) {
        r = await fetch(
          `${SB_URL}/rest/v1/graph_edges_v1?from_node_id=eq.${recNode}&edge_type=eq.performed_by&select=to_node_id&limit=1`,
          { headers }
        );
        if (r.ok) {
          const artistEdges = await r.json();
          if (artistEdges[0]?.to_node_id) return artistEdges[0].to_node_id;
        }
      }
    }
  } catch { /* fall through to null */ }
  return null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  // Fail closed: reject if AUDIT_ADMIN_KEY is not configured, not provided, or wrong.
  const expectedKey = process.env.AUDIT_ADMIN_KEY;
  const adminKey    = req.headers['x-admin-key'];
  if (!expectedKey || !adminKey || adminKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Destructure body. 'granted_by' is intentionally omitted — derived server-side.
  const { work_id, consent_type, status, expires_at, provenance } = req.body || {};

  if (!work_id)      return res.status(400).json({ error: 'work_id required' });
  if (!consent_type) return res.status(400).json({ error: 'consent_type required' });
  if (!status)       return res.status(400).json({ error: 'status required' });

  // Validate work_id format before URL interpolation to prevent injection.
  if (!UUID_RE.test(work_id)) {
    return res.status(400).json({ error: 'work_id must be a valid UUID' });
  }

  if (!VALID_CONSENT_TYPES.includes(consent_type)) {
    return res.status(400).json({
      error: `consent_type must be one of: ${VALID_CONSENT_TYPES.join(', ')}`,
    });
  }
  if (!VALID_CONSENT_STATES.includes(status)) {
    return res.status(400).json({
      error: `status must be one of: ${VALID_CONSENT_STATES.join(', ')}`,
    });
  }

  // Validate expires_at: must be null/absent or a valid ISO-8601 timestamp in the future.
  if (expires_at !== undefined && expires_at !== null) {
    const d = new Date(expires_at);
    if (isNaN(d.getTime())) {
      return res.status(400).json({ error: 'expires_at must be a valid ISO-8601 timestamp' });
    }
    if (d <= new Date()) {
      return res.status(400).json({ error: 'expires_at must be a future timestamp' });
    }
  }

  // Verify work_id exists in graph_nodes_v1 (work_id is now safe to interpolate).
  try {
    const checkRes = await fetch(
      `${SB_URL}/rest/v1/graph_nodes_v1?id=eq.${work_id}&select=id,node_type&limit=1`,
      { headers: { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` } }
    );
    const nodes = await checkRes.json();
    if (!nodes.length) {
      return res.status(404).json({ error: `work_id ${work_id} not found in rights graph` });
    }
  } catch (err) {
    return res.status(502).json({ error: `Graph lookup failed: ${err.message}` });
  }

  // Derive granted_by from the rights graph — never from the caller.
  const derivedGrantedBy = await resolveGrantedBy(work_id);

  const row = {
    work_id,
    consent_type,
    status,
    granted_by: derivedGrantedBy,
    granted_at: status === 'unset' ? null : new Date().toISOString(),
    expires_at: (expires_at !== undefined && expires_at !== null) ? expires_at : null,
    provenance: {
      flow:           provenance?.flow    || 'admin',
      set_by_user_id: provenance?.user_id || null,
      notes:          provenance?.notes   || null,
      set_at:         new Date().toISOString(),
    },
  };

  try {
    const upsertRes = await fetch(
      `${SB_URL}/rest/v1/ai_consent_v1?on_conflict=work_id,consent_type`,
      {
        method: 'POST',
        headers: {
          'apikey':        SB_KEY,
          'Authorization': `Bearer ${SB_KEY}`,
          'Content-Type':  'application/json',
          'Prefer':        'resolution=merge-duplicates,return=representation',
        },
        body: JSON.stringify(row),
      }
    );
    if (!upsertRes.ok) {
      const text = await upsertRes.text();
      return res.status(502).json({
        error:  `Consent upsert failed: ${upsertRes.status}`,
        detail: text.slice(0, 300),
      });
    }
    const saved = await upsertRes.json();
    return res.status(200).json({ ok: true, consent: saved[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
