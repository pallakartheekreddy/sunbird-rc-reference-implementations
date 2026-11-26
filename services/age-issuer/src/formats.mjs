// The formats the age credential is published in (scripts/credential-specs.py):
// SD-JWT VC for OpenID4VP 1.0 wallets (Paradym, walt.id), W3C ldp_vc for
// Inji Wallet and apps embedding the Inji SDK.
export const OFFER_FORMATS = ['vc+sd-jwt', 'ldp_vc'];

/**
 * The format to make an offer in: the one asked for, or the default.
 *
 * @param {unknown} requested
 * @param {string} fallback
 * @returns {string}
 */
export function offerFormat(requested, fallback) {
  if (requested === undefined || requested === null || requested === '') return fallback;
  if (typeof requested !== 'string' || !OFFER_FORMATS.includes(requested)) {
    throw Object.assign(new Error(`unsupported format; expected one of ${OFFER_FORMATS.join(', ')}`), { status: 400 });
  }
  return requested;
}
