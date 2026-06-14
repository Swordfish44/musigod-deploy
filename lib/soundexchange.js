// lib/soundexchange.js
// SoundExchange has a public artist search at soundexchange.com/artist-search
// We check their unclaimed royalties database

async function scanSoundExchange(artistName) {
  try {
    const encoded = encodeURIComponent(artistName);

    // SoundExchange public unclaimed royalties search
    const res = await fetch(
      `https://www.soundexchange.com/wp-admin/admin-ajax.php`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'Mozilla/5.0 (compatible; MusiGod-Scanner/1.0; +https://musigod.com)',
          'Referer': 'https://www.soundexchange.com/artist-search/',
        },
        body: `action=artist_search&artist_name=${encoded}`
      }
    );

    // SoundExchange doesn't expose raw dollar amounts publicly
    // But we can check if the artist appears in unclaimed list
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = null; }

    const found = data && (data.success || (Array.isArray(data) && data.length > 0));
    const results = Array.isArray(data) ? data : (data?.data || []);

    const gaps = [];

    if (found && results.length > 0) {
      gaps.push({
        type: 'soundexchange_unclaimed',
        severity: 'critical',
        message: `Artist found in SoundExchange unclaimed royalties database — digital performance royalties waiting to be collected`,
        estimatedImpact: 0 // actual amount requires account registration
      });
    } else if (!found) {
      // Not finding them could mean: not registered, or registered and paid out
      gaps.push({
        type: 'soundexchange_unregistered',
        severity: 'high',
        message: `"${artistName}" not confirmed registered with SoundExchange — Pandora/SiriusXM/iHeart royalties may be collecting dust`,
        estimatedImpact: 0
      });
    }

    return {
      found,
      artistName,
      results: results.slice(0, 5),
      manualUrl: `https://www.soundexchange.com/artist-search/?query=${encoded}`,
      gaps,
      totalEstimatedImpact: gaps.reduce((s, g) => s + g.estimatedImpact, 0),
      note: 'Actual dollar amount only visible after SoundExchange account registration'
    };
  } catch (err) {
    return {
      found: null,
      error: err.message,
      artistName,
      manualUrl: `https://www.soundexchange.com/artist-search/?query=${encodeURIComponent(artistName)}`,
      gaps: [{
        type: 'soundexchange_check_needed',
        severity: 'high',
        message: 'SoundExchange manual check needed — common gap for artists with internet radio history',
        estimatedImpact: 0
      }]
    };
  }
}

module.exports = { scanSoundExchange };
