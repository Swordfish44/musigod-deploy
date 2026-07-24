'use strict';

// lib/registration-readiness.js
// Deterministic, side-effect-free registration readiness evaluation engine.
//
// Input: a track object (catalog_enriched_tracks_v1 shape, optionally merged
// with split data) and a destination string.
// Output: a stable decision object with blocker codes and evidence summary.
//
// No DB access. No external calls. No side effects. Safe to call in tests.

const RULESET_VERSION = 'registration-readiness-v1';

const DESTINATIONS = ['ASCAP', 'BMI', 'MLC', 'SOUNDEXCHANGE', 'NEIGHBORING_RIGHTS'];

// Stable blocker code registry
const BLOCKER_META = {
  MISSING_WRITERS:                  { severity: 'BLOCKING',      subject: 'composition' },
  MISSING_WRITER_IPI:               { severity: 'BLOCKING',      subject: 'writer' },
  MISSING_PRO_AFFILIATION:          { severity: 'NEEDS_REVIEW',  subject: 'writer' },
  WRONG_PRO_AFFILIATION:            { severity: 'BLOCKING',      subject: 'writer' },
  MISSING_CONFIRMED_SPLITS:         { severity: 'BLOCKING',      subject: 'ownership' },
  MISSING_PUBLISHER_IDENTITY:       { severity: 'BLOCKING',      subject: 'publisher' },
  MISSING_ISRC:                     { severity: 'BLOCKING',      subject: 'recording' },
  MISSING_MASTER_RIGHTS_HOLDER:     { severity: 'BLOCKING',      subject: 'master_rights' },
  WRITER_CONFLICT:                  { severity: 'BLOCKING',      subject: 'composition' },
  ENRICHMENT_ERROR:                 { severity: 'BLOCKING',      subject: 'track' },
  EXISTING_REGISTRATION_AMENDMENT:  { severity: 'BLOCKING',      subject: 'registration' },
  MISSING_ISWC:                     { severity: 'WARNING',       subject: 'composition' },
  TERRITORY_UNCONFIRMED:            { severity: 'NEEDS_REVIEW',  subject: 'territory' },
};

function mkBlocker(code, message, subjectId = null, evidenceRefs = []) {
  const meta = BLOCKER_META[code] || { severity: 'BLOCKING', subject: 'unknown' };
  return {
    code,
    severity: meta.severity,
    subject: meta.subject,
    subject_id: subjectId,
    message,
    evidence_refs: evidenceRefs,
  };
}

function getWriters(track) {
  if (Array.isArray(track.writers)) return track.writers;
  if (typeof track.writers === 'string') {
    try { return JSON.parse(track.writers); } catch { return []; }
  }
  return [];
}

function hasWriterConflict(track) {
  return typeof track.enrichment_error === 'string' &&
    track.enrichment_error.includes('[conflict]');
}

// An enrichment error that is NOT a writer-conflict (those are handled per-destination)
function hasUnresolvedEnrichmentError(track) {
  if (!track.enrichment_error) return false;
  if (hasWriterConflict(track)) return false;
  // "[preserved prior writers]" prefix is informational, not a blocking error
  if (track.enrichment_error.startsWith('[preserved prior writers]')) return false;
  return true;
}

// Splits are confirmed when the calling layer sets splits_validated=true,
// meaning catalog_writer_splits_v1.validated = true for this track.
// Equal-split defaults are NEVER treated as confirmed.
function splitsConfirmed(track) {
  return track.splits_validated === true;
}

function getIsrcs(track) {
  if (!Array.isArray(track.isrcs)) return [];
  return track.isrcs.filter(Boolean);
}

// ── Evidence summary ─────────────────────────────────────────────────────────

function buildEvidenceSummary(track, writers) {
  const isrcs = getIsrcs(track);
  return {
    track_title:             track.track_title || track.trackTitle || null,
    artist_name:             track.artist_name || track.artistName || null,
    enriched:                !!track.enriched,
    enrichment_source:       track.enrichment_source || track.enrichmentSource || null,
    writer_count:            writers.length,
    writers_with_ipi:        writers.filter(w => !!w.ipi).length,
    writers_with_pro:        writers.filter(w => !!w.pro).length,
    splits_confirmed:        splitsConfirmed(track),
    has_iswc:                !!(track.iswc),
    isrc_count:              isrcs.length,
    has_master_rights_holder: !!(track.master_rights_holder),
    has_publisher_identity:  !!(track.publisher_ipi || track.publisher_name),
    has_enrichment_error:    !!(track.enrichment_error),
    has_writer_conflict:     hasWriterConflict(track),
  };
}

// ── ASCAP ────────────────────────────────────────────────────────────────────
//
// Required: verified writers, correct PRO (not BMI), IPI/CAE, confirmed splits.
// ISWC: warning only — may be assigned during or after registration.

function evaluateASCAP(track, writers, globalBlockers) {
  const items = [...globalBlockers];

  if (hasWriterConflict(track)) {
    items.push(mkBlocker('WRITER_CONFLICT', 'Writer credit contradiction detected — keep existing credits and flag for review.'));
  }

  if (writers.length === 0) {
    items.push(mkBlocker('MISSING_WRITERS', 'No writer credits on record.'));
  }

  for (const w of writers) {
    if (!w.ipi) {
      items.push(mkBlocker('MISSING_WRITER_IPI',
        `IPI/CAE not verified for writer "${w.name || '(unknown)'}" — required for ASCAP bulk registration.`,
        w.name || null));
    }
    const pro = (w.pro || '').toUpperCase();
    if (pro === 'BMI') {
      items.push(mkBlocker('WRONG_PRO_AFFILIATION',
        `Writer "${w.name}" is a BMI member — their share cannot be registered at ASCAP.`,
        w.name || null));
    } else if (!pro) {
      items.push(mkBlocker('MISSING_PRO_AFFILIATION',
        `PRO affiliation not confirmed for writer "${w.name || '(unknown)'}" — verify before submission.`,
        w.name || null));
    }
  }

  if (writers.length > 0 && !splitsConfirmed(track)) {
    items.push(mkBlocker('MISSING_CONFIRMED_SPLITS',
      'Writer ownership splits have not been confirmed — equal-split defaults are not authoritative.'));
  }

  const warnings = [];
  if (!track.iswc) {
    warnings.push(mkBlocker('MISSING_ISWC', 'No ISWC on record; may be assigned during or after ASCAP registration.'));
  }

  return { items, warnings };
}

// ── BMI ──────────────────────────────────────────────────────────────────────

function evaluateBMI(track, writers, globalBlockers) {
  const items = [...globalBlockers];

  if (hasWriterConflict(track)) {
    items.push(mkBlocker('WRITER_CONFLICT', 'Writer credit contradiction detected — flag for review.'));
  }

  if (writers.length === 0) {
    items.push(mkBlocker('MISSING_WRITERS', 'No writer credits on record.'));
  }

  for (const w of writers) {
    if (!w.ipi) {
      items.push(mkBlocker('MISSING_WRITER_IPI',
        `IPI/CAE not verified for writer "${w.name || '(unknown)'}" — required for BMI title registration.`,
        w.name || null));
    }
    const pro = (w.pro || '').toUpperCase();
    if (pro === 'ASCAP') {
      items.push(mkBlocker('WRONG_PRO_AFFILIATION',
        `Writer "${w.name}" is an ASCAP member — their share cannot be registered at BMI.`,
        w.name || null));
    } else if (!pro) {
      items.push(mkBlocker('MISSING_PRO_AFFILIATION',
        `PRO affiliation not confirmed for writer "${w.name || '(unknown)'}" — verify before submission.`,
        w.name || null));
    }
  }

  if (writers.length > 0 && !splitsConfirmed(track)) {
    items.push(mkBlocker('MISSING_CONFIRMED_SPLITS',
      'Writer ownership splits have not been confirmed — equal-split defaults are not authoritative.'));
  }

  const warnings = [];
  if (!track.iswc) {
    warnings.push(mkBlocker('MISSING_ISWC', 'No ISWC on record; may be assigned during or after BMI registration.'));
  }

  return { items, warnings };
}

// ── MLC ──────────────────────────────────────────────────────────────────────
//
// The MLC requires work identity, writer IPI, confirmed ownership, and publisher/
// administrator identity for a publisher share claim. ISWC: warning only.

function evaluateMLC(track, writers, globalBlockers) {
  const items = [...globalBlockers];

  if (hasWriterConflict(track)) {
    items.push(mkBlocker('WRITER_CONFLICT', 'Writer credit contradiction detected — flag for review.'));
  }

  if (writers.length === 0) {
    items.push(mkBlocker('MISSING_WRITERS', 'No writer credits on record.'));
  }

  for (const w of writers) {
    if (!w.ipi) {
      items.push(mkBlocker('MISSING_WRITER_IPI',
        `IPI/CAE not verified for writer "${w.name || '(unknown)'}" — required for MLC publisher claim.`,
        w.name || null));
    }
  }

  if (writers.length > 0 && !splitsConfirmed(track)) {
    items.push(mkBlocker('MISSING_CONFIRMED_SPLITS',
      'Writer ownership splits have not been confirmed — equal-split defaults are not authoritative.'));
  }

  if (!track.publisher_ipi && !track.publisher_name) {
    items.push(mkBlocker('MISSING_PUBLISHER_IDENTITY',
      'Publisher or administrator identity and IPI not verified — required for MLC publisher share claim.'));
  }

  const warnings = [];
  if (!track.iswc) {
    warnings.push(mkBlocker('MISSING_ISWC', 'No ISWC on record; MLC may assign one upon registration.'));
  }

  return { items, warnings };
}

// ── SoundExchange ─────────────────────────────────────────────────────────────
//
// SoundExchange covers master/sound recording rights — not composition.
// Required: ISRC, master rights holder, featured artist.
// Writer credits and composition PRO affiliation are NOT evaluated here.

function evaluateSoundExchange(track) {
  const items = [];
  const isrcs = getIsrcs(track);

  if (isrcs.length === 0) {
    items.push(mkBlocker('MISSING_ISRC', 'No ISRC — SoundExchange requires ISRC to process a sound recording claim.'));
  }

  if (!track.master_rights_holder) {
    items.push(mkBlocker('MISSING_MASTER_RIGHTS_HOLDER',
      'Master recording rights holder not confirmed — required to establish SoundExchange claimant.'));
  }

  return { items, warnings: [] };
}

// ── Neighboring Rights ────────────────────────────────────────────────────────
//
// International neighboring rights require ISRC, master rights holder, and
// society/territory determination. Territory unconfirmed → NEEDS_REVIEW.

function evaluateNeighboringRights(track) {
  const items = [];
  const isrcs = getIsrcs(track);

  if (isrcs.length === 0) {
    items.push(mkBlocker('MISSING_ISRC', 'No ISRC — required for international neighboring rights claim.'));
  }

  if (!track.master_rights_holder) {
    items.push(mkBlocker('MISSING_MASTER_RIGHTS_HOLDER',
      'Master recording rights holder not confirmed — required for neighboring rights claim.'));
  }

  if (!track.territory || !track.society_mandate) {
    items.push(mkBlocker('TERRITORY_UNCONFIRMED',
      'Territory scope and applicable society mandate not confirmed — manual review required before submission.'));
  }

  return { items, warnings: [] };
}

// ── Decision engine ───────────────────────────────────────────────────────────

function computeDecision(items, warnings) {
  if (items.some(i => i.severity === 'BLOCKING')) return 'BLOCKED';
  if (items.some(i => i.severity === 'NEEDS_REVIEW')) return 'NEEDS_REVIEW';
  return 'READY';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Evaluate registration readiness for a single track and destination.
 *
 * @param {object} track - Catalog enriched track (catalog_enriched_tracks_v1 shape).
 *   May include merged fields: splits_validated, master_rights_holder, publisher_ipi,
 *   publisher_name, existing_registration_id, territory, society_mandate.
 * @param {string} destination - One of DESTINATIONS.
 * @returns {object} Decision object matching the gate contract.
 */
function evaluateReadiness(track, destination) {
  const writers = getWriters(track);
  const evaluatedAt = new Date().toISOString();
  const trackId = track.id || null;

  if (!DESTINATIONS.includes(destination)) {
    return {
      catalog_track_id: trackId,
      destination,
      decision: 'NOT_APPLICABLE',
      evaluated_at: evaluatedAt,
      ruleset_version: RULESET_VERSION,
      blockers: [],
      warnings: [],
      evidence_summary: buildEvidenceSummary(track, writers),
      existing_registration: track.existing_registration_id || null,
    };
  }

  // Global blockers apply to all destinations
  const globalBlockers = [];
  if (hasUnresolvedEnrichmentError(track)) {
    globalBlockers.push(mkBlocker('ENRICHMENT_ERROR',
      `Unresolved enrichment error: ${track.enrichment_error}`));
  }
  if (track.requires_amendment) {
    globalBlockers.push(mkBlocker('EXISTING_REGISTRATION_AMENDMENT',
      'Existing registration found that requires amendment — not treated as a new registration.'));
  }

  let result;
  switch (destination) {
    case 'ASCAP':
      result = evaluateASCAP(track, writers, globalBlockers);
      break;
    case 'BMI':
      result = evaluateBMI(track, writers, globalBlockers);
      break;
    case 'MLC':
      result = evaluateMLC(track, writers, globalBlockers);
      break;
    case 'SOUNDEXCHANGE':
      result = evaluateSoundExchange(track);
      // Global blockers still apply to SoundExchange
      result.items = [...globalBlockers, ...result.items];
      break;
    case 'NEIGHBORING_RIGHTS':
      result = evaluateNeighboringRights(track);
      result.items = [...globalBlockers, ...result.items];
      break;
  }

  const blockers = result.items;
  const warnings = result.warnings || [];
  const decision = computeDecision(blockers, warnings);

  return {
    catalog_track_id: trackId,
    destination,
    decision,
    evaluated_at: evaluatedAt,
    ruleset_version: RULESET_VERSION,
    blockers,
    warnings,
    evidence_summary: buildEvidenceSummary(track, writers),
    existing_registration: track.existing_registration_id || null,
  };
}

/**
 * Evaluate readiness for all destinations for a single track.
 * Returns an array of 5 decision objects.
 */
function evaluateAllDestinations(track) {
  return DESTINATIONS.map(dest => evaluateReadiness(track, dest));
}

module.exports = {
  evaluateReadiness,
  evaluateAllDestinations,
  DESTINATIONS,
  RULESET_VERSION,
  BLOCKER_META,
};
