(function () {
  var SDK_URL = 'https://browser.sentry-cdn.com/8.55.0/bundle.min.js'
  var initialized = false

  function getConfigReady() {
    if (window.MUSIGOD_PUBLIC_CONFIG_READY && typeof window.MUSIGOD_PUBLIC_CONFIG_READY.then === 'function') {
      return window.MUSIGOD_PUBLIC_CONFIG_READY
    }
    return Promise.resolve()
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var script = document.createElement('script')
      script.src = src
      script.async = true
      script.onload = resolve
      script.onerror = reject
      document.head.appendChild(script)
    })
  }

  function initSentry() {
    if (initialized || !window.MUSIGOD_SENTRY_DSN) return
    if (!window.Sentry || typeof window.Sentry.init !== 'function') return

    initialized = true
    window.Sentry.init({
      dsn: window.MUSIGOD_SENTRY_DSN,
      environment: window.MUSIGOD_ENVIRONMENT || 'production',
      tracesSampleRate: 0,
      initialScope: {
        tags: {
          app: 'musigod',
        },
      },
    })
  }

  function captureError(error, context) {
    try {
      if (!window.Sentry || typeof window.Sentry.captureException !== 'function') return
      window.Sentry.withScope(function (scope) {
        scope.setTag('app', 'musigod')
        if (context) scope.setContext('browser_event', context)
        window.Sentry.captureException(error)
      })
    } catch (_) {
      // Browser telemetry must never break page functionality.
    }
  }

  window.addEventListener('error', function (event) {
    captureError(event.error || new Error(event.message || 'window error'), {
      source: event.filename || '',
      line: event.lineno || 0,
      column: event.colno || 0,
    })
  })

  window.addEventListener('unhandledrejection', function (event) {
    var reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason || 'unhandled rejection'))
    captureError(reason, { type: 'unhandledrejection' })
  })

  getConfigReady()
    .then(function () {
      if (!window.MUSIGOD_SENTRY_DSN) return
      if (window.Sentry) {
        initSentry()
        return
      }
      return loadScript(SDK_URL).then(initSentry).catch(function () {})
    })
    .catch(function () {})
})()
