// api/set-ai-consent.js
// POST /api/set-ai-consent
//
// Sets AI-licensing consent state for a work. Called from:
//   - Artist portal (artist opts in/out via UI)
//   - Admin panel (manual override)
//   - Bulk import (future: CSV/API ingestion)
//
// Auth: x-admin-key (same pattern as all admin endpoints).
//
// Per CLAUDE.md: this touches consent state — PR only, human merges.
// This file is the write path. The read path is fn_get_consent_state_v1()
// called by api/partner/resolve-rights.js.
//
// Raw fetch only. No Supabase JS client.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

const VALID_CONSENT_TYPES  = ['ai_training', 'ai_generation', 'nil_use'];
const VALID_CONSENT_STATES = ['granted', 'denied', 'unset'];

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'POST only' });

  const adminKey = req.headers['x-admin-key'];
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { work_id, consent_type, status, granted_by, expires_at, provenance } = req.body || {};

  // Validate
  if (!work_id)        return res.status(400).json({ error: 'work_id required' });
  if (!consent_type)   return res.status(400).json({ error: 'consent_type required' });
  if (!status)         return res.status(400).json({ error: 'status required' });

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

  // Verify work_id exists in graph_nodes_v1
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

  // Upsert consent row (one row per work_id + consent_type)
  const row = {
    work_id,
    consent_type,
    status,
    granted_by:   granted_by   || null,
    granted_at:   status === 'unset' ? null : new Date().toISOString(),
    expires_at:   expires_at   || null,
    provenance:   {
      flow:            provenance?.flow    || 'admin',
      set_by_user_id:  provenance?.user_id || null,
      notes:           provenance?.notes   || null,
      set_at:          new Date().toISOString(),
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
      return res.status(502).json({ error: `Consent upsert failed: ${upsertRes.status}`, detail: text.slice(0, 300) });
    }
    const saved = await upsertRes.json();
    return res.status(200).json({ ok: true, consent: saved[0] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
