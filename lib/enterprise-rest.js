'use strict';

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const TABLES = new Set([
  'enterprise_organizations_v1','enterprise_pilot_workspaces_v1','enterprise_catalogs_v1','enterprise_assets_v1',
  'enterprise_review_tasks_v1','enterprise_activity_events_v1','enterprise_data_sources_v1',
  'enterprise_import_batches_v1','enterprise_import_records_v1','enterprise_title_findings_v1','enterprise_correction_packages_v1'
]);

function configured() { return Boolean(SB_KEY); }
function headers(extra = {}) { return { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', ...extra }; }

async function request(table, query = '', options = {}) {
  if (!TABLES.has(table)) throw new Error('table is not allowlisted');
  if (!SB_KEY) throw new Error('Supabase service key not configured');
  const response = await fetch(`${SB_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, { ...options, headers: headers(options.headers) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

function select(table, query) { return request(table, query); }
function insert(table, rows) { return request(table, '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(rows) }); }

module.exports = { configured, select, insert };
