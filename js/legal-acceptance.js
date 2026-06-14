/**
 * MusiGod Legal Acceptance Module
 * File: js/legal-acceptance.js
 * 
 * Usage:
 *   import { recordTermsAcceptance, recordPrivacyAcceptance, addLegalCheckboxes } from './js/legal-acceptance.js';
 * 
 * Or include as <script type="module"> and call window.MusiGodLegal.*
 * 
 * Calls Supabase RPC via raw fetch (no Supabase JS client — house rule).
 */

const SUPABASE_URL = 'https://uykzkrnoetcldeuxzqyy.supabase.co';
// Uses the anon key for public-facing calls (functions are SECURITY DEFINER)
const SUPABASE_ANON_KEY = window.__MG_ANON_KEY || '';

/**
 * Record terms of service acceptance.
 * Call this when an artist checks the terms checkbox or completes signup.
 *
 * @param {object} opts
 * @param {string} [opts.artistId]    - UUID of the artist (if logged in)
 * @param {string} [opts.artistEmail] - Artist email
 * @param {string} [opts.sourcePage]  - Page where acceptance happened (e.g. 'register.html')
 * @param {string} [opts.method]      - 'checkbox' | 'signature' | 'implied'
 * @returns {Promise<{id: string}|null>}
 */
export async function recordTermsAcceptance({ artistId = null, artistEmail = null, sourcePage = 'unknown', method = 'checkbox' } = {}) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_record_terms_acceptance_v1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept-Profile': 'registrations',
        'Content-Profile': 'registrations',
      },
      body: JSON.stringify({
        p_artist_id: artistId,
        p_artist_email: artistEmail,
        p_source_page: sourcePage,
        p_ip_address: null,   // server-side IP capture if needed via edge function
        p_user_agent: navigator.userAgent,
        p_method: method,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[MusiGod Legal] Terms acceptance failed:', err);
      return null;
    }
    const acceptanceId = await resp.json();
    return { id: acceptanceId };
  } catch (e) {
    console.error('[MusiGod Legal] Terms acceptance error:', e);
    return null;
  }
}

/**
 * Record privacy policy acceptance.
 *
 * @param {object} opts  - same shape as recordTermsAcceptance
 * @returns {Promise<{id: string}|null>}
 */
export async function recordPrivacyAcceptance({ artistId = null, artistEmail = null, sourcePage = 'unknown', method = 'checkbox' } = {}) {
  try {
    const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/fn_record_privacy_acceptance_v1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept-Profile': 'registrations',
        'Content-Profile': 'registrations',
      },
      body: JSON.stringify({
        p_artist_id: artistId,
        p_artist_email: artistEmail,
        p_source_page: sourcePage,
        p_ip_address: null,
        p_user_agent: navigator.userAgent,
        p_method: method,
      }),
    });
    if (!resp.ok) {
      const err = await resp.text();
      console.error('[MusiGod Legal] Privacy acceptance failed:', err);
      return null;
    }
    const acceptanceId = await resp.json();
    return { id: acceptanceId };
  } catch (e) {
    console.error('[MusiGod Legal] Privacy acceptance error:', e);
    return null;
  }
}

/**
 * Record both terms + privacy acceptance together.
 * Use this on register.html and recovery-conversion.html.
 *
 * @param {object} opts
 * @returns {Promise<{termsId: string, privacyId: string}|null>}
 */
export async function recordFullLegalAcceptance({ artistId = null, artistEmail = null, sourcePage = 'unknown', method = 'checkbox' } = {}) {
  const [terms, privacy] = await Promise.all([
    recordTermsAcceptance({ artistId, artistEmail, sourcePage, method }),
    recordPrivacyAcceptance({ artistId, artistEmail, sourcePage, method }),
  ]);
  if (!terms || !privacy) return null;
  return { termsId: terms.id, privacyId: privacy.id };
}

/**
 * Inject standard legal agreement checkboxes into a form container.
 * Automatically wires up acceptance recording on change.
 *
 * @param {string} containerId   - ID of the DOM element to inject into
 * @param {object} opts
 * @param {string} opts.sourcePage
 * @param {Function} [opts.getArtistId]   - callback returning artistId string
 * @param {Function} [opts.getArtistEmail] - callback returning email string
 *
 * Usage:
 *   addLegalCheckboxes('legal-acceptance-container', {
 *     sourcePage: 'register.html',
 *     getArtistEmail: () => document.getElementById('email').value,
 *   });
 */
export function addLegalCheckboxes(containerId, { sourcePage = 'unknown', getArtistId = () => null, getArtistEmail = () => null } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  container.innerHTML = `
    <div class="mg-legal-checkboxes">
      <label class="mg-legal-check">
        <input type="checkbox" id="mg-terms-check" required />
        <span>I have read and agree to the <a href="/terms.html" target="_blank">Terms of Service</a>.</span>
      </label>
      <label class="mg-legal-check">
        <input type="checkbox" id="mg-privacy-check" required />
        <span>I have read and agree to the <a href="/privacy.html" target="_blank">Privacy Policy</a>.</span>
      </label>
      <p class="mg-legal-note">
        By continuing, you also acknowledge the <a href="/disclosures.html" target="_blank">Recovery Disclosures</a>.
        Recovery estimates are projections only. MusiGod does not guarantee any specific recovery amount.
      </p>
    </div>
  `;

  // Wire acceptance recording when both are checked
  function maybeRecord() {
    const termsChecked = document.getElementById('mg-terms-check')?.checked;
    const privacyChecked = document.getElementById('mg-privacy-check')?.checked;
    if (termsChecked && privacyChecked) {
      recordFullLegalAcceptance({
        artistId: getArtistId(),
        artistEmail: getArtistEmail(),
        sourcePage,
        method: 'checkbox',
      });
    }
  }

  document.getElementById('mg-terms-check')?.addEventListener('change', maybeRecord);
  document.getElementById('mg-privacy-check')?.addEventListener('change', maybeRecord);
}

/**
 * Returns true if both legal checkboxes are checked.
 * Call before allowing form submission.
 */
export function legalCheckboxesAccepted() {
  return (
    document.getElementById('mg-terms-check')?.checked === true &&
    document.getElementById('mg-privacy-check')?.checked === true
  );
}

// Expose on window for non-module usage
window.MusiGodLegal = {
  recordTermsAcceptance,
  recordPrivacyAcceptance,
  recordFullLegalAcceptance,
  addLegalCheckboxes,
  legalCheckboxesAccepted,
};
