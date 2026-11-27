// What a visitor sees at the /try/ demo sites, and on /try/ when creating a test
// citizen fails. What breaks if this fails: a decline reads as a refusal, an
// expired check as a failure, or nginx's HTML 429 as a crash.

import test from 'node:test';
import assert from 'node:assert/strict';
import { siteOutcome, tryErrorKey, SITE_THRESHOLDS } from '../../services/verifier-web/try/site.js';

test('thresholds', () => assert.deepEqual(SITE_THRESHOLDS, { social: 16, shop: 18 }));

test('outcomes the visitor sees', () => {
  assert.equal(siteOutcome(200, { state: 'decided', decision: 'APPROVED' }), 'allowed');
  assert.equal(siteOutcome(200, { state: 'decided', decision: 'DENIED' }), 'refused');
  assert.equal(siteOutcome(200, { state: 'declined' }), 'declined');
  assert.equal(siteOutcome(200, { state: 'rejected' }), 'failed');
  assert.equal(siteOutcome(404, { state: 'expired' }), 'expired');
  assert.equal(siteOutcome(200, { state: 'waiting' }), 'waiting');
  assert.equal(siteOutcome(0, undefined), 'failed');
});

test('errors from creating a test citizen', () => {
  assert.equal(tryErrorKey(429, '<html>'), 'try.error.rateLimited');
  assert.equal(tryErrorKey(503, { error: 'demo_busy' }), 'try.error.busy');
  assert.equal(tryErrorKey(400, { error: 'invalid_request', field: 'dateOfBirth' }), 'try.error.invalid.dateOfBirth');
  assert.equal(tryErrorKey(500, {}), 'try.error.generic');
});
