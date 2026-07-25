'use strict';

function normalizeTitle(value) {
  return String(value || '').toLowerCase().trim();
}

function validSplitWriters(writers) {
  if (!Array.isArray(writers) || writers.length === 0) return false;
  if (writers.some(w => !w || !String(w.name || '').trim())) return false;
  const total = writers.reduce((sum, w) => sum + Number(w.split_pct || 0), 0);
  return Math.abs(total - 100) <= 0.1;
}

function buildValidatedSplitsMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.validated !== true || !validSplitWriters(row.writers)) continue;
    const key = normalizeTitle(row.track_title);
    if (!key || map.has(key)) continue;
    map.set(key, row);
  }
  return map;
}

function mergeValidatedSplitEvidence(track, splitsMap) {
  const row = splitsMap.get(normalizeTitle(track?.track_title));
  if (!row) return { ...track, splits_validated: false };

  const enrichedWriters = Array.isArray(track.writers) ? track.writers : [];
  const enrichedByName = new Map(
    enrichedWriters.map(w => [String(w?.name || '').toLowerCase().trim(), w])
  );

  const writers = row.writers.map(splitWriter => {
    const prior = enrichedByName.get(String(splitWriter.name || '').toLowerCase().trim()) || {};
    return {
      ...prior,
      name: splitWriter.name,
      role: splitWriter.role || prior.role || 'writer',
      ipi: splitWriter.ipi || prior.ipi || null,
      split_pct: Number(splitWriter.split_pct),
      source: 'validated_split',
    };
  });

  return {
    ...track,
    writers,
    splits_validated: true,
  };
}

module.exports = {
  normalizeTitle,
  validSplitWriters,
  buildValidatedSplitsMap,
  mergeValidatedSplitEvidence,
};
