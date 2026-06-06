// api/scan-artist.js
const { runFullScan } = require('../lib/scanner');

const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth check
  const adminKey = req.headers['x-admin-key'];
  const expectedKey = process.env.AUDIT_ADMIN_KEY;
  if (expectedKey && adminKey !== expectedKey) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { artistName } = req.body || {};
  if (!artistName || artistName.trim().length < 2) {
    return res.status(400).json({ error: 'artistName required' });
  }

  const name = artistName.trim();
  const cacheKey = name.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return res.status(200).json({ ...cached.data, cached: true });
  }

  try {
    const result = await runFullScan(name);
    cache.set(cacheKey, { data: result, ts: Date.now() });
    return res.status(200).json(result);
  } catch (err) {
    console.error('Scan error:', err);
    return res.status(500).json({ error: 'Scan failed', message: err.message });
  }
};
