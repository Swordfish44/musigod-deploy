'use strict';

const store = require('../../lib/enterprise-rest');
const pilot = require('../../lib/harbourview-workspace');

module.exports = async function handler(req, res) {
  cors(req, res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!['GET','POST'].includes(req.method)) return res.status(405).json({ error: 'GET or POST only' });
  if (!process.env.ADMIN_API_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!store.configured()) return res.status(500).json({ error: 'Supabase service key not configured' });

  try {
    const context = await getContext();
    if (req.method === 'GET') return res.status(200).json(await snapshot(context));
    const { action, input = {} } = req.body || {};
    if (action === 'create_catalog') {
      const row = { ...pilot.validateCatalog(input), organization_id: context.organization.id, workspace_id: context.workspace.id };
      const created = (await store.insert('enterprise_catalogs_v1', row))[0];
      await event(context, 'catalog.created', 'catalog', created.id, `Catalog ${created.catalog_code} created`);
      return res.status(201).json({ catalog: created });
    }
    if (action === 'create_review_task') {
      const row = { ...pilot.validateReviewTask(input), organization_id: context.organization.id, workspace_id: context.workspace.id };
      const created = (await store.insert('enterprise_review_tasks_v1', row))[0];
      await event(context, 'review_task.created', 'review_task', created.id, created.title, { required_reviewer_role: created.required_reviewer_role });
      return res.status(201).json({ review_task: created });
    }
    return res.status(400).json({ error: 'unsupported_action', allowed_actions: ['create_catalog','create_review_task'] });
  } catch (error) {
    return res.status(422).json({ error: 'workspace_operation_failed', detail: error.message });
  }
};

async function getContext() {
  const organizations = await store.select('enterprise_organizations_v1', `slug=eq.${pilot.ORG_SLUG}&select=*`);
  if (!organizations[0]) throw new Error('HarbourView organization is not configured');
  const workspaces = await store.select('enterprise_pilot_workspaces_v1', `organization_id=eq.${organizations[0].id}&workspace_code=eq.${pilot.WORKSPACE_CODE}&select=*`);
  if (!workspaces[0]) throw new Error('HarbourView pilot workspace is not configured');
  return { organization: organizations[0], workspace: workspaces[0] };
}

async function snapshot(context) {
  const base = `organization_id=eq.${context.organization.id}`;
  const [catalogs, assets, batches, tasks, findings, packages, activity] = await Promise.all([
    store.select('enterprise_catalogs_v1', `${base}&order=created_at.desc&select=*`),
    store.select('enterprise_assets_v1', `${base}&select=id,review_status`),
    store.select('enterprise_import_batches_v1', `${base}&order=received_at.desc&limit=25&select=*`),
    store.select('enterprise_review_tasks_v1', `${base}&order=created_at.desc&limit=50&select=*`),
    store.select('enterprise_title_findings_v1', `${base}&select=id,review_status,finding_type`),
    store.select('enterprise_correction_packages_v1', `${base}&select=id,status,package_reference`),
    store.select('enterprise_activity_events_v1', `${base}&order=occurred_at.desc&limit=50&select=*`),
  ]);
  return {
    organization: context.organization,
    workspace: context.workspace,
    metrics: {
      catalogs: catalogs.length, assets: assets.length, import_batches: batches.length,
      open_reviews: tasks.filter(t => ['open','in_progress','blocked'].includes(t.status)).length,
      unresolved_findings: findings.filter(f => !['resolved','rejected'].includes(f.review_status)).length,
      correction_packages: packages.length,
    }, catalogs, batches, review_tasks: tasks, activity,
    gates: { external_submission_enabled: false, correction_human_approval_required: true, chain_of_title_legal_review_required: true },
  };
}

function event(context, event_type, entity_type, entity_id, summary, metadata = {}) {
  return store.insert('enterprise_activity_events_v1', { organization_id: context.organization.id, workspace_id: context.workspace.id, event_type, entity_type, entity_id, summary, metadata });
}

function cors(req, res) {
  const allowed = new Set(['https://musigod.com','https://www.musigod.com']);
  if (allowed.has(req.headers.origin)) res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');
  res.setHeader('Cache-Control', 'no-store');
}
