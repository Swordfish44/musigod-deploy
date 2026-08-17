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
    if (action === 'create_reviewer') {
      const row = { ...pilot.validateReviewer(input), organization_id: context.organization.id };
      const created = (await store.insert('enterprise_reviewers_v1', row))[0];
      await event(context, 'reviewer.created', 'reviewer', created.id, `Reviewer ${created.display_name} created`, { role: created.role });
      return res.status(201).json({ reviewer: created });
    }
    if (action === 'assign_review_task') {
      const [task] = await store.select('enterprise_review_tasks_v1', `id=eq.${input.task_id}&organization_id=eq.${context.organization.id}&select=*`);
      const [reviewer] = await store.select('enterprise_reviewers_v1', `id=eq.${input.reviewer_id}&organization_id=eq.${context.organization.id}&select=*`);
      const update = pilot.validateTaskAssignment(input, task, reviewer);
      const updated = (await store.patch('enterprise_review_tasks_v1', `id=eq.${task.id}`, update))[0];
      await event(context, 'review_task.assigned', 'review_task', task.id, `${task.title} assigned to ${reviewer.display_name}`, { reviewer_id: reviewer.id });
      return res.status(200).json({ review_task: updated });
    }
    if (action === 'approve_source_authorization') {
      const [task] = await store.select('enterprise_review_tasks_v1', `id=eq.${input.task_id}&organization_id=eq.${context.organization.id}&select=*`);
      const [reviewer] = await store.select('enterprise_reviewers_v1', `id=eq.${input.reviewer_id}&organization_id=eq.${context.organization.id}&select=*`);
      const approval = pilot.validateSourceApproval(input, task, reviewer);
      const authorizationId = await store.rpc('fn_enterprise_approve_source_authorization_v1', {
        p_task_id: task.id, p_reviewer_id: reviewer.id, p_data_source_id: input.data_source_id,
        p_authorization_reference: approval.authorization_reference, p_resolution_notes: approval.resolution_notes,
      });
      return res.status(200).json({ authorization_id: authorizationId, status: 'approved' });
    }
    if (action === 'resolve_review_task') {
      const [task] = await store.select('enterprise_review_tasks_v1', `id=eq.${input.task_id}&organization_id=eq.${context.organization.id}&select=*`);
      const [reviewer] = await store.select('enterprise_reviewers_v1', `id=eq.${input.reviewer_id}&organization_id=eq.${context.organization.id}&select=*`);
      const resolution = pilot.validateTaskResolution(input, task, reviewer);
      await store.rpc('fn_enterprise_resolve_review_task_v1', { p_task_id: task.id, p_reviewer_id: reviewer.id, p_decision: resolution.decision, p_resolution_notes: resolution.resolution_notes });
      return res.status(200).json({ task_id: task.id, status: resolution.decision });
    }
    return res.status(400).json({ error: 'unsupported_action', allowed_actions: ['create_catalog','create_review_task','create_reviewer','assign_review_task','approve_source_authorization','resolve_review_task'] });
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
  const [catalogs, assets, batches, tasks, findings, packages, activity, reviewers, sources, authorizations, uploads] = await Promise.all([
    store.select('enterprise_catalogs_v1', `${base}&order=created_at.desc&select=*`),
    store.select('enterprise_assets_v1', `${base}&select=id,review_status`),
    store.select('enterprise_import_batches_v1', `${base}&order=received_at.desc&limit=25&select=*`),
    store.select('enterprise_review_tasks_v1', `${base}&order=created_at.desc&limit=50&select=*`),
    store.select('enterprise_title_findings_v1', `${base}&select=id,review_status,finding_type`),
    store.select('enterprise_correction_packages_v1', `${base}&select=id,status,package_reference`),
    store.select('enterprise_activity_events_v1', `${base}&order=occurred_at.desc&limit=50&select=*`),
    store.select('enterprise_reviewers_v1', `${base}&active=eq.true&order=display_name.asc&select=*`),
    store.select('enterprise_data_sources_v1', `${base}&active=eq.true&order=source_name.asc&select=*`),
    store.select('enterprise_source_authorizations_v1', `${base}&select=*`),
    store.select('enterprise_portfolio_uploads_v1', `${base}&order=uploaded_at.desc&limit=25&select=*`),
  ]);
  return {
    organization: context.organization,
    workspace: context.workspace,
    metrics: {
      catalogs: catalogs.length, assets: assets.length, import_batches: batches.length,
      open_reviews: tasks.filter(t => ['open','in_progress','blocked'].includes(t.status)).length,
      unresolved_findings: findings.filter(f => !['resolved','rejected'].includes(f.review_status)).length,
      correction_packages: packages.length,
    }, catalogs, batches, review_tasks: tasks, activity, reviewers, sources, source_authorizations: authorizations, uploads,
    gates: { external_submission_enabled: false, correction_human_approval_required: true, chain_of_title_legal_review_required: true, source_authorization_approved: authorizations.some(a => a.status === 'approved' && (!a.expires_at || new Date(a.expires_at) > new Date())) },
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
