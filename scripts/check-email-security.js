const {
  flattenTxt,
  formatDnsFailure,
  normalizeDnsValue,
  resolveDns,
} = require('./lib/dns-utils');
const { fetchHttps } = require('./lib/http-utils');
const { createReporter } = require('./lib/output-utils');

const DOMAIN = 'musigod.com';
const DMARC_DOMAIN = `_dmarc.${DOMAIN}`;
const DEFAULT_DKIM_SELECTORS = [
  'default',
  'google',
  'selector1',
  'selector2',
  'k1',
  's1',
  's2',
  'mail',
  'smtp',
];

const dkimSelectors = (process.env.DKIM_SELECTORS || '')
  .split(',')
  .map((selector) => selector.trim())
  .filter(Boolean);
const selectorsToCheck = dkimSelectors.length > 0 ? dkimSelectors : DEFAULT_DKIM_SELECTORS;
const reporter = createReporter(`Email DNS security check for ${DOMAIN}`);
let dnsTimedOut = false;

async function checkMx() {
  const result = await resolveDns('resolveMx', DOMAIN);
  if (!result.ok) {
    dnsTimedOut = true;
    reporter.addResolver(result.resolversTried);
    reporter.line('FAIL', `MX ${DOMAIN}`, formatDnsFailure(result), { durationMs: result.durationMs });
    return;
  }

  if (result.records.length === 0) {
    reporter.line('FAIL', `MX ${DOMAIN}`, 'no MX records found; inbound email will fail', {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
    return;
  }

  const summary = result.records
    .sort((a, b) => a.priority - b.priority)
    .map((record) => `${record.priority} ${record.exchange}`)
    .join(', ');
  reporter.line('PASS', `MX ${DOMAIN}`, summary, {
    durationMs: result.durationMs,
    resolverUsed: result.resolverUsed,
  });

  if (result.localResolverFailed) {
    reporter.line('WARN', `MX ${DOMAIN}`, 'local resolver failed; fallback resolver succeeded');
  }
}

async function checkSpf() {
  const result = await resolveDns('resolveTxt', DOMAIN);
  if (!result.ok) {
    dnsTimedOut = true;
    reporter.addResolver(result.resolversTried);
    reporter.line('FAIL', `SPF TXT ${DOMAIN}`, formatDnsFailure(result), { durationMs: result.durationMs });
    return;
  }

  const spfRecords = flattenTxt(result.records).filter((record) =>
    normalizeDnsValue(record).startsWith('v=spf1'),
  );

  if (spfRecords.length === 1) {
    reporter.line('PASS', `SPF TXT ${DOMAIN}`, 'one SPF record found', {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  } else if (spfRecords.length > 1) {
    reporter.line('FAIL', `SPF TXT ${DOMAIN}`, `${spfRecords.length} SPF records found; only one is valid`, {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  } else {
    reporter.line('FAIL', `SPF TXT ${DOMAIN}`, 'no SPF record found', {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  }

  if (result.localResolverFailed) {
    reporter.line('WARN', `SPF TXT ${DOMAIN}`, 'local resolver failed; fallback resolver succeeded');
  }
}

async function checkDmarc() {
  const result = await resolveDns('resolveTxt', DMARC_DOMAIN);
  if (!result.ok) {
    dnsTimedOut = true;
    reporter.addResolver(result.resolversTried);
    reporter.line('FAIL', `DMARC TXT ${DMARC_DOMAIN}`, formatDnsFailure(result), { durationMs: result.durationMs });
    return;
  }

  const dmarcRecords = flattenTxt(result.records).filter((record) =>
    normalizeDnsValue(record).startsWith('v=dmarc1'),
  );

  if (dmarcRecords.length === 1) {
    reporter.line('PASS', `DMARC TXT ${DMARC_DOMAIN}`, 'one DMARC record found', {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  } else if (dmarcRecords.length > 1) {
    reporter.line('FAIL', `DMARC TXT ${DMARC_DOMAIN}`, `${dmarcRecords.length} DMARC records found; only one is valid`, {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  } else {
    reporter.line('FAIL', `DMARC TXT ${DMARC_DOMAIN}`, 'no DMARC record found', {
      durationMs: result.durationMs,
      resolverUsed: result.resolverUsed,
    });
  }

  if (result.localResolverFailed) {
    reporter.line('WARN', `DMARC TXT ${DMARC_DOMAIN}`, 'local resolver failed; fallback resolver succeeded');
  }
}

async function hasDkimRecord(selector) {
  const host = `${selector}._domainkey.${DOMAIN}`;
  const txt = await resolveDns('resolveTxt', host);

  if (txt.ok) {
    const match = flattenTxt(txt.records).some((record) =>
      normalizeDnsValue(record).startsWith('v=dkim1'),
    );
    if (match) {
      return { selector, host, type: 'TXT', resolverUsed: txt.resolverUsed };
    }
  }

  const cname = await resolveDns('resolveCname', host);
  if (cname.ok && cname.records.length > 0) {
    return {
      selector,
      host,
      type: 'CNAME',
      target: cname.records.join(', '),
      resolverUsed: cname.resolverUsed,
    };
  }

  return null;
}

async function checkDkim() {
  if (dnsTimedOut) {
    reporter.line('WARN', 'DKIM', 'skipped selector probing because DNS lookups are failing in this environment');
    return;
  }

  const started = Date.now();
  const found = [];
  for (const selector of selectorsToCheck) {
    const record = await hasDkimRecord(selector);
    if (record) {
      found.push(record);
      reporter.addResolver(record.resolverUsed);
    }
  }

  const durationMs = Date.now() - started;
  if (found.length > 0) {
    const summary = found
      .map((record) => `${record.selector} (${record.type}${record.target ? ` -> ${record.target}` : ''})`)
      .join(', ');
    reporter.line('PASS', 'DKIM', summary, { durationMs });
  } else if (dkimSelectors.length > 0) {
    reporter.line('FAIL', 'DKIM', `no DKIM records found for selectors: ${selectorsToCheck.join(', ')}`, { durationMs });
  } else {
    reporter.line(
      'WARN',
      'DKIM',
      `no DKIM records found for common selectors: ${selectorsToCheck.join(', ')}; set DKIM_SELECTORS=selector1,selector2 for provider-specific validation`,
      { durationMs },
    );
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
  await checkMx();
  await checkSpf();
  await checkDmarc();
  await checkDkim();
  await checkHttpsFallback(DOMAIN);
  await checkHttpsFallback(`www.${DOMAIN}`);
  reporter.finish();
})();
