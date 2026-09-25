'use strict'

// Admin-only read of registrations.audit_findings_v1 for admin-findings.html.
// Replaces the service_role key that was embedded in that public page.
// Fails closed: no ADMIN_API_KEY configured => 503; wrong key => 401.

const crypto = require('crypto')
const { captureException, withSentry } = require('../_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ALLOWED_FILTERS = {
  severity: new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']),
  status: new Set(['OPEN', 'APPROVED', 'REJECTED', 'ESCALATED', 'IN_REVIEW']),
}

function adminKeyValid(given) {
  const expected = process.env.ADMIN_API_KEY
  if (!expected || !given) return false
  const a = Buffer.from(String(given)); const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

module.exports = withSentry(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!process.env.ADMIN_API_KEY) return res.status(503).json({ error: 'Admin access is not configured' })
  if (!adminKeyValid(req.headers['x-admin-key'])) return res.status(401).json({ error: 'Unauthorized' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })

  const q = req.query || {}
  const filters = ['order=estimated_recovery_amount.desc', 'limit=100']
  for (const [field, allowed] of Object.entries(ALLOWED_FILTERS)) {
    const value = String(q[field] || '').toUpperCase()
    if (value) {
      if (!allowed.has(value)) return res.status(400).json({ error: `invalid ${field}` })
      filters.push(`${field}=eq.${value}`)
    }
  }
  const email = String(q.email || '').trim().toLowerCase()
  if (email) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'invalid email' })
    filters.push(`artist_email=eq.${encodeURIComponent(email)}`)
  }
  const type = String(q.finding_type || '')
  if (type) {
    if (!/^[A-Z0-9_]{1,64}$/i.test(type)) return res.status(400).json({ error: 'invalid finding_type' })
    filters.push(`finding_type=eq.${encodeURIComponent(type)}`)
  }

  try {
    const response = await fetch(`${SB_URL}/rest/v1/audit_findings_v1?${filters.join('&')}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`, 'Accept-Profile': 'registrations' },
    })
    if (!response.ok) throw new Error(`audit_findings_v1 read failed: ${response.status}`)
    return res.status(200).json(await response.json())
  } catch (error) {
    captureException(error, { route: 'admin/list-audit-findings', statusCode: 502 })
    return res.status(502).json({ error: 'Could not load findings' })
  }
}, 'admin/list-audit-findings')

module.exports.adminKeyValid = adminKeyValid
