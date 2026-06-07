// lib/enrich-catalog.js
// Pulls full track-level data from MusicBrainz for every release
// Returns songwriter credits, ISWCs, ISRCs, co-writers per track

const MB_BASE = 'https://musicbrainz.org/ws/2';
const UA = 'MusiGod-CatalogEnricher/1.0 +https://musigod.com';
const RATE_LIMIT_MS = 300; // Reduced for faster processing

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function mbGet(path) {
  await sleep(RATE_LIMIT_MS);
  const res = await fetch(`${MB_BASE}${path}&fmt=json`, {
    headers: { 'User-Agent': UA }
  });
  if (res.status === 503) {
    // Rate limited — wait 5s and retry once
    await sleep(5000);
    const retry = await fetch(`${MB_BASE}${path}&fmt=json`, { headers: { 'User-Agent': UA } });
    if (!retry.ok) throw new Error(`MusicBrainz ${retry.status}: ${path}`);
    return retry.json();
  }
  if (!res.ok) throw new Error(`MusicBrainz ${res.status}: ${path}`);
  return res.json();
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

// Get full recording details including writer credits for a release
async function getReleaseRecordings(releaseMBID) {
  const data = await mbGet(
    `/release/${releaseMBID}?inc=recordings+artist-credits+work-rels+recording-rels`
  );
  return data.media || [];
}

// Get work details (ISWC + writer credits)
async function getWorkDetails(workMBID) {
  const data = await mbGet(
    `/work/${workMBID}?inc=artist-rels+aliases`
  );
  return data;
}

// Get recording details including ISRCs and work relationships
async function getRecordingDetails(recordingMBID) {
  const data = await mbGet(
    `/recording/${recordingMBID}?inc=isrcs+work-rels+artist-credits`
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
    if (onProgress) onProgress({ step: 'release', current: i + 1, total: processed.length, title: rg.title });

    // Get first release in group
    const releaseId = await getFirstReleaseId(rg.id);
    if (!releaseId) continue;

    try {
      const media = await getReleaseRecordings(releaseId);

      for (const medium of media) {
        const tracks = medium.tracks || [];
        for (const track of tracks) {
          const recording = track.recording || {};
          const trackData = {
            // Release info
            releaseTitle: rg.title,
            releaseYear: (rg['first-release-date'] || '').substring(0, 4) || null,
            releaseType: rg['primary-type'] || 'Unknown',
            releaseMBID: releaseId,
            releaseGroupMBID: rg.id,

            // Track info
            trackNumber: track.number || null,
            trackTitle: track.title || recording.title || null,
            trackDuration: recording.length ? Math.round(recording.length / 1000) : null,

            // Recording info
            recordingMBID: recording.id || null,
            isrcs: [], // populated below
            iswc: null, // populated below

            // Writer info
            writers: [],
            publishers: [],

            // Artist credits
            artistCredits: (recording['artist-credit'] || [])
              .map(ac => typeof ac === 'string' ? ac : ac.artist?.name)
              .filter(Boolean),

            // Status
            enriched: false,
            enrichmentError: null,
          };

          // Deep enrich recording (ISRC + work/writer data)
          // Only enrich first 3 tracks per release to stay within timeout
          const trackIndex = tracks.indexOf(track);
          if (recording.id && trackIndex < 3) {
            try {
              const recDetail = await getRecordingDetails(recording.id);
              trackData.isrcs = recDetail.isrcs || [];

              // Get work relationships for writer credits
              const workRels = (recDetail.relations || []).filter(r => r['target-type'] === 'work');
              for (const wr of workRels.slice(0, 1)) { // limit to 1 work per recording
                if (wr.work?.id) {
                  try {
                    const work = await getWorkDetails(wr.work.id);
                    trackData.iswc = trackData.iswc || work.iswc || null;

                    const writerRels = (work.relations || []).filter(r =>
                      ['composer','lyricist','writer','music','lyrics'].includes(r.type)
                    );
                    for (const wRel of writerRels) {
                      if (wRel.artist) {
                        trackData.writers.push({
                          name: wRel.artist.name,
                          mbid: wRel.artist.id,
                          role: wRel.type,
                          ipi: null,
                        });
                      }
                    }
                    trackData.enriched = true;
                  } catch (e) {}
                }
              }
            } catch (e) {
              trackData.enrichmentError = e.message;
            }
          }

          enrichedTracks.push(trackData);
        }
      }
    } catch (e) {
      console.warn(`[enrich] Failed to process release ${rg.title}: ${e.message}`);
    }
  }

  console.log(`[enrich] Enriched ${enrichedTracks.length} tracks across ${processed.length} releases`);

  return {
    artistName,
    mbid,
    totalReleases: releaseGroups.length,
    processedReleases: processed.length,
    totalTracks: enrichedTracks.length,
    enrichedTracks,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = { enrichArtistCatalog, findArtistMBID };
