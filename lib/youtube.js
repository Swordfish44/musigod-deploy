// lib/youtube.js
// YouTube Data API v3 — free, 10,000 units/day quota
// Get key: https://console.cloud.google.com → YouTube Data API v3
// Docs: https://developers.google.com/youtube/v3

const YT_API_KEY = process.env.YOUTUBE_API_KEY;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

async function ytGet(path) {
  const res = await fetch(`${YT_BASE}${path}&key=${YT_API_KEY}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}: ${path}`);
  return res.json();
}

// Search for artist channel
async function findChannel(artistName) {
  const data = await ytGet(`/search?part=snippet&q=${encodeURIComponent(artistName)}&type=channel&maxResults=5`);
  const items = data.items || [];
  // Find official channel — prefer VEVO or exact name match
  const vevo = items.find(i => i.snippet.channelTitle.toLowerCase().includes('vevo'));
  const exact = items.find(i => i.snippet.channelTitle.toLowerCase().includes(artistName.toLowerCase()));
  return vevo || exact || items[0] || null;
}

// Get videos for a channel
async function getChannelVideos(channelId, maxResults = 50) {
  const data = await ytGet(`/search?part=snippet&channelId=${channelId}&type=video&maxResults=${maxResults}&order=viewCount`);
  return data.items || [];
}

// Get video statistics (views, likes)
async function getVideoStats(videoIds) {
  const ids = videoIds.join(',');
  const data = await ytGet(`/videos?part=statistics,contentDetails,snippet&id=${ids}`);
  return data.items || [];
}

// Check if videos have Content ID claims (indirect — we check monetization signals)
// Note: actual Content ID status requires YouTube Partner access
// We infer from: official channel presence, view count vs engagement ratios
function assessContentIDRisk(videos) {
  const highViewUnclaimed = videos.filter(v => {
    const views = parseInt(v.statistics?.viewCount || 0);
    const likes = parseInt(v.statistics?.likeCount || 0);
    // High views, no monetization signals = likely unclaimed
    return views > 10000;
  });
  return highViewUnclaimed;
}

async function scanYouTube(artistName) {
  if (!YT_API_KEY) {
    return {
      found: null,
      error: 'YouTube API key not configured',
      artistName,
      manualUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(artistName)}`,
      gaps: [{
        type: 'youtube_api_needed',
        severity: 'medium',
        message: 'Add YOUTUBE_API_KEY to env to enable automated YouTube scan',
        estimatedImpact: 0
      }]
    };
  }

  try {
    // Search for videos directly (catches fan uploads too)
    const searchData = await ytGet(
      `/search?part=snippet&q=${encodeURIComponent(artistName)}&type=video&maxResults=50&order=viewCount`
    );
    const videos = searchData.items || [];
    const videoIds = videos.map(v => v.id?.videoId).filter(Boolean);

    let stats = [];
    if (videoIds.length > 0) {
      stats = await getVideoStats(videoIds.slice(0, 50));
    }

    // Find official channel
    const channel = await findChannel(artistName);

    // Assess gaps
    const gaps = [];
    const totalViews = stats.reduce((s, v) => s + parseInt(v.statistics?.viewCount || 0), 0);

    if (!channel) {
      gaps.push({
        type: 'no_official_channel',
        severity: 'high',
        message: `No official YouTube channel found for "${artistName}" — all video revenue going to fan/unofficial uploaders`,
        estimatedImpact: Math.round(totalViews * 0.002) // rough $2 RPM on unclaimed views
      });
    }

    // Videos with very high views likely have unclaimed Content ID
    const highViewVideos = stats.filter(v => parseInt(v.statistics?.viewCount || 0) > 50000);
    if (highViewVideos.length > 0) {
      const highViewCount = highViewVideos.reduce((s, v) => s + parseInt(v.statistics?.viewCount || 0), 0);
      gaps.push({
        type: 'high_view_unclaimed',
        severity: 'high',
        message: `${highViewVideos.length} videos with 50K+ views each — Content ID status unknown, potential unclaimed ad revenue`,
        videos: highViewVideos.slice(0, 5).map(v => ({
          title: v.snippet?.title,
          views: parseInt(v.statistics?.viewCount || 0).toLocaleString(),
          url: `https://youtube.com/watch?v=${v.id}`
        })),
        estimatedImpact: Math.round(highViewCount * 0.001)
      });
    }

    return {
      found: videos.length > 0,
      artistName,
      officialChannel: channel ? {
        id: channel.id?.channelId,
        name: channel.snippet?.channelTitle,
        url: `https://youtube.com/channel/${channel.id?.channelId}`
      } : null,
      totalVideosFound: videos.length,
      totalViewsFound: totalViews,
      topVideos: stats.slice(0, 10).map(v => ({
        title: v.snippet?.title,
        views: parseInt(v.statistics?.viewCount || 0).toLocaleString(),
        url: `https://youtube.com/watch?v=${v.id}`
      })),
      manualUrl: `https://www.youtube.com/results?search_query=${encodeURIComponent(artistName)}`,
      gaps,
      totalEstimatedImpact: gaps.reduce((s, g) => s + g.estimatedImpact, 0)
    };
  } catch (err) {
    return { found: null, error: err.message, artistName, gaps: [] };
  }
}

module.exports = { scanYouTube };
