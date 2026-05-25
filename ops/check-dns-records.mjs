import {
  resolve4,
  resolveCname,
  resolveMx,
  resolveNs,
  resolveTxt,
} from 'node:dns/promises';

const DOMAIN = 'musigod.com';
const WWW_DOMAIN = `www.${DOMAIN}`;
const DMARC_DOMAIN = `_dmarc.${DOMAIN}`;

const VERCEL_APEX_A = '76.76.21.21';
const VERCEL_WWW_CNAME = 'cname.vercel-dns.com';
const VERCEL_NAMESERVERS = ['ns1.vercel-dns.com', 'ns2.vercel-dns.com'];
const CLOUDFLARE_NAMESERVERS = [
  'karsyn.ns.cloudflare.com',
  'kurt.ns.cloudflare.com',
];

const results = {
  pass: 0,
  warn: 0,
};

function normalizeDnsValue(value) {
  return String(value).trim().toLowerCase().replace(/\.$/, '');
}

function normalizeList(values) {
  return values.map(normalizeDnsValue).sort();
}

function sameSet(actual, expected) {
  const normalizedActual = normalizeList(actual);
  const normalizedExpected = normalizeList(expected);

  return (
    normalizedActual.length === normalizedExpected.length &&
    normalizedActual.every((value, index) => value === normalizedExpected[index])
  );
}

function printPass(label, detail) {
  results.pass += 1;
  console.log(`PASS ${label}: ${detail}`);
}

function printWarn(label, detail) {
  results.warn += 1;
  console.log(`WARN ${label}: ${detail}`);
}

function flattenTxtRecords(records) {
  return records.map((record) => record.join(''));
}

async function checkRecord(label, checker) {
  try {
    await checker();
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : null;
    const reason = code || error.message || 'unknown DNS lookup error';
    printWarn(label, `lookup failed: ${reason}`);
  }
}

await checkRecord(`A ${DOMAIN}`, async () => {
  const records = await resolve4(DOMAIN);

  if (records.includes(VERCEL_APEX_A)) {
    printPass(`A ${DOMAIN}`, records.join(', '));
    return;
  }

  printWarn(
    `A ${DOMAIN}`,
    `${records.join(', ') || 'none'}; expected ${VERCEL_APEX_A} or current Vercel-provided apex value`,
  );
});

await checkRecord(`CNAME ${WWW_DOMAIN}`, async () => {
  const records = await resolveCname(WWW_DOMAIN);
  const normalized = records.map(normalizeDnsValue);

  if (normalized.includes(VERCEL_WWW_CNAME)) {
    printPass(`CNAME ${WWW_DOMAIN}`, records.join(', '));
    return;
  }

  printWarn(
    `CNAME ${WWW_DOMAIN}`,
    `${records.join(', ') || 'none'}; expected ${VERCEL_WWW_CNAME} or current Vercel-provided CNAME`,
  );
});

await checkRecord(`MX ${DOMAIN}`, async () => {
  const records = await resolveMx(DOMAIN);

  if (records.length > 0) {
    const summary = records
      .sort((a, b) => a.priority - b.priority)
      .map((record) => `${record.priority} ${record.exchange}`)
      .join(', ');

    printPass(`MX ${DOMAIN}`, summary);
    return;
  }

  printWarn(`MX ${DOMAIN}`, 'no MX records found; email delivery may fail');
});

await checkRecord(`TXT ${DOMAIN}`, async () => {
  const records = flattenTxtRecords(await resolveTxt(DOMAIN));
  const spf = records.find((record) =>
    normalizeDnsValue(record).startsWith('v=spf1'),
  );

  if (spf) {
    printPass(`TXT ${DOMAIN}`, 'SPF record found');
    return;
  }

  printWarn(`TXT ${DOMAIN}`, 'no SPF TXT record found');
});

await checkRecord(`TXT ${DMARC_DOMAIN}`, async () => {
  const records = flattenTxtRecords(await resolveTxt(DMARC_DOMAIN));
  const dmarc = records.find((record) =>
    normalizeDnsValue(record).startsWith('v=dmarc1'),
  );

  if (dmarc) {
    printPass(`TXT ${DMARC_DOMAIN}`, 'DMARC record found');
    return;
  }

  printWarn(`TXT ${DMARC_DOMAIN}`, 'no DMARC TXT record found');
});

await checkRecord(`NS ${DOMAIN}`, async () => {
  const records = await resolveNs(DOMAIN);

  if (sameSet(records, CLOUDFLARE_NAMESERVERS)) {
    printPass(`NS ${DOMAIN}`, `Cloudflare nameservers active: ${records.join(', ')}`);
    return;
  }

  if (sameSet(records, VERCEL_NAMESERVERS)) {
    printWarn(
      `NS ${DOMAIN}`,
      `still using Vercel nameservers: ${records.join(', ')}`,
    );
    return;
  }

  printWarn(
    `NS ${DOMAIN}`,
    `unexpected nameservers: ${records.join(', ') || 'none'}; expected Cloudflare ${CLOUDFLARE_NAMESERVERS.join(', ')}`,
  );
});

console.log('');
console.log(`DNS check complete: ${results.pass} PASS, ${results.warn} WARN`);
console.log('Read-only check complete. No DNS records were modified.');

