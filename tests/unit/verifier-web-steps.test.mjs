// The "Behind the scenes" verification steps. What breaks for a reader if these
// fail: a rejected presentation shown with every tick green, or a check the page
// claims passed that the service never reported.

import test from 'node:test';
import assert from 'node:assert/strict';
import { STEP_IDS, stepStatuses, extraChecks } from '../../services/verifier-web/steps.js';

const ALL = {
  holderSignature: 'OK', nonce: 'OK', audience: 'OK', credentialSignatures: 'OK',
  holderBinding: 'OK', revocation: 'OK', expiry: 'OK', dcql: 'OK', algorithm: 'OK',
};
const st = (r) => Object.fromEntries(stepStatuses(r).map((s) => [s.id, s.status]));

test('the steps, in order', () => {
  assert.deepEqual(STEP_IDS, ['request', 'issuerSignature', 'holderSignature', 'holderBinding', 'revocation', 'expiry', 'algorithm', 'disclosure', 'trust', 'decision']);
  assert.deepEqual(stepStatuses({ state: 'decided', checks: ALL }).map((s) => s.id), STEP_IDS);
});

test('decided: every step ok', () => {
  assert.ok(Object.values(st({ state: 'decided', checks: ALL })).every((s) => s === 'ok'));
});

test('waiting / declined / cancelled / expired / idle: every step pending', () => {
  for (const state of ['waiting', 'declined', 'cancelled', 'expired', undefined]) {
    assert.ok(Object.values(st({ state, checks: ALL })).every((s) => s === 'pending'), String(state));
  }
});

test('pex satisfies the request step', () => {
  const { dcql, ...rest } = ALL;
  assert.equal(st({ state: 'decided', checks: { ...rest, pex: 'OK' } }).request, 'ok');
});

test('untrusted issuer fails trust; earlier ok, later pending', () => {
  const s = st({ state: 'rejected', checks: ALL, reason: 'issuer is not in the demo trust allowlist' });
  assert.equal(s.trust, 'fail');
  assert.equal(s.revocation, 'ok');
  assert.equal(s.disclosure, 'ok', 'the service checked disclosure before trust');
  assert.equal(s.decision, 'pending');
});

test('missing issuer identifier fails trust', () => {
  assert.equal(st({ state: 'rejected', checks: ALL, reason: 'presentation carried no issuer identifier' }).trust, 'fail');
});

test('over-disclosure, wrong type and no match fail disclosure', () => {
  for (const reason of ['presentation disclosed unrequested claims: name', 'presented credential is not of type AgeVerificationCredential', 'presentation matched no credential for this request']) {
    assert.equal(st({ state: 'rejected', checks: ALL, reason }).disclosure, 'fail', reason);
  }
});

test('algorithm rejection fails algorithm', () => {
  const { algorithm, ...checks } = ALL;
  const s = st({ state: 'rejected', checks, failedCheck: 'algorithm', reason: 'the signature algorithm is not approved' });
  assert.equal(s.algorithm, 'fail');
  assert.equal(s.trust, 'pending');
});

test('a failed upstream check fails its step', () => {
  const s = st({ state: 'rejected', checks: { ...ALL, revocation: 'NOK' }, failedCheck: 'revocation', reason: 'check revocation did not pass' });
  assert.equal(s.revocation, 'fail');
  assert.equal(s.holderBinding, 'ok');
  assert.equal(s.algorithm, 'pending');
});

test('a missing holder check fails the holder signature step', () => {
  const { nonce, ...checks } = ALL;
  assert.equal(st({ state: 'rejected', checks, failedCheck: 'nonce', reason: 'check nonce did not pass' }).holderSignature, 'fail');
});

test('unattributed rejection fails the decision step, never all-green', () => {
  const s = st({ state: 'rejected', checks: ALL, reason: 'something new' });
  assert.equal(s.decision, 'fail');
  assert.ok(Object.values(s).includes('fail'));
});

test('a rejected result with no checks at all still shows a failure', () => {
  assert.equal(st({ state: 'rejected', reason: 'verification failed' }).request, 'fail');
});

test('extraChecks lists unmapped keys', () => {
  assert.deepEqual(extraChecks({ ...ALL, mdocDeviceAuth: 'OK' }), ['mdocDeviceAuth']);
  assert.deepEqual(extraChecks(undefined), []);
});

test('a disclosure rejection never shows trust as passed: the service checks disclosure first', () => {
  // readSession runs the type check, "matched no credential" and the exact-
  // disclosure check BEFORE the trust check, so on these rejections trust never ran.
  for (const reason of ['presentation disclosed unrequested claims: birthdate', 'presentation matched no credential for this request', 'presented credential is not of type X']) {
    const s = st({ state: 'rejected', checks: ALL, reason });
    assert.equal(s.disclosure, 'fail', reason);
    assert.equal(s.trust, 'pending', reason);
  }
});

test('an expired credential fails the expiry step, not the signature', () => {
  // oid4vc-service checks expiry before the proof and stops there, so later
  // checks are absent; the cross goes on "Not expired".
  const s = st({ state: 'rejected', checks: { expiry: 'NOK' }, reason: 'verification failed' });
  assert.equal(s.expiry, 'fail');
  assert.equal(s.issuerSignature, 'pending');
  assert.equal(s.trust, 'pending');
});

