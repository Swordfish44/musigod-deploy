'use strict';
// lib/artist-identity.js
// Artist identity and authority questionnaire schema and validator.
// Pure functions — no DB access, no network calls.
// Does NOT request SSN, EIN, routing numbers, account numbers, card numbers,
// passwords, recovery codes, or portal credentials.

const PERFORMER_ROLES = [
  'FEATURED_PERFORMER',
  'NON_FEATURED_PERFORMER',
  'FEATURED_ON_SOME',
  'BACKGROUND_VOCALIST',
  'SESSION_MUSICIAN',
  'PRODUCER',
  'BAND_MEMBER',
  'SOLO_ARTIST',
  'OTHER',
];

const SUBMISSION_CONTEXTS = [
  'INDIVIDUAL',     // artist submitting for themselves
  'ENTITY',         // artist acting on behalf of an LLC/corp they control
  'GROUP',          // acting for a group (band, duo)
  'REPRESENTATIVE', // authorized third-party acting for the artist
];

const PRO_LIST = [
  'ASCAP', 'BMI', 'SESAC', 'GMR',
  'PRS', 'SOCAN', 'APRA_AMCOS', 'STIM', 'GEMA', 'SACEM',
  'OTHER', 'NONE',
];

// Fields that must NEVER appear in a submitted identity record
const PROHIBITED_FIELDS = [
  'ssn', 'ein', 'tax_id', 'routing_number', 'account_number',
  'card_number', 'password', 'recovery_code', 'portal_credential',
];

const REQUIRED_FIELDS = [
  'legal_first_name',
  'legal_last_name',
  'professional_name',
  'submission_context',
  'performer_roles',
  'soundexchange_member',
  'attestation_accurate',
  'attestation_authorized',
];

function validateIdentity(data) {
  const errors = [];
  const warnings = [];

  // Prohibited fields — reject immediately
  for (const field of PROHIBITED_FIELDS) {
    const v = data[field];
    if (v !== null && v !== undefined && v !== '') {
      errors.push(`Prohibited field submitted: ${field}. Never provide ${field} through this form.`);
    }
  }

  // Required fields
  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`Required field missing: ${field}`);
    }
  }

  // Attestations must be explicitly true (not truthy — must be the boolean true)
  if (data.attestation_accurate !== true) {
    errors.push('attestation_accurate must be explicitly true');
  }
  if (data.attestation_authorized !== true) {
    errors.push('attestation_authorized must be explicitly true');
  }

  // submission_context must be valid
  if (data.submission_context && !SUBMISSION_CONTEXTS.includes(data.submission_context)) {
    errors.push(`Invalid submission_context: ${data.submission_context}. Allowed: ${SUBMISSION_CONTEXTS.join(', ')}`);
  }

  // REPRESENTATIVE context requires representative fields
  if (data.submission_context === 'REPRESENTATIVE') {
    if (!data.representative_name) errors.push('representative_name required for REPRESENTATIVE context');
    if (!data.representative_role) errors.push('representative_role required for REPRESENTATIVE context');
    if (!data.representative_evidence_ref) {
      warnings.push('representative_evidence_ref strongly recommended for REPRESENTATIVE context');
    }
  }

  // performer_roles must be a non-empty array of valid values
  if (Array.isArray(data.performer_roles)) {
    if (data.performer_roles.length === 0) {
      errors.push('At least one performer_role is required');
    }
    for (const r of data.performer_roles) {
      if (!PERFORMER_ROLES.includes(r)) {
        errors.push(`Invalid performer_role: ${r}. Allowed: ${PERFORMER_ROLES.join(', ')}`);
      }
    }
  } else if (data.performer_roles !== undefined) {
    errors.push('performer_roles must be an array');
  }

  // soundexchange_member must be boolean or 'UNKNOWN'
  const sxm = data.soundexchange_member;
  if (sxm !== true && sxm !== false && sxm !== 'UNKNOWN') {
    errors.push('soundexchange_member must be true, false, or "UNKNOWN"');
  }

  // PRO affiliations — warn on unknowns, don't block
  if (data.pro_affiliations !== undefined) {
    const pros = Array.isArray(data.pro_affiliations) ? data.pro_affiliations : [data.pro_affiliations];
    for (const pro of pros) {
      if (!PRO_LIST.includes(pro)) {
        warnings.push(`Unknown PRO affiliation: "${pro}". Please verify spelling.`);
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}

function buildIdentityQuestionnaireSchema() {
  return {
    version: 'artist-identity-v1',
    fields: [
      { key: 'legal_first_name', label: 'Legal first name', type: 'text', required: true },
      { key: 'legal_last_name', label: 'Legal last name', type: 'text', required: true },
      { key: 'professional_name', label: 'Professional / stage name', type: 'text', required: true },
      { key: 'aliases', label: 'Historical aliases and spelling variants', type: 'text[]', required: false },
      { key: 'group_affiliations', label: 'Group or featured-artist affiliations', type: 'text[]', required: false },
      { key: 'business_entities', label: 'Business entities, labels, or master-owning entities', type: 'text[]', required: false },
      { key: 'pro_affiliations', label: 'PRO memberships', type: 'enum[]', enum: PRO_LIST, required: false },
      { key: 'soundexchange_member', label: 'SoundExchange membership status', type: 'enum', enum: [true, false, 'UNKNOWN'], required: true },
      { key: 'performer_roles', label: 'Performer role(s)', type: 'enum[]', enum: PERFORMER_ROLES, required: true },
      { key: 'submission_context', label: 'Submitting as', type: 'enum', enum: SUBMISSION_CONTEXTS, required: true },
      { key: 'representative_name', label: 'Authorized representative name', type: 'text', required: false, condition: 'submission_context=REPRESENTATIVE' },
      { key: 'representative_role', label: 'Representative role or title', type: 'text', required: false, condition: 'submission_context=REPRESENTATIVE' },
      { key: 'representative_evidence_ref', label: 'Authorization evidence document reference', type: 'text', required: false, condition: 'submission_context=REPRESENTATIVE' },
      { key: 'attestation_accurate', label: 'I attest that the information submitted is accurate and complete to the best of my knowledge.', type: 'boolean', required: true },
      { key: 'attestation_authorized', label: 'I attest that I am authorized to submit these documents and to engage MusiGod to conduct this audit.', type: 'boolean', required: true },
    ],
    prohibited: PROHIBITED_FIELDS.map(f => ({
      key: f,
      reason: 'Never provide passwords, tax identifiers, banking credentials, or portal login details through this form.',
    })),
  };
}

module.exports = {
  PERFORMER_ROLES,
  SUBMISSION_CONTEXTS,
  PRO_LIST,
  PROHIBITED_FIELDS,
  REQUIRED_FIELDS,
  validateIdentity,
  buildIdentityQuestionnaireSchema,
};
