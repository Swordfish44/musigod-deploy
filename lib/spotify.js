// lib/spotify.js
// Spotify Web API — requires client credentials (free)
// Get keys: https://developer.spotify.com/dashboard
// Docs: https://developer.spotify.com/documentation/web-api

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID;
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET;

let _token = null;
let _tokenExpiry = 0;

async function getToken() {
  if (_token && Date.now() < _tokenExpiry) return _token;
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Authorization': 'Basic ' + Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64')
    },
    body: 'grant_type=client_credentials'
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`Spotify auth failed: ${data.error_description}`);
  _token = data.access_token;
  _tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return _token;
}

async function spotifyGet(path) {
  const token = await getToken();
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) throw new Error(`Spotify ${res.status}: ${path}`);
  return res.json();
}

// Search for artist
async function findArtist(name) {
  const data = await spotifyGet(`/search?q=${encodeURIComponent(name)}&type=artist&limit=5`);
  const artists = data.artists?.items || [];
  if (!artists.length) return null;
  const exact = artists.find(a => a.name.toLowerCase() === name.toLowerCase());
  return exact || artists[0];
}

// Get all albums for an artist
async function getArtistAlbums(artistId) {
  const albums = [];
  let url = `/artists/${artistId}/albums?include_groups=album,single,compilation&market=US&limit=50`;
  while (url) {
    const data = await spotifyGet(url);
    (data.items || []).forEach(a => albums.push(a));
    // Pagination
    if (data.next) {
      url = data.next.replace('https://api.spotify.com/v1', '');
    } else {
      url = null;
    }
  }
  return albums;
}

// Get tracks for an album (to check ISRC)
async function getAlbumTracks(albumId) {
  const data = await spotifyGet(`/albums/${albumId}/tracks?limit=50`);
  return data.items || [];
}

// Get full track objects with ISRC
async function getTracksWithISRC(trackIds) {
  const chunks = [];
  for (let i = 0; i < trackIds.length; i += 50) chunks.push(trackIds.slice(i, i + 50));
  const tracks = [];
  for (const chunk of chunks) {
    const data = await spotifyGet(`/tracks?ids=${chunk.join(',')}&market=US`);
    (data.tracks || []).forEach(t => tracks.push(t));
  }
  return tracks;
}

async function scanSpotify(artistName) {
  if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
    return { found: false, error: 'Spotify credentials not configured', artistName, gaps: [] };
  }

  try {
    const artist = await findArtist(artistName);
    if (!artist) return { found: false, artistName, albums: [], gaps: [] };

    const albums = await getArtistAlbums(artist.id);
    const gaps = [];

    // Check for missing metadata on albums
    const missingArtwork = albums.filter(a => !a.images?.length);
    if (missingArtwork.length > 0) {
      gaps.push({
        type: 'missing_artwork',
        severity: 'low',
        message: `${missingArtwork.length} albums missing artwork on Spotify`,
        releases: missingArtwork.map(a => a.name),
        estimatedImpact: 0
      });
    }

    // Sample ISRC check on first 5 albums
    const missingISRC = [];
    const sampleAlbums = albums.filter(a => a.album_type === 'album').slice(0, 5);
    for (const album of sampleAlbums) {
      const tracks = await getAlbumTracks(album.id);
      const trackIds = tracks.map(t => t.id).filter(Boolean);
      if (trackIds.length) {
        const full = await getTracksWithISRC(trackIds);
        const noISRC = full.filter(t => !t.external_ids?.isrc);
        if (noISRC.length > 0) {
          missingISRC.push({ album: album.name, count: noISRC.length, tracks: noISRC.map(t => t.name) });
        }
      }
    }

    if (missingISRC.length > 0) {
      const totalMissing = missingISRC.reduce((s, a) => s + a.count, 0);
      gaps.push({
        type: 'missing_isrc',
        severity: 'high',
        message: `${totalMissing} tracks missing ISRC codes across ${missingISRC.length} albums (sampled)`,
        details: missingISRC,
        estimatedImpact: totalMissing * 150 // each untracked ISRC = lost royalty routing
      });
    }

    // Catalog depth check — albums with very low follower counts may be unofficial
    const popularityGap = albums.filter(a => a.album_type === 'album');
    if (popularityGap.length < 5 && artist.followers?.total > 50000) {
      gaps.push({
        type: 'catalog_gap',
        severity: 'high',
        message: `Only ${popularityGap.length} albums on Spotify but artist has ${artist.followers.total.toLocaleString()} followers — catalog likely incomplete`,
        estimatedImpact: 5000
      });
    }

    return {
      found: true,
      artistName,
      spotifyId: artist.id,
      spotifyUrl: artist.external_urls?.spotify,
      followers: artist.followers?.total || 0,
      popularity: artist.popularity || 0,
      genres: artist.genres || [],
      totalAlbums: albums.length,
      albums: albums.map(a => ({
        title: a.name,
        year: a.release_date?.substring(0, 4),
        type: a.album_type,
        tracks: a.total_tracks,
        spotifyUrl: a.external_urls?.spotify
      })),
      gaps,
      totalEstimatedImpact: gaps.reduce((s, g) => s + g.estimatedImpact, 0)
    };
  } catch (err) {
    return { found: false, error: err.message, artistName, gaps: [] };
  }
}

module.exports = { scanSpotify };
