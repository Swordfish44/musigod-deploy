// lib/overrides.js
// Load manual writer overrides for an artist from Supabase.
// Called once at the start of enrichment; results cached in a Map for O(1) lookup per track.

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co';
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;

// Returns Map<lowerTrackTitle, [{name, role, source:'manual'}]>
async function loadOverrides(artistName) {
  const map = new Map();
  if (!SB_KEY) return map;

  try {
    const res = await fetch(
      `${SB_URL}/rest/v1/catalog_writer_overrides?artist_name=ilike.${encodeURIComponent(artistName)}&select=track_title,writers`,
      { headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` } }
    );
    if (!res.ok) {
      console.warn(`[overrides] fetch failed ${res.status}`);
      return map;
    }
    const rows = await res.json();
    for (const row of rows) {
      const writers = (row.writers || []).map(w => ({
        name: w.name, mbid: null, role: w.role || 'writer', ipi: null, source: 'manual',
      }));
      if (writers.length) map.set(row.track_title.toLowerCase(), writers);
    }
    if (map.size) console.log(`[overrides] loaded ${map.size} manual override(s) for "${artistName}"`);
  } catch (err) {
    console.warn('[overrides] error:', err.message);
  }
  return map;
}

module.exports = { loadOverrides };
