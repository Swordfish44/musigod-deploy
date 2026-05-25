const {
  formatDnsFailure,
  normalizeDnsValue,
  resolveDns,
  sameSet,
} = require('./lib/dns-utils');
const { fetchHttps } = require('./lib/http-utils');
const { createReporter } = require('./lib/output-utils');

const DOMAIN = 'musigod.com';
const WWW_DOMAIN = `www.${DOMAIN}`;
const VERCEL_APEX_A = '76.76.21.21';
const VERCEL_WWW_CNAME = 'cname.vercel-dns.com';
const VERCEL_NAMESERVERS = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'];
const CLOUDFLARE_NAMESERVERS = [
  'karsyn.ns.cloudflare.com',
  'kurt.ns.cloudflare.com',
];

const reporter = createReporter(`DNS state check for ${DOMAIN}`);
let dnsTimedOut = false;

async function checkApexA() {
  const result = await resolveDns('resolve4', DOMAIN);
  if (!result.ok) {
    dnsTimedOut = true;
    reporter.addResolver(result.resolversTried);
    reporter.line('FAIL', `A ${DOMAIN}`, formatDnsFailure(result), { durationMs: result.durationMs });
    return;
  }

  const level = result.records.includes(VERCEL_APEX_A) ? 'PASS' : 'FAIL';
  const detail = result.records.includes(VERCEL_APEX_A)
    ? `Vercel apex value present: ${result.records.join(', ')}`
    : `${result.records.join(', ') || 'none'}; expected ${VERCEL_APEX_A} or current Vercel apex value`;
  reporter.line(level, `A ${DOMAIN}`, detail, {
    durationMs: result.durationMs,
    resolverUsed: result.resolverUsed,
  });

  if (result.localResolverFailed) {
    reporter.line('WARN', `A ${DOMAIN}`, 'local resolver failed; fallback resolver succeeded');
  }
}

async function checkWwwCname() {
  const result = await resolveDns('resolveCname', WWW_DOMAIN);
  if (!result.ok) {
    dnsTimedOut = true;
    reporter.addResolver(result.resolversTried);
    reporter.line('FAIL', `CNAME ${WWW_DOMAIN}`, formatDnsFailure(result), { durationMs: result.durationMs });
    return;
  }

  const normalized = result.records.map(normalizeDnsValue);
  const level = normalized.includes(VERCEL_WWW_CNAME) ? 'PASS' : 'FAIL';
  const detail = normalized.includes(VERCEL_WWW_CNAME)
    ? `Vercel CNAME present: ${result.records.join(', ')}`
    : `${result.records.join(', ') || 'none'}; expected ${VERCEL_WWW_CNAME} or current Vercel CNAME`;
  reporter.line(level, `CNAME ${WWW_DOMAIN}`, detail, {
    durationMs: result.durationMs,
    resolverUsed: result.resolverUsed,
  });

  if (result.localResolverFailed) {
    reporter.line('WARN', `CNAME ${WWW_DOMAIN}`, 'local resolver failed; fallback resolver succeeded');
  }
}

async function checkNameservers() {
  const result = await resolveDns('resolveNs', DOMAIN);
  if (!result.ok) {
    dnsTimedOut = true;
    reporter.addResolver(result.resolversTried);
    reporter.line('FAIL', `NS ${DOMAIN}`, formatDnsFailure(result), { durationMs: result.durationMs });
    return;
  }

  if (sameSet(result.records, CLOUDFLARE_NAMESERVERS)) {
    reporter.line('PASS', `NS ${DOMAIN}`, `Cloudflare nameservers active: ${result.records.join(', ')}`, {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  } else if (sameSet(result.records, VERCEL_NAMESERVERS)) {
    reporter.line('WARN', `NS ${DOMAIN}`, `still on Vercel DNS: ${result.records.join(', ')}`, {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  } else {
    reporter.line('WARN', `NS ${DOMAIN}`, `unexpected nameservers: ${result.records.join(', ') || 'none'}`, {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  }

  if (result.localResolverFailed) {
    reporter.line('WARN', `NS ${DOMAIN}`, 'local resolver failed; fallback resolver succeeded');
  }
}

async function checkHttpsFallback(hostname) {
  const url = `https://${hostname}`;
  const result = await fetchHttps(url);
  if (result.ok) {
    const level = dnsTimedOut ? 'WARN' : 'PASS';
    const detail = dnsTimedOut
      ? `status ${result.status}; HTTPS succeeds despite DNS timeout in this environment`
      : `status ${result.status}`;
    reporter.line(level, `HTTPS ${url}`, detail, { durationMs: result.durationMs });
    return;
  }

  reporter.line('FAIL', `HTTPS ${url}`, `${result.errorCode}: ${result.errorMessage}`, {
    durationMs: result.durationMs,
  });
}

(async () => {
  reporter.startSection();
  await checkApexA();
  await checkWwwCname();
  await checkNameservers();
  await checkHttpsFallback(DOMAIN);
  await checkHttpsFallback(WWW_DOMAIN);
  reporter.finish();
})();
