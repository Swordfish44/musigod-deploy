'use strict';
const crypto = require('crypto');

const ENGINE_VERSION = 'registration-submission-v1';
const DESTINATIONS = Object.freeze({
  ASCAP: { rights: 'composition', channel: 'PORTAL_FILE', format: 'CSV', readiness: 'ASCAP' },
  BMI: { rights: 'composition', channel: 'PORTAL_FILE', format: 'CSV', readiness: 'BMI' },
  MLC: { rights: 'mechanical', channel: 'PORTAL_FILE', format: 'CSV', readiness: 'MLC' },
  SOUNDEXCHANGE: { rights: 'neighboring', channel: 'PARTNER_PENDING', format: 'CSV', readiness: 'SOUNDEXCHANGE' },
  HFA: { rights: 'mechanical', channel: 'PARTNER_PENDING', format: 'CWR', readiness: 'MLC' },
  SESAC: { rights: 'composition', channel: 'MANUAL_REVIEW', format: 'PORTAL', readiness: null },
  PPL: { rights: 'neighboring', channel: 'PARTNER_PENDING', format: 'CSV', readiness: 'NEIGHBORING_RIGHTS' },
  GVL: { rights: 'neighboring', channel: 'PARTNER_PENDING', format: 'CSV', readiness: 'NEIGHBORING_RIGHTS' },
  PRS_MCPS: { rights: 'composition_mechanical', channel: 'PARTNER_PENDING', format: 'CWR', readiness: null },
  SOCAN: { rights: 'composition', channel: 'PARTNER_PENDING', format: 'CWR', readiness: null },
  SENA: { rights: 'neighboring', channel: 'PARTNER_PENDING', format: 'CSV', readiness: 'NEIGHBORING_RIGHTS' },
});

const TRANSITIONS = Object.freeze({
  DRAFT: ['VALIDATING', 'CANCELLED'],
  VALIDATING: ['BLOCKED', 'READY_FOR_REVIEW'],
  BLOCKED: ['VALIDATING', 'CANCELLED'],
  READY_FOR_REVIEW: ['APPROVED', 'REJECTED'],
  APPROVED: ['DISPATCHING', 'CANCELLED'],
  DISPATCHING: ['SUBMITTED', 'FAILED'],
  FAILED: ['DISPATCHING', 'CANCELLED'],
  SUBMITTED: ['ACCEPTED', 'PARTIALLY_ACCEPTED', 'REJECTED_BY_DESTINATION'],
  PARTIALLY_ACCEPTED: ['DISPATCHING', 'CLOSED'],
  REJECTED_BY_DESTINATION: ['DISPATCHING', 'CLOSED'],
  ACCEPTED: ['CLOSED'], REJECTED: [], CANCELLED: [], CLOSED: [],
});

function destinationSpec(destination) {
  const key = String(destination || '').toUpperCase();
  if (!DESTINATIONS[key]) throw new Error(`Unsupported registration destination: ${destination}`);
  return { key, ...DESTINATIONS[key] };
}

function transition(current, next) {
  if (!(TRANSITIONS[current] || []).includes(next)) throw new Error(`Invalid submission transition: ${current} -> ${next}`);
  return next;
}

function buildPlan({ destination, catalogId, tracks, readinessResults = [], authorization, requestedBy }) {
  const spec = destinationSpec(destination);
  if (!catalogId || !requestedBy) throw new Error('catalogId and requestedBy are required');
  if (!authorization?.approved || !authorization.reference) throw new Error('Approved client authorization with reference is required');
  if (!Array.isArray(tracks) || !tracks.length) throw new Error('At least one track is required');
  const byId = new Map(readinessResults.map(x => [x.catalog_track_id, x]));
  const items = tracks.map(track => {
    const readiness = spec.readiness ? byId.get(track.id) : null;
    const blockers = [];
    if (!spec.readiness) blockers.push({ code: 'DESTINATION_RULES_UNVERIFIED', message: `${spec.key} readiness rules require verification.` });
    else if (!readiness || readiness.destination !== spec.readiness) blockers.push({ code: 'READINESS_NOT_EVALUATED', message: `${spec.readiness} readiness evaluation is required.` });
    else if (readiness.decision !== 'READY') blockers.push(...(readiness.blockers || [{ code: 'NOT_READY', message: `Readiness is ${readiness.decision}.` }]));
    return { catalog_track_id: track.id, title: track.track_title || track.trackTitle || null, readiness_decision: readiness?.decision || 'NOT_EVALUATED', blockers };
  });
  const blocked = items.filter(x => x.blockers.length);
  const payload = { engine_version: ENGINE_VERSION, destination: spec.key, catalog_id: catalogId, authorization_reference: authorization.reference, requested_by: requestedBy, track_ids: tracks.map(x => x.id) };
  return { ...payload, channel: spec.channel, format: spec.format, status: blocked.length ? 'BLOCKED' : 'READY_FOR_REVIEW', items, summary: { total: items.length, ready: items.length - blocked.length, blocked: blocked.length }, payload_sha256: crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex'), external_submission_performed: false };
}

function approve(plan, reviewer, notes) {
  if (plan.status !== 'READY_FOR_REVIEW') throw new Error('Only a ready package can be approved');
  if (!reviewer?.id || !['registration_admin', 'administrator'].includes(reviewer.role)) throw new Error('Named registration administrator approval is required');
  if (String(notes || '').trim().length < 12) throw new Error('Substantive approval notes are required');
  return { ...plan, status: 'APPROVED', approved_by: reviewer.id, approved_at: new Date().toISOString(), approval_notes: notes.trim() };
}

function dispatch(approved, connector) {
  if (approved.status !== 'APPROVED' && approved.status !== 'FAILED') throw new Error('Package must be approved before dispatch');
  if (!connector?.verified || connector.destination !== approved.destination) throw new Error('Verified destination connector is required');
  if (connector.channel !== approved.channel) throw new Error('Connector channel does not match approved package');
  if (approved.channel === 'PARTNER_PENDING' || approved.channel === 'MANUAL_REVIEW') throw new Error(`External dispatch unavailable: ${approved.destination} channel is ${approved.channel}`);
  return { ...approved, status: 'DISPATCHING', dispatch_attempted_at: new Date().toISOString(), external_submission_performed: false };
}

function recordReceipt(submission, receipt) {
  if (submission.status !== 'DISPATCHING') throw new Error('Receipt requires a dispatching package');
  if (!receipt?.external_reference || !receipt?.received_at) throw new Error('External receipt reference and timestamp are required');
  return { ...submission, status: 'SUBMITTED', receipt: { external_reference: receipt.external_reference, received_at: receipt.received_at, response_sha256: receipt.response_sha256 || null }, external_submission_performed: true };
}

module.exports = { ENGINE_VERSION, DESTINATIONS, TRANSITIONS, destinationSpec, transition, buildPlan, approve, dispatch, recordReceipt };
