# MusiGod DNS Migration Checklist

This checklist is for moving `musigod.com` nameservers from Vercel DNS to Cloudflare without breaking the Vercel site or email.

Do not change nameservers until every required DNS record has been copied into Cloudflare and verified.

## Roles

- Cloudflare is the DNS and security layer. After migration, Cloudflare will answer DNS for `musigod.com` and can provide security features such as DNS management, proxying, firewall rules, and SSL/TLS controls.
- Vercel remains the app hosting and deployment platform. Vercel builds, hosts, and serves the MusiGod site and APIs.
- Email delivery depends on provider DNS records. MX, SPF, DKIM, and DMARC records must exist in Cloudflare before changing nameservers.

## Current Nameservers

These are the current Vercel DNS nameservers:

- `ns1.vercel-dns.com`
- `ns2.vercel-dns.com`

## Final Cloudflare Nameservers

These are the Cloudflare nameservers to set at the registrar only after all records are verified in Cloudflare:

- `karsyn.ns.cloudflare.com`
- `kurt.ns.cloudflare.com`

## Required Vercel App Records

Create or verify these records in Cloudflare before changing nameservers:

| Type | Name | Value | Proxy Mode |
| --- | --- | --- | --- |
| `A` | `@` | `76.76.21.21` or the current Vercel-provided apex value | DNS only during migration |
| `CNAME` | `www` | `cname.vercel-dns.com` or the current Vercel-provided CNAME | DNS only during migration |

Confirm the current required values in the Vercel project domain settings before cutover. DNS propagation can take time after any record or nameserver change.

## Required Email Records

Copy every active email record from Vercel DNS or the current DNS provider into Cloudflare before nameserver cutover:

| Type | Name | Purpose |
| --- | --- | --- |
| `MX` | `@` or provider-specified host | Routes inbound email to the mail provider |
| `TXT` | `@` or provider-specified host | SPF record, usually starts with `v=spf1` |
| `TXT` or `CNAME` | Provider-specified DKIM selector host | DKIM authentication for outbound mail |
| `TXT` | `_dmarc` | DMARC policy, starts with `v=DMARC1` |

Email providers may require multiple DKIM records. Copy all provider-supplied records exactly, including hostnames, priorities, and TXT values.

## Pre-Migration Steps

1. Export or manually record all current Vercel DNS records for `musigod.com`.
2. In Cloudflare, add the Vercel app records for apex and `www`.
3. In Cloudflare, add all email records: MX, SPF TXT, DKIM TXT/CNAME, and DMARC TXT.
4. In Cloudflare, keep Vercel app records as DNS only during the initial migration unless Vercel and Cloudflare settings have already been validated for proxying.
5. Do not delete records from Vercel DNS during the migration window.
6. Run the read-only DNS helper:

```bash
node ops/check-dns-records.mjs
```

The helper prints PASS/WARN results only. It does not modify DNS.

## Nameserver Cutover

1. Confirm all required records exist in Cloudflare.
2. Confirm the Vercel project still has `musigod.com` and `www.musigod.com` attached and valid.
3. At the domain registrar, replace:

```text
ns1.vercel-dns.com
ns2.vercel-dns.com
```

with:

```text
karsyn.ns.cloudflare.com
kurt.ns.cloudflare.com
```

4. Wait for nameserver propagation.
5. Re-run:

```bash
node ops/check-dns-records.mjs
```

## Post-Cutover Validation

Validate these immediately after propagation begins and again after propagation settles:

- `https://musigod.com` loads the Vercel site.
- `https://www.musigod.com` loads the Vercel site.
- Vercel domain status is valid for apex and `www`.
- Inbound email receives successfully.
- Outbound email passes SPF, DKIM, and DMARC.
- Stripe checkout, signup, admin, rights audit, and webhook routes still resolve under the production domain.
- `node ops/check-dns-records.mjs` shows expected app, email, and nameserver results.

## Rollback Plan

If the site or email breaks after nameserver cutover:

1. Do not delete Cloudflare records.
2. At the registrar, restore the Vercel nameservers:

```text
ns1.vercel-dns.com
ns2.vercel-dns.com
```

3. Wait for nameserver propagation.
4. Verify the site and email again.
5. Fix the missing or incorrect Cloudflare records before attempting another cutover.

