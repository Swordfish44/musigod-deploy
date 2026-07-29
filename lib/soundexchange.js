// lib/soundexchange.js
//
// Feeds the artist gap-scanner (lib/scanner.js → api/scan-artist.js).
//
// IMPORTANT: this module used to POST to soundexchange.com's internal
// wp-admin/admin-ajax.php endpoint with a spoofed User-Agent/Referer to
// mimic their artist-search widget. That was an undocumented, unofficial
// endpoint — not something SoundExchange has published or approved for
// third-party use — so it has been removed. See
// docs/SOUNDEXCHANGE_API_ACCESS_REQUEST.md for the authorized path forward.
//
// Current behavior:
//   - If the officially-authorized adapter (lib/soundexchange-adapter.js) is
//     enabled and configured, use it for deterministic ISRC/recording
//     matching against SoundExchange's documented Repertoire Search API.
//   - Otherwise (the default — no approved API access yet), do not contact
//     SoundExchange at all. Return a manual-check pointer to their public
//     artist-search page for a human to look up.
//
// Either way, this never surfaces private royalty balances — those require
// SoundExchange account login and stay out of scope (see CSV/XLSX import
// workflow for authorized account-data ingestion).

const { isEnabled, matchByRecording } = require('./soundexchange-adapter');

async function scanSoundExchange(artistName) {
  const encoded = encodeURIComponent(artistName);
  const manualUrl = `https://www.soundexchange.com/artist-search/?query=${encoded}`;

  if (!isEnabled()) {
    return {
      found: null,
      artistName,
      results: [],
      manualUrl,
      gaps: [{
        type: 'soundexchange_manual_check_needed',
        severity: 'high',
        message: `SoundExchange manual check needed for "${artistName}" — no automated API access configured yet (common gap for artists with internet radio/streaming history)`,
        estimatedImpact: 0,
      }],
      totalEstimatedImpact: 0,
      note: 'Automated SoundExchange lookup is disabled until repertoire@soundexchange.com approves API access (see docs/SOUNDEXCHANGE_API_ACCESS_REQUEST.md). Actual dollar amounts always require SoundExchange account login.',
    };
  }

  try {
    const result = await matchByRecording({ artistName, title: artistName });
    const found = result.matched === true;

    const gaps = [];
    if (found) {
      gaps.push({
        type: 'soundexchange_confirmed_registered',
        severity: 'low',
        message: `"${artistName}" confirmed in SoundExchange repertoire via authorized API match`,
        estimatedImpact: 0,
      });
    } else {
      gaps.push({
        type: 'soundexchange_unregistered_or_unconfirmed',
        severity: 'high',
        message: `"${artistName}" not confirmed registered with SoundExchange — Pandora/SiriusXM/iHeart royalties may be uncollected`,
        estimatedImpact: 0,
      });
    }

    return {
      found,
      artistName,
      results: (result.candidates || []).slice(0, 5),
      manualUrl,
      gaps,
      totalEstimatedImpact: 0,
      note: 'Match determined via SoundExchange Repertoire Search API (recording/ISRC matching only). Actual dollar amounts require SoundExchange account login.',
      provenance: result.provenance || null,
    };
  } catch (err) {
    return {
      found: null,
      error: err.message,
      artistName,
      manualUrl,
      gaps: [{
        type: 'soundexchange_check_needed',
        severity: 'high',
        message: 'SoundExchange automated check failed — manual check needed',
        estimatedImpact: 0,
      }],
      totalEstimatedImpact: 0,
    };
  }
}

module.exports = { scanSoundExchange };
