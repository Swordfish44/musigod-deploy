/**
 * MusiGod Operational Disclosure Banners
 * File: js/disclosure-banners.js
 *
 * Loads active disclosures from Supabase and renders them
 * in a target container based on the current page context.
 *
 * Usage (add to any recovery workflow page):
 *
 *   <div id="mg-disclosures"></div>
 *   <script type="module">
 *     import { renderDisclosures } from '/js/disclosure-banners.js';
 *     renderDisclosures('mg-disclosures', 'recovery-conversion');
 *   </script>
 */

const SUPABASE_URL = 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SUPABASE_ANON_KEY = window.__MG_ANON_KEY || '';

/**
 * Fetch active disclosures for a given workflow page context.
 * @param {string} workflowPage - e.g. 'recovery-conversion', 'audit-report', 'authorization'
 * @returns {Promise<Array>}
 */
async function fetchDisclosures(workflowPage) {
  // Fetch all active disclosures; filter by workflow_placement client-side
  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/operational_disclosures_v1?is_active=eq.true&select=*`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept-Profile': 'registrations',
      },
    }
  );
  if (!resp.ok) return [];
  const rows = await resp.json();
  return rows.filter(d =>
    !d.workflow_placement || d.workflow_placement.includes(workflowPage)
  );
}

/**
 * Render disclosure banners into a container element.
 * Banners are ordered: critical → warning → info.
 *
 * @param {string} containerId - DOM element ID to render into
 * @param {string} workflowPage - current page context
 * @param {object} opts
 * @param {string[]} [opts.formats] - which display formats to show ('banner', 'inline', 'footnote')
 */
export async function renderDisclosures(containerId, workflowPage, { formats = ['banner', 'inline'] } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;

  let disclosures;
  try {
    disclosures = await fetchDisclosures(workflowPage);
  } catch (e) {
    console.error('[MusiGod Disclosures] Fetch failed:', e);
    return;
  }

  const filtered = disclosures
    .filter(d => formats.includes(d.display_format))
    .sort((a, b) => {
      const order = { critical: 0, warning: 1, info: 2 };
      return (order[a.severity] ?? 3) - (order[b.severity] ?? 3);
    });

  if (!filtered.length) return;

  const colorMap = {
    critical: { border: '#c0392b', bg: '#fdecea', icon: '⚠' },
    warning:  { border: '#e67e22', bg: '#fef0e6', icon: '⚠' },
    info:     { border: '#2980b9', bg: '#e8f4fd', icon: 'ℹ' },
  };

  const html = filtered.map(d => {
    const c = colorMap[d.severity] || colorMap.info;
    return `
      <div class="mg-disclosure mg-disclosure--${d.severity} mg-disclosure--${d.display_format}"
           data-key="${d.disclosure_key}"
           style="border-left: 4px solid ${c.border}; background: ${c.bg}; padding: 12px 16px; margin-bottom: 10px; border-radius: 4px; font-family: Arial, sans-serif; font-size: 13px;">
        <strong style="color: #1a1a2e; display: block; margin-bottom: 4px;">${c.icon} ${d.headline}</strong>
        <span style="color: #4a4a6a; line-height: 1.5;">${d.body_text}</span>
      </div>
    `;
  }).join('');

  container.innerHTML = html;
}

/**
 * Render the universal estimate disclaimer (use on any page showing recovery figures).
 *
 * @param {string} containerId
 * @param {string} context - 'dashboard_card' | 'report_header' | 'authorization_summary' | 'recovery_total' | 'admin_view'
 */
export async function renderEstimateDisclaimer(containerId, context = 'dashboard_card') {
  const container = document.getElementById(containerId);
  if (!container) return;

  const resp = await fetch(
    `${SUPABASE_URL}/rest/v1/recovery_estimate_disclosures_v1?context=eq.${encodeURIComponent(context)}&is_active=eq.true&select=*`,
    {
      headers: {
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': `Bearer ${SUPABASE_ANON_KEY}`,
        'Accept-Profile': 'registrations',
      },
    }
  );
  if (!resp.ok) return;
  const rows = await resp.json();
  if (!rows.length) return;

  const d = rows[0];
  container.innerHTML = `
    <p class="mg-estimate-disclaimer" style="font-family: Arial, sans-serif; font-size: 12px; color: #6a6a8a; line-height: 1.5; margin-top: 8px; border-top: 1px solid #e0ddd5; padding-top: 8px;">
      ${d.short_label ? `<strong>${d.short_label}</strong> ` : ''}${d.disclaimer_text}
    </p>
  `;
}

// Expose on window for non-module usage
window.MusiGodDisclosures = { renderDisclosures, renderEstimateDisclaimer };
