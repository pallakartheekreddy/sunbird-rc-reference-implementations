// An offer carries only the claims its credential schema declares. What breaks
// if this fails: the ldp_vc age credential (no selective disclosure) carries the
// holder's name and date of birth, and Inji-based wallets present them in full,
// so they reach the verification service although only ageOver16 was asked for.

import test from 'node:test';
import assert from 'node:assert/strict';
import { claimsForSchema } from '../../services/age-issuer/src/formats.mjs';

const derived = { ageOver16: true, ageOver18: false, name: 'Dana Okafor', dateOfBirth: '2009-05-26' };

test('the ldp_vc schema gets only the age answers', () => {
  assert.deepEqual(claimsForSchema(derived, ['ageOver16', 'ageOver18']), { ageOver16: true, ageOver18: false });
});

test('the SD-JWT schema keeps name and date of birth as withheld, disclosable claims', () => {
  assert.deepEqual(claimsForSchema(derived, ['name', 'ageOver16', 'ageOver18', 'dateOfBirth']), derived);
});

test('false is kept, never dropped as falsy', () => {
  assert.equal('ageOver18' in claimsForSchema(derived, ['ageOver18']), true);
});

test('a schema that declares no properties is refused rather than issuing everything', () => {
  for (const props of [[], undefined, null]) {
    assert.throws(() => claimsForSchema(derived, props), /declares no claims/);
  }
});
