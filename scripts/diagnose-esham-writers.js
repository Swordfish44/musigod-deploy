// scripts/diagnose-esham-writers.js
// Probe MB for a few Esham recordings to find exactly where writers=0 comes from.
// Run: node scripts/diagnose-esham-writers.js

const MB_BASE = 'https://musicbrainz.org/ws/2';
const UA = 'MusiGod-CatalogEnricher/1.0 +https://musigod.com';
const RATE_LIMIT_MS = 500;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mbGet(path) {
  await sleep(RATE_LIMIT_MS);
  const url = `${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`MB ${res.status}: ${path.slice(0, 80)}`);
  return res.json();
}

async function main() {
  const ESHAM_MBID = '25bac939-a1ad-406f-9e00-584afd47dbfe';

  // Step 1: Get one release group
  console.log('\n=== STEP 1: Release groups ===');
  const rgData = await mbGet(`/release-group?artist=${ESHAM_MBID}&limit=3`);
  const rg = rgData['release-groups'][0];
  console.log(`Release group: "${rg.title}" (${rg.id})`);

  // Step 2: Get first release in that group
  console.log('\n=== STEP 2: First release ===');
  const relData = await mbGet(`/release?release-group=${rg.id}&limit=1`);
  const release = relData.releases?.[0];
  if (!release) { console.log('No release found'); return; }
  console.log(`Release: "${release.title}" (${release.id})`);

  // Step 3: Get tracks+ISRCs for that release
  console.log('\n=== STEP 3: Tracks with ISRCs ===');
  const trackData = await mbGet(`/release/${release.id}?inc=recordings+isrcs+artist-credits`);
  const tracks = [];
  for (const medium of trackData.media || []) {
    for (const t of medium.tracks || []) {
      const rec = t.recording || {};
      tracks.push({
        trackTitle: t.title || rec.title,
        recordingMBID: rec.id || null,
        isrcs: rec.isrcs || [],
      });
    }
  }
  console.log(`Tracks found: ${tracks.length}`);
  const withMBID = tracks.filter(t => t.recordingMBID);
  const withoutMBID = tracks.filter(t => !t.recordingMBID);
  console.log(`  With recordingMBID: ${withMBID.length}`);
  console.log(`  Without recordingMBID: ${withoutMBID.length}`);
  if (withoutMBID.length) {
    console.log('  Tracks missing recordingMBID:', withoutMBID.map(t => t.trackTitle));
  }

  // Step 4: For first 3 tracks with MBIDs, get work-rels
  console.log('\n=== STEP 4: Work-rels for first 3 recordings ===');
  const sample = withMBID.slice(0, 3);
  for (const track of sample) {
    console.log(`\n-- Track: "${track.trackTitle}" (${track.recordingMBID})`);
    const recData = await mbGet(`/recording/${track.recordingMBID}?inc=work-rels`);
    const allRels = recData.relations || [];
    const workRels = allRels.filter(r => r['target-type'] === 'work');
    console.log(`  Total relations: ${allRels.length}`);
    console.log(`  Work relations: ${workRels.length}`);

    if (workRels.length === 0) {
      console.log('  → NO WORK LINKED — Discogs fallback should trigger');
    } else {
      for (const wr of workRels) {
        console.log(`  Work: "${wr.work?.title}" (id=${wr.work?.id || 'MISSING ID'})`);
        const hasId = !!wr.work?.id;
        console.log(`  work.id present: ${hasId}`);

        if (hasId) {
          // Step 5: Get work details
          console.log('\n=== STEP 5: Work details for artist-rels ===');
          const workData = await mbGet(`/work/${wr.work.id}?inc=artist-rels`);
          const artistRels = (workData.relations || []).filter(r => r['target-type'] === 'artist');
          console.log(`  Artist relations on work: ${artistRels.length}`);
          if (artistRels.length > 0) {
            console.log('  ALL relation types:', artistRels.map(r => `"${r.type}"`).join(', '));
            const WRITER_TYPES = ['composer','lyricist','writer','music','lyrics',
              'composer-lyricist','arranger','words','written by'];
            const writerRels = artistRels.filter(r => WRITER_TYPES.includes(r.type));
            console.log(`  Writer-type matches (filter): ${writerRels.length}`);
            if (writerRels.length === 0 && artistRels.length > 0) {
              console.log('  ⚠ FILTER MISMATCH — types in MB not in our allowlist:',
                artistRels.map(r => r.type).filter(t => !WRITER_TYPES.includes(t)));
            }
          }
          console.log(`  ISWCs: ${(workData.iswcs || []).join(', ') || 'none'}`);
        } else {
          console.log('  ⚠ work.id is null/undefined — inner try block SKIPPED, no Discogs fallback!');
        }
      }
    }
  }

  // Step 6: Verify Discogs env token presence
  console.log('\n=== STEP 6: Env check ===');
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  console.log(`DISCOGS_TOKEN set: ${!!process.env.DISCOGS_TOKEN}`);
  console.log(`DISCOGS_TOKEN length: ${(process.env.DISCOGS_TOKEN || '').length}`);
}

main().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
