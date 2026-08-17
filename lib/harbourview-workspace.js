'use strict';

const ingestion = require('./enterprise-ingestion');

const WORKSPACE_CODE = 'HV-PRI-001';
const ORG_SLUG = 'harbourview';
const MAX_IMPORT_ROWS = 1000;
const TASK_TYPES = new Set(['identity','metadata','royalty_rule','correction','chain_of_title','security','other']);
const REVIEWER_ROLES = new Set(['analyst','reviewer','administrator','legal']);

function text(value, name, max = 200) {
  const result = String(value || '').trim();
  if (!result) throw new Error(`${name} is required`);
  if (result.length > max) throw new Error(`${name} exceeds ${max} characters`);
  return result;
}

function validateCatalog(input = {}) {
  const assetType = input.asset_type || 'mixed';
  if (!['mixed','recording','composition'].includes(assetType)) throw new Error('asset_type is unsupported');
  return {
    catalog_code: text(input.catalog_code, 'catalog_code', 64).toUpperCase(),
    name: text(input.name, 'name'),
    asset_type: assetType,
    status: 'intake',
    source_reference: input.source_reference ? text(input.source_reference, 'source_reference') : null,
  };
}

function validateReviewTask(input = {}) {
  if (!TASK_TYPES.has(input.task_type)) throw new Error('task_type is unsupported');
  if (!REVIEWER_ROLES.has(input.required_reviewer_role)) throw new Error('required_reviewer_role is unsupported');
  if (input.task_type === 'chain_of_title' && !['reviewer','administrator','legal'].includes(input.required_reviewer_role)) {
    throw new Error('chain_of_title requires reviewer, administrator, or legal review');
  }
  return {
    task_type: input.task_type,
    title: text(input.title, 'title'),
    description: input.description ? text(input.description, 'description', 2000) : null,
    priority: ['low','normal','high','critical'].includes(input.priority) ? input.priority : 'normal',
    required_reviewer_role: input.required_reviewer_role,
    status: 'open',
    catalog_id: input.catalog_id || null,
    due_at: input.due_at || null,
  };
}

function validateReviewer(input = {}) {
  const email = text(input.email, 'email', 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('valid reviewer email is required');
  if (!REVIEWER_ROLES.has(input.role)) throw new Error('reviewer role is unsupported');
  return { display_name: text(input.display_name, 'display_name', 120), email, role: input.role, active: true };
}

function validateTaskAssignment(input = {}, task, reviewer) {
  if (!task || !['open','in_progress','blocked'].includes(task.status)) throw new Error('an open review task is required');
  if (!reviewer || !reviewer.active) throw new Error('an active reviewer is required');
  const allowed = task.required_reviewer_role === reviewer.role || reviewer.role === 'administrator' || (task.required_reviewer_role === 'reviewer' && reviewer.role === 'legal');
  if (!allowed) throw new Error(`reviewer role does not satisfy the ${task.required_reviewer_role} gate`);
  return { assigned_reviewer_id: reviewer.id, status: 'in_progress' };
}

function validateSourceApproval(input = {}, task, reviewer) {
  validateTaskAssignment(input, task, reviewer);
  if (task.task_type !== 'security' || reviewer.role !== 'administrator') throw new Error('source authorization requires a security task and administrator reviewer');
  return { authorization_reference: text(input.authorization_reference, 'authorization_reference'), resolution_notes: text(input.resolution_notes, 'resolution_notes', 2000) };
}

function validateTaskResolution(input = {}, task, reviewer) {
  validateTaskAssignment(input, task, reviewer);
  if (!['approved','rejected','closed'].includes(input.decision)) throw new Error('review decision is unsupported');
  if (task.task_type === 'security' && input.decision === 'approved') throw new Error('use source authorization approval for security tasks');
  if (task.task_type === 'chain_of_title' && reviewer.role !== 'legal') throw new Error('chain-of-title resolution requires legal reviewer');
  return { decision: input.decision, resolution_notes: text(input.resolution_notes, 'resolution_notes', 2000) };
}

function buildImportPlan(input = {}, context = {}) {
  const rows = Array.isArray(input.records) ? input.records : [];
  if (!rows.length) throw new Error('records must contain at least one row');
  if (rows.length > MAX_IMPORT_ROWS) throw new Error(`pilot imports are limited to ${MAX_IMPORT_ROWS} rows`);
  const manifest = { ...input.manifest, organization_id: context.organization_id };
  const check = ingestion.validateImportManifest(manifest);
  if (!check.valid) throw new Error(check.errors.join('; '));
  const records = rows.map((row, index) => {
    const recordType = row.record_type || input.record_type;
    const normalized = ingestion.normalizeEnterpriseRecord(recordType, row.data || row, {
      source_name: manifest.source_name,
      source_record_id: row.source_record_id || null,
      imported_at: context.imported_at,
    });
    return { ...normalized, row_number: index + 1, source_record_id: row.source_record_id || null, validation_status: 'accepted', validation_messages: [] };
  });
  return { manifest, records, row_count: records.length };
}

module.exports = { WORKSPACE_CODE, ORG_SLUG, MAX_IMPORT_ROWS, validateCatalog, validateReviewTask, validateReviewer, validateTaskAssignment, validateSourceApproval, validateTaskResolution, buildImportPlan };
