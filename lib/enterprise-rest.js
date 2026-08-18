'use strict';

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
const TABLES = new Set([
  'enterprise_organizations_v1','enterprise_pilot_workspaces_v1','enterprise_catalogs_v1','enterprise_assets_v1',
  'enterprise_review_tasks_v1','enterprise_activity_events_v1','enterprise_data_sources_v1',
  'enterprise_import_batches_v1','enterprise_import_records_v1','enterprise_title_findings_v1','enterprise_correction_packages_v1'
  ,'enterprise_reviewers_v1','enterprise_source_authorizations_v1','enterprise_portfolio_uploads_v1'
  ,'enterprise_source_asset_records_v1','enterprise_asset_match_candidates_v1','enterprise_royalty_statements_v1'
  ,'enterprise_royalty_reconciliations_v1','enterprise_ownership_claims_v1','enterprise_ownership_conflicts_v1'
  ,'enterprise_recovery_opportunities_v1','enterprise_analysis_rules_v1'
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
function patch(table, query, values) { return request(table, query, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(values) }); }

async function rpc(name, params) {
  if (!/^fn_enterprise_[a-z0-9_]+$/.test(name)) throw new Error('RPC is not allowlisted');
  if (!SB_KEY) throw new Error('Supabase service key not configured');
  const response = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: 'POST', headers: headers(), body: JSON.stringify(params) });
  const body = await response.text();
  if (!response.ok) throw new Error(`Supabase RPC ${response.status}: ${body}`);
  return body ? JSON.parse(body) : null;
}

async function storageUpload(bucket, objectPath, mimeType, data) {
  if (bucket !== 'enterprise-portfolio-quarantine') throw new Error('storage bucket is not allowlisted');
  const response = await fetch(`${SB_URL}/storage/v1/object/${bucket}/${objectPath}`, { method: 'POST', headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': mimeType, 'x-upsert': 'false' }, body: data });
  if (!response.ok) throw new Error(`Storage upload ${response.status}: ${await response.text()}`);
}

async function storageDownload(bucket, objectPath) {
  if (bucket !== 'enterprise-portfolio-quarantine') throw new Error('storage bucket is not allowlisted');
  const response = await fetch(`${SB_URL}/storage/v1/object/${bucket}/${objectPath}`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } });
  if (!response.ok) throw new Error(`Storage download ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

module.exports = { configured, select, insert, patch, rpc, storageUpload, storageDownload };
