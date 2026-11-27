// What the /try/ pages show for an API answer. Pure, unit-tested
// (tests/unit/try-site.test.mjs).

export const SITE_THRESHOLDS = { social: 16, shop: 18 };

/**
 * The visitor-facing outcome of a verifier session poll.
 * @returns {'allowed'|'refused'|'declined'|'expired'|'failed'|'waiting'}
 */
export function siteOutcome(httpStatus, body) {
  if (httpStatus === 404) return 'expired';
  if (httpStatus !== 200 || !body) return 'failed';
  switch (body.state) {
    case 'waiting':
      return 'waiting';
    case 'declined':
    case 'cancelled':
      return 'declined';
    case 'decided':
      return body.decision === 'APPROVED' ? 'allowed' : 'refused';
    case 'expired':
      return 'expired';
    default:
      return 'failed';
  }
}

/** The i18n key for a failed POST /api/try/citizens. */
export function tryErrorKey(httpStatus, body) {
  if (httpStatus === 429) return 'try.error.rateLimited';
  if (httpStatus === 503 && body?.error === 'demo_busy') return 'try.error.busy';
  if (httpStatus === 400 && ['name', 'dateOfBirth', 'wallet'].includes(body?.field)) {
    return `try.error.invalid.${body.field}`;
  }
  return 'try.error.generic';
}

/**
 * Link to a demo site. Once a credential has been issued, the site must ask in
 * that credential's format: switching the wallet radio afterwards would send a
 * Paradym (SD-JWT) holder a request only an Inji (ldp_vc) credential can answer.
 */
export function siteLink(site, { issuedWallet, chosenWallet, lang }) {
  return `/try/${site}/?wallet=${encodeURIComponent(issuedWallet || chosenWallet)}&lang=${encodeURIComponent(lang)}`;
}
