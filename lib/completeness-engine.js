'use strict';
// lib/completeness-engine.js
// Dynamic intake completeness engine. Calculates required vs received vs valid items.
// AUDIT_READY gate: all mandatory items must be VALID and none can be AWAITING_REVIEW or REJECTED.
// Pure functions — no DB access, no network calls.

const ITEM_STATUS = {
  REQUIRED: 'REQUIRED',           // expected but not yet received
  RECEIVED: 'RECEIVED',           // received, validation pending
  VALID: 'VALID',                 // received and passes all checks
  REJECTED: 'REJECTED',           // received but failed validation
  MISSING: 'MISSING',             // not received, reminder due
  OPTIONAL: 'OPTIONAL',           // available but not required
  NOT_APPLICABLE: 'NOT_APPLICABLE',
  CLIENT_DECLINED: 'CLIENT_DECLINED',
  UNABLE_TO_OBTAIN: 'UNABLE_TO_OBTAIN',
  THIRD_PARTY_REQUIRED: 'THIRD_PARTY_REQUIRED',
  AWAITING_REVIEW: 'AWAITING_REVIEW',
};

const ENGINE_VERSION = 'completeness-engine-v1';

const MANDATORY_ITEMS = [
  { id: 'identity_confirmed', label: 'Artist identity and authority questionnaire', category: 'identity' },
  { id: 'engagement_signed', label: 'Engagement agreement signed', category: 'agreement' },
  { id: 'loa_signed', label: 'Limited Letter of Authorization signed', category: 'agreement' },
  { id: 'soundexchange_catalog', label: 'SoundExchange associated recordings export', category: 'soundexchange' },
  { id: 'soundexchange_payments', label: 'SoundExchange payment statements (all available years)', category: 'soundexchange' },
  { id: 'featured_performer_declaration', label: 'Featured-performer identity confirmed', category: 'identity' },
  { id: 'master_ownership', label: 'Master ownership or exclusive license evidence', category: 'ownership' },
];

const OPTIONAL_ITEMS = [
  { id: 'soundexchange_search_and_claim', label: 'SoundExchange search-and-claim / unclaimed export', category: 'soundexchange' },
  { id: 'soundexchange_adjustments', label: 'SoundExchange adjustment and reversal records', category: 'soundexchange' },
  { id: 'distributor_statements', label: 'Distributor statements', category: 'distributor' },
  { id: 'label_statements', label: 'Label statements', category: 'label' },
  { id: 'ppl_statements', label: 'PPL and international CMO statements', category: 'international' },
  { id: 'international_mandates', label: 'Existing international collection mandates', category: 'international' },
];

const ALL_ITEMS = [...MANDATORY_ITEMS, ...OPTIONAL_ITEMS];
const ALL_ITEM_IDS = new Set(ALL_ITEMS.map(i => i.id));

function computeCompleteness(itemStatuses) {
  // itemStatuses: { [itemId]: { status: string, document_ids?: string[], notes?: string } }

  const mandatory = MANDATORY_ITEMS.map(item => {
    const s = itemStatuses[item.id] || { status: ITEM_STATUS.MISSING };
    return { ...item, status: s.status, document_ids: s.document_ids || [], notes: s.notes || '', mandatory: true };
  });

  const optional = OPTIONAL_ITEMS.map(item => {
    const s = itemStatuses[item.id] || { status: ITEM_STATUS.OPTIONAL };
    return { ...item, status: s.status, document_ids: s.document_ids || [], notes: s.notes || '', mandatory: false };
  });

  const mandatoryPassed = mandatory.filter(i => i.status === ITEM_STATUS.VALID).length;
  const mandatoryTotal = mandatory.length;
  const mandatoryMissing = mandatory.filter(i =>
    i.status === ITEM_STATUS.MISSING || i.status === ITEM_STATUS.REQUIRED
  );
  const mandatoryRejected = mandatory.filter(i => i.status === ITEM_STATUS.REJECTED);
  const mandatoryAwaitingReview = mandatory.filter(i => i.status === ITEM_STATUS.AWAITING_REVIEW);

  const optionalReceived = optional.filter(i =>
    [ITEM_STATUS.RECEIVED, ITEM_STATUS.VALID, ITEM_STATUS.AWAITING_REVIEW].includes(i.status)
  ).length;

  const auditReady =
    mandatoryPassed === mandatoryTotal &&
    mandatoryAwaitingReview.length === 0 &&
    mandatoryRejected.length === 0;

  const progressPercent = Math.round((mandatoryPassed / mandatoryTotal) * 100);

  const blockers = [
    ...mandatoryMissing.map(i => ({ type: 'MISSING_MANDATORY', item_id: i.id, label: i.label })),
    ...mandatoryRejected.map(i => ({ type: 'MANDATORY_REJECTED', item_id: i.id, label: i.label })),
    ...mandatoryAwaitingReview.map(i => ({ type: 'MANDATORY_AWAITING_REVIEW', item_id: i.id, label: i.label })),
  ];

  return {
    audit_ready: auditReady,
    mandatory_passed: mandatoryPassed,
    mandatory_total: mandatoryTotal,
    mandatory_missing: mandatoryMissing.length,
    mandatory_rejected: mandatoryRejected.length,
    mandatory_awaiting_review: mandatoryAwaitingReview.length,
    optional_received: optionalReceived,
    optional_total: optional.length,
    progress_percent: progressPercent,
    blockers,
    items: [...mandatory, ...optional],
    computed_at: new Date().toISOString(),
    engine_version: ENGINE_VERSION,
  };
}

function markItemStatus(currentStatuses, itemId, status, { documentIds = [], notes = '' } = {}) {
  if (!ITEM_STATUS[status]) throw new Error(`Unknown status: ${status}`);
  if (!ALL_ITEM_IDS.has(itemId)) throw new Error(`Unknown intake item: ${itemId}`);
  return {
    ...currentStatuses,
    [itemId]: { status, document_ids: documentIds, notes },
  };
}

module.exports = {
  ITEM_STATUS,
  ENGINE_VERSION,
  MANDATORY_ITEMS,
  OPTIONAL_ITEMS,
  ALL_ITEMS,
  computeCompleteness,
  markItemStatus,
};
