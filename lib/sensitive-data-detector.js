'use strict';
// lib/sensitive-data-detector.js
// Detects probable sensitive data patterns in document text or tabular rows.
// NEVER logs detected values — reports only category, document ID, and page/row reference.
// If quarantine=true, the document must not enter the audit pipeline until replaced.
// Pure functions — no DB access, no network calls.

const CATEGORIES = {
  SSN: 'SSN',
  EIN: 'EIN',
  BANK_ACCOUNT: 'BANK_ACCOUNT',
  ROUTING_NUMBER: 'ROUTING_NUMBER',
  CARD_NUMBER: 'CARD_NUMBER',
  PASSWORD: 'PASSWORD',
  RECOVERY_CODE: 'RECOVERY_CODE',
  TAX_FORM: 'TAX_FORM',
  PORTAL_CREDENTIAL: 'PORTAL_CREDENTIAL',
};

// Severity hierarchy: CRITICAL → quarantine; HIGH → human review required
const DETECTORS = [
  {
    category: CATEGORIES.SSN,
    // Matches 9-digit SSN in standard formats — never logs captured value
    pattern: /\b\d{3}[-\s]\d{2}[-\s]\d{4}\b/,
    label: 'Social Security Number pattern',
    severity: 'CRITICAL',
  },
  {
    category: CATEGORIES.EIN,
    // Employer Identification Number: XX-XXXXXXX
    pattern: /\b\d{2}-\d{7}\b/,
    label: 'EIN / Tax ID pattern',
    severity: 'CRITICAL',
  },
  {
    category: CATEGORIES.ROUTING_NUMBER,
    pattern: /\b(routing\s*(number|#|no\.?)?[\s:]*)\d{9}\b/i,
    label: 'Routing number pattern',
    severity: 'CRITICAL',
  },
  {
    category: CATEGORIES.BANK_ACCOUNT,
    pattern: /\b(account\s*(number|#|no\.?)?[\s:]*)\d{8,17}\b/i,
    label: 'Bank account number pattern',
    severity: 'CRITICAL',
  },
  {
    category: CATEGORIES.CARD_NUMBER,
    // Simplified Visa/MC/Amex card number patterns — 15-16 digit sequences
    pattern: /\b(?:4\d{15}|5[1-5]\d{14}|3[47]\d{13}|6011\d{12})\b/,
    label: 'Payment card number pattern',
    severity: 'CRITICAL',
  },
  {
    category: CATEGORIES.PASSWORD,
    // Detects labelled password fields — never captures the value
    pattern: /\b(password|passwd|pwd|passphrase)\s*[:=]\s*\S+/i,
    label: 'Password label pattern',
    severity: 'CRITICAL',
  },
  {
    category: CATEGORIES.RECOVERY_CODE,
    pattern: /\b(recovery\s*code|backup\s*code|2fa\s*code|otp|one.time)\s*[:=]\s*\S+/i,
    label: 'Recovery / 2FA code pattern',
    severity: 'HIGH',
  },
  {
    category: CATEGORIES.TAX_FORM,
    pattern: /\b(form\s*)?(1099|W-?[289]|W-?4|1040|Schedule\s*[A-Z])\b/i,
    label: 'Tax form reference',
    severity: 'HIGH',
  },
  {
    category: CATEGORIES.PORTAL_CREDENTIAL,
    // Detects labelled login fields
    pattern: /\b(username|login\s*id|user\s*id|account\s*login)\s*[:=]\s*\S+/i,
    label: 'Portal credential label pattern',
    severity: 'HIGH',
  },
];

function _buildFinding(detector, { documentId, pageOrRow }) {
  return {
    category: detector.category,
    label: detector.label,
    severity: detector.severity,
    document_id: documentId || null,
    page_or_row: pageOrRow || null,
    detected_value: '[REDACTED — value is never logged]',
    remediation:
      `Replace this file with an export that does not contain "${detector.label}". ` +
      `Contact MusiGod if you need guidance on redacting before upload.`,
  };
}

function scanText(text, { documentId = null, pageOrRow = null } = {}) {
  if (typeof text !== 'string') {
    return { document_id: documentId, findings: [], quarantine: false, review_required: false, finding_count: 0 };
  }

  const findings = [];
  for (const detector of DETECTORS) {
    if (detector.pattern.test(text)) {
      findings.push(_buildFinding(detector, { documentId, pageOrRow }));
    }
  }

  return {
    document_id: documentId,
    findings,
    quarantine: findings.some(f => f.severity === 'CRITICAL'),
    review_required: findings.length > 0,
    finding_count: findings.length,
  };
}

function scanRows(rows, { documentId = null } = {}) {
  const allFindings = [];

  for (let i = 0; i < rows.length; i++) {
    const rowText = Object.values(rows[i]).map(v => (v == null ? '' : String(v))).join(' ');
    const result = scanText(rowText, { documentId, pageOrRow: `row:${i + 1}` });
    allFindings.push(...result.findings);
  }

  return {
    document_id: documentId,
    findings: allFindings,
    quarantine: allFindings.some(f => f.severity === 'CRITICAL'),
    review_required: allFindings.length > 0,
    finding_count: allFindings.length,
  };
}

// Redact sensitive values from a log-safe summary — never emit raw values
function buildSafeSummary(scanResult) {
  return {
    document_id: scanResult.document_id,
    quarantine: scanResult.quarantine,
    review_required: scanResult.review_required,
    finding_count: scanResult.finding_count,
    categories_found: [...new Set(scanResult.findings.map(f => f.category))],
    page_or_row_refs: scanResult.findings.map(f => f.page_or_row).filter(Boolean),
  };
}

module.exports = {
  CATEGORIES,
  DETECTORS,
  scanText,
  scanRows,
  buildSafeSummary,
};
