'use strict'
const assert = require('assert/strict')
const { Readable } = require('stream')
process.env.SUPABASE_URL = 'https://fixture.example.invalid'
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-service-key'
delete process.env.RESEND_API_KEY
delete process.env.SENTRY_DSN
const tokens = require('../lib/intake-tokens')
const sign = require('../api/sign-agreement')
const upload = require('../api/upload-artist-document')
const { _clearStore } = require('../lib/intake-rate-limit')
const response = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) })
let assertions = 0
const equal = (a,b,label) => { assert.deepEqual(a,b,label); assertions++ }
async function exercise(kind, scenario) {
  _clearStore()
  const raw = tokens.generateRawToken()
  const record = tokens.buildTokenRecord({ rawToken: raw, tokenType: kind === 'sign' ? 'agreement_sign' : 'document_upload', artistEmail: 'fixture@example.invalid', createdBy: 'fixture' })
  let reads = 0, claims = 0, writes = 0, release
  const parallel = scenario === 'concurrent' ? 2 : 1
  const barrier = new Promise(resolve => { release = resolve })
  global.fetch = async (url, options = {}) => {
    const u = new URL(String(url)), method = options.method || 'GET'
    if (u.pathname.endsWith('/intake_upload_tokens_v1')) {
      if (method === 'GET') {
        const snapshot = { ...record }
        if (++reads === parallel) release()
        await barrier
        return response([snapshot])
      }
      if (scenario === 'http') return { ok: false, status: 503, text: async () => 'fixture unavailable' }
      if (scenario === 'network') throw new Error('fixture network failure')
      if (scenario === 'malformed') return response(null)
      const guarded = u.searchParams.get('used_at') === 'is.null' && u.searchParams.get('revoked_at') === 'is.null' && u.searchParams.get('expires_at')?.startsWith('gt.')
      const unavailable = record.used_at || scenario === 'revoked' || scenario === 'expired'
      if (guarded && unavailable) return response([])
      record.used_at = new Date().toISOString(); claims++
      if (options.headers.Prefer === 'return=representation') {
        equal(u.searchParams.get('select'), 'token_hash', 'claim returns only token hash')
        return response([{ token_hash: record.token_hash }])
      }
      return response(null)
    }
    if (u.pathname.includes('/storage/v1/object/')) { writes++; return response({}) }
    if (u.pathname.endsWith('/fn_complete_authorization_onboarding_v1')) { writes++; return response({}) }
    if (u.pathname.endsWith('/artist_documents_v1')) return response([{ id: 'fixture-document' }])
    return response([])
  }
  async function call() {
    let body, headers = { 'x-intake-token': raw, 'x-forwarded-for': '192.0.2.1' }
    if (kind === 'sign') {
      body = JSON.stringify({ artist_email: 'fixture@example.invalid', service_type: 'PUBLISHING_ADMIN', disclosure_acknowledged: true })
    } else {
      const boundary = 'fixture-boundary'
      headers['content-type'] = `multipart/form-data; boundary=${boundary}`
      body = `--${boundary}\r\nContent-Disposition: form-data; name="artist_email"\r\n\r\nfixture@example.invalid\r\n--${boundary}\r\nContent-Disposition: form-data; name="document_type"\r\n\r\nPRO_STATEMENT\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="fixture.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 fixture\r\n--${boundary}--\r\n`
    }
    const req = Readable.from([Buffer.from(body)]); req.method = 'POST'; req.headers = headers
    const res = { code: 200, setHeader(){}, status(code){this.code=code;return this}, json(value){this.body=value;return this}, end(){return this} }
    await (kind === 'sign' ? sign : upload)(req,res)
    return res.code
  }
  const statuses = await Promise.all(Array.from({length:parallel},call))
  if (scenario === 'concurrent') {
    equal(statuses.sort(), [200,401], `${kind}: exactly one stale-read request proceeds`)
    equal(claims, 1, `${kind}: one token claim`)
    equal(writes, 1, `${kind}: one authorized side effect`)
  } else {
    equal(writes, 0, `${kind}/${scenario}: no authorized side effect`)
    equal(statuses[0] >= 400, true, `${kind}/${scenario}: fail closed`)
  }
}
;(async()=>{
  const quiet={info:console.info,error:console.error};console.info=console.error=()=>{}
  try { for (const kind of ['sign','upload']) for (const scenario of ['concurrent','revoked','expired','http','network','malformed']) await exercise(kind,scenario) }
  finally { Object.assign(console,quiet) }
  console.log(`${assertions} token-consumption assertions passed; all fetches mocked`)
})().catch(error=>{console.error(error);process.exitCode=1})
