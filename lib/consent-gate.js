'use strict';
// lib/consent-gate.js
//
// Reusable enforcement gate for AI-licensing consent.
// Every partner and AI workflow that needs work data for AI purposes MUST
// call checkConsent() and verify allowed === true before proceeding.
//
// checkConsent never throws — on any error it returns allowed: false.
// This is intentional: the safe default is to block, not to permit.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';

function sbKey() {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY || '';
}

const VALID_CONSENT_TYPES = ['ai_training', 'ai_generation', 'nil_use'];

// Check consent for one (workNodeId, consentType) pair.
// Returns: { allowed: boolean, effective_status: string, reason: string }
//   allowed = true ONLY when effective_status === 'granted'.
//   Denied / unset / expired / any error → allowed: false.
async function checkConsent(workNodeId, consentType) {
  if (!VALID_CONSENT_TYPES.includes(consentType)) {
    return {
      allowed:          false,
      effective_status: 'unknown',
      reason:           `invalid_consent_type:${consentType}`,
    };
  }
  if (!workNodeId) {
    return { allowed: false, effective_status: 'unset', reason: 'no_work_id' };
  }

  try {
    const key = sbKey();
    const res = await fetch(`${SB_URL}/rest/v1/rpc/fn_get_consent_state_v1`, {
      method: 'POST',
      headers: {
        'apikey':        key,
        'Authorization': `Bearer ${key}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ p_work_id: workNodeId }),
    });

    if (!res.ok) {
      return { allowed: false, effective_status: 'unknown', reason: 'consent_lookup_failed' };
    }

    const rows = await res.json();
    if (!Array.isArray(rows)) {
      return { allowed: false, effective_status: 'unknown', reason: 'consent_lookup_invalid_response' };
    }

    const row = rows.find(r => r.consent_type === consentType);
    if (!row) {
      return { allowed: false, effective_status: 'unset', reason: 'consent_type_not_found' };
    }

    const effective = row.effective_status;
    const allowed   = effective === 'granted';
    const reason = {
      granted: 'consent_granted',
      denied:  'consent_denied',
      expired: 'consent_expired',
      unset:   'consent_unset',
    }[effective] ?? `consent_unknown:${effective}`;

    return { allowed, effective_status: effective, reason };
  } catch (err) {
    return { allowed: false, effective_status: 'unknown', reason: `gate_error:${err.message}` };
  }
}

// Check all three consent types for a work in parallel.
// Returns: { ai_training: {...}, ai_generation: {...}, nil_use: {...} }
async function checkAllConsent(workNodeId) {
  const results = {};
  await Promise.all(
    VALID_CONSENT_TYPES.map(async type => {
      results[type] = await checkConsent(workNodeId, type);
    })
  );
  return results;
}

module.exports = { checkConsent, checkAllConsent, VALID_CONSENT_TYPES };
