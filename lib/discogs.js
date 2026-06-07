// lib/discogs.js
// Discogs has a real public API — no auth needed for search, token for higher rate limits
// Docs: https://www.discogs.com/developers/

const DISCOGS_TOKEN = process.env.DISCOGS_TOKEN || '';
const BASE = 'https://api.discogs.com';
const UA = 'MusiGod-RoyaltyScanner/1.0 +https://musigod.com';

async function discogsGet(path) {
  const headers = { 'User-Agent': UA, 'Accept': 'application/json' };
  if (DISCOGS_TOKEN) headers['Authorization'] = `Discogs token=${DISCOGS_TOKEN}`;
  const res = await fetch(`${BASE}${path}`, { headers });
  if (!res.ok) throw new Error(`Discogs ${res.status}: ${path}`);
  return res.json();
}

// Find artist by name — returns top match
async function findArtist(name) {
  const data = await discogsGet(`/database/search?q=${encodeURIComponent(name)}&type=artist&per_page=5`);
  const results = data.results || [];
  if (!results.length) return null;
  // Pick best match (exact name match preferred)
  const exact = results.find(r => r.title.toLowerCase() === name.toLowerCase());
  return exact || results[0];
}

// Get artist's full release list
async function getArtistReleases(artistId) {
  const releases = [];
  let page = 1;
  let pages = 1;
  do {
    const data = await discogsGet(`/artists/${artistId}/releases?sort=year&sort_order=asc&per_page=100&page=${page}`);
    pages = data.pagination?.pages || 1;
    (data.releases || []).forEach(r => {
      releases.push({
        title: r.title,
        year: r.year || null,
        type: r.type || 'release',
        role: r.role || 'Main',
        format: r.format || null,
        label: r.label || null,
        catno: r.catno || null,
        resourceUrl: r.resource_url,
        thumb: r.thumb || null,
      });
    });
    page++;
  } while (page <= pages && page <= 5); // cap at 500 releases
  return releases;
}

// Main: scan artist catalog via Discogs
async function scanDiscogs(artistName) {
  try {
    const artist = await findArtist(artistName);
    if (!artist) return { found: false, artistName, releases: [], gaps: [] };

    const releases = await getArtistReleases(artist.id);

    // Identify potential gaps
    const gaps = [];
    const currentYear = new Date().getFullYear();

    // Old releases likely not on streaming
    const preStreamingEra = releases.filter(r => r.year && r.year < 2005 && r.role === 'Main');
    if (preStreamingEra.length > 0) {
      gaps.push({
        type: 'pre_streaming',
        severity: 'high',
        message: `${preStreamingEra.length} releases from before 2005 — likely not on all DSPs`,
        releases: preStreamingEra.map(r => r.title),
        estimatedImpact: preStreamingEra.length * 800 // conservative per-album estimate
      });
    }

    // Releases with no year = metadata gaps
    const noYear = releases.filter(r => !r.year && r.role === 'Main');
    if (noYear.length > 0) {
      gaps.push({
        type: 'missing_metadata',
        severity: 'medium',
        message: `${noYear.length} releases with no year — metadata gaps`,
        releases: noYear.map(r => r.title),
        estimatedImpact: 0
      });
    }

    // Compilation appearances = potential unclaimed mechanicals
    const compAppearances = releases.filter(r => r.role === 'Appearance' || r.type === 'compilation');
    if (compAppearances.length > 0) {
      gaps.push({
        type: 'compilation_appearances',
        severity: 'medium',
        message: `${compAppearances.length} compilation appearances — mechanical royalties may be unclaimed`,
        releases: compAppearances.map(r => r.title).slice(0, 10),
        estimatedImpact: compAppearances.length * 200
      });
    }

    return {
      found: true,
      artistName,
      discogsId: artist.id,
      discogsUrl: `https://www.discogs.com/artist/${artist.id}`,
      totalReleases: releases.length,
      mainReleases: releases.filter(r => r.role === 'Main').length,
      releases,
      gaps,
      totalEstimatedImpact: gaps.reduce((sum, g) => sum + g.estimatedImpact, 0)
    };
  } catch (err) {
    return { found: false, error: err.message, artistName, releases: [], gaps: [] };
  }
}

module.exports = { scanDiscogs };

// ─── CREDIT ENRICHMENT (for catalog enrichment pipeline) ──────────────────

const DISCOGS_RATE_MS = 1100; // 60 req/min unauthenticated, 1 req/sec safe floor
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Search for a specific release by artist + title, return best match release ID
async function findRelease(artistName, releaseTitle) {
  await sleep(DISCOGS_RATE_MS);
  const q = `${artistName} ${releaseTitle}`;
  const data = await discogsGet(`/database/search?q=${encodeURIComponent(q)}&type=release&per_page=5`);
  const results = data.results || [];
  if (!results.length) return null;
  // Prefer exact title match
  const exact = results.find(r =>
    r.title?.toLowerCase().includes(releaseTitle.toLowerCase())
  );
  return (exact || results[0]);
}

// Get full release details including tracklist + extraartists (writer credits)
async function getReleaseCredits(discogsReleaseId) {
  await sleep(DISCOGS_RATE_MS);
  const data = await discogsGet(`/releases/${discogsReleaseId}`);
  
  // extraartists = album-level credits (Written-By, Music By, etc.)
  const albumCredits = (data.extraartists || []).filter(a =>
    ['written-by', 'music by', 'lyrics by', 'words by', 'composed by',
     'written by', 'music', 'lyrics', 'words', 'songwriter']
      .some(role => a.role?.toLowerCase().includes(role))
  );

  // tracklist with per-track extraartists
  const tracks = (data.tracklist || []).map(t => ({
    position: t.position,
    title:    t.title,
    duration: t.duration,
    writers:  (t.extraartists || [])
      .filter(a => ['written-by','music by','lyrics by','words by','composed by',
                    'written by','music','lyrics','words','songwriter']
        .some(role => a.role?.toLowerCase().includes(role)))
      .map(a => ({ name: a.name, role: a.role })),
    // Fall through to album-level credits if track has none
    albumWriters: albumCredits.map(a => ({ name: a.name, role: a.role })),
  }));

  return {
    discogsId:     data.id,
    title:         data.title,
    year:          data.year,
    albumWriters:  albumCredits.map(a => ({ name: a.name, role: a.role })),
    tracks,
  };
}

// Match a track title against Discogs tracklist (fuzzy)
function matchTrack(discogsTracklist, trackTitle) {
  if (!trackTitle) return null;
  const norm = s => s?.toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(trackTitle);
  return discogsTracklist.find(t => norm(t.title) === target) || null;
}

// High-level: given artist + release title + track title, get writer credits
// Returns array of { name, role } or []
async function getTrackWriters(artistName, releaseTitle, trackTitle) {
  try {
    const release = await findRelease(artistName, releaseTitle);
    if (!release) return [];

    const credits = await getReleaseCredits(release.id);
    const track   = matchTrack(credits.tracks, trackTitle);

    if (!track) return credits.albumWriters; // fall back to album-level

    // Prefer track-specific credits; fall back to album-level if empty
    return track.writers.length > 0 ? track.writers : track.albumWriters;
  } catch (err) {
    console.warn(`[discogs] getTrackWriters failed for "${trackTitle}": ${err.message}`);
    return [];
  }
}

module.exports.findRelease      = findRelease;
module.exports.getReleaseCredits = getReleaseCredits;
module.exports.getTrackWriters  = getTrackWriters;
