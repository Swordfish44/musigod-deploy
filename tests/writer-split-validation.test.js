'use strict';

const assert = require('assert');
const { Readable } = require('stream');
const handler = require('../api/validate-writer-splits');
const fs = require('fs');
const path = require('path');

function request(body, key = 'test-admin') {
  const req = Readable.from([Buffer.from(JSON.stringify(body || {}))]);
  req.method = 'POST';
  req.headers = { 'x-admin-key': key };
  return req;
}

function response() {
  return {
    code: null,
    body: null,
    setHeader() {},
    status(code) { this.code = code; return this; },
    json(body) { this.body = body; return this; },
    end() { return this; },
  };
}

async function main() {
  let passed = 0;
  const ok = message => { passed++; console.log(`  ✅ ${message}`); };
  console.log('\n═══ Writer Split Validation Test ═══');

  const priorAdmin = process.env.AUDIT_ADMIN_KEY;
  const priorDb = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const priorFetch = global.fetch;

  try {
    delete process.env.AUDIT_ADMIN_KEY;
    let res = response();
    await handler(request({}), res);
    assert.equal(res.code, 503);
    ok('fails closed when admin authorization is not configured');

    process.env.AUDIT_ADMIN_KEY = 'test-admin';
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service';
    res = response();
    await handler(request({}, 'wrong-key'), res);
    assert.equal(res.code, 401);
    ok('rejects an invalid admin key');

    let rpcBody;
    global.fetch = async (_url, options) => {
      rpcBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ validated: true }),
      };
    };
    res = response();
    await handler(request({
      artist_id: '11111111-1111-1111-1111-111111111111',
      track_title: 'My Song',
      expected_updated_at: '2026-07-25T10:00:00Z',
      validated_by: 'admin@example.com',
      evidence_ref: 'split-sheet:sha256:abc123',
    }), res);
    assert.equal(res.code, 200);
    assert.equal(rpcBody.p_track_title, 'My Song');
    assert.equal(rpcBody.p_validated_by, 'admin@example.com');
    ok('passes explicit validation metadata to the atomic RPC');

    const migration = fs.readFileSync(
      path.join(__dirname, '..', 'supabase', 'migrations', '20260725_writer_split_validation_v1.sql'),
      'utf8'
    );
    assert(migration.includes('FOR UPDATE'));
    assert(migration.includes('changed after review'));
    assert(migration.includes("abs(v_total - 100) > 0.1"));
    assert(migration.includes('SET search_path = public, pg_temp'));
    assert(migration.includes('FROM PUBLIC, anon, authenticated'));
    ok('migration locks rows, checks revision and totals, pins search_path, and revokes public execution');
  } finally {
    if (priorAdmin === undefined) delete process.env.AUDIT_ADMIN_KEY;
    else process.env.AUDIT_ADMIN_KEY = priorAdmin;
    if (priorDb === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    else process.env.SUPABASE_SERVICE_ROLE_KEY = priorDb;
    global.fetch = priorFetch;
  }

  console.log(`\n${passed} assertions | ${passed} passed | 0 failed`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
