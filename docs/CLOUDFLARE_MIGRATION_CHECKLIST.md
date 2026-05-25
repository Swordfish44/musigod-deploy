# Cloudflare Migration Checklist

This checklist prepares `musigod.com` for a nameserver move from Vercel DNS to Cloudflare without changing live DNS automatically.

## Safety Rules

- Do not change nameservers until every production DNS record is present in Cloudflare.
- Do not delete existing Vercel DNS records during the migration window.
- Do not expose API keys, mail credentials, Stripe secrets, Supabase secrets, or registrar credentials.
- Use read-only checks before and after cutover.

## Required Cloudflare Records

| Purpose | Type | Name | Value |
| --- | --- | --- | --- |
| Vercel apex routing | `A` | `@` | `76.76.21.21` or current Vercel-provided apex value |
| Vercel www routing | `CNAME` | `www` | `cname.vercel-dns.com` or current Vercel-provided CNAME |
| Inbound email | `MX` | `@` or provider host | Mail-provider supplied MX records with exact priority |
| SPF | `TXT` | `@` or provider host | Mail-provider supplied SPF record beginning with `v=spf1` |
| DKIM | `TXT` or `CNAME` | Provider selector host | Mail-provider supplied DKIM record |
| DMARC | `TXT` | `_dmarc` | DMARC policy beginning with `v=DMARC1` |

Keep Vercel routing records as DNS only during initial migration unless Cloudflare proxy behavior has been explicitly validated with Vercel.

## Preserve Email Inboxes

1. Identify the current email provider.
2. Copy all MX records exactly, including priority.
3. Copy the SPF TXT record exactly.
4. Copy every DKIM TXT or CNAME record exactly.
5. Copy the DMARC TXT record exactly.
6. Validate email DNS before nameserver cutover:

```bash
npm run dns:email
```

7. After cutover, send and receive test email from every production inbox.
8. Confirm outbound messages pass SPF, DKIM, and DMARC.

## Avoid Downtime

1. Inventory all existing Vercel DNS records.
2. Add matching records in Cloudflare before changing nameservers.
3. Confirm `musigod.com` and `www.musigod.com` resolve correctly.
4. Confirm HTTPS works before and after cutover.
5. Change only nameservers at the registrar when ready.
6. Keep the Vercel DNS zone intact until Cloudflare has been stable through the validation window.

## Vercel Compatibility

1. Confirm the Vercel project still has `musigod.com` and `www.musigod.com` configured.
2. Confirm apex DNS uses `76.76.21.21` or the current value shown by Vercel.
3. Confirm `www` DNS uses `cname.vercel-dns.com` or the current CNAME shown by Vercel.
4. Confirm production routes still work:
   - `/`
   - `/register.html`
   - `/rights-audit.html`
   - `/admin.html`
   - `/api/create-checkout-session`

## SSL Verification

1. Before cutover, confirm Vercel shows valid certificates for apex and `www`.
2. After cutover, confirm `https://musigod.com` returns a successful response.
3. After cutover, confirm `https://www.musigod.com` returns a successful response.
4. If Cloudflare proxying is enabled later, verify SSL/TLS mode and redirects before routing customers through it.

## Read-Only Verification Commands

```bash
npm run dns:check
npm run dns:email
npm run dns:sync
```

## Nameserver Cutover

Only after all checks are acceptable, replace the current Vercel nameservers:

```text
ns1.vercel-dns.com
ns2.vercel-dns.com
```

with the assigned Cloudflare nameservers:

```text
karsyn.ns.cloudflare.com
kurt.ns.cloudflare.com
```

## Post-Cutover Validation

1. Run:

```bash
npm run dns:check
npm run dns:email
npm run dns:sync
```

2. Confirm apex and `www` load the Vercel site over HTTPS.
3. Confirm signup, Stripe checkout, success/cancel redirects, rights audit unlock, admin activation, dashboard loading, artist portal loading, webhook lifecycle, email triggers, and n8n callbacks still resolve.
4. Confirm inbound email works.
5. Confirm outbound email passes SPF, DKIM, and DMARC.
6. Confirm Cloudflare shows the zone as active.

## Rollback Plan

If the Vercel site or email fails after cutover:

1. Do not delete Cloudflare records.
2. Restore the Vercel nameservers at the registrar:

```text
ns1.vercel-dns.com
ns2.vercel-dns.com
```

3. Wait for propagation.
4. Re-run the verification commands.
5. Fix the missing or incorrect Cloudflare records before attempting cutover again.

