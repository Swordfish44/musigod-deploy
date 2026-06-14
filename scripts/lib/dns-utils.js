const dns = require('node:dns').promises;
const { performance } = require('node:perf_hooks');

const DNS_TIMEOUT_MS = Number(process.env.DNS_TIMEOUT_MS || 1500);
const DNS_RETRIES = Number(process.env.DNS_RETRIES || 1);
const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ETIMEOUT', 'EAI_AGAIN', 'ESERVFAIL']);
const DOMAIN_FAILURE_CODES = new Set(['ENODATA', 'ENOTFOUND', 'ENODOMAIN']);

function createResolver(name, servers) {
  const resolver = new dns.Resolver({ timeout: DNS_TIMEOUT_MS, tries: 1 });
  if (servers) {
    resolver.setServers(servers);
  }
  return { name, resolver };
}

const RESOLVERS = [
  createResolver('system', null),
  createResolver('google-dns-8.8.8.8', ['8.8.8.8']),
  createResolver('cloudflare-dns-1.1.1.1', ['1.1.1.1']),
];

function normalizeDnsValue(value) {
  return String(value).trim().toLowerCase().replace(/\.$/, '');
}

function normalizeList(values) {
  return values.map(normalizeDnsValue).sort();
}

function sameSet(actual, expected) {
  const a = normalizeList(actual);
  const e = normalizeList(expected);
  return a.length === e.length && a.every((value, index) => value === e[index]);
}

function flattenTxt(records) {
  return records.map((record) => record.join(''));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout(promise, timeoutMs, label) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`${label} timed out after ${timeoutMs}ms`);
      error.code = 'ETIMEOUT';
      reject(error);
    }, timeoutMs);
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function classifyFailure(errors) {
  const codes = errors.map((entry) => entry.code).filter(Boolean);

  if (codes.length > 0 && codes.every((code) => DOMAIN_FAILURE_CODES.has(code))) {
    return 'actual_domain_failure';
  }

  if (errors.some((entry) => entry.resolver === 'system' && RETRYABLE_CODES.has(entry.code))) {
    return 'local_resolver_failure';
  }

  return 'dns_failure';
}

function formatDnsFailure(result) {
  const attempts = result.errors
    .map((entry) => `${entry.resolver}#${entry.attempt}:${entry.code || entry.message}`)
    .join(', ');
  return `${result.classification}; ${attempts}`;
}

async function resolveDns(method, hostname, options = {}) {
  const timeoutMs = options.timeoutMs || DNS_TIMEOUT_MS;
  const retries = options.retries ?? DNS_RETRIES;
  const started = performance.now();
  const errors = [];

  for (const { name, resolver } of RESOLVERS) {
    for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
      try {
        const records = await withTimeout(
          resolver[method](hostname),
          timeoutMs,
          `${name} ${method} ${hostname}`,
        );

        return {
          ok: true,
          records,
          resolverUsed: name,
          localResolverFailed: name !== 'system' && errors.some((entry) => entry.resolver === 'system'),
          durationMs: performance.now() - started,
          errors,
        };
      } catch (error) {
        const code = error.code || error.name || 'ERROR';
        errors.push({
          resolver: name,
          attempt,
          code,
          message: error.message,
        });

        if (!RETRYABLE_CODES.has(code) || attempt > retries) {
          break;
        }

        await sleep(150 * attempt);
      }
    }
  }

  return {
    ok: false,
    classification: classifyFailure(errors),
    durationMs: performance.now() - started,
    errors,
    resolversTried: RESOLVERS.map((entry) => entry.name),
  };
}

module.exports = {
  flattenTxt,
  formatDnsFailure,
  normalizeDnsValue,
  resolveDns,
  sameSet,
};
