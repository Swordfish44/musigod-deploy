// lib/genius.js
// Genius API — writer credits fallback for catalog enrichment
// Docs: https://docs.genius.com

const BASE  = 'https://api.genius.com';
const TOKEN = process.env.GENIUS_ACCESS_TOKEN || '';

async function geniusGet(path) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': 'MusiGod-CatalogEnricher/1.0 +https://musigod.com' },
  });
  if (!res.ok) throw new Error(`Genius ${res.status}: ${path}`);
  return res.json();
}

// Normalize for fuzzy title matching
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// Search Genius for a track by artist + title, return song id or null
async function findSong(artistName, trackTitle) {
  const q = `${artistName} ${trackTitle}`;
  const data = await geniusGet(`/search?q=${encodeURIComponent(q)}`);
  const hits = data.response?.hits || [];

  const artistNorm = norm(artistName);
  // Prefer hits where primary artist matches and title matches
  const match = hits.find(h => {
    const r = h.result;
    return norm(r.primary_artist?.name).includes(artistNorm) &&
           norm(r.title).includes(norm(trackTitle));
  }) || hits.find(h => norm(h.result.primary_artist?.name).includes(artistNorm));

  return match?.result?.id || null;
}

// Given a Genius song id, return writer credits
async function getSongWriters(songId) {
  const data = await geniusGet(`/songs/${songId}`);
  const song = data.response?.song || {};

  const writers = (song.writer_artists || []).map(a => ({
    name:   a.name,
    mbid:   null,
    role:   'writer',
    ipi:    null,
    source: 'genius',
  }));

  return writers;
}

// High-level: search + fetch writers in one call. Returns [] if not found.
async function getGeniusWriters(artistName, trackTitle) {
  if (!TOKEN) return [];
  try {
    const songId = await findSong(artistName, trackTitle);
    if (!songId) return [];
    return await getSongWriters(songId);
  } catch (err) {
    console.warn(`[genius] failed for "${trackTitle}": ${err.message}`);
    return [];
  }
}

module.exports = { getGeniusWriters };
