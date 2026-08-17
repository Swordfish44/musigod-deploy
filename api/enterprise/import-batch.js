'use strict';

const store = require('../../lib/enterprise-rest');
const pilot = require('../../lib/harbourview-workspace');
const portfolio = require('../../lib/enterprise-portfolio-upload');

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
    const [upload] = await store.select('enterprise_portfolio_uploads_v1', `id=eq.${req.body?.upload_id}&organization_id=eq.${organizationId}&select=*`);
    if (!upload || upload.status !== 'preview_ready') throw new Error('a preview-ready portfolio upload is required');
    const [source] = await store.select('enterprise_data_sources_v1', `id=eq.${upload.data_source_id}&organization_id=eq.${organizationId}&active=eq.true&select=*`);
    if (!source || !['official','client_authorized'].includes(source.authority_status)) throw new Error('source is not enabled for this pilot');
    const authorizations = await store.select('enterprise_source_authorizations_v1', `organization_id=eq.${organizationId}&data_source_id=eq.${source.id}&status=eq.approved&select=id,expires_at`);
    if (!authorizations.some(a => !a.expires_at || new Date(a.expires_at) > new Date())) throw new Error('approved source authorization is required before import');
    const fileData = await store.storageDownload(upload.storage_bucket, upload.storage_path);
    const parsed = portfolio.buildPreview({ filename: upload.filename, mimeType: upload.mime_type, data: fileData }, upload.record_type, { source_name: source.source_name, imported_at: new Date().toISOString() });
    if (parsed.content_sha256 !== upload.content_sha256) throw new Error('stored upload integrity check failed');
    const manifest = { organization_id: organizationId, source_name: source.source_name, transport: 'csv', content_sha256: upload.content_sha256, filename: upload.filename, upload_id: upload.id };
    const duplicate = await store.select('enterprise_import_batches_v1', `organization_id=eq.${organizationId}&content_sha256=eq.${manifest.content_sha256}&select=id`);
    if (duplicate[0]) return res.status(409).json({ error: 'duplicate_import', batch_id: duplicate[0].id });
    const batch = (await store.insert('enterprise_import_batches_v1', {
      organization_id: organizationId, data_source_id: source.id, filename: upload.filename,
      content_sha256: manifest.content_sha256, status: 'validated', row_count: parsed.row_count,
      accepted_count: parsed.row_count, rejected_count: 0, validation_summary: { valid: true, upload_id: upload.id }, input_manifest: manifest,
    }))[0];
    await store.insert('enterprise_import_records_v1', parsed.records.map((record, index) => ({
      organization_id: organizationId, batch_id: batch.id, row_number: index + 1, record_type: record.record_type,
      source_record_id: record.source_record_id, normalized_payload: record.normalized_payload,
      validation_status: 'accepted', validation_messages: [], provenance: record.provenance,
    })));
    await store.patch('enterprise_portfolio_uploads_v1', `id=eq.${upload.id}`, { status: 'imported', imported_batch_id: batch.id, imported_at: new Date().toISOString() });
    await store.insert('enterprise_activity_events_v1', {
      organization_id: organizationId, workspace_id: workspaces[0].id, event_type: 'import.validated', entity_type: 'import_batch',
      entity_id: batch.id, summary: `${parsed.row_count} authorized rows imported`, metadata: { content_sha256: manifest.content_sha256, upload_id: upload.id }
    });
    return res.status(201).json({ batch, accepted_count: parsed.row_count, external_submission_performed: false });
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
