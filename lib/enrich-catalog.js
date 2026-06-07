// lib/enrich-catalog.js
// Pulls full track-level data from MusicBrainz for every release
// Returns songwriter credits, ISWCs, ISRCs, co-writers per track
//
// NOTE: This runs inside api/run-enrichment-job.js (background worker, 300s budget).
// Do NOT call from a synchronous Vercel function.

const MB_BASE = 'https://musicbrainz.org/ws/2';
const UA      = 'MusiGod-CatalogEnricher/1.0 +https://musigod.com';

// MB rate limit: 1 req/sec for authenticated, ~1 req/sec unauthenticated
// We use 1100ms to stay safe and avoid 503s
const RATE_LIMIT_MS   = 1100;
const RETRY_SLEEP_MS  = 10000; // on 503, wait 10s
const MAX_RETRIES     = 3;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mbGet(path) {
  const url = `${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    await sleep(RATE_LIMIT_MS);

    let res;
    try {
      res = await fetch(url, { headers: { 'User-Agent': UA } });
    } catch (err) {
      if (attempt === MAX_RETRIES) throw new Error(`MB network error: ${err.message}`);
      await sleep(RETRY_SLEEP_MS);
      continue;
    }

    if (res.status === 503 || res.status === 429) {
      console.warn(`[MB] ${res.status} on attempt ${attempt}: ${path}`);
      if (attempt === MAX_RETRIES) throw new Error(`MusicBrainz rate limit: ${path}`);
      await sleep(RETRY_SLEEP_MS * attempt);
      continue;
    }

    if (!res.ok) throw new Error(`MusicBrainz ${res.status}: ${path}`);
    return res.json();
  }
}

// Find artist MBID by name
async function findArtistMBID(artistName) {
  const data = await mbGet(`/artist/?query=artist:"${encodeURIComponent(artistName)}"&limit=5`);
  const artists = data.artists || [];
  if (!artists.length) return null;
  const exact = artists.find(a => a.name.toLowerCase() === artistName.toLowerCase());
  return (exact || artists[0]).id;
}

// Get all release groups for artist
async function getReleaseGroups(artistMBID) {
  const groups = [];
  let offset = 0;
  const limit = 100;
  let total = 999;

  while (offset < total) {
    const data = await mbGet(
      `/release-group?artist=${artistMBID}&limit=${limit}&offset=${offset}`
    );
    total = data['release-group-count'] || 0;
    const batch = data['release-groups'] || [];
    groups.push(...batch);
    offset += limit;
    if (batch.length < limit) break;
  }
  return groups;
}

// Get first release ID for a release group
async function getFirstReleaseId(releaseGroupMBID) {
  const data = await mbGet(`/release?release-group=${releaseGroupMBID}&limit=1`);
  const releases = data.releases || [];
  return releases.length ? releases[0].id : null;
}

// Get recordings for a release (shallow — just track list + recording IDs)
async function getReleaseRecordings(releaseMBID) {
  const data = await mbGet(
    `/release/${releaseMBID}?inc=recordings+artist-credits`
  );
  return data.media || [];
}

// Get recording details: ISRCs + work relationships
async function getRecordingDetails(recordingMBID) {
  const data = await mbGet(
    `/recording/${recordingMBID}?inc=isrcs+work-rels+artist-credits`
  );
  return data;
}

// Get work details: ISWC + writer relationships
async function getWorkDetails(workMBID) {
  const data = await mbGet(
    `/work/${workMBID}?inc=artist-rels+aliases`
  );
  return data;
}

// Main enrichment function
async function enrichArtistCatalog(artistName, options = {}) {
  const { maxReleases = 50, onProgress = null } = options;

  console.log(`[enrich] Starting catalog enrichment for: ${artistName}`);

  // 1. Find artist
  const mbid = await findArtistMBID(artistName);
  if (!mbid) throw new Error(`Artist "${artistName}" not found in MusicBrainz`);
  console.log(`[enrich] Found MBID: ${mbid}`);

  // 2. Get release groups
  const releaseGroups = await getReleaseGroups(mbid);
  console.log(`[enrich] Found ${releaseGroups.length} release groups`);

  const enrichedTracks = [];
  const processed = releaseGroups.slice(0, maxReleases);

  for (let i = 0; i < processed.length; i++) {
    const rg = processed[i];
    if (onProgress) {
      await onProgress({ step: 'release', current: i + 1, total: processed.length, title: rg.title });
    }

    const releaseId = await getFirstReleaseId(rg.id);
    if (!releaseId) continue;

    let media;
    try {
      media = await getReleaseRecordings(releaseId);
    } catch (e) {
      console.warn(`[enrich] Failed to get recordings for "${rg.title}": ${e.message}`);
      continue;
    }

    for (const medium of media) {
      const tracks = medium.tracks || [];

      for (const track of tracks) {
        const recording = track.recording || {};

        const trackData = {
          releaseTitle:      rg.title,
          releaseYear:       (rg['first-release-date'] || '').substring(0, 4) || null,
          releaseType:       rg['primary-type'] || 'Unknown',
          releaseMBID:       releaseId,
          releaseGroupMBID:  rg.id,
          trackNumber:       track.number || null,
          trackTitle:        track.title || recording.title || null,
          trackDuration:     recording.length ? Math.round(recording.length / 1000) : null,
          recordingMBID:     recording.id || null,
          isrcs:             [],
          iswc:              null,
          writers:           [],
          publishers:        [],
          artistCredits:     (recording['artist-credit'] || [])
                               .map(ac => typeof ac === 'string' ? ac : ac.artist?.name)
                               .filter(Boolean),
          enriched:          false,
          enrichmentError:   null,
        };

        // Deep enrich every track — no index gate (we have 300s budget in background worker)
        if (!recording.id) {
          trackData.enrichmentError = 'No recording MBID';
          enrichedTracks.push(trackData);
          continue;
        }

        try {
          const recDetail = await getRecordingDetails(recording.id);
          trackData.isrcs = recDetail.isrcs || [];

          const workRels = (recDetail.relations || []).filter(r => r['target-type'] === 'work');

          if (!workRels.length) {
            // Recording has no linked work — still mark what we got
            trackData.enrichmentError = 'No work linked in MusicBrainz';
            enrichedTracks.push(trackData);
            continue;
          }

          // Use the first work (most recordings have exactly one)
          for (const wr of workRels.slice(0, 2)) {
            if (!wr.work?.id) continue;

            try {
              const work = await getWorkDetails(wr.work.id);

              // MB returns iswcs as an array (e.g. ["T-123.456.789-0"])
              const iswcList = work.iswcs || [];
              trackData.iswc = trackData.iswc || iswcList[0] || null;

              // Writer relations — MB uses these types for composer/lyricist credits
              const writerRels = (work.relations || []).filter(r =>
                r['target-type'] === 'artist' &&
                ['composer', 'lyricist', 'writer', 'music', 'lyrics',
                 'composer-lyricist', 'arranger', 'orchestrator'].includes(r.type)
              );

              for (const wRel of writerRels) {
                if (wRel.artist) {
                  // Avoid duplicate writers across multiple works
                  const alreadyAdded = trackData.writers.some(w => w.mbid === wRel.artist.id);
                  if (!alreadyAdded) {
                    trackData.writers.push({
                      name: wRel.artist.name,
                      mbid: wRel.artist.id,
                      role: wRel.type,
                      ipi:  null,
                    });
                  }
                }
              }
            } catch (workErr) {
              console.warn(`[enrich] Work fetch failed for ${wr.work.id}: ${workErr.message}`);
            }
          }

          // Mark enriched if we got at least one writer OR an ISWC
          trackData.enriched = trackData.writers.length > 0 || !!trackData.iswc;

          if (!trackData.enriched) {
            trackData.enrichmentError = 'Work found but no writer credits in MusicBrainz';
          }

        } catch (recErr) {
          console.warn(`[enrich] Recording fetch failed for ${recording.id}: ${recErr.message}`);
          trackData.enrichmentError = recErr.message;
        }

        enrichedTracks.push(trackData);
      }
    }
  }

  console.log(`[enrich] Enriched ${enrichedTracks.length} tracks across ${processed.length} releases`);

  return {
    artistName,
    mbid,
    totalReleases:     releaseGroups.length,
    processedReleases: processed.length,
    totalTracks:       enrichedTracks.length,
    enrichedTracks,
    generatedAt:       new Date().toISOString(),
  };
}

module.exports = { enrichArtistCatalog, findArtistMBID };
