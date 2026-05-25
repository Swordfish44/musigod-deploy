const { captureException, withSentry } = require('./_sentry')
const { listAuditEvents, listAuditStatuses, log, safeErrorMessage } = require('./_fulfillment')

const ADMIN_API_KEY = process.env.ADMIN_API_KEY

module.exports = withSentry(async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  if (!ADMIN_API_KEY) return res.status(500).json({ error: 'ADMIN_API_KEY is not configured' })
  if (req.headers['x-admin-key'] !== ADMIN_API_KEY) return res.status(401).json({ error: 'Unauthorized' })

  const url = new URL(req.url, 'https://musigod.com')
  const query = clean(url.searchParams.get('q'))
  const status = clean(url.searchParams.get('status'))
  const limit = url.searchParams.get('limit') || '50'

  try {
    const jobs = await listAuditStatuses({ query, status, limit })
    const failed = jobs.filter(job => ['FAILED_RETRYING', 'ACTION_REQUIRED'].includes(job.current_status)).length
    const completed = jobs.filter(job => job.current_status === 'COMPLETED').length
    const retrying = jobs.filter(job => job.current_status === 'FAILED_RETRYING').length
    const active = jobs.filter(job => ['PAID', 'FULFILLMENT_QUEUED', 'PROCESSING'].includes(job.current_status)).length
    const events = query && jobs[0]?.audit_id ? await listAuditEvents(jobs[0].audit_id, 12) : []

    log('info', 'ADMIN_FULFILLMENT_VIEWED', { count: jobs.length, query: query || null, status: status || null })
    return res.status(200).json({
      jobs,
      events,
      summary: {
        total: jobs.length,
        active,
        failed,
        retrying,
        completed,
      },
      server_time: new Date().toISOString(),
    })
  } catch (err) {
    log('error', 'ADMIN_FULFILLMENT_FAILED', { message: safeErrorMessage(err) })
    captureException(err, {
      route: 'admin-fulfillment',
      method: req.method,
      path: req.url,
      statusCode: 500,
    })
    return res.status(500).json({ error: 'Fulfillment admin lookup failed' })
  }
}, 'admin-fulfillment')

function setCors(req, res) {
  const origin = req.headers.origin || ''
  const allowed = new Set(['https://musigod.com', 'https://www.musigod.com'])
  res.setHeader('Access-Control-Allow-Origin', allowed.has(origin) ? origin : 'https://musigod.com')
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Key')
}

function clean(value) {
  return String(value || '').trim()
}
