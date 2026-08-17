'use strict';

const crypto = require('crypto');
const store = require('../../lib/enterprise-rest');
const pilot = require('../../lib/harbourview-workspace');
const upload = require('../../lib/enterprise-portfolio-upload');

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  if (!process.env.ADMIN_API_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const contentType = req.headers['content-type'] || '';
    const boundary = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/)?.slice(1).find(Boolean)?.trim();
    if (!boundary) throw new Error('multipart/form-data boundary is required');
    const raw = await upload.getRawBody(req); const { fields, file } = upload.parseMultipart(raw, boundary);
    const [organization] = await store.select('enterprise_organizations_v1', `slug=eq.${pilot.ORG_SLUG}&select=id`);
    const [workspace] = await store.select('enterprise_pilot_workspaces_v1', `organization_id=eq.${organization.id}&workspace_code=eq.${pilot.WORKSPACE_CODE}&select=id`);
    const [catalog] = await store.select('enterprise_catalogs_v1', `id=eq.${fields.catalog_id}&organization_id=eq.${organization.id}&select=id`);
    const [source] = await store.select('enterprise_data_sources_v1', `id=eq.${fields.data_source_id}&organization_id=eq.${organization.id}&active=eq.true&select=*`);
    const [reviewer] = await store.select('enterprise_reviewers_v1', `id=eq.${fields.reviewer_id}&organization_id=eq.${organization.id}&active=eq.true&select=id`);
    if (!catalog || !source || !reviewer) throw new Error('valid catalog, source, and named uploader are required');
    const preview = upload.buildPreview(file, fields.record_type, { source_name: source.source_name, imported_at: new Date().toISOString() });
    const duplicate = await store.select('enterprise_portfolio_uploads_v1', `organization_id=eq.${organization.id}&content_sha256=eq.${preview.content_sha256}&select=id`);
    if (duplicate[0]) return res.status(409).json({ error: 'duplicate_upload', upload_id: duplicate[0].id });
    const authorizations = await store.select('enterprise_source_authorizations_v1', `organization_id=eq.${organization.id}&data_source_id=eq.${source.id}&status=eq.approved&select=id,expires_at`);
    const authorized = authorizations.some(a => !a.expires_at || new Date(a.expires_at) > new Date());
    const objectPath = `${organization.id}/${workspace.id}/${crypto.randomUUID()}-${preview.filename}`;
    await store.storageUpload('enterprise-portfolio-quarantine', objectPath, preview.mime_type, file.data);
    const created = (await store.insert('enterprise_portfolio_uploads_v1', {
      organization_id: organization.id, workspace_id: workspace.id, catalog_id: catalog.id, data_source_id: source.id,
      uploaded_by_reviewer_id: reviewer.id, filename: preview.filename, storage_path: objectPath, mime_type: preview.mime_type,
      file_size_bytes: preview.file_size_bytes, content_sha256: preview.content_sha256, record_type: fields.record_type,
      status: authorized ? 'preview_ready' : 'quarantined', row_count: preview.row_count, preview: preview.preview,
      validation_summary: { valid: true, headers: preview.headers, preview_rows: preview.preview.length, authorization_approved: authorized },
    }))[0];
    await store.insert('enterprise_activity_events_v1', { organization_id: organization.id, workspace_id: workspace.id, event_type: 'portfolio_upload.previewed', entity_type: 'portfolio_upload', entity_id: created.id, summary: `${preview.filename} securely uploaded for preview`, metadata: { row_count: preview.row_count, status: created.status, reviewer_id: reviewer.id } });
    return res.status(201).json({ upload: created, preview: preview.preview, import_allowed: authorized });
  } catch (error) { return res.status(422).json({ error: 'upload_rejected', detail: error.message }); }
};

module.exports.config = { api: { bodyParser: false } };
function cors(req, res) { const allowed = new Set(['https://musigod.com','https://www.musigod.com']); if (allowed.has(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin); res.setHeader('Vary','Origin'); res.setHeader('Access-Control-Allow-Methods','POST, OPTIONS'); res.setHeader('Access-Control-Allow-Headers','Content-Type, x-admin-key'); res.setHeader('Cache-Control','no-store'); }
