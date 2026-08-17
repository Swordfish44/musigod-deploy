'use strict';

const store = require('../../lib/enterprise-rest');
const pilot = require('../../lib/harbourview-workspace');

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ADMIN_API_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const organizations = await store.select('enterprise_organizations_v1', `slug=eq.${pilot.ORG_SLUG}&select=id`);
    if (!organizations[0]) throw new Error('HarbourView organization is not configured');
    const organizationId = organizations[0].id;
    const workspaces = await store.select('enterprise_pilot_workspaces_v1', `organization_id=eq.${organizationId}&workspace_code=eq.${pilot.WORKSPACE_CODE}&select=id,max_assets`);
    const sources = await store.select('enterprise_data_sources_v1', `organization_id=eq.${organizationId}&source_name=eq.${encodeURIComponent(req.body?.manifest?.source_name || '')}&active=eq.true&select=*`);
    if (!sources[0] || !['official','client_authorized'].includes(sources[0].authority_status)) throw new Error('source is not authorized for this pilot');
    const plan = pilot.buildImportPlan(req.body, { organization_id: organizationId, imported_at: new Date().toISOString() });
    const duplicate = await store.select('enterprise_import_batches_v1', `organization_id=eq.${organizationId}&content_sha256=eq.${plan.manifest.content_sha256}&select=id`);
    if (duplicate[0]) return res.status(409).json({ error: 'duplicate_import', batch_id: duplicate[0].id });
    const batch = (await store.insert('enterprise_import_batches_v1', {
      organization_id: organizationId, data_source_id: sources[0].id, filename: plan.manifest.filename || null,
      content_sha256: plan.manifest.content_sha256, source_period_start: plan.manifest.period_start || null,
      source_period_end: plan.manifest.period_end || null, status: 'validated', row_count: plan.row_count,
      accepted_count: plan.row_count, rejected_count: 0, validation_summary: { valid: true }, input_manifest: plan.manifest,
    }))[0];
    await store.insert('enterprise_import_records_v1', plan.records.map(record => ({ ...record, organization_id: organizationId, batch_id: batch.id })));
    await store.insert('enterprise_activity_events_v1', {
      organization_id: organizationId, workspace_id: workspaces[0].id, event_type: 'import.validated', entity_type: 'import_batch',
      entity_id: batch.id, summary: `${plan.row_count} authorized rows validated`, metadata: { content_sha256: plan.manifest.content_sha256 }
    });
    return res.status(201).json({ batch, accepted_count: plan.row_count, external_submission_performed: false });
  } catch (error) {
    return res.status(422).json({ error: 'import_rejected', detail: error.message });
  }
};

function cors(req, res) {
  const allowed = new Set(['https://musigod.com','https://www.musigod.com']);
  if (allowed.has(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
}
