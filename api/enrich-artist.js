// api/enrich-artist.js
// POST { artistName, publisherName, publisherIPI, maxReleases }
// Returns enriched catalog + download links for registration CSVs

const { enrichArtistCatalog } = require('../lib/enrich-catalog');
const {
  generateASCAPCSV,
  generateBMICSV,
  generateMLCCSV,
  generateMasterCatalogCSV,
  generateGapsReport,
} = require('../lib/generate-registration-files');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const adminKey = req.headers['x-admin-key'];
  if (process.env.AUDIT_ADMIN_KEY && adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const {
    artistName,
    publisherName = 'MusiGod Publishing Administration',
    publisherIPI = '',
    maxReleases = 30,
  } = req.body || {};

  if (!artistName) return res.status(400).json({ error: 'artistName required' });

  try {
    // Enrich catalog from MusicBrainz
    const catalog = await enrichArtistCatalog(artistName, { maxReleases });

    // Generate all registration files
    const ascapCSV    = generateASCAPCSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const bmiCSV      = generateBMICSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const mlcCSV      = generateMLCCSV(catalog.enrichedTracks, publisherName, publisherIPI);
    const masterCSV   = generateMasterCatalogCSV(catalog.enrichedTracks);
    const gapsReport  = generateGapsReport(catalog.enrichedTracks);

    return res.status(200).json({
      artistName,
      mbid: catalog.mbid,
      totalReleases: catalog.totalReleases,
      processedReleases: catalog.processedReleases,
      totalTracks: catalog.totalTracks,
      gapsReport,
      files: {
        ascap:  { filename: `${artistName}_ASCAP_Registration.csv`,  content: ascapCSV },
        bmi:    { filename: `${artistName}_BMI_Registration.csv`,    content: bmiCSV },
        mlc:    { filename: `${artistName}_MLC_Registration.csv`,    content: mlcCSV },
        master: { filename: `${artistName}_Master_Catalog.csv`,      content: masterCSV },
      },
      generatedAt: catalog.generatedAt,
    });
  } catch (err) {
    console.error('Enrich error:', err);
    return res.status(500).json({ error: err.message });
  }
};
