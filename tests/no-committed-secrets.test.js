'use strict'
// Regression: no service_role key, Supabase secret key, Vercel token or n8n API
// key may be committed. Anon (public) keys are allowed in client pages.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const root = path.resolve(__dirname, '..')
const skip = new Set(['node_modules', '.git', '.vercel'])
const offenders = []
function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { walk(full); continue }
    if (!/\.(js|py|html|md|json|sql|ts|txt|sh|ps1|toml|yml|yaml)$/i.test(e.name)) continue
    const text = fs.readFileSync(full, 'utf8')
    if (/sb_secret_[A-Za-z0-9]/.test(text) || /\bvcp_[A-Za-z0-9]{20,}/.test(text)) offenders.push(`${full}: secret-format key`)
    for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]{10,}\.(eyJ[A-Za-z0-9_-]+)\.[A-Za-z0-9_-]+/g)) {
      let claims = {}
      try { claims = JSON.parse(Buffer.from(m[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString()) } catch {}
      if (claims.role === 'service_role' || claims.iss === 'n8n') offenders.push(`${path.relative(root, full)}: ${claims.role || claims.iss} JWT`)
    }
  }
}
walk(root)
assert.deepStrictEqual(offenders, [], `Committed secrets found:\n${offenders.join('\n')}`)

// admin endpoint fails closed
delete process.env.ADMIN_API_KEY
const { adminKeyValid } = require('../api/admin/list-audit-findings')
assert.strictEqual(adminKeyValid('anything'), false, 'no ADMIN_API_KEY => always reject')
process.env.ADMIN_API_KEY = 'k-123'
assert.strictEqual(adminKeyValid('k-123'), true)
assert.strictEqual(adminKeyValid('k-124'), false)
assert.strictEqual(adminKeyValid(''), false)
console.log('no-committed-secrets tests passed')
