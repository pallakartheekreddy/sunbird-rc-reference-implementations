// The anonymous "recent checks" list on /try/. What breaks if this fails: the
// public table leaks a transaction id or keeps holder activity beyond 24 h, or
// one check shows up once per poll.

import test from 'node:test';
import assert from 'node:assert/strict';
import { recentChecks, SITES } from '../../services/verifier/src/core/recent.mjs';

const session = { useCase: 'age', site: 'shop', threshold: 18, queryMode: 'pex' };
const decided = {
  state: 'decided',
  decision: 'APPROVED',
  reason: 'over 18',
  checks: { proof: 'OK', revocation: 'OK', expiry: 'NOK' },
};

test('sites', () => assert.deepEqual(SITES, ['verifier', 'social', 'shop']));

test('records a final result once, with no holder data', () => {
  let t = 1_000;
  const r = recentChecks({ now: () => t });
  r.record('tx1', session, { state: 'waiting' });
  r.record('tx1', session, decided);
  r.record('tx1', session, decided);
  assert.deepEqual(r.list(), [
    {
      at: new Date(1_000).toISOString(),
      site: 'shop',
      threshold: 18,
      wallet: 'inji',
      outcome: 'APPROVED',
      checksPassed: 2,
      checksTotal: 3,
      reason: 'over 18',
    },
  ]);
  assert.equal(JSON.stringify(r.list()).includes('tx1'), false);
});

test('a decline is recorded as declined, not denied', () => {
  const r = recentChecks();
  r.record('tx2', { ...session, queryMode: 'dcql' }, { state: 'declined', reason: 'holder declined' });
  assert.deepEqual([r.list()[0].outcome, r.list()[0].wallet], ['declined', 'openid']);
});

test('keeps the newest 50 and forgets after 24 h', () => {
  let t = 0;
  const r = recentChecks({ now: () => t });
  for (let i = 0; i < 60; i++) {
    t = i;
    r.record(`tx${i}`, session, decided);
  }
  assert.equal(r.list().length, 50);
  assert.equal(r.list()[0].at, new Date(59).toISOString());
  t = 59 + 86_400_001;
  assert.equal(r.list().length, 0);
});
