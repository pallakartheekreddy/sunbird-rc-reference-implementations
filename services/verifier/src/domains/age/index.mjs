// Age domain module.
//
// The whole Age-specific surface of the verifier: which claim to ask for, and
// what decision a verified claim produces. Everything else in services/verifier
// is generic and is what iterations 2 and 3 build on.
//
// It receives only verified, allowlisted, minimum-disclosure claims. It never
// sees a raw presentation, an undisclosed claim, or an unverified credential.

/**
 * The thresholds a service may ask about. Must match the issuer's
 * AGE_THRESHOLDS: asking for a threshold the credential does not carry would
 * fail every presentation at the DCQL step.
 */
export const SUPPORTED_THRESHOLDS = [13, 16, 18, 21];

/** What a caller that names no threshold gets: the original Age behaviour. */
export const DEFAULT_THRESHOLD = 18;

/** The default threshold's claim, kept for callers written before thresholds. */
export const AGE_CLAIM = 'ageOver18';

/**
 * The one derived assertion a threshold is answered by.
 *
 * Rejects rather than rounds: a service that asked for 17 and was silently
 * given 16 or 18 would be applying a rule it never chose.
 *
 * @param {number} threshold
 * @returns {string}
 */
export function ageClaim(threshold) {
  if (!SUPPORTED_THRESHOLDS.includes(threshold)) {
    throw Object.assign(new Error(`unsupported age threshold: ${String(threshold)}`), {
      code: 'UNSUPPORTED_THRESHOLD',
    });
  }
  return `ageOver${threshold}`;
}

/**
 * Reads a threshold from a query-string value. Absent → the default.
 * Only plain digits are read, so " 18", "18.0" or "1e1" can't be coerced
 * into a threshold the caller didn't write.
 *
 * @param {string|null|undefined} raw
 * @returns {number}
 */
export function parseThreshold(raw) {
  if (raw === null || raw === undefined || raw === '') return DEFAULT_THRESHOLD;
  const threshold = /^\d{1,3}$/.test(raw) ? Number(raw) : NaN;
  ageClaim(threshold); // throws UNSUPPORTED_THRESHOLD
  return threshold;
}

/**
 * Minimum disclosure for an age-restricted service: one derived assertion.
 *
 * @param {{vct: string, threshold?: number}} config
 * @returns {{id: string, vct: string, claims: string[]}}
 */
export function ageCredentialRequest({ vct, threshold = DEFAULT_THRESHOLD }) {
  return { id: 'age_cred', vct, claims: [ageClaim(threshold)] };
}

/**
 * @param {Record<string, unknown>} claims verified, minimum-disclosure claims
 * @param {number} [threshold]
 * @returns {{decision: 'APPROVED'|'DENIED', reason: string}}
 */
export function decideAge(claims, threshold = DEFAULT_THRESHOLD) {
  const claim = ageClaim(threshold);
  const asserted = claims?.[claim];

  // Strict boolean. A string "false" is truthy in JavaScript, and an age gate
  // that approves on the string "false" is the exact class of bug this
  // iteration exists to prove absent. A non-boolean, including a presentation
  // that answers a different threshold, means the credential did not carry
  // what was asked. That is a verification problem rather than a business
  // answer, so it is refused, not denied.
  if (typeof asserted !== 'boolean') {
    throw Object.assign(new Error(`${claim} is not a boolean assertion`), { code: 'MALFORMED_CLAIM' });
  }

  return asserted
    ? { decision: 'APPROVED', reason: `issuer asserts the holder is over ${threshold}` }
    : { decision: 'DENIED', reason: `issuer asserts the holder is not over ${threshold}` };
}
