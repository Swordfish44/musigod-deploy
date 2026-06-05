// api/scan-artist.js
// Vercel serverless function
// Deploy to musigod.com as /api/scan-artist
// POST { "artistName": "Esham" }
// Returns full royalty gap scan results

const { runFullScan } = require('../lib/scanner');

// Simple in-memory cache to avoid hammering APIs on repeated lookups
const cache = new Map();
const CACHE_TTL = 1000 * 60 * 60; // 1 hour

export default async function handler(req, res) {
  // CORS for musigod.com frontend
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  // Auth check — simple admin key for internal tool
  const adminKey = req.headers['x-admin-key'];
  if (adminKey !== process.env.AUDIT_ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { artistName } = req.body;
  if (!artistName || typeof artistName !== 'string' || artistName.trim().length < 2) {
    return res.status(400).json({ error: 'artistName required (min 2 chars)' });
  }

  const name = artistName.trim();
  const cacheKey = name.toLowerCase();

  // Return cached result if fresh
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
}
