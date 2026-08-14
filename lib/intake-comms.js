'use strict';
// lib/intake-comms.js
// Versioned, testable communication templates for the artist rights intake workflow.
// Uses Resend + n8n infrastructure (matching existing register-artist.js pattern).
// NEVER attaches private evidence to email.
// NEVER places sensitive values, signed URLs, document content, or banking data in email.
// NEVER includes signed storage URLs in any email field.
// Links in email must require authenticated portal access.

const TEMPLATE_VERSION = 'intake-comms-v1';

const MESSAGE_TYPES = [
  'INVITATION',
  'IDENTITY_REMINDER',
  'ENGAGEMENT_REMINDER',
  'LOA_REMINDER',
  'MISSING_DOCUMENT_REMINDER',
  'REJECTED_DOCUMENT_REQUEST',
  'MISSING_PERIOD_REMINDER',
  'AUDIT_READY_CONFIRMATION',
  'CLIENT_ACTION_REQUIRED',
  'INACTIVITY_WARNING',
  'WITHDRAWAL_CONFIRMATION',
  'EXPIRATION_NOTICE',
];

// Default cadence: intervalDays between reminders, maxReminders before stopping
const DEFAULT_CADENCE = {
  INVITATION:                  { intervalDays: 0, maxReminders: 1 },
  IDENTITY_REMINDER:           { intervalDays: 3, maxReminders: 3 },
  ENGAGEMENT_REMINDER:         { intervalDays: 3, maxReminders: 3 },
  LOA_REMINDER:                { intervalDays: 3, maxReminders: 3 },
  MISSING_DOCUMENT_REMINDER:   { intervalDays: 7, maxReminders: 4 },
  REJECTED_DOCUMENT_REQUEST:   { intervalDays: 3, maxReminders: 3 },
  MISSING_PERIOD_REMINDER:     { intervalDays: 7, maxReminders: 2 },
  AUDIT_READY_CONFIRMATION:    { intervalDays: 0, maxReminders: 1 },
  CLIENT_ACTION_REQUIRED:      { intervalDays: 5, maxReminders: 3 },
  INACTIVITY_WARNING:          { intervalDays: 14, maxReminders: 2 },
  WITHDRAWAL_CONFIRMATION:     { intervalDays: 0, maxReminders: 1 },
  EXPIRATION_NOTICE:           { intervalDays: 0, maxReminders: 1 },
};

// Fields that must never appear in email content or customFields
const SENSITIVE_KEYS = new Set([
  'password', 'token', 'secret', 'ssn', 'ein',
  'routing', 'account_number', 'signed_url', 'storage_url',
  'tax_id', 'card_number', 'bank_account',
]);

const BUSINESS_HOURS = {
  startHour: 9,   // 9 AM
  endHour: 17,    // 5 PM
  defaultTimezone: 'America/New_York',
};

function buildMessageRecord({
  messageType,
  artistId,
  artistEmail,
  engagementId,
  correlationId,
  portalUrl = null,
  customFields = {},
}) {
  if (!MESSAGE_TYPES.includes(messageType)) throw new Error(`Unknown message type: ${messageType}`);
  if (!artistId) throw new Error('artistId required');
  if (!artistEmail) throw new Error('artistEmail required');
  if (!correlationId) throw new Error('correlationId required');

  // portalUrl must be an authenticated portal link — not a Supabase signed URL
  if (portalUrl) {
    if (portalUrl.includes('token=') || portalUrl.includes('/storage/v1/object')) {
      throw new Error(
        'portalUrl must be an authenticated portal link, not a signed storage URL. ' +
        'Never include signed storage URLs in email.'
      );
    }
  }

  // Reject sensitive keys in customFields
  for (const key of Object.keys(customFields)) {
    if (SENSITIVE_KEYS.has(key.toLowerCase())) {
      throw new Error(`Sensitive field "${key}" must not appear in email message record`);
    }
  }

  return {
    message_type: messageType,
    artist_id: artistId,
    artist_email: artistEmail,
    engagement_id: engagementId || null,
    correlation_id: correlationId,
    template_version: TEMPLATE_VERSION,
    cadence: DEFAULT_CADENCE[messageType],
    portal_url: portalUrl,
    custom_fields: customFields,
    scheduled_at: null,
    sent_at: null,
    status: 'PENDING',
    created_at: new Date().toISOString(),
  };
}

function shouldSendReminder({
  messageType,
  priorSentCount,
  lastSentAt,
  requirementSatisfied = false,
  cadenceOverride = null,
}) {
  // Stop immediately if the requirement is already satisfied
  if (requirementSatisfied) {
    return { send: false, reason: 'Requirement already satisfied — reminders stopped' };
  }

  const cadence = cadenceOverride || DEFAULT_CADENCE[messageType];
  if (!cadence) return { send: false, reason: `No cadence configured for ${messageType}` };

  if (priorSentCount >= cadence.maxReminders) {
    return { send: false, reason: `Maximum reminders reached (${cadence.maxReminders})` };
  }

  if (lastSentAt && cadence.intervalDays > 0) {
    const daysSinceLast = (Date.now() - new Date(lastSentAt).getTime()) / (1000 * 60 * 60 * 24);
    if (daysSinceLast < cadence.intervalDays) {
      return {
        send: false,
        reason: `Too soon — must wait ${cadence.intervalDays} days between reminders (${daysSinceLast.toFixed(1)} elapsed)`,
      };
    }
  }

  return { send: true, reason: 'OK' };
}

function isBusinessHour(timestamp) {
  const date = new Date(timestamp);
  const utcHour = date.getUTCHours();
  // Simplified — production implementation should use Intl.DateTimeFormat with artist's timezone
  // Eastern time offset: UTC-5 (EST) or UTC-4 (EDT); use -5 as conservative default
  const easternHour = (utcHour - 5 + 24) % 24;
  return easternHour >= BUSINESS_HOURS.startHour && easternHour < BUSINESS_HOURS.endHour;
}

function buildSubject(messageType, { professionalName = 'Artist' } = {}) {
  const subjects = {
    INVITATION: `${professionalName} — Your MusiGod neighboring rights audit invitation`,
    IDENTITY_REMINDER: `Action needed: Complete your identity questionnaire (MusiGod)`,
    ENGAGEMENT_REMINDER: `Action needed: Sign your MusiGod engagement agreement`,
    LOA_REMINDER: `Action needed: Sign your Limited Letter of Authorization`,
    MISSING_DOCUMENT_REMINDER: `Action needed: Missing documents for your rights audit`,
    REJECTED_DOCUMENT_REQUEST: `Action needed: Replacement document required`,
    MISSING_PERIOD_REMINDER: `Missing statement periods — MusiGod audit update`,
    AUDIT_READY_CONFIRMATION: `Your MusiGod audit is ready to begin`,
    CLIENT_ACTION_REQUIRED: `Your attention required — MusiGod rights audit`,
    INACTIVITY_WARNING: `Your MusiGod intake is pending — please respond`,
    WITHDRAWAL_CONFIRMATION: `MusiGod audit request closed`,
    EXPIRATION_NOTICE: `Your MusiGod intake invitation has expired`,
  };
  return subjects[messageType] || `MusiGod — ${messageType}`;
}

function buildTimeline(sentRecords) {
  return sentRecords
    .filter(r => r.sent_at)
    .map(r => ({
      type: r.message_type,
      sent_at: r.sent_at,
      template_version: r.template_version,
    }))
    .sort((a, b) => new Date(a.sent_at) - new Date(b.sent_at));
}

module.exports = {
  TEMPLATE_VERSION,
  MESSAGE_TYPES,
  DEFAULT_CADENCE,
  BUSINESS_HOURS,
  SENSITIVE_KEYS,
  buildMessageRecord,
  shouldSendReminder,
  isBusinessHour,
  buildSubject,
  buildTimeline,
};
