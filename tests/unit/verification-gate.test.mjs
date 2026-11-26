// The gate between "a wallet answered" and "a business rule may run".

import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateChecks, REQUIRED_CHECKS } from '../../services/verifier/src/core/checks.mjs';
import { assertExactClaims } from '../../services/verifier/src/core/claim-policy.mjs';
import { sessionStore } from '../../services/verifier/src/core/sessions.mjs';

const allOk = () => Object.fromEntries(REQUIRED_CHECKS.map((name) => [name, 'OK']));

test('passes only when every required check is OK', () => {
  assert.deepEqual(evaluateChecks({ status: 'verified', verified: true, checks: allOk() }), { ok: true });
});

test('a single failed check fails the whole gate, and is named', () => {
  for (const name of REQUIRED_CHECKS) {
    const checks = { ...allOk(), [name]: 'NOK' };
    const result = evaluateChecks({ status: 'verified', verified: true, checks });
    assert.equal(result.ok, false, `${name}: NOK must fail the gate`);
    assert.equal(result.failedCheck, name);
  }
});

test('a MISSING check is a failure, not a pass', () => {
  // The difference matters: an upstream version that stops reporting a check
  // would otherwise silently widen what this verifier accepts.
  for (const name of REQUIRED_CHECKS) {
    const checks = allOk();
    delete checks[name];
    const result = evaluateChecks({ status: 'verified', verified: true, checks });
    assert.equal(result.ok, false, `missing ${name} must fail the gate`);
    assert.equal(result.failedCheck, name);
  }
});

test('holder binding and audience are among the required checks', () => {
  // Named explicitly so that dropping one from the list is a test change rather
  // than a silent policy change.
  for (const required of ['holderSignature', 'nonce', 'audience', 'credentialSignatures', 'holderBinding', 'revocation', 'expiry', 'dcql']) {
    assert.ok(REQUIRED_CHECKS.includes(required), `${required} must be required`);
  }
});

test('verified:false never passes, whatever the checks say', () => {
  assert.equal(evaluateChecks({ status: 'failed', verified: false, checks: allOk() }).ok, false);
  assert.equal(evaluateChecks({ status: 'verified', checks: allOk() }).ok, false);
  assert.equal(evaluateChecks(undefined).ok, false);
});

test('pending is distinguished from rejected', () => {
  // The UI has to keep waiting rather than show a refusal.
  assert.deepEqual(evaluateChecks({ status: 'pending' }), { ok: false, reason: 'pending' });
});

test('claim policy: exactly the expected claims', () => {
  assert.deepEqual(assertExactClaims(['ageOver18', 'iss'], { ageOver18: true, iss: 'did:web:x' }), { ok: true });
});

test('claim policy rejects an unrequested claim', () => {
  const result = assertExactClaims(['ageOver18', 'iss'], { ageOver18: true, iss: 'did:web:x', dateOfBirth: '1998-04-02' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /unrequested claims: dateOfBirth/);
});

test('claim policy rejects a missing claim', () => {
  const result = assertExactClaims(['ageOver18', 'iss'], { iss: 'did:web:x' });
  assert.equal(result.ok, false);
  assert.match(result.reason, /missing requested claims: ageOver18/);
});

test('sessions expire, and do not accumulate a history of holder activity', () => {
  let now = 1_000_000;
  const sessions = sessionStore({ ttlSeconds: 300, now: () => now });
  sessions.create({ id: 'txn-1', requestId: 'age_cred', expectedClaims: ['ageOver18', 'iss'], qrData: 'openid4vp://' });
  assert.equal(sessions.get('txn-1').requestId, 'age_cred');
  assert.equal(sessions.size, 1);

  now += 301_000;
  assert.equal(sessions.get('txn-1'), undefined, 'an expired session must not be readable');
  assert.equal(sessions.size, 0, 'and must not be retained');
});

test('a PEX session requires the pex check in place of dcql, and nothing else changes', () => {
  // The query check names which query language the wallet satisfied. A PEX
  // transaction never reports `dcql`, and a DCQL one never reports `pex`.
  const pexChecks = { ...allOk(), pex: 'OK' };
  delete pexChecks.dcql;
  assert.deepEqual(evaluateChecks({ status: 'verified', verified: true, checks: pexChecks }, { query: 'pex' }), {
    ok: true,
  });
  // The PEX check is required, not optional.
  const missing = { ...pexChecks };
  delete missing.pex;
  const result = evaluateChecks({ status: 'verified', verified: true, checks: missing }, { query: 'pex' });
  assert.equal(result.failedCheck, 'pex');
  // And the other required checks are still required on the PEX path.
  const noBinding = { ...pexChecks };
  delete noBinding.holderBinding;
  assert.equal(
    evaluateChecks({ status: 'verified', verified: true, checks: noBinding }, { query: 'pex' }).failedCheck,
    'holderBinding',
  );
});

test('a DCQL session is not satisfied by a pex check, and an unknown query mode is refused', () => {
  const pexChecks = { ...allOk(), pex: 'OK' };
  delete pexChecks.dcql;
  assert.equal(evaluateChecks({ status: 'verified', verified: true, checks: pexChecks }).failedCheck, 'dcql');
  assert.throws(() => evaluateChecks({ status: 'verified', verified: true, checks: allOk() }, { query: 'sql' }), /query/);
});
