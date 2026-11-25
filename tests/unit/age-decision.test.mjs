// The Age business rule. Small on purpose — it is the only Age-specific logic in
// the verifier, and it must never be the thing that decides whether a
// presentation was genuine.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAge,
  ageCredentialRequest,
  ageClaim,
  AGE_CLAIM,
  DEFAULT_THRESHOLD,
  SUPPORTED_THRESHOLDS,
  parseThreshold,
} from '../../services/verifier/src/domains/age/index.mjs';

test('APPROVED only for a boolean true', () => {
  assert.deepEqual(decideAge({ ageOver18: true }).decision, 'APPROVED');
});

test('DENIED for a boolean false — a verified answer, not a failure', () => {
  const outcome = decideAge({ ageOver18: false });
  assert.equal(outcome.decision, 'DENIED');
  assert.match(outcome.reason, /not over 18/);
});

test('a non-boolean assertion is refused, not silently approved', () => {
  // "false" is a truthy string in JavaScript. An age gate that approves on it is
  // exactly the class of bug this iteration has to prove absent.
  for (const value of ['true', 'false', 1, 0, null, undefined, {}, []]) {
    assert.throws(() => decideAge({ ageOver18: value }), /not a boolean/, `should refuse ${JSON.stringify(value)}`);
  }
});

test('an empty claim set is refused', () => {
  assert.throws(() => decideAge({}), /not a boolean/);
  assert.throws(() => decideAge(undefined), /not a boolean/);
});

test('the credential request asks for one claim and pins the credential type', () => {
  const request = ageCredentialRequest({ vct: 'http://localhost/vct/age-verification-credential' });
  assert.deepEqual(request.claims, [AGE_CLAIM]);
  assert.equal(request.claims.length, 1, 'minimum disclosure means exactly one domain claim');
  assert.equal(request.vct, 'http://localhost/vct/age-verification-credential');
});

test('every supported threshold maps to its own claim', () => {
  assert.deepEqual(SUPPORTED_THRESHOLDS, [13, 16, 18, 21]);
  assert.equal(ageClaim(13), 'ageOver13');
  assert.equal(ageClaim(21), 'ageOver21');
  assert.equal(DEFAULT_THRESHOLD, 18);
});

test('an unsupported threshold is rejected, never rounded to a supported one', () => {
  for (const value of [17, 0, -18, 18.5, '18', null, NaN]) {
    assert.throws(() => ageClaim(value), /unsupported age threshold/, `should reject ${String(value)}`);
  }
});

test('the request asks for the threshold\'s claim only', () => {
  const request = ageCredentialRequest({ vct: 'v', threshold: 13 });
  assert.deepEqual(request.claims, ['ageOver13']);
});

test('the decision reads the requested threshold, not ageOver18', () => {
  assert.equal(decideAge({ ageOver21: true }, 21).decision, 'APPROVED');
  const denied = decideAge({ ageOver21: false }, 21);
  assert.equal(denied.decision, 'DENIED');
  assert.match(denied.reason, /not over 21/);
  assert.equal(decideAge({ ageOver16: true }, 16).decision, 'APPROVED');
});

test('a 21+ check answered with only ageOver18 is refused, not approved', () => {
  // DCQL already stops a wallet answering with the wrong claim; this is the backstop.
  assert.throws(() => decideAge({ ageOver18: true }, 21), /ageOver21 is not a boolean/);
});

test('parseThreshold: absent means the default, digits mean that threshold', () => {
  assert.equal(parseThreshold(null), 18);
  assert.equal(parseThreshold(''), 18);
  assert.equal(parseThreshold('21'), 21);
  assert.equal(parseThreshold('13'), 13);
});

test('parseThreshold: anything else is rejected with a code the server maps to 400', () => {
  for (const raw of ['17', '18.0', ' 18', '0x12', 'eighteen', '-18', '1e1']) {
    assert.throws(() => parseThreshold(raw), (err) => err.code === 'UNSUPPORTED_THRESHOLD', raw);
  }
});
