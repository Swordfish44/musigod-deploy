// Quick diagnostic: hit MB for Esham and log ALL work relation types
// Run: node scripts/probe-esham-mb.js

const MB_BASE = 'https://musicbrainz.org/ws/2';
const UA = 'MusiGod-CatalogEnricher/1.0 +https://musigod.com';
const RATE_MS = 1100;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function mbGet(path) {
  await sleep(RATE_MS);
  const url = `${MB_BASE}${path}${path.includes('?') ? '&' : '?'}fmt=json`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`MB ${res.status}: ${path}`);
  return res.json();
}

async function main() {
  // 1. Find Esham
  const search = await mbGet(`/artist/?query=artist:"Esham"&limit=5`);
  const artist = search.artists?.find(a => a.name.toLowerCase() === 'esham') || search.artists?.[0];
  if (!artist) { console.error('Artist not found'); return; }
  console.log(`Artist: ${artist.name} (${artist.id})`);

  // 2. Get first release group
  const rgs = await mbGet(`/release-group?artist=${artist.id}&limit=5&offset=0`);
  const rg = rgs['release-groups']?.[0];
  if (!rg) { console.error('No release groups'); return; }
  console.log(`Release group: "${rg.title}" (${rg.id})`);

  // 3. Get first release
  const releases = await mbGet(`/release?release-group=${rg.id}&limit=1`);
  const release = releases.releases?.[0];
  if (!release) { console.error('No release'); return; }
  console.log(`Release: ${release.id}`);

  // 4. Get tracks
  const releaseData = await mbGet(`/release/${release.id}?inc=recordings+isrcs+artist-credits`);
  const tracks = releaseData.media?.[0]?.tracks || [];
  console.log(`Tracks: ${tracks.length}`);

  // 5. For first 3 tracks, get recording work-rels then work artist-rels
  for (const t of tracks.slice(0, 3)) {
    const rec = t.recording || {};
    if (!rec.id) continue;
    console.log(`\n--- Track: "${t.title || rec.title}" (rec ${rec.id}) ---`);

    const recData = await mbGet(`/recording/${rec.id}?inc=work-rels`);
    const workRels = (recData.relations || []).filter(r => r['target-type'] === 'work');
    console.log(`  work-rels: ${workRels.length}`);

    for (const wr of workRels.slice(0, 2)) {
      const workId = wr.work?.id;
      if (!workId) continue;
      console.log(`  work: ${workId} (rel type: "${wr.type}")`);

      const work = await mbGet(`/work/${workId}?inc=artist-rels`);
      const artistRels = (work.relations || []).filter(r => r['target-type'] === 'artist');
      console.log(`  work artist-rels (${artistRels.length}):`);
      for (const ar of artistRels) {
        console.log(`    type="${ar.type}" artist="${ar.artist?.name}"`);
      }
      if (!artistRels.length) console.log('    (none)');
    }
  }
}

main().catch(console.error);
