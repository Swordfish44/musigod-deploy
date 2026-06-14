// lib/mlc.js
// The MLC has no public API — but their search is a simple fetch-able endpoint
// We scrape their public work search results
// Docs: https://www.themlc.com/search

async function scanMLC(artistName) {
  try {
    const encoded = encodeURIComponent(artistName);

    // MLC uses a Next.js API under the hood — this is their public search endpoint
    const res = await fetch(
      `https://www.themlc.com/api/search/works?query=${encoded}&page=0&size=50`,
      {
        headers: {
          'Accept': 'application/json',
          'User-Agent': 'Mozilla/5.0 (compatible; MusiGod-Scanner/1.0; +https://musigod.com)',
          'Referer': 'https://www.themlc.com/search',
        }
      }
    );

    if (!res.ok) {
      // Fallback: return a structured result noting manual check needed
      return {
        found: null, // null = unknown (not confirmed found OR not found)
        artistName,
        note: 'MLC search requires manual verification',
        manualUrl: `https://www.themlc.com/search?query=${encoded}`,
        gaps: [{
          type: 'mlc_manual_check',
          severity: 'high',
          message: 'MLC database requires manual lookup — unclaimed mechanicals common for pre-2021 catalog',
          estimatedImpact: 0
        }]
      };
    }

    const data = await res.json();
    const works = data.works || data.content || data.results || [];
    const totalWorks = data.totalElements || data.total || works.length;

    const gaps = [];

    if (totalWorks === 0) {
      gaps.push({
        type: 'not_registered_mlc',
        severity: 'critical',
        message: `No works found in MLC database for "${artistName}" — ALL streaming mechanicals since 2021 may be unclaimed`,
        estimatedImpact: 0 // unknown without catalog size
      });
    } else {
      // Check for works with unmatched publisher
      const unmatched = works.filter(w =>
        !w.publishers?.length ||
        w.publishers?.some(p => p.name?.toLowerCase().includes('unknown') || !p.ipi)
      );
      if (unmatched.length > 0) {
        gaps.push({
          type: 'unmatched_publisher',
          severity: 'high',
          message: `${unmatched.length} of ${totalWorks} works have no publisher match — writer share collected but publisher share sitting unclaimed`,
          works: unmatched.slice(0, 10).map(w => w.title),
          estimatedImpact: unmatched.length * 300
        });
      }
    }

    return {
      found: totalWorks > 0,
      artistName,
      totalWorks,
      works: works.slice(0, 20).map(w => ({
        title: w.title || w.workTitle,
        iswc: w.iswc,
        writers: (w.writers || []).map(wr => wr.name || wr.fullName),
        publishers: (w.publishers || []).map(p => p.name),
      })),
      manualUrl: `https://www.themlc.com/search?query=${encoded}`,
      gaps,
      totalEstimatedImpact: gaps.reduce((s, g) => s + g.estimatedImpact, 0)
    };
  } catch (err) {
    return {
      found: null,
      error: err.message,
      artistName,
      manualUrl: `https://www.themlc.com/search?query=${encodeURIComponent(artistName)}`,
      gaps: []
    };
  }
}

module.exports = { scanMLC };
