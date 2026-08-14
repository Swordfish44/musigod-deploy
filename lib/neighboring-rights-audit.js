'use strict';
// lib/neighboring-rights-audit.js
//
// Neighboring Rights Recovery Audit — pure processing library.
//
// Design constraints:
//   - Zero network calls, zero database writes, zero file I/O.
//   - Every function is deterministic and idempotent for identical inputs.
//   - Credential and sensitive fields are redacted before any output is built.
//   - Fuzzy title matching is a candidate generator only; corroboration required.
//   - Performer share and rightsholder share are always separated.
//   - Gross vs net, paid vs held, domestic vs international are never collapsed.
//   - Contradictory evidence is preserved, never overwritten.
//
// Supported import types:
//   soundexchange_catalog     — SoundExchange Direct catalog export
//   soundexchange_statement   — SoundExchange payment/adjustment statement
//   soundexchange_unclaimed   — SoundExchange search-and-claim export
//   ppl_statement             — PPL repertoire/royalty statement
//   distributor_statement     — Distributor royalty statement
//   performer_roster          — Performer participation declarations
//   ownership_declaration     — Master/rightsholder ownership assertions
//   territory_mandate         — Territory mandate records
//
// Classifications (recording-level, per Phase 3):
//   CLAIMED_PAID              CLAIMED_UNPAID          UNCLAIMED
//   PARTIALLY_CLAIMED         MISSING_FROM_CMO        OWNERSHIP_CONFLICT
//   PERFORMER_CONFLICT        IDENTIFIER_CONFLICT     TERRITORY_GAP
//   MANDATE_GAP               STATEMENT_ONLY_UNMATCHED
//   CATALOG_ONLY_NO_USAGE_EVIDENCE                    INSUFFICIENT_EVIDENCE
//   MANUAL_REVIEW

// ── ISRC handling ──────────────────────────────────────────────────────────────

const ISRC_REGEX = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

// Normalize an ISRC: remove hyphens, spaces, uppercase. Preserve original.
// Returns { original, normalized, valid, error }
function normalizeISRC(raw) {
  const original = String(raw || '').trim();
  if (!original) return { original, normalized: null, valid: false, error: 'empty' };
  const normalized = original.replace(/[-\s]/g, '').toUpperCase();
  if (!ISRC_REGEX.test(normalized)) {
    return { original, normalized, valid: false, error: `malformed: "${normalized}" (expected CC+XXX+YY+NNNNN, 12 chars)` };
  }
  return { original, normalized, valid: true, error: null };
}

// ── Sensitive-field redaction ─────────────────────────────────────────────────

const SENSITIVE_PATTERNS = [
  /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g,  // email
  /\b\d{3}-\d{2}-\d{4}\b/g,                                     // SSN
  /\b\d{9}\b/g,                                                  // EIN-like
  /password|secret|token|api[_-]?key|bearer\s+\S+/gi,           // credential keywords
  /\b[A-Za-z0-9]{20,}\b/g,                                      // long opaque tokens (conservative)
];

// Redact sensitive fields from a row object before including in audit output.
// Never logs, prints, or surfaces raw account numbers, tax IDs, or tokens.
function redactRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const keyLower = k.toLowerCase();
    // Redact by key name
    if (/password|secret|token|api_key|tax_id|ssn|ein|routing|account_number|bank/.test(keyLower)) {
      out[k] = '[REDACTED]';
      continue;
    }
    // Redact string values matching sensitive patterns
    if (typeof v === 'string') {
      let val = v;
      // Only redact the specific dangerous patterns, not all long strings
      val = val.replace(/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED-SSN]');
      // Email redaction (preserve domain for debugging, redact local part)
      val = val.replace(/\b([A-Za-z0-9._%+\-]+)(@[A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g, '[REDACTED]$2');
      out[k] = val;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── Import schema definitions ─────────────────────────────────────────────────

const IMPORT_SCHEMAS = {
  soundexchange_catalog: {
    required: ['isrc', 'title', 'artist_name'],
    optional: ['album_title', 'release_year', 'duration_seconds', 'label', 'performer_name',
               'rightsholder_name', 'rightsholder_share_pct', 'territory', 'catalog_number'],
  },
  soundexchange_statement: {
    required: ['isrc', 'statement_period', 'gross_royalties', 'currency'],
    optional: ['title', 'artist_name', 'usage_type', 'territory', 'paid_amount',
               'held_amount', 'adjustment_amount', 'payment_date', 'payment_ref',
               'reversal', 'claimant_type', 'statement_ref', 'net_royalties',
               'withholding_amount', 'exchange_rate', 'original_currency', 'original_amount'],
  },
  soundexchange_unclaimed: {
    required: ['artist_name', 'title'],
    optional: ['isrc', 'album_title', 'release_year', 'territory', 'unclaimed_since',
               'search_ref'],
  },
  ppl_statement: {
    required: ['isrc', 'statement_period', 'gross_royalties', 'currency'],
    optional: ['title', 'performer_name', 'rightsholder_name', 'territory', 'usage_type',
               'paid_amount', 'held_amount', 'payment_date', 'exchange_rate',
               'original_currency', 'original_amount', 'statement_ref'],
  },
  distributor_statement: {
    required: ['title', 'statement_period', 'net_royalties', 'currency'],
    optional: ['isrc', 'upc', 'artist_name', 'album_title', 'platform', 'territory',
               'gross_royalties', 'fee_amount', 'streams', 'downloads', 'payment_date',
               'statement_ref'],
  },
  performer_roster: {
    required: ['performer_name', 'role'],
    optional: ['isrc', 'title', 'album_title', 'artist_name', 'performer_ipi',
               'performer_isni', 'featured', 'effective_from', 'effective_to', 'evidence_ref'],
  },
  ownership_declaration: {
    required: ['rightsholder_name', 'share_pct'],
    optional: ['isrc', 'title', 'territory', 'right_type', 'effective_from', 'effective_to',
               'agreement_ref', 'label', 'distributor'],
  },
  territory_mandate: {
    required: ['territory', 'mandate_holder'],
    optional: ['isrc', 'title', 'mandate_type', 'effective_from', 'effective_to',
               'cmo_name', 'mandate_ref'],
  },
};

// ── Validation ────────────────────────────────────────────────────────────────

// Validate an array of parsed rows against an import schema.
// Returns { valid: [...], quarantine: [...], errors: [...] }
// Each quarantined row includes a `_quarantine_reason` field.
// Zero writes — pure classification.
function validateImport(rows, importType) {
  const schema = IMPORT_SCHEMAS[importType];
  if (!schema) {
    return {
      valid: [],
      quarantine: rows.map(r => ({ ...r, _quarantine_reason: `unknown import type: ${importType}` })),
      errors: [`Unknown import type: "${importType}". Valid types: ${Object.keys(IMPORT_SCHEMAS).join(', ')}`],
    };
  }

  const valid = [];
  const quarantine = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const issues = [];

    // Check required fields
    for (const field of schema.required) {
      const val = String(row[field] ?? '').trim();
      if (!val) issues.push(`missing required field: "${field}"`);
    }

    // Validate ISRC if present
    const rawISRC = String(row.isrc ?? '').trim();
    if (rawISRC) {
      const { valid: isrcValid, error: isrcError } = normalizeISRC(rawISRC);
      if (!isrcValid) issues.push(`invalid ISRC: ${isrcError}`);
    }

    // Validate numeric amounts
    for (const field of ['gross_royalties', 'net_royalties', 'paid_amount', 'held_amount',
                          'adjustment_amount', 'share_pct', 'rightsholder_share_pct']) {
      if (row[field] !== undefined && row[field] !== null && row[field] !== '') {
        const num = Number(row[field]);
        if (isNaN(num)) issues.push(`non-numeric value in "${field}": ${JSON.stringify(row[field])}`);
      }
    }

    if (issues.length > 0) {
      quarantine.push({ ...redactRow(row), _quarantine_reason: issues.join('; '), _row_index: i });
      errors.push(`Row ${i}: ${issues.join('; ')}`);
    } else {
      valid.push(row);
    }
  }

  return { valid, quarantine, errors };
}

// ── ISRC matching ─────────────────────────────────────────────────────────────

// Strong match: normalized ISRC equality. Returns boolean.
function matchByISRC(catalogISRCs, statementISRC) {
  const { normalized: stmtNorm, valid } = normalizeISRC(statementISRC);
  if (!valid) return false;
  return (catalogISRCs || []).some(raw => {
    const { normalized: catNorm, valid: v } = normalizeISRC(raw);
    return v && catNorm === stmtNorm;
  });
}

// Detect duplicate ISRC conflicts: same ISRC appears in multiple statement rows
// for the same period/territory combination.
// Returns array of conflict groups: [{ isrc, rows: [...] }, ...]
function detectISRCConflicts(statementRows) {
  const byISRC = {};
  for (const row of statementRows) {
    const { normalized, valid } = normalizeISRC(row.isrc || '');
    if (!valid) continue;
    const key = `${normalized}|${row.statement_period || ''}|${row.territory || 'WORLD'}`;
    if (!byISRC[key]) byISRC[key] = { isrc: normalized, rows: [] };
    byISRC[key].rows.push(row);
  }
  return Object.values(byISRC).filter(g => g.rows.length > 1);
}

// ── Fuzzy title matching ──────────────────────────────────────────────────────

const normStr = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Fuzzy match: returns a candidate score (0–1). Must NOT auto-match.
// Caller must call requiresCorroboration() and verify ≥2 corroborating signals.
function scoreFuzzyTitle(titleA, titleB) {
  const a = normStr(titleA);
  const b = normStr(titleB);
  if (!a || !b) return 0;
  if (a === b) return 1.0;
  // Levenshtein similarity approximation via common prefix/suffix and length ratio
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  // Count matching characters (simplified — not full Levenshtein)
  let matches = 0;
  const shorter = a.length <= b.length ? a : b;
  const longer  = a.length <= b.length ? b : a;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return Math.min(matches / maxLen, 0.99); // never 1.0 from fuzzy — exact needs ISRC or strict equality
}

// A fuzzy candidate requires corroboration from ≥2 independent signals beyond title.
// Signals: artist match, duration within 5s, release/album match, MBID presence.
// Returns { corroborated: boolean, signals: [...], missing: [...] }
function requiresCorroboration(catalogTrack, statementRow) {
  const signals = [];
  const missing = [];

  // Signal 1: artist name match
  const catArtist = normStr(catalogTrack.artist_name);
  const stmtArtist = normStr(statementRow.artist_name || statementRow.performer_name || '');
  if (catArtist && stmtArtist && (catArtist.includes(stmtArtist) || stmtArtist.includes(catArtist))) {
    signals.push('artist_name');
  } else {
    missing.push('artist_name');
  }

  // Signal 2: duration within 5 seconds
  const catDur = Number(catalogTrack.track_duration);
  const stmtDur = Number(statementRow.duration_seconds);
  if (catDur > 0 && stmtDur > 0 && Math.abs(catDur - stmtDur) <= 5) {
    signals.push('duration');
  } else if (!catDur || !stmtDur) {
    missing.push('duration (not available)');
  } else {
    missing.push('duration (mismatch)');
  }

  // Signal 3: release/album title match
  const catRelease = normStr(catalogTrack.release_title);
  const stmtAlbum = normStr(statementRow.album_title || '');
  if (catRelease && stmtAlbum && (catRelease.includes(stmtAlbum) || stmtAlbum.includes(catRelease))) {
    signals.push('release_title');
  } else {
    missing.push('release_title');
  }

  // Signal 4: MBID cross-reference (if present in statement)
  if (statementRow.recording_mbid && statementRow.recording_mbid === catalogTrack.recording_mbid) {
    signals.push('recording_mbid');
  }

  const corroborated = signals.length >= 2;
  return { corroborated, signals, missing };
}

// ── Interest separation ───────────────────────────────────────────────────────

// Split a royalty amount into economic interests per Phase 3.
// Never combines performer share with rightsholder share.
// claimantType: 'featured_performer' | 'rightsholder' | 'non_featured_performer' | 'unknown'
function splitInterests(row, claimantType) {
  const gross = Number(row.gross_royalties ?? 0) || 0;
  const net   = Number(row.net_royalties ?? gross) || 0;
  const paid  = Number(row.paid_amount ?? 0) || 0;
  const held  = Number(row.held_amount ?? 0) || 0;
  const adj   = Number(row.adjustment_amount ?? 0) || 0;
  const currency = String(row.currency || 'USD').toUpperCase();
  const origCurrency = String(row.original_currency || currency).toUpperCase();
  const origAmount = Number(row.original_amount ?? gross) || 0;
  const exchRate = Number(row.exchange_rate ?? 1) || 1;

  return {
    claimant_type: claimantType || 'unknown',
    gross,
    net,
    paid,
    held,
    adjustment: adj,
    currency,
    original_currency: origCurrency,
    original_amount: origAmount,
    exchange_rate: exchRate,
    exchange_rate_provenance: row.exchange_rate ? 'statement_provided' : 'assumed_1:1',
    // Protect against double-counting: only one of these will be non-zero per row
    featured_performer_gross:  claimantType === 'featured_performer' ? gross : 0,
    rightsholder_gross:        claimantType === 'rightsholder'       ? gross : 0,
    non_featured_gross:        claimantType === 'non_featured_performer' ? gross : 0,
    other_gross:               ['featured_performer','rightsholder','non_featured_performer'].includes(claimantType) ? 0 : gross,
  };
}

// ── Statement deduplication ───────────────────────────────────────────────────

// Build a dedup key for a statement row.
// Two rows with the same key are duplicates and should not both be counted.
function statementDedupKey(row) {
  const isrc = normalizeISRC(row.isrc || '').normalized || '';
  const period = String(row.statement_period || '').trim();
  const territory = String(row.territory || 'WORLD').trim().toUpperCase();
  const stmtRef = String(row.statement_ref || '').trim();
  const amount = String(row.gross_royalties ?? '').trim();
  return `${isrc}|${period}|${territory}|${stmtRef}|${amount}`;
}

// Remove duplicate rows. Keeps first occurrence. Returns { unique, duplicates }.
function deduplicateStatements(rows) {
  const seen = new Set();
  const unique = [];
  const duplicates = [];
  for (const row of rows) {
    const key = statementDedupKey(row);
    if (seen.has(key)) {
      duplicates.push({ ...row, _duplicate_key: key });
    } else {
      seen.add(key);
      unique.push(row);
    }
  }
  return { unique, duplicates };
}

// ── Reversal / adjustment detection ──────────────────────────────────────────

// A reversal row negates a prior payment row (same ISRC+period+territory, negative amount).
// Returns { net, reversals, adjusted_rows }
function applyReversals(rows) {
  const reversals = rows.filter(r => Number(r.adjustment_amount || r.gross_royalties || 0) < 0
                                   || String(r.reversal || '').toLowerCase() === 'true');
  const nonReversals = rows.filter(r => !reversals.includes(r));
  let net = 0;
  for (const r of nonReversals) net += Number(r.gross_royalties || 0);
  for (const r of reversals)    net += Number(r.adjustment_amount || r.gross_royalties || 0);
  return { net, reversals, adjusted_rows: nonReversals };
}

// ── Gross vs net reconciliation ───────────────────────────────────────────────

// Reconcile gross and net amounts for a set of statement rows.
// Never uses net when gross is available without explaining the difference.
// Returns reconciliation summary.
function reconcileGrossNet(rows) {
  let totalGross = 0, totalNet = 0, totalFees = 0, totalWithholding = 0;
  let grossRowCount = 0, netRowCount = 0;

  for (const r of rows) {
    const gross = Number(r.gross_royalties ?? '');
    const net   = Number(r.net_royalties ?? '');
    const fee   = Number(r.fee_amount ?? '');
    const wht   = Number(r.withholding_amount ?? '');

    if (!isNaN(gross)) { totalGross += gross; grossRowCount++; }
    if (!isNaN(net))   { totalNet += net;     netRowCount++; }
    if (!isNaN(fee))   totalFees += fee;
    if (!isNaN(wht))   totalWithholding += wht;
  }

  const impliedNet = totalGross - totalFees - totalWithholding;

  return {
    total_gross:         totalGross,
    total_net_stated:    totalNet,
    total_fees:          totalFees,
    total_withholding:   totalWithholding,
    implied_net:         impliedNet,
    gross_rows:          grossRowCount,
    net_rows:            netRowCount,
    reconciles:          netRowCount === 0 || Math.abs(totalNet - impliedNet) < 0.01,
    reconciliation_gap:  totalNet - impliedNet,
    note: netRowCount === 0
      ? 'No net rows; gross only'
      : Math.abs(totalNet - impliedNet) < 0.01
        ? 'Gross and net reconcile'
        : `Gap of ${(totalNet - impliedNet).toFixed(2)} between stated net and gross-minus-deductions`,
  };
}

// ── Recording classification ──────────────────────────────────────────────────

const VALID_CLASSIFICATIONS = new Set([
  'CLAIMED_PAID', 'CLAIMED_UNPAID', 'UNCLAIMED', 'PARTIALLY_CLAIMED',
  'MISSING_FROM_CMO', 'OWNERSHIP_CONFLICT', 'PERFORMER_CONFLICT',
  'IDENTIFIER_CONFLICT', 'TERRITORY_GAP', 'MANDATE_GAP',
  'STATEMENT_ONLY_UNMATCHED', 'CATALOG_ONLY_NO_USAGE_EVIDENCE',
  'INSUFFICIENT_EVIDENCE', 'MANUAL_REVIEW',
]);

// Classify a recording given its evidence state.
// evidence: {
//   hasISRC, hasOwnershipDeclaration, hasPerformerDeclaration,
//   hasMandate, hasStatementMatch, hasPaidAmount, hasHeldAmount,
//   hasOwnershipConflict, hasPerformerConflict, hasIdentifierConflict,
//   hasTerritory, isFuzzyMatchOnly, insufficientEvidence
// }
// Returns one of the 14 classification strings.
function classifyRecording(evidence) {
  if (evidence.insufficientEvidence) return 'INSUFFICIENT_EVIDENCE';
  if (evidence.hasOwnershipConflict)  return 'OWNERSHIP_CONFLICT';
  if (evidence.hasPerformerConflict)  return 'PERFORMER_CONFLICT';
  if (evidence.hasIdentifierConflict) return 'IDENTIFIER_CONFLICT';
  if (evidence.isFuzzyMatchOnly)      return 'MANUAL_REVIEW';

  if (evidence.hasStatementMatch) {
    if (evidence.hasPaidAmount && !evidence.hasHeldAmount)  return 'CLAIMED_PAID';
    if (evidence.hasPaidAmount && evidence.hasHeldAmount)   return 'PARTIALLY_CLAIMED';
    if (!evidence.hasPaidAmount && evidence.hasHeldAmount)  return 'CLAIMED_UNPAID';
    return 'CLAIMED_UNPAID';
  }

  if (!evidence.hasStatementMatch && evidence.hasISRC) {
    if (!evidence.hasMandate)    return 'MANDATE_GAP';
    if (!evidence.hasTerritory)  return 'TERRITORY_GAP';
    return 'UNCLAIMED';
  }

  if (!evidence.hasStatementMatch && !evidence.hasISRC) {
    return 'CATALOG_ONLY_NO_USAGE_EVIDENCE';
  }

  if (evidence.hasStatementMatch && !evidence.hasISRC) {
    return 'STATEMENT_ONLY_UNMATCHED';
  }

  return 'MISSING_FROM_CMO';
}

// ── Full audit pipeline ────────────────────────────────────────────────────────

// Run the full neighboring-rights audit pipeline.
// All processing is in-memory. Zero DB writes. Zero network calls.
//
// options: {
//   catalogTracks: [...],          // from catalog_enriched_tracks_v1
//   soundexchangeStatements: [...], // validated SoundExchange statement rows
//   soundexchangeCatalog: [...],    // validated SoundExchange catalog rows
//   pplStatements: [...],           // validated PPL statement rows
//   distributorStatements: [...],   // validated distributor statement rows
//   performerRoster: [...],         // validated performer roster rows
//   ownershipDeclarations: [...],   // validated ownership declaration rows
//   territoryMandates: [...],       // validated territory mandate rows
//   dryRun: true,                   // must be true; guards against accidental writes
// }
//
// Returns:
// {
//   dry_run: true,
//   pipeline_version: '1.0.0',
//   processed_at: ISO8601,
//   catalog_total: N,
//   classifications: { CLAIMED_PAID: N, ... },
//   recordings: [...],     // per-track results
//   exceptions: [...],     // quarantine + conflicts + fuzzy-only
//   reconciliation: {...}, // gross/net totals per source
//   confirmed_receivable_calculable: false | true,
//   verdict: '...',
// }
function runAudit(options = {}) {
  if (options.dryRun !== true) {
    throw new Error('runAudit() requires dryRun: true — this pipeline never writes to production');
  }

  const catalog = options.catalogTracks || [];
  const sxStatements = options.soundexchangeStatements || [];
  const sxCatalog = options.soundexchangeCatalog || [];
  const pplStatements = options.pplStatements || [];
  const distStatements = options.distributorStatements || [];
  const performers = options.performerRoster || [];
  const ownership = options.ownershipDeclarations || [];
  const mandates = options.territoryMandates || [];

  // ── Step 1: Dedup all statement sources
  const { unique: sxUnique, duplicates: sxDups } = deduplicateStatements(sxStatements);
  const { unique: pplUnique, duplicates: pplDups } = deduplicateStatements(pplStatements);
  const { unique: distUnique } = deduplicateStatements(distStatements);

  const exceptions = [
    ...sxDups.map(r => ({ type: 'DUPLICATE_STATEMENT', source: 'soundexchange', row: redactRow(r) })),
    ...pplDups.map(r => ({ type: 'DUPLICATE_STATEMENT', source: 'ppl', row: redactRow(r) })),
  ];

  // ── Step 2: ISRC conflict detection
  const sxISRCConflicts = detectISRCConflicts(sxUnique);
  const pplISRCConflicts = detectISRCConflicts(pplUnique);
  for (const c of [...sxISRCConflicts, ...pplISRCConflicts]) {
    exceptions.push({ type: 'ISRC_CONFLICT', isrc: c.isrc, rows: c.rows.map(redactRow) });
  }

  // ── Step 3: Build lookup structures
  const sxByISRC = buildISRCIndex(sxUnique);
  const pplByISRC = buildISRCIndex(pplUnique);
  const sxCatalogByISRC = buildISRCIndex(sxCatalog);
  const performersByISRC = buildISRCIndex(performers, 'isrc');
  const ownershipByISRC = buildISRCIndex(ownership, 'isrc');
  const mandatesByISRC = buildISRCIndex(mandates, 'isrc');

  // ── Step 4: Classify each catalog recording
  const classificationCounts = {};
  for (const cls of VALID_CLASSIFICATIONS) classificationCounts[cls] = 0;

  const recordings = catalog.map(track => {
    const trackISRCs = (track.isrcs || []);
    const hasISRC = trackISRCs.length > 0;

    // Find statement matches
    const sxMatches  = hasISRC ? findISRCMatches(trackISRCs, sxByISRC)  : [];
    const pplMatches = hasISRC ? findISRCMatches(trackISRCs, pplByISRC) : [];
    const allMatches = [...sxMatches, ...pplMatches];
    const hasStatementMatch = allMatches.length > 0;

    // Check SoundExchange catalog registration
    const sxCatalogMatch = hasISRC ? findISRCMatches(trackISRCs, sxCatalogByISRC) : [];

    // Performer and ownership evidence
    const trackPerformers = hasISRC ? findISRCMatches(trackISRCs, performersByISRC) : [];
    const trackOwnership  = hasISRC ? findISRCMatches(trackISRCs, ownershipByISRC)  : [];
    const trackMandates   = hasISRC ? findISRCMatches(trackISRCs, mandatesByISRC)   : [];

    // Amount totals
    const { net: sxNet, reversals: sxReversals } = applyReversals(sxMatches);
    const { net: pplNet } = applyReversals(pplMatches);
    const hasPaidAmount = allMatches.some(r => Number(r.paid_amount || 0) > 0);
    const hasHeldAmount = allMatches.some(r => Number(r.held_amount || 0) > 0);

    // Conflict detection
    const hasOwnershipConflict = detectOwnershipConflict(trackOwnership);
    const hasPerformerConflict = detectPerformerConflict(trackPerformers);
    const hasIdentifierConflict = detectIdentifierConflict(trackISRCs);

    const evidence = {
      hasISRC,
      hasOwnershipDeclaration: trackOwnership.length > 0,
      hasPerformerDeclaration: trackPerformers.length > 0,
      hasMandate: trackMandates.length > 0,
      hasStatementMatch,
      hasPaidAmount,
      hasHeldAmount,
      hasOwnershipConflict,
      hasPerformerConflict,
      hasIdentifierConflict,
      hasTerritory: allMatches.some(r => r.territory),
      isFuzzyMatchOnly: false,
      insufficientEvidence: !hasISRC && !hasStatementMatch && trackOwnership.length === 0,
    };

    const classification = classifyRecording(evidence);
    classificationCounts[classification] = (classificationCounts[classification] || 0) + 1;

    // Interest separation for matched amounts
    const interests = allMatches.map(r => {
      const ctype = inferClaimantType(r, trackPerformers);
      return splitInterests(r, ctype);
    });

    return {
      id: track.id,
      track_title: track.track_title,
      release_title: track.release_title,
      release_year: track.release_year,
      recording_mbid: track.recording_mbid,
      isrcs: trackISRCs,
      classification,
      has_isrc: hasISRC,
      soundexchange_registered: sxCatalogMatch.length > 0,
      statement_matches: allMatches.length,
      soundexchange_statement_net: sxNet,
      ppl_statement_net: pplNet,
      has_reversals: sxReversals.length > 0,
      performer_evidence: trackPerformers.length > 0,
      ownership_evidence: trackOwnership.length > 0,
      mandate_evidence: trackMandates.length > 0,
      interests,
      evidence,
    };
  });

  // ── Step 5: Reconciliation summaries
  const sxReconciliation  = reconcileGrossNet(sxUnique);
  const pplReconciliation = reconcileGrossNet(pplUnique);
  const distReconciliation = reconcileGrossNet(distUnique);

  // ── Step 6: Verdict
  const hasAnyStatements = sxUnique.length > 0 || pplUnique.length > 0 || distUnique.length > 0;
  const hasAnyOwnership  = ownership.length > 0;
  const confirmed_receivable_calculable = hasAnyStatements && hasAnyOwnership;

  const verdict = confirmed_receivable_calculable
    ? 'Statements and ownership evidence are present. A partial receivable calculation may be possible for matched recordings. Review CLAIMED_UNPAID and UNCLAIMED classifications.'
    : 'No private CMO statements or usage/payment exports are present in this audit run. No defensible neighboring-rights receivable total can currently be calculated. Provide SoundExchange statements, PPL statements, and ownership declarations to proceed.';

  return {
    dry_run: true,
    pipeline_version: '1.0.0',
    processed_at: new Date().toISOString(),
    catalog_total: catalog.length,
    statements_processed: {
      soundexchange: sxUnique.length,
      ppl: pplUnique.length,
      distributor: distUnique.length,
    },
    classifications: classificationCounts,
    recordings,
    exceptions,
    reconciliation: {
      soundexchange: sxReconciliation,
      ppl: pplReconciliation,
      distributor: distReconciliation,
    },
    confirmed_receivable_calculable,
    verdict,
  };
}

// ── Internal helpers ──────────────────────────────────────────────────────────

function buildISRCIndex(rows, isrcField = 'isrc') {
  const idx = {};
  for (const row of rows) {
    const { normalized, valid } = normalizeISRC(row[isrcField] || '');
    if (!valid) continue;
    if (!idx[normalized]) idx[normalized] = [];
    idx[normalized].push(row);
  }
  return idx;
}

function findISRCMatches(trackISRCs, index) {
  const results = [];
  for (const raw of trackISRCs) {
    const { normalized, valid } = normalizeISRC(raw);
    if (!valid) continue;
    if (index[normalized]) results.push(...index[normalized]);
  }
  return results;
}

function detectOwnershipConflict(ownershipRows) {
  if (ownershipRows.length < 2) return false;
  const totals = {};
  for (const r of ownershipRows) {
    const territory = (r.territory || 'WORLD').toUpperCase();
    totals[territory] = (totals[territory] || 0) + Number(r.share_pct || 0);
  }
  return Object.values(totals).some(total => total > 100.01);
}

function detectPerformerConflict(performerRows) {
  const names = new Set(performerRows.map(r => (r.performer_name || '').toLowerCase().trim()));
  const rolesPerName = {};
  for (const r of performerRows) {
    const name = (r.performer_name || '').toLowerCase().trim();
    if (!rolesPerName[name]) rolesPerName[name] = new Set();
    rolesPerName[name].add((r.role || '').toLowerCase().trim());
  }
  // Conflict: same performer listed with contradictory roles
  return Object.values(rolesPerName).some(roles => roles.size > 1 && roles.has('featured') && roles.has('non_featured'));
}

function detectIdentifierConflict(isrcs) {
  // Conflict: duplicate ISRCs within a single track's array
  const norms = isrcs.map(r => normalizeISRC(r).normalized).filter(Boolean);
  return new Set(norms).size !== norms.length;
}

function inferClaimantType(statementRow, performerRows) {
  if (statementRow.claimant_type) return statementRow.claimant_type;
  const hasFeaturedPerformer = performerRows.some(p => String(p.featured || '').toLowerCase() === 'true');
  if (hasFeaturedPerformer) return 'featured_performer';
  if (statementRow.rightsholder_name) return 'rightsholder';
  return 'unknown';
}

// ── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // ISRC
  normalizeISRC,
  matchByISRC,
  detectISRCConflicts,

  // Validation
  validateImport,
  IMPORT_SCHEMAS,

  // Redaction
  redactRow,

  // Matching
  scoreFuzzyTitle,
  requiresCorroboration,

  // Interest separation
  splitInterests,

  // Statement handling
  statementDedupKey,
  deduplicateStatements,
  applyReversals,
  reconcileGrossNet,

  // Classification
  classifyRecording,
  VALID_CLASSIFICATIONS,

  // Pipeline
  runAudit,
};
