// The age derivation is the issuer's privacy-critical step: it is what lets the
// verifier learn "over 18" instead of a date of birth. Frozen "today" values
// throughout, so the boundary cases mean the same thing in every run.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  completedYears,
  parseCalendarDate,
  deriveAgeClaims,
  AGE_THRESHOLDS,
  ageClaimsValidUntil,
} from '../../services/age-issuer/src/age-claims.mjs';

const on = (iso) => parseCalendarDate(iso);

test('completedYears: the day before, the day of, and the day after an 18th birthday', () => {
  const birth = on('2008-03-15');
  assert.equal(completedYears(birth, on('2026-03-14')), 17, 'day before -> still 17');
  assert.equal(completedYears(birth, on('2026-03-15')), 18, 'birthday itself -> 18');
  assert.equal(completedYears(birth, on('2026-03-16')), 18, 'day after -> 18');
});

test('completedYears: a leap-day birth has a birthday in common years too', () => {
  const birth = on('2008-02-29');
  // 2026 has no 29 February. Someone born on a leap day is 18 by 1 March at the
  // latest; the elapsed-milliseconds approach gets this wrong in one direction
  // or the other depending on how many leap years fell in between.
  assert.equal(completedYears(birth, on('2026-02-28')), 17);
  assert.equal(completedYears(birth, on('2026-03-01')), 18);
});

test('completedYears: month boundary does not leak into the year count', () => {
  const birth = on('2008-12-31');
  assert.equal(completedYears(birth, on('2026-01-01')), 17);
  assert.equal(completedYears(birth, on('2026-12-31')), 18);
});

test('parseCalendarDate rejects anything that is not a real calendar date', () => {
  for (const bad of ['2008-02-30', '2008-13-01', '2008-00-10', '08-01-01', '2008/01/01', '', null, undefined, '2008-1-1']) {
    assert.throws(() => parseCalendarDate(bad), /calendar date/i, `should reject ${JSON.stringify(bad)}`);
  }
});

test('parseCalendarDate does not shift the day for timezone reasons', () => {
  // new Date('2008-03-15') is midnight UTC, which is the previous day west of
  // Greenwich. A date of birth is a calendar date, not an instant.
  assert.deepEqual(parseCalendarDate('2008-03-15'), { year: 2008, month: 3, day: 15 });
});

test('deriveAgeClaims asserts both thresholds, as booleans', () => {
  const claims = deriveAgeClaims(
    { citizenId: 'AGE-000001', name: 'Meera Nair', dateOfBirth: '1998-04-02' },
    new Date('2026-08-24T00:00:00Z'),
  );
  assert.equal(claims.ageOver18, true);
  assert.equal(claims.ageOver16, true);
  assert.equal(typeof claims.ageOver18, 'boolean', 'a string "true" would be truthy everywhere');
  // Carried so the holder has something to withhold: the credential is what
  // makes selective disclosure demonstrable rather than asserted.
  assert.equal(claims.name, 'Meera Nair');
  assert.equal(claims.dateOfBirth, '1998-04-02');
});

test('deriveAgeClaims: a minor gets ageOver18 present and false, never missing', () => {
  const claims = deriveAgeClaims(
    { citizenId: 'AGE-000002', name: 'Arjun Das', dateOfBirth: '2012-08-30' },
    new Date('2026-08-24T00:00:00Z'),
  );
  // Present-and-false is what lets the verifier reach a VERIFIED DENIED. A
  // missing claim would fail the DCQL check instead, which is a different
  // (wrong) answer to the question the verifier asked.
  assert.equal(claims.ageOver18, false);
  assert.equal('ageOver18' in claims, true);
});

test('deriveAgeClaims: over 16 but under 18', () => {
  const claims = deriveAgeClaims({ citizenId: 'X', dateOfBirth: '2009-01-01' }, new Date('2026-08-24T00:00:00Z'));
  assert.equal(claims.ageOver16, true);
  assert.equal(claims.ageOver18, false);
});

test('deriveAgeClaims refuses to invent an assertion without authoritative data', () => {
  assert.throws(
    () => deriveAgeClaims({ citizenId: 'AGE-000009', name: 'No DOB' }, new Date('2026-08-24T00:00:00Z')),
    /dateOfBirth/,
  );
  assert.throws(() => deriveAgeClaims(null), /registry record/);
});

test('deriveAgeClaims rejects a future date of birth', () => {
  assert.throws(
    () => deriveAgeClaims({ citizenId: 'AGE-000010', dateOfBirth: '2030-01-01' }, new Date('2026-08-24T00:00:00Z')),
    /future dateOfBirth/,
  );
});

test('deriveAgeClaims asserts exactly the published thresholds: 16 and 18', () => {
  assert.deepEqual(AGE_THRESHOLDS, [16, 18]);
  // Aged 15 on the frozen date: under both.
  const claims = deriveAgeClaims({ citizenId: 'X', dateOfBirth: '2011-01-01' }, new Date('2026-08-24T00:00:00Z'));
  assert.deepEqual([claims.ageOver16, claims.ageOver18], [false, false]);
  assert.deepEqual(Object.keys(claims).filter((k) => k.startsWith('ageOver')).sort(), ['ageOver16', 'ageOver18']);
});

test('ageClaimsValidUntil: the birthday a "not over N" answer becomes wrong', () => {
  // The credential must expire then. Same rule as oid4vc-service's
  // registry-derived validUntil, so both issuance paths agree.
  const now = new Date('2026-11-26T10:00:00Z');
  assert.equal(ageClaimsValidUntil('2009-05-26', now), '2027-05-26', '17: until 18');
  assert.equal(ageClaimsValidUntil('2011-03-01', now), '2027-03-01', '15: until 16, the earliest flip');
  assert.equal(ageClaimsValidUntil('1990-01-01', now), undefined, 'adult: no expiry');
  assert.equal(ageClaimsValidUntil('2008-11-26', now), undefined, 'turns 18 today: already over 18');
  assert.equal(ageClaimsValidUntil('2008-11-27', now), '2026-11-27', 'turns 18 tomorrow');
  assert.equal(ageClaimsValidUntil('2012-02-29', now), '2028-02-29', 'leap-day 16th birthday in a leap year');
  assert.throws(() => ageClaimsValidUntil('not-a-date', now));
});
