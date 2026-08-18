'use strict';

const ingestion = require('./enterprise-ingestion');
const RULE_VERSION = 'portfolio-match-v1';
const clean = value => String(value || '').trim();
const text = value => clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const id = value => ingestion.cleanIdentifier(value);
const list = value => Array.isArray(value) ? value : value == null ? [] : [value];

function durationSeconds(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.round(value) : null;
  const raw = clean(value);
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  const parts = raw.split(':').map(Number);
  if (parts.some(Number.isNaN) || parts.length > 3) return null;
  return Math.round(parts.reduce((total, part) => total * 60 + part, 0));
}

function normalizeAsset(source = {}) {
  const sourceValues = JSON.parse(JSON.stringify(source));
  const normalized = {
    asset_type: clean(source.asset_type || source.record_type).toLowerCase(),
    isrc: id(source.isrc), iswc: id(source.iswc), title: text(source.title),
    artist: text(source.artist), release: text(source.release), label: text(source.label),
    writers: list(source.writers || source.writer).map(text).filter(Boolean).sort(),
    duration_seconds: durationSeconds(source.duration_seconds ?? source.duration),
    source_identifiers: list(source.source_identifiers || source.source_identifier).map(id).filter(Boolean).sort(),
  };
  return { source_values: sourceValues, normalized_values: normalized, transformation: { rule_version: RULE_VERSION, operations: ['trim','case_fold','punctuation_fold','identifier_compaction','duration_seconds'] } };
}

function compare(leftInput, rightInput) {
  const left = normalizeAsset(leftInput), right = normalizeAsset(rightInput), a = left.normalized_values, b = right.normalized_values;
  const evidence = [], contradictions = [];
  const add = (field, weight, exact = true) => evidence.push({ field, weight, exact });
  const conflict = field => contradictions.push(field);
  if (a.asset_type && b.asset_type && a.asset_type !== b.asset_type) conflict('asset_type');
  for (const field of ['isrc','iswc']) {
    if (a[field] && b[field]) a[field] === b[field] ? add(field, 100) : conflict(field);
  }
  if (a.source_identifiers.some(value => b.source_identifiers.includes(value))) add('source_identifier', 100);
  if (a.title && a.title === b.title) add('title', 30);
  if (a.artist && a.artist === b.artist) add('artist', 25);
  if (a.release && a.release === b.release) add('release', 10);
  if (a.label && a.label === b.label) add('label', 5);
  if (a.writers.length && a.writers.some(value => b.writers.includes(value))) add('writer', 20);
  if (a.duration_seconds != null && b.duration_seconds != null) {
    const delta = Math.abs(a.duration_seconds - b.duration_seconds);
    if (delta <= 2) add('duration', 10); else if (delta > 10) conflict('duration');
  }
  const exactIdentifier = evidence.some(item => ['isrc','iswc','source_identifier'].includes(item.field));
  const score = Math.min(100, evidence.reduce((sum, item) => sum + item.weight, 0));
  let classification = 'rejected';
  if (!contradictions.length && exactIdentifier) classification = 'exact';
  else if (!contradictions.length && score >= 70 && evidence.length >= 2) classification = 'probable';
  else if (score >= 35 || (exactIdentifier && contradictions.length)) classification = 'ambiguous';
  return { classification, score, evidence, contradictions, rule_version: RULE_VERSION, left, right, merge_allowed: ['exact','probable'].includes(classification) };
}

function rankCandidates(source, candidates = []) {
  const ranked = candidates.map(candidate => ({ candidate, result: compare(source, candidate) })).sort((a,b) => b.result.score - a.result.score);
  if (ranked.length > 1 && ranked[0].result.score === ranked[1].result.score && ranked[0].result.classification !== 'rejected') {
    ranked[0].result = { ...ranked[0].result, classification: 'ambiguous', merge_allowed: false, ambiguity_reason: 'top candidates have equal deterministic scores' };
  }
  return ranked;
}

module.exports = { RULE_VERSION, durationSeconds, normalizeAsset, compare, rankCandidates };
