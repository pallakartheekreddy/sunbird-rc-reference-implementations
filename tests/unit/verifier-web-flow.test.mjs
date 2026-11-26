// Page flow guards. What breaks for a reader if these fail: a network error
// leaves a dead Start button; a late poll answer turns "cancelled" into
// "approved" for a session the server will no longer decide.

import test from 'node:test';
import assert from 'node:assert/strict';
import { request, pollStillCurrent, startFailure } from '../../services/verifier-web/flow.js';

test('request returns status and parsed body', async () => {
  const fake = async () => ({ status: 201, json: async () => ({ sessionId: 's1' }) });
  assert.deepEqual(await request(fake, '/x'), { status: 201, body: { sessionId: 's1' } });
});

test('request turns a network error into status 0, never a rejection', async () => {
  const offline = async () => { throw new TypeError('Failed to fetch'); };
  assert.deepEqual(await request(offline, '/x'), { status: 0, body: {} });
});

test('request tolerates a non-JSON body', async () => {
  const html = async () => ({ status: 502, json: async () => { throw new SyntaxError('bad'); } });
  assert.deepEqual(await request(html, '/x'), { status: 502, body: {} });
});

test('a poll answer only counts while that session is still the one waiting', () => {
  assert.equal(pollStillCurrent({ view: 'waiting', sessionId: 's1' }, 's1'), true);
  assert.equal(pollStillCurrent({ view: 'result', sessionId: 's1' }, 's1'), false, 'cancelled meanwhile');
  assert.equal(pollStillCurrent({ view: 'waiting', sessionId: 's2' }, 's1'), false, 'a newer session');
});

test('a failure to START is its own outcome, not a failed presentation', () => {
  const r = startFailure(502, {});
  assert.equal(r.state, 'unavailable');
  assert.match(r.reason, /502/);
  assert.equal(startFailure(0, {}).reason, 'the verifier service could not be reached');
  assert.equal(startFailure(400, { error: 'unsupported_threshold' }).reason, 'unsupported_threshold');
});
