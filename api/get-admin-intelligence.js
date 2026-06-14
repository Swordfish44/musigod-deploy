const { captureException, withSentry } = require('./_sentry')

const SB_URL = process.env.SUPABASE_URL || 'https://uykzkrnoetcldeuxzqyy.supabase.co'
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY
const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!SB_KEY) return res.status(500).json({ error: 'Supabase service key not configured' })
  if (ADMIN_API_KEY && req.headers['x-admin-key'] !== ADMIN_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  try {
    const [
      summaryRows,
      highLeakage,
      highRecovery,
      stalledCases,
      queueBottlenecks,
      criticalFindings,
      pendingDocs,
      recentActivity,
      automationFailed,
      topAffiliates,
    ] = await Promise.all([
      // Build 5 section 1: summary metrics
      sbFetch('v_admin_intelligence_v1', 'registrations'),

      // Highest leakage artists (section 3)
      sbFetch('v_leakage_dashboard_v1?limit=10', 'registrations'),

      // Highest recovery opportunities (section 1)
      sbFetch('recovery_cases_v1?status=eq.IDENTIFIED&order=amount_identified.desc&limit=10', 'registrations'),

      // Stalled recovery cases (section 2): cases not updated in 14+ days
      sbFetch(
        `recovery_cases_v1?status=in.(IDENTIFIED,DOCUMENTS_NEEDED,SUBMITTED,IN_REVIEW)&updated_at=lt.${daysAgo(14)}&order=amount_identified.desc&limit=10`,
        'registrations'
      ),

      // Queue bottlenecks (section 4)
      sbFetch('v_admin_queue_summary_v1?status=eq.OPEN&order=task_count.desc&limit=10', 'registrations'),

      // High-confidence critical findings (section 10)
      sbFetch(
        'audit_findings_v1?severity=eq.CRITICAL&status=eq.OPEN&order=estimated_recovery_amount.desc&limit=10',
        'registrations'
      ),

      // Pending document reviews (section 9)
      sbFetch('artist_documents_v1?status=eq.UPLOADED&order=created_at.asc&limit=20', 'registrations'),

      // Recent recovery activity (section 12)
      sbFetch(
        'artist_activity_timeline_v1?visibility=in.(BOTH,ADMIN_ONLY)&order=created_at.desc&limit=20',
        'registrations'
      ),

      // Failed automation runs (section 11)
      sbFetch('recovery_automation_runs_v1?status=eq.FAILED&order=created_at.desc&limit=10', 'registrations'),

      // Top affiliates
      sbFetch('affiliates_v1?order=total_referred.desc&limit=5', 'affiliates').catch(() => []),
    ])

    const summary = summaryRows?.[0] || {}

    return res.status(200).json({
      summary,
      high_leakage_artists:       highLeakage       || [],
      high_recovery_opportunities: highRecovery     || [],
      stalled_cases:              stalledCases       || [],
      queue_bottlenecks:          queueBottlenecks   || [],
      critical_findings:          criticalFindings   || [],
      pending_doc_reviews:        pendingDocs        || [],
      recent_activity:            recentActivity     || [],
      failed_automation:          automationFailed   || [],
      top_affiliates:             topAffiliates      || [],
    })

  } catch (err) {
    console.error('get-admin-intelligence error:', err)
    captureException(err, { route: 'get-admin-intelligence' })
    return res.status(500).json({ error: err.message })
  }
}, 'get-admin-intelligence')

async function sbFetch(path, schema) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Accept-Profile': schema,
    },
  })
  const text = await r.text()
  if (!r.ok) throw new Error(`Supabase ${path} failed: ${r.status} ${text}`)
  return text ? JSON.parse(text) : null
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString()
}

function setCors(req, res) {
  res.setHeader('Access-Control-Allow-Origin', 'https://musigod.com')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-admin-key')
}
