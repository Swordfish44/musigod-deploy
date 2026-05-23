let Sentry = null
let initialized = false

function getSentry() {
  if (initialized) return Sentry
  initialized = true

  if (!process.env.SENTRY_DSN) return null

  try {
    Sentry = require('@sentry/node')
    Sentry.init({
      dsn: process.env.SENTRY_DSN,
      environment: process.env.VERCEL_ENV || 'production',
      tracesSampleRate: 0,
      defaultIntegrations: true,
      beforeSend(event) {
        if (event.request) {
          delete event.request.cookies
          delete event.request.data
        }
        return event
      },
    })
  } catch (_) {
    Sentry = null
  }

  return Sentry
}

function safeContext(context) {
  const safe = context && typeof context === 'object' ? { ...context } : {}
  delete safe.body
  delete safe.rawBody
  delete safe.headers
  return safe
}

function captureException(error, context = {}) {
  try {
    const client = getSentry()
    if (!client) return

    client.withScope((scope) => {
      const safe = safeContext(context)
      if (safe.route) scope.setTag('route', safe.route)
      if (safe.method) scope.setTag('method', safe.method)
      if (safe.statusCode) scope.setTag('status_code', String(safe.statusCode))
      scope.setTag('app', 'musigod')
      scope.setContext('request', safe)
      client.captureException(error)
    })
  } catch (_) {
    // Sentry must never break production request handling.
  }
}

async function flush(timeoutMs = 5000) {
  try {
    const client = getSentry()
    if (!client || typeof client.flush !== 'function') return false
    return Boolean(await client.flush(timeoutMs))
  } catch (_) {
    return false
  }
}

function withSentry(handler, name) {
  return async function sentryWrappedHandler(req, res) {
    let statusCode = 200
    const originalStatus = res.status?.bind(res)

    if (originalStatus) {
      res.status = (code) => {
        statusCode = code
        return originalStatus(code)
      }
    }

    try {
      return await handler(req, res)
    } catch (error) {
      captureException(error, {
        route: name,
        method: req.method,
        path: req.url,
        statusCode,
      })
      throw error
    }
  }
}

module.exports = {
  captureException,
  flush,
  withSentry,
}
