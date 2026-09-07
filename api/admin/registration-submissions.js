'use strict';
const engine = require('../../lib/registration-submission-engine');
const { evaluateReadiness } = require('../../lib/registration-readiness');
const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

async function db(table, query = '', options = {}) {
  const response = await fetch(`${SB_URL}/rest/v1/${table}${query ? `?${query}` : ''}`, { ...options, headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Content-Type': 'application/json', 'Accept-Profile': 'registrations', 'Content-Profile': 'registrations', ...(options.headers || {}) } });
  const text = await response.text();
  if (!response.ok) throw new Error(`Registration store ${response.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}
const select = (table, query) => db(table, query);
const insert = (table, body) => db(table, '', { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
const patch = (table, query, body) => db(table, query, { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify(body) });
const event = (packageId, type, from, to, actorId, notes, evidence = {}) => insert('registration_submission_events_v1', { package_id: packageId, event_type: type, from_status: from, to_status: to, actor_id: actorId || null, notes: notes || null, evidence });

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'GET or POST only' });
  if (!process.env.ADMIN_API_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' });
  if (!SB_KEY) return res.status(503).json({ error: 'Registration database access is not configured' });
  try {
    if (req.method === 'GET') {
      const packages = await select('registration_submission_packages_v1', 'order=created_at.desc&limit=100&select=*');
      const connectors = await select('registration_submission_connectors_v1', 'order=destination.asc&select=*');
      return res.status(200).json({ engine_version: engine.ENGINE_VERSION, destinations: engine.DESTINATIONS, packages, connectors });
    }
    const { action, input = {} } = req.body || {};
    if (action === 'create_plan') {
      const [profile] = await select('rights_registration_profiles_v1', `id=eq.${encodeURIComponent(input.profile_id)}&select=id`);
      const [authorization] = await select('rights_authorizations_v1', `id=eq.${encodeURIComponent(input.authorization_id)}&profile_id=eq.${encodeURIComponent(input.profile_id)}&status=eq.EXECUTED&select=id,status`);
      if (!profile || !authorization) throw new Error('Executed client authorization for this profile is required');
      const spec = engine.destinationSpec(input.destination);
      const tracks = Array.isArray(input.tracks) ? input.tracks : [];
      const readinessResults = spec.readiness ? tracks.map(track => evaluateReadiness(track, spec.readiness)) : [];
      const plan = engine.buildPlan({ destination: spec.key, catalogId: input.catalog_id, tracks, readinessResults, authorization: { approved: true, reference: authorization.id }, requestedBy: 'admin' });
      const [created] = await insert('registration_submission_packages_v1', { profile_id: profile.id, registration_item_id: input.registration_item_id || null, destination: plan.destination, channel: plan.channel, format: plan.format, engine_version: plan.engine_version, payload: plan, payload_sha256: plan.payload_sha256, authorization_reference: plan.authorization_reference, status: plan.status });
      await event(created.id, 'package.created', null, created.status, null, `Created ${created.destination} registration package`, { summary: plan.summary });
      return res.status(201).json({ package: created, plan });
    }
    const [pkg] = await select('registration_submission_packages_v1', `id=eq.${encodeURIComponent(input.package_id)}&select=*`);
    if (!pkg) return res.status(404).json({ error: 'Submission package not found' });
    if (action === 'approve') {
      const approved = engine.approve({ ...pkg.payload, status: pkg.status }, { id: input.reviewer_id, role: input.reviewer_role }, input.notes);
      const [updated] = await patch('registration_submission_packages_v1', `id=eq.${pkg.id}&status=eq.READY_FOR_REVIEW`, { status: 'APPROVED', approved_by: approved.approved_by, approved_at: approved.approved_at, approval_notes: approved.approval_notes, updated_at: approved.approved_at });
      if (!updated) throw new Error('Package approval conflict; reload and try again');
      await event(pkg.id, 'package.approved', pkg.status, 'APPROVED', input.reviewer_id, input.notes);
      return res.status(200).json({ package: updated });
    }
    if (action === 'record_receipt') {
      if (pkg.status !== 'DISPATCHING') throw new Error('Package must be dispatching before a receipt can be recorded');
      const receipt = engine.recordReceipt({ ...pkg.payload, status: pkg.status }, { external_reference: input.external_reference, received_at: input.received_at, response_sha256: input.response_sha256 });
      const [updated] = await patch('registration_submission_packages_v1', `id=eq.${pkg.id}&status=eq.DISPATCHING`, { status: 'SUBMITTED', external_reference: receipt.receipt.external_reference, external_response_sha256: receipt.receipt.response_sha256, submitted_at: receipt.receipt.received_at, updated_at: new Date().toISOString() });
      await event(pkg.id, 'external.receipt_recorded', pkg.status, 'SUBMITTED', input.reviewer_id, input.notes, receipt.receipt);
      return res.status(200).json({ package: updated });
    }
    return res.status(400).json({ error: 'Unsupported action', allowed: ['create_plan', 'approve', 'record_receipt'] });
  } catch (error) { return res.status(422).json({ error: 'registration_submission_failed', detail: error.message, external_submission_performed: false }); }
};
