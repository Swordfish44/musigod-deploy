const { performance } = require('node:perf_hooks');

const HTTPS_TIMEOUT_MS = Number(process.env.HTTPS_TIMEOUT_MS || 7000);
const HTTPS_RETRIES = Number(process.env.HTTPS_RETRIES || 1);

async function fetchHttps(url, options = {}) {
  const timeoutMs = options.timeoutMs || HTTPS_TIMEOUT_MS;
  const started = performance.now();
  const retries = options.retries ?? HTTPS_RETRIES;
  let lastError = null;

  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'HEAD',
        redirect: 'manual',
        signal: controller.signal,
        headers: {
          'User-Agent': 'musigod-dns-readonly-check/1.0',
        },
      });

      return {
        ok: response.status >= 200 && response.status < 400,
        status: response.status,
        attempts: attempt,
        durationMs: performance.now() - started,
      };
    } catch (error) {
      lastError = error;
    } finally {
      clearTimeout(timeout);
    }
  }

  return {
    ok: false,
    attempts: retries + 1,
    errorCode: lastError.name || lastError.code || 'ERROR',
    errorMessage: lastError.message,
    durationMs: performance.now() - started,
  };
}

module.exports = {
  fetchHttps,
};
