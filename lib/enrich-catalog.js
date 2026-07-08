// lib/enrich-catalog.js
// MusicBrainz catalog enrichment — batched to fit within 300s Vercel budget.
//
// API call budget for 10 releases, ~18 tracks each:
//   1  findArtist
//   2  getReleaseGroups (paginated, usually 1-2 calls)
//  10  getFirstReleaseId (1 per release group)
//  10  getReleaseWithISRCs (replaces per-track recording calls — gets all tracks+ISRCs in one)
// ~180 getWorkDetails (1 per track that has a linked work)
// ─────
// ~203 total MB calls × 500ms = ~102s ✓ well inside 300s
//
// Fallback chain for tracks missing writers: MB → Discogs → Genius

const { findReleases, getReleaseCredits } = require('./discogs');
const { getGeniusWriters } = require('./genius');
const { loadOverrides }    = require('./overrides');

// Cache Discogs tracklists per release title — fetch once, match all tracks locally
const discogsCache = new Map();

async function getDiscogsWritersForTrack(artistName, releaseTitle, trackTitle) {
  const cacheKey = `${artistName}||${releaseTitle}`;

  if (!discogsCache.has(cacheKey)) {
    try {
      const candidates = await findReleases(artistName, releaseTitle);
      console.log(`[discogs] findReleases("${artistName}", "${releaseTitle}") → ${candidates.length} candidates`);
      let bestCredits = null;
      // Try each candidate; stop at the first one with writer credits
      for (const candidate of candidates.slice(0, 5)) {
        const credits = await getReleaseCredits(candidate.id);
        const hasWriters = credits.albumWriters.length > 0 ||
          credits.tracks.some(t => t.writers.length > 0);
        console.log(`[discogs] candidate ${candidate.id} "${candidate.title}" → ${credits.albumWriters.length} album writers, hasWriters=${hasWriters}`);
        if (hasWriters) {
          bestCredits = credits;
          break;
        }
        if (!bestCredits) bestCredits = credits; // keep first as fallback
      }
      discogsCache.set(cacheKey, candidates.length ? bestCredits : null);
    } catch (err) {
      console.warn(`[discogs] FAILED for "${releaseTitle}": ${err.message}`);
      discogsCache.set(cacheKey, null);
    }
  }

  const credits = discogsCache.get(cacheKey);
  if (!credits) return [];

  // Match track locally
  const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const target = norm(trackTitle);
  const track = credits.tracks.find(t => norm(t.title) === target);

  const writers = track
    ? (track.writers.length > 0 ? track.writers : (credits.albumWriters || []))
    : (credits.albumWriters || []);

  if (writers.length > 0) {
    console.log(`[discogs] "${trackTitle}" → writers: ${writers.map(w=>w.name).join(', ')}`);
  }
  return writers;
}

const MB_BASE        = 'https://musicbrainz.org/ws/2';
const UA             = 'MusiGod-CatalogEnricher/1.0 +https://musigod.com';
const RATE_LIMIT_MS  = 500;   // MB is fine with 2 req/sec with proper User-Agent
const RETRY_SLEEP_MS = 8000;
const MAX_RETRIES    = 3;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mbGet(path) {
  const url = `${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(RATE_LIMIT_MS);
    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw new Error(`MB network: ${err.message}`);
      await sleep(RETRY_SLEEP_MS * attempt);
      continue;
    }
    if (res.status === 503 || res.status === 429) {
      console.warn(`[MB] ${res.status} attempt ${attempt}: ${path.slice(0,60)}`);
      if (attempt === MAX_RETRIES) throw new Error(`MB rate limit: ${path.slice(0,60)}`);
      await sleep(RETRY_SLEEP_MS * attempt);
      continue;
    }
    if (!res.ok) throw new Error(`MB ${res.status}: ${path.slice(0,80)}`);
    return res.json();
  }
}

async function findArtistMBID(artistName) {
  const data = await mbGet(`/artist/?query=artist:"${encodeURIComponent(artistName)}"&limit=5`);
  const artists = data.artists || [];
  if (!artists.length) return null;
  const exact = artists.find(a => a.name.toLowerCase() === artistName.toLowerCase());
  return (exact || artists[0]).id;
}

async function getReleaseGroups(artistMBID) {
  const groups = [];
  let offset = 0;
  const limit = 100;
  while (true) {
    const data = await mbGet(`/release-group?artist=${artistMBID}&limit=${limit}&offset=${offset}`);
    const batch = data['release-groups'] || [];
    groups.push(...batch);
    offset += limit;
    if (batch.length < limit) break;
  }
  return groups;
}

async function getFirstReleaseId(releaseGroupMBID) {
  const data = await mbGet(`/release?release-group=${releaseGroupMBID}&limit=1`);
  return data.releases?.[0]?.id || null;
}

// BATCHED: get all tracks + ISRCs for a release in ONE call
// Returns array of { trackNumber, trackTitle, trackDuration, recordingMBID, isrcs, artistCredits }
async function getReleaseTracksWithISRCs(releaseMBID) {
  const data = await mbGet(`/release/${releaseMBID}?inc=recordings+isrcs+artist-credits`);
  const tracks = [];
  for (const medium of data.media || []) {
    for (const t of medium.tracks || []) {
      const rec = t.recording || {};
      tracks.push({
        trackNumber:   t.number || null,
        trackTitle:    t.title || rec.title || null,
        trackDuration: rec.length ? Math.round(rec.length / 1000) : null,
        recordingMBID: rec.id || null,
        isrcs:         rec.isrcs || [],
        artistCredits: (rec['artist-credit'] || [])
          .map(ac => typeof ac === 'string' ? ac : ac.artist?.name)
          .filter(Boolean),
      });
    }
  }
  return tracks;
}

// Get work-rels for a single recording (to find the linked work MBID)
async function getRecordingWorkRels(recordingMBID) {
  const data = await mbGet(`/recording/${recordingMBID}?inc=work-rels`);
  return (data.relations || []).filter(r => r['target-type'] === 'work');
}

async function getWorkDetails(workMBID) {
  const data = await mbGet(`/work/${workMBID}?inc=artist-rels`);
  return data;
}

async function enrichArtistCatalog(artistName, options = {}) {
  const { maxReleases = 50, onProgress = null } = options;

  console.log(`[enrich] Starting: ${artistName}, maxReleases=${maxReleases}`);

  const overrides = await loadOverrides(artistName);
  const mbid = await findArtistMBID(artistName);
  if (!mbid) throw new Error(`Artist "${artistName}" not found in MusicBrainz`);
  console.log(`[enrich] MBID: ${mbid}`);

  const releaseGroups = await getReleaseGroups(mbid);
  console.log(`[enrich] ${releaseGroups.length} release groups`);

  const enrichedTracks = [];
  const toProcess = releaseGroups.slice(0, maxReleases);

  for (let i = 0; i < toProcess.length; i++) {
    const rg = toProcess[i];
    if (onProgress) await onProgress({ current: i + 1, total: toProcess.length, title: rg.title });

    let releaseId;
    try {
      releaseId = await getFirstReleaseId(rg.id);
    } catch (e) {
      console.warn(`[enrich] Failed release ID lookup "${rg.title}": ${e.message}`);
      continue;
    }
    if (!releaseId) { console.warn(`[enrich] No release for "${rg.title}"`); continue; }

    let tracks;
    try {
      // ONE batched call for all tracks + ISRCs on this release
      tracks = await getReleaseTracksWithISRCs(releaseId);
    } catch (e) {
      console.warn(`[enrich] Failed release "${rg.title}": ${e.message}`);
      continue;
    }

    for (const t of tracks) {
      const trackData = {
        releaseTitle:     rg.title,
        releaseYear:      (rg['first-release-date'] || '').slice(0, 4) || null,
        releaseType:      rg['primary-type'] || 'Unknown',
        releaseMBID:      releaseId,
        releaseGroupMBID: rg.id,
        trackNumber:      t.trackNumber,
        trackTitle:       t.trackTitle,
        trackDuration:    t.trackDuration,
        recordingMBID:    t.recordingMBID,
        isrcs:            t.isrcs,
        iswc:             null,
        writers:          [],
        artistCredits:    t.artistCredits,
        enriched:         false,
        enrichmentError:  null,
        enrichmentSource: null,
      };

      // Manual override takes priority over all automated sources
      const manualWriters = overrides.get((t.trackTitle || '').toLowerCase());
      if (manualWriters) {
        trackData.writers = manualWriters;
        trackData.enriched = true;
        trackData.enrichmentSource = 'manual';
        enrichedTracks.push(trackData);
        continue;
      }

      if (!t.recordingMBID) {
        trackData.enrichmentError = 'No recording MBID';
        enrichedTracks.push(trackData);
        continue;
      }

      // Look up work via recording's work-rels
      try {
        const workRels = await getRecordingWorkRels(t.recordingMBID);

        if (!workRels.length) {
          // No MB work — try Discogs then Genius
          const dw = await getDiscogsWritersForTrack(artistName, rg.title, t.trackTitle);
          if (dw.length) {
            trackData.writers = dw.map(w => ({ name: w.name, mbid: null, role: w.role || 'writer', ipi: null, source: 'discogs' }));
            trackData.enriched = true;
            trackData.enrichmentSource = 'discogs';
          } else {
            const gw = await getGeniusWriters(artistName, t.trackTitle);
            if (gw.length) {
              trackData.writers = gw;
              trackData.enriched = true;
              trackData.enrichmentSource = 'genius';
            } else {
              trackData.enrichmentError = 'No work in MB; no credits on Discogs or Genius';
            }
          }
          enrichedTracks.push(trackData);
          continue;
        }

        // Get work details for first linked work
        const workRel = workRels[0];
        if (workRel.work?.id) {
          try {
            const work = await getWorkDetails(workRel.work.id);
            trackData.iswc = (work.iswcs || [])[0] || null;

            // Log ALL artist relations on the work so we can see what MB returns
            const allArtistRels = (work.relations || []).filter(r => r['target-type'] === 'artist');
            if (allArtistRels.length > 0) {
              console.log(`[MB] Work ${workRel.work.id} artist rels:`, allArtistRels.map(r => r.type).join(', '));
            } else {
              console.log(`[MB] Work ${workRel.work.id} has NO artist relations`);
            }

            const writerRels = allArtistRels.filter(r =>
              ['composer','lyricist','writer','music','lyrics',
               'composer-lyricist','arranger','words','written by'].includes(r.type)
            );

            for (const wr of writerRels) {
              if (wr.artist && !trackData.writers.some(w => w.mbid === wr.artist.id)) {
                trackData.writers.push({ name: wr.artist.name, mbid: wr.artist.id, role: wr.type, ipi: null, source: 'musicbrainz' });
              }
            }

            trackData.enriched = trackData.writers.length > 0 || !!trackData.iswc;
            trackData.enrichmentSource = trackData.enriched ? 'musicbrainz' : null;

            // Work exists but no writer credits — try Discogs then Genius.
            // Check writers directly: ISWC alone sets enriched=true but we still need writer names.
            if (trackData.writers.length === 0) {
              const dw = await getDiscogsWritersForTrack(artistName, rg.title, t.trackTitle);
              if (dw.length) {
                trackData.writers = dw.map(w => ({ name: w.name, mbid: null, role: w.role || 'writer', ipi: null, source: 'discogs' }));
                trackData.enriched = true;
                trackData.enrichmentSource = 'discogs';
              } else {
                const gw = await getGeniusWriters(artistName, t.trackTitle);
                if (gw.length) {
                  trackData.writers = gw;
                  trackData.enriched = true;
                  trackData.enrichmentSource = 'genius';
                } else {
                  trackData.enrichmentError = 'Work in MB but no writer credits; not on Discogs or Genius';
                }
              }
            }
          } catch (workErr) {
            console.warn(`[enrich] Work fetch failed ${workRel.work.id}: ${workErr.message}`);
            trackData.enrichmentError = `Work fetch failed: ${workErr.message}`;
          }
        }
      } catch (recErr) {
        console.warn(`[enrich] Recording work-rels failed ${t.recordingMBID}: ${recErr.message}`);
        trackData.enrichmentError = recErr.message;
      }

      enrichedTracks.push(trackData);
    }
  }

  console.log(`[enrich] Complete: ${enrichedTracks.length} tracks, ${enrichedTracks.filter(t=>t.enriched).length} enriched`);

  return {
    artistName, mbid,
    totalReleases:     releaseGroups.length,
    processedReleases: toProcess.length,
    totalTracks:       enrichedTracks.length,
    enrichedTracks,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { enrichArtistCatalog, findArtistMBID };
