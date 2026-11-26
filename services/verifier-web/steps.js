// Turns a verifier-service result into the "Behind the scenes" step list.
//
// A tick is drawn only for what the service reported as passing. Anything the
// service did not report is pending, never assumed; a rejection always shows a
// failed step, even one this map cannot attribute.

export const STEP_IDS = [
  'request',
  'issuerSignature',
  'holderSignature',
  'holderBinding',
  'revocation',
  'algorithm',
  'trust',
  'disclosure',
  'decision',
];

/** Service check keys behind each step. `any`: one suffices; otherwise all are needed. */
const CHECKS = {
  request: { any: ['dcql', 'pex'] },
  issuerSignature: { all: ['credentialSignatures'] },
  holderSignature: { all: ['holderSignature', 'nonce', 'audience'] },
  holderBinding: { all: ['holderBinding'] },
  revocation: { all: ['revocation'] },
  algorithm: { all: ['algorithm'] },
};

const MAPPED = new Set(Object.values(CHECKS).flatMap((c) => c.any || c.all));

/** Steps the service reports through its rejection reason rather than a check. */
const REASONS = [
  { step: 'trust', pattern: /allowlist|issuer identifier/i },
  { step: 'disclosure', pattern: /claims|not of type|matched no/i },
];

function checkStatus(spec, checks) {
  const keys = spec.any || spec.all;
  const values = keys.map((k) => checks[k]);
  if (spec.any) {
    if (values.includes('OK')) return 'ok';
    return values.some((v) => v !== undefined) ? 'fail' : 'absent';
  }
  if (values.every((v) => v === 'OK')) return 'ok';
  return values.some((v) => v !== undefined && v !== 'OK') ? 'fail' : 'absent';
}

/**
 * @param {{state?: string, checks?: Record<string,string>, failedCheck?: string, reason?: string}} result
 * @returns {Array<{id: string, status: 'pending'|'ok'|'fail'}>}
 */
export function stepStatuses(result = {}) {
  const { state, checks = {}, failedCheck, reason = '' } = result;
  if (state === 'decided') return STEP_IDS.map((id) => ({ id, status: 'ok' }));
  if (state !== 'rejected') return STEP_IDS.map((id) => ({ id, status: 'pending' }));

  const raw = Object.fromEntries(STEP_IDS.map((id) => [id, CHECKS[id] ? checkStatus(CHECKS[id], checks) : 'ok']));
  raw.decision = 'absent';

  // Which step failed, most specific evidence first.
  const byCheck = failedCheck && STEP_IDS.find((id) => (CHECKS[id]?.any || CHECKS[id]?.all || []).includes(failedCheck));
  const byReason = REASONS.find((r) => r.pattern.test(reason))?.step;
  const failed =
    byCheck ||
    byReason ||
    STEP_IDS.find((id) => raw[id] === 'fail') ||
    STEP_IDS.find((id) => raw[id] === 'absent' && id !== 'decision') ||
    'decision';

  const at = STEP_IDS.indexOf(failed);
  return STEP_IDS.map((id, i) => ({
    id,
    status: i < at ? (raw[id] === 'ok' ? 'ok' : 'pending') : i === at ? 'fail' : 'pending',
  }));
}

/**
 * Check keys no step covers, shown by their raw name so a new upstream check is
 * visible rather than silently dropped.
 *
 * @param {Record<string,string>|undefined} checks
 * @returns {string[]}
 */
export function extraChecks(checks) {
  return Object.keys(checks || {}).filter((k) => !MAPPED.has(k));
}
