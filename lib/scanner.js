// lib/scanner.js
// Main orchestrator — runs all sources in parallel, aggregates results

const { scanDiscogs } = require('./discogs');
const { scanSpotify } = require('./spotify');
const { scanMLC } = require('./mlc');
const { scanSoundExchange } = require('./soundexchange');
const { scanYouTube } = require('./youtube');

// Conservative royalty estimation model
// Based on industry averages for independent artists
function estimateRoyalties(results, artistName) {
  const estimates = {
    pro: 0,
    mlc: 0,
    soundexchange: 0,
    youtube: 0,
    streaming: 0,
    neighboring: 0,
  };

  const discogs = results.discogs;
  const spotify = results.spotify;
  const mlc = results.mlc;
  const sx = results.soundexchange;
  const yt = results.youtube;

  // PRO estimate: based on catalog size and active years
  // Average indie artist with pre-2010 catalog: $500-2000/album in uncollected PRO
  if (discogs?.found) {
    const preDigitalAlbums = (discogs.releases || []).filter(
      r => r.year && r.year < 2010 && r.role === 'Main'
    ).length;
    estimates.pro = preDigitalAlbums * 800;
  }

  // MLC estimate: from their own gap analysis
  if (mlc) {
    estimates.mlc = mlc.totalEstimatedImpact || 0;
    if (mlc.found === false && discogs?.mainReleases > 5) {
      // Not registered at all — significant mechanical gap
      estimates.mlc = discogs.mainReleases * 600;
    }
  }

  // SoundExchange
  estimates.soundexchange = sx?.totalEstimatedImpact || 0;
  if (sx?.found === false && discogs?.mainReleases > 3) {
    // Unregistered with long catalog = likely uncollected digital performance
    estimates.soundexchange = discogs.mainReleases * 400;
  }

  // YouTube
  estimates.youtube = yt?.totalEstimatedImpact || 0;

  // Streaming metadata gaps (ISRC missing = unrouted royalties)
  estimates.streaming = spotify?.totalEstimatedImpact || 0;

  // Neighboring rights: rough estimate for artists with international presence
  // If they have 10K+ Spotify followers or significant catalog, flag it
  if (spotify?.followers > 10000 || (discogs?.mainReleases > 5)) {
    estimates.neighboring = Math.round((discogs?.mainReleases || 5) * 350);
  }

  const total = Object.values(estimates).reduce((s, v) => s + v, 0);

  return { estimates, total };
}

async function runFullScan(artistName) {
  const startTime = Date.now();

  // Run all scans in parallel
  const [discogs, spotify, mlc, soundexchange, youtube] = await Promise.allSettled([
    scanDiscogs(artistName),
    scanSpotify(artistName),
    scanMLC(artistName),
    scanSoundExchange(artistName),
    scanYouTube(artistName),
  ]);

  const results = {
    discogs:      discogs.status === 'fulfilled'      ? discogs.value      : { error: discogs.reason?.message, found: null },
    spotify:      spotify.status === 'fulfilled'      ? spotify.value      : { error: spotify.reason?.message, found: null },
    mlc:          mlc.status === 'fulfilled'          ? mlc.value          : { error: mlc.reason?.message, found: null },
    soundexchange:soundexchange.status === 'fulfilled'? soundexchange.value: { error: soundexchange.reason?.message, found: null },
    youtube:      youtube.status === 'fulfilled'      ? youtube.value      : { error: youtube.reason?.message, found: null },
  };

  // Aggregate all gaps
  const allGaps = [
    ...(results.discogs.gaps || []),
    ...(results.spotify.gaps || []),
    ...(results.mlc.gaps || []),
    ...(results.soundexchange.gaps || []),
    ...(results.youtube.gaps || []),
  ].sort((a, b) => {
    const sev = { critical: 0, high: 1, medium: 2, low: 3 };
    return (sev[a.severity] || 3) - (sev[b.severity] || 3);
  });

  const { estimates, total } = estimateRoyalties(results, artistName);

  const scanTime = ((Date.now() - startTime) / 1000).toFixed(1);

  return {
    artistName,
    scanTime: `${scanTime}s`,
    scannedAt: new Date().toISOString(),
    sources: {
      discogs: {
        status: results.discogs.found ? 'found' : results.discogs.found === null ? 'error' : 'not_found',
        totalReleases: results.discogs.totalReleases || 0,
        mainReleases: results.discogs.mainReleases || 0,
        url: results.discogs.discogsUrl || null,
        error: results.discogs.error || null,
      },
      spotify: {
        status: results.spotify.found ? 'found' : results.spotify.found === null ? 'error' : 'not_found',
        followers: results.spotify.followers || 0,
        totalAlbums: results.spotify.totalAlbums || 0,
        url: results.spotify.spotifyUrl || null,
        error: results.spotify.error || null,
      },
      mlc: {
        status: results.mlc.found === true ? 'found' : results.mlc.found === false ? 'not_found' : 'unknown',
        totalWorks: results.mlc.totalWorks || 0,
        url: results.mlc.manualUrl || null,
        error: results.mlc.error || null,
      },
      soundexchange: {
        status: results.soundexchange.found === true ? 'found' : results.soundexchange.found === false ? 'not_found' : 'unknown',
        url: results.soundexchange.manualUrl || null,
        error: results.soundexchange.error || null,
      },
      youtube: {
        status: results.youtube.found ? 'found' : results.youtube.found === null ? 'error' : 'not_found',
        totalVideos: results.youtube.totalVideosFound || 0,
        totalViews: results.youtube.totalViewsFound || 0,
        officialChannel: results.youtube.officialChannel || null,
        url: results.youtube.manualUrl || null,
        error: results.youtube.error || null,
      },
    },
    catalog: {
      releases: results.discogs.releases || [],
      spotifyAlbums: results.spotify.albums || [],
      mlcWorks: results.mlc.works || [],
      youtubeTopVideos: results.youtube.topVideos || [],
    },
    gaps: allGaps,
    estimates,
    totalEstimated: total,
    disclaimer: 'Estimates are conservative approximations based on catalog size and industry averages. Actual amounts require account registration with each royalty body.',
  };
}

module.exports = { runFullScan };
