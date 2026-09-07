'use strict';
const assert = require('assert');
const handler = require('../api/enterprise/sample-workspace');
function response() { return { statusCode: 200, headers: {}, body: null, setHeader(k, v) { this.headers[k] = v; }, status(n) { this.statusCode = n; return this; }, json(value) { this.body = value; return this; } }; }
(async () => {
  const getRes = response(); await handler({ method: 'GET' }, getRes);
  assert.equal(getRes.statusCode, 200); assert.equal(getRes.body.sample, true);
  assert.match(getRes.body.sample_notice, /Synthetic demonstration/);
  assert(getRes.body.assets.length > 0); assert(getRes.body.royalty_reconciliations.length > 0);
  assert(getRes.body.ownership_conflicts.length > 0); assert(getRes.body.recovery_opportunities.length > 0);
  assert.equal(getRes.body.gates.external_submission_enabled, false);
  const postRes = response(); await handler({ method: 'POST' }, postRes); assert.equal(postRes.statusCode, 405);
  console.log('sample workspace: public synthetic report data is labeled, complete, read-only, and fail-closed');
})();
