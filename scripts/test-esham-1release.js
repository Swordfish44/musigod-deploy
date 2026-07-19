// scripts/test-esham-1release.js
// Runs enrichment for Esham, 1 release only, and prints writer results.
// Run: node scripts/test-esham-1release.js

// Minimal dotenv shim
const fs = require('fs');
const envPath = require('path').join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
    if (m) process.env[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { enrichArtistCatalog } = require('../lib/enrich-catalog');

(async () => {
  console.log('Starting enrichment for Esham (maxReleases=1)...\n');
  try {
    const result = await enrichArtistCatalog('Esham', { maxReleases: 1 });
    console.log('\n=== RESULTS ===');
    console.log(`Total tracks: ${result.totalTracks}`);
    const withWriters = result.enrichedTracks.filter(t => t.writers.length > 0);
    const withoutWriters = result.enrichedTracks.filter(t => t.writers.length === 0);
    console.log(`Tracks WITH writers: ${withWriters.length}`);
    console.log(`Tracks WITHOUT writers: ${withoutWriters.length}`);

    if (withWriters.length > 0) {
      console.log('\nWriter samples:');
      for (const t of withWriters.slice(0, 3)) {
        console.log(`  "${t.trackTitle}" (source: ${t.enrichmentSource}) → ${t.writers.map(w=>w.name).join(', ')}`);
      }
    }

    if (withoutWriters.length > 0) {
      console.log('\nTracks without writers (first 5):');
      for (const t of withoutWriters.slice(0, 5)) {
        console.log(`  "${t.trackTitle}" — enriched=${t.enriched}, error="${t.enrichmentError || 'none'}", iswc=${t.iswc || 'none'}`);
      }
    }
  } catch (err) {
    console.error('FATAL:', err.message);
  }
})();
