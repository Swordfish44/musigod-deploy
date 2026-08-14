'use strict';
// lib/intake-state-machine.js
// Deterministic artist rights intake workflow state machine.
// Zero DB writes, zero network calls. All persistence is caller's responsibility.
// Transitions are idempotent for terminal states and DOCUMENTS_PARTIAL self-loops.

const STATES = [
  'INVITED',
  'IDENTITY_PENDING',
  'IDENTITY_CONFIRMED',
  'ENGAGEMENT_PENDING',
  'ENGAGEMENT_SENT',
  'ENGAGEMENT_SIGNED',
  'LOA_PENDING',
  'LOA_SENT',
  'LOA_SIGNED',
  'EXPORT_GUIDANCE_PENDING',
  'DOCUMENTS_PARTIAL',
  'DOCUMENTS_COMPLETE',
  'DOCUMENTS_VALIDATING',
  'DOCUMENTS_NEED_CORRECTION',
  'OWNERSHIP_REVIEW',
  'AUTHORIZATION_REVIEW',
  'AUDIT_READY',
  'AUDIT_IN_PROGRESS',
  'CLIENT_ACTION_REQUIRED',
  'CLOSED',
  'WITHDRAWN',
];

// Legal transitions stored as Set<"FROM→TO">
const VALID_TRANSITIONS = new Set([
  'INVITED→IDENTITY_PENDING',
  'INVITED→WITHDRAWN',
  'IDENTITY_PENDING→IDENTITY_CONFIRMED',
  'IDENTITY_PENDING→WITHDRAWN',
  'IDENTITY_PENDING→CLIENT_ACTION_REQUIRED',
  'IDENTITY_CONFIRMED→ENGAGEMENT_PENDING',
  'IDENTITY_CONFIRMED→WITHDRAWN',
  'ENGAGEMENT_PENDING→ENGAGEMENT_SENT',
  'ENGAGEMENT_PENDING→WITHDRAWN',
  'ENGAGEMENT_SENT→ENGAGEMENT_SIGNED',
  'ENGAGEMENT_SENT→ENGAGEMENT_PENDING',  // resend / expired envelope
  'ENGAGEMENT_SENT→WITHDRAWN',
  'ENGAGEMENT_SIGNED→LOA_PENDING',
  'ENGAGEMENT_SIGNED→WITHDRAWN',
  'LOA_PENDING→LOA_SENT',
  'LOA_PENDING→WITHDRAWN',
  'LOA_SENT→LOA_SIGNED',
  'LOA_SENT→LOA_PENDING',  // resend / expired
  'LOA_SENT→WITHDRAWN',
  'LOA_SIGNED→EXPORT_GUIDANCE_PENDING',
  'LOA_SIGNED→WITHDRAWN',
  'EXPORT_GUIDANCE_PENDING→DOCUMENTS_PARTIAL',
  'EXPORT_GUIDANCE_PENDING→WITHDRAWN',
  'DOCUMENTS_PARTIAL→DOCUMENTS_PARTIAL',  // additional upload
  'DOCUMENTS_PARTIAL→DOCUMENTS_COMPLETE',
  'DOCUMENTS_PARTIAL→CLIENT_ACTION_REQUIRED',
  'DOCUMENTS_PARTIAL→WITHDRAWN',
  'DOCUMENTS_COMPLETE→DOCUMENTS_VALIDATING',
  'DOCUMENTS_VALIDATING→DOCUMENTS_NEED_CORRECTION',
  'DOCUMENTS_VALIDATING→OWNERSHIP_REVIEW',
  'DOCUMENTS_VALIDATING→AUTHORIZATION_REVIEW',
  'DOCUMENTS_VALIDATING→AUDIT_READY',
  'DOCUMENTS_NEED_CORRECTION→DOCUMENTS_PARTIAL',
  'DOCUMENTS_NEED_CORRECTION→WITHDRAWN',
  'OWNERSHIP_REVIEW→AUTHORIZATION_REVIEW',
  'OWNERSHIP_REVIEW→DOCUMENTS_NEED_CORRECTION',
  'OWNERSHIP_REVIEW→AUDIT_READY',
  'OWNERSHIP_REVIEW→CLIENT_ACTION_REQUIRED',
  'AUTHORIZATION_REVIEW→AUDIT_READY',
  'AUTHORIZATION_REVIEW→DOCUMENTS_NEED_CORRECTION',
  'AUTHORIZATION_REVIEW→CLIENT_ACTION_REQUIRED',
  'AUDIT_READY→AUDIT_IN_PROGRESS',
  'AUDIT_READY→WITHDRAWN',
  'AUDIT_IN_PROGRESS→CLIENT_ACTION_REQUIRED',
  'AUDIT_IN_PROGRESS→CLOSED',
  'CLIENT_ACTION_REQUIRED→DOCUMENTS_PARTIAL',
  'CLIENT_ACTION_REQUIRED→OWNERSHIP_REVIEW',
  'CLIENT_ACTION_REQUIRED→AUTHORIZATION_REVIEW',
  'CLIENT_ACTION_REQUIRED→WITHDRAWN',
  'CLOSED→CLOSED',      // idempotent terminal
  'WITHDRAWN→WITHDRAWN', // idempotent terminal
]);

const TERMINAL_STATES = new Set(['CLOSED', 'WITHDRAWN']);

const STATE_SET = new Set(STATES);

function transitionKey(from, to) {
  return `${from}→${to}`;
}

function isValidTransition(from, to) {
  return VALID_TRANSITIONS.has(transitionKey(from, to));
}

function allowedTargets(fromState) {
  return [...VALID_TRANSITIONS]
    .filter(k => k.startsWith(fromState + '→'))
    .map(k => k.split('→')[1]);
}

function makeTransitionRecord({
  actor,
  priorState,
  newState,
  trigger,
  evidenceRef = null,
  authScope = null,
  correlationId,
  reason = '',
}) {
  if (!actor) throw new Error('transition requires actor');
  if (!trigger) throw new Error('transition requires trigger');
  if (!correlationId) throw new Error('transition requires correlationId');
  return {
    actor,
    timestamp: new Date().toISOString(),
    prior_state: priorState,
    new_state: newState,
    trigger,
    evidence_ref: evidenceRef,
    auth_scope: authScope,
    correlation_id: correlationId,
    reason: String(reason),
  };
}

function transition(currentState, targetState, params) {
  if (!STATE_SET.has(currentState)) {
    throw new Error(`Unknown current state: ${currentState}`);
  }
  if (!STATE_SET.has(targetState)) {
    throw new Error(`Unknown target state: ${targetState}`);
  }

  // Idempotent terminal — same state, no record
  if (TERMINAL_STATES.has(currentState) && currentState === targetState) {
    return { state: currentState, record: null, idempotent: true };
  }

  if (!isValidTransition(currentState, targetState)) {
    throw new Error(
      `Invalid state transition: ${currentState} → ${targetState}. ` +
      `Allowed from ${currentState}: ${allowedTargets(currentState).join(', ') || 'none'}`
    );
  }

  const record = makeTransitionRecord({
    ...params,
    priorState: currentState,
    newState: targetState,
  });
  return { state: targetState, record, idempotent: false };
}

module.exports = {
  STATES,
  VALID_TRANSITIONS,
  TERMINAL_STATES,
  isValidTransition,
  allowedTargets,
  transition,
  makeTransitionRecord,
  transitionKey,
};
