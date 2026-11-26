// Derivation of the age assertions that go into an AgeVerificationCredential.
//
// This is the privacy-critical half of the issuer: the verifier is meant to
// learn "this person is over 18", not "this person was born on 1998-04-02". The
// derivation therefore happens HERE, on the issuer side, against the
// authoritative registry record — never in the wallet, and never from a claim a
// caller supplied.
//
// Pure functions, no I/O, so the truth table is unit-testable without a stack.

/**
 * Whole years elapsed between two calendar dates.
 *
 * Compares calendar fields rather than elapsed milliseconds. Subtracting
 * timestamps and dividing by 365.25 days is wrong for the case that matters
 * most here — someone whose birthday is today, or who was born on 29 February —
 * and "wrong on your 18th birthday" is exactly the bug an age check cannot have.
 *
 * @param {{year:number, month:number, day:number}} birth
 * @param {{year:number, month:number, day:number}} on
 * @returns {number}
 */
export function completedYears(birth, on) {
  let years = on.year - birth.year;
  const beforeBirthday =
    on.month < birth.month || (on.month === birth.month && on.day < birth.day);
  if (beforeBirthday) years -= 1;
  return years;
}

/**
 * Parses a strict ISO calendar date (YYYY-MM-DD) into its fields.
 *
 * Deliberately NOT `new Date(s)`: that resolves to an instant, so the day can
 * shift by one depending on the container's timezone, and it happily accepts
 * garbage like "2001-13-45" by rolling it over. A date of birth is a calendar
 * date, not a moment.
 *
 * @param {string} value
 * @returns {{year:number, month:number, day:number}}
 */
export function parseCalendarDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) {
    throw new Error(`not an ISO calendar date (YYYY-MM-DD): ${JSON.stringify(value)}`);
  }
  const [, y, m, d] = match;
  const date = { year: Number(y), month: Number(m), day: Number(d) };
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) {
    throw new Error(`impossible calendar date: ${value}`);
  }
  // Round-trip through UTC to reject 2001-02-30 and friends, which the range
  // check above lets through.
  const utc = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    utc.getUTCFullYear() !== date.year ||
    utc.getUTCMonth() + 1 !== date.month ||
    utc.getUTCDate() !== date.day
  ) {
    throw new Error(`impossible calendar date: ${value}`);
  }
  return date;
}

/**
 * Thresholds asserted in every AgeVerificationCredential: the minimum age for
 * online services (16) and adulthood (18).
 * Must match the verifier's SUPPORTED_THRESHOLDS and the published schema.
 */
export const AGE_THRESHOLDS = [16, 18];

/**
 * Builds the credential claims for one registry record.
 *
 * `name` and `dateOfBirth` are included as disclosable claims on purpose: they
 * are what the holder chooses NOT to reveal when the verifier asks only for
 * ageOver18. A credential carrying nothing but the answer would make selective
 * disclosure untestable.
 *
 * @param {{citizenId?:string, name?:string, dateOfBirth?:string}} record
 * @param {Date} [now]
 * @returns {{ageOver16:boolean, ageOver18:boolean, name:string, dateOfBirth:string}}
 */
export function deriveAgeClaims(record, now = new Date()) {
  if (!record || typeof record !== 'object') throw new Error('no registry record');
  if (!record.dateOfBirth) {
    throw new Error(
      `AgeCitizen ${record.citizenId ?? '(unknown)'} has no dateOfBirth; refusing to issue an ` +
        'age assertion that is not derived from authoritative data',
    );
  }
  const birth = parseCalendarDate(record.dateOfBirth);
  const today = {
    year: now.getUTCFullYear(),
    month: now.getUTCMonth() + 1,
    day: now.getUTCDate(),
  };
  const age = completedYears(birth, today);
  if (age < 0) {
    throw new Error(`AgeCitizen ${record.citizenId} has a future dateOfBirth: ${record.dateOfBirth}`);
  }

  const claims = { name: String(record.name ?? ''), dateOfBirth: record.dateOfBirth };
  for (const threshold of AGE_THRESHOLDS) {
    claims[`ageOver${threshold}`] = age >= threshold;
  }
  return claims;
}
