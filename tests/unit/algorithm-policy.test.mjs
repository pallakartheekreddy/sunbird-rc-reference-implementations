// The approved-algorithm policy, checked as a unit (REQUIREMENTS §8).
//
// Iteration 01 recorded this allowlist as a deviation rather than shipping it,
// because `alg` was not observable and a policy field for it would have been a
// control that did nothing. oid4vc-service now reports the algorithms it observed
// as `algs`, so these tests are about the control actually biting — including the
// cases that are easy to get wrong: an ABSENT algorithm and a MALFORMED one, both
// of which must be refusals rather than passes.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadAlgorithmPolicy } from '../../services/verifier/src/core/algorithms.mjs';

/** Writes a policy file and loads it, so the file format is under test too. */
function policy(approved) {
  const dir = mkdtempSync(join(tmpdir(), 'algpolicy-'));
  const file = join(dir, 'algorithms.json');
  writeFileSync(file, JSON.stringify({ approved }));
  return loadAlgorithmPolicy({ file });
}

/** The policy this repository actually ships. */
function shipped() {
  return loadAlgorithmPolicy({ file: 'config/policy/algorithms.json' });
}

describe('the approved-algorithm policy', () => {
  test('the shipped policy approves ES256 and EdDSA, and nothing else', () => {
    // EdDSA for ldp_vc: credentials-service's Ed25519Signature2020 proofs, which
    // oid4vc-service reports as EdDSA, and Inji wallets' Ed25519 holder keys.
    assert.deepEqual(shipped().approved, ['ES256', 'EdDSA']);
  });

  test('an Inji ldp_vc presentation (ES256 holder proof, Ed25519 credential) is accepted', () => {
    assert.equal(shipped().check(['ES256', 'EdDSA']).ok, true);
  });

  test('an unrecognised proof suite, reported by name, is refused', () => {
    // oid4vc-service reports a suite it cannot map as its own type name.
    assert.equal(shipped().check(['ES256', 'BbsBlsSignature2020']).ok, false);
  });

  test('an ES256 presentation is accepted', () => {
    const result = shipped().check(['ES256']);
    assert.equal(result.ok, true);
    assert.deepEqual(result.algorithms, ['ES256']);
  });

  test('both signatures being ES256 is accepted', () => {
    // A presentation is an issuer signature plus a holder binding signature, and
    // upstream reports the set it observed across both.
    assert.equal(shipped().check(['ES256', 'ES256']).ok, true);
  });

  test('an unapproved algorithm is rejected', () => {
    for (const alg of ['ES384', 'ES512', 'RS256', 'PS256', 'ES256K', 'HS256']) {
      const result = shipped().check([alg]);
      assert.equal(result.ok, false, `${alg} must not be accepted`);
      assert.match(result.reason, /not approved/);
      assert.match(result.diagnostic, new RegExp(alg));
    }
  });

  test('`none` is rejected like any other unapproved algorithm', () => {
    // The unsecured-JWS attack. It is well-formed as a token, which is exactly
    // why an allowlist has to be positive rather than a blocklist.
    const result = shipped().check(['none']);
    assert.equal(result.ok, false);
    assert.match(result.reason, /not approved/);
  });

  test('one approved algorithm does not excuse an unapproved one beside it', () => {
    // The failure this test exists for: accepting the pair because half of it is
    // ES256 would let the other half be anything at all.
    const result = shipped().check(['ES256', 'HS256']);
    assert.equal(result.ok, false);
    assert.match(result.diagnostic, /HS256/);
  });

  test('a missing algorithm is rejected, not defaulted', () => {
    // Upstream omits an alg it could not parse rather than guessing, so an empty
    // list means "we could not observe one". Accepting that would reduce the
    // control to "reject only the algorithms we happen to recognise".
    for (const absent of [undefined, null, [], {}, '']) {
      const result = shipped().check(absent);
      assert.equal(result.ok, false, `${JSON.stringify(absent)} must not be accepted`);
      assert.match(result.reason, /could not be determined/);
    }
  });

  test('a malformed algorithm is rejected', () => {
    for (const bad of [['ES 256'], ['ES256; DROP'], ['a'], ['x'.repeat(40)], [42], [null], [{ alg: 'ES256' }]]) {
      const result = shipped().check(bad);
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must not be accepted`);
      assert.match(result.reason, /malformed|not approved/);
    }
  });

  test('a malformed algorithm is not echoed back unbounded', () => {
    // The value is attacker-influenced, so the diagnostic quotes it and caps it.
    const result = shipped().check(['x'.repeat(500)]);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostic.length < 120, 'the diagnostic must not carry 500 characters of input');
  });

  test('a policy approving nothing refuses to load', () => {
    // An empty allowlist would refuse every presentation, which is
    // indistinguishable from the stack being broken unless it says why.
    assert.throws(() => policy([]), /approves no algorithms/);
  });

  test('a policy listing a malformed algorithm refuses to load', () => {
    assert.throws(() => policy(['ES 256']), /malformed algorithm/);
  });

  test('a widened policy accepts what it lists, and still nothing else', () => {
    // Proves the allowlist is data rather than a hardcoded ES256 check.
    const wider = policy(['ES256', 'EdDSA']);
    assert.equal(wider.check(['EdDSA']).ok, true);
    assert.equal(wider.check(['ES256', 'EdDSA']).ok, true);
    assert.equal(wider.check(['RS256']).ok, false);
  });
});
