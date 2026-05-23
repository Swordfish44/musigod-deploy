# Sentry Setup

MusiGod uses optional Sentry telemetry for browser pages and Vercel serverless API functions. If Sentry DSNs are missing, telemetry no-ops and production requests continue normally.

## Required Vercel Environment Variables

- `SENTRY_DSN`: private server/API Sentry DSN for `/api/*.js` functions.
- `SENTRY_PUBLIC_DSN`: public browser Sentry DSN returned by `/api/public-config`.

## Optional Environment Variables

- `SENTRY_AUTH_TOKEN`: used only by release tooling if added later.
- `SENTRY_ORG`: Sentry organization slug for release tooling.
- `SENTRY_PROJECT`: Sentry project slug for release tooling.

## Server Test

```bash
curl -sS -X POST https://musigod.com/api/test-sentry -H "X-Admin-Key: $ADMIN_API_KEY"
```

Expected response:

```json
{
  "ok": true,
  "telemetryAttempted": true,
  "sentryConfigured": true,
  "eventId": "...",
  "flushed": true,
  "environment": "production",
  "release": "..."
}
```

Forced throw path:

```bash
curl.exe -sS -X POST https://musigod.com/api/test-sentry-throw -H "X-Admin-Key: ADMIN_KEY"
```

This route captures and flushes a test event, then throws `MusiGod Sentry forced throw test` so Sentry receives a true serverless error path.

## Browser Test

Open a production page, then run this in the browser console:

```js
setTimeout(function () { throw new Error('MusiGod Sentry browser telemetry test') }, 0)
```

Also test unhandled promise rejection capture:

```js
Promise.reject(new Error('MusiGod Sentry browser rejection test'))
```

## Local Env Check

```bash
npm run sentry:test
```

This checks only whether expected environment variable names exist. It does not print values.

## Troubleshooting First Event Visibility

- Check the project DSN in Sentry under Settings, Projects, Client Keys.
- Confirm Vercel has `SENTRY_DSN` and `SENTRY_PUBLIC_DSN` set for the production environment.
- Redeploy production after changing Vercel environment variables.
- Clear Sentry issue filters, including environment, release, time range, and resolved/ignored status.
- Test the captured error path:

```bash
curl.exe -sS -X POST https://musigod.com/api/test-sentry -H "X-Admin-Key: ADMIN_KEY"
```

- Test the forced serverless throw path:

```bash
curl.exe -sS -X POST https://musigod.com/api/test-sentry-throw -H "X-Admin-Key: ADMIN_KEY"
```

- Serverless functions can terminate immediately after sending a response. MusiGod calls `flush(5000)` on Sentry test routes so queued events have time to send before the function exits.

## Security Rules

- Never expose Supabase service-role keys.
- Never expose Stripe secret keys or webhook secrets.
- Never put the private `SENTRY_DSN` in frontend code if using separate public/private DSNs.
- Never log raw payment payloads, webhook bodies, admin keys, Supabase keys, or user secrets.
- Browser code may only receive `SENTRY_PUBLIC_DSN` through `/api/public-config`.
- Server telemetry must never fail customer requests if Sentry is unavailable.
