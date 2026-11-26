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

/**
 * The derived claims narrowed to what the credential's schema declares.
 *
 * The age credential is published as two schemas: SD-JWT (age answers plus
 * name and date of birth as withheld, selectively-disclosable claims) and
 * ldp_vc (age answers only, because a W3C ldp_vc is presented whole). Issuing
 * by the schema keeps the ldp_vc minimal without the issuer knowing why.
 *
 * @param {Record<string, unknown>} claims derived from the registry record
 * @param {string[]|undefined|null} schemaProperties
 * @returns {Record<string, unknown>}
 */
export function claimsForSchema(claims, schemaProperties) {
  if (!Array.isArray(schemaProperties) || schemaProperties.length === 0) {
    throw new Error('credential schema declares no claims; refusing to issue');
  }
  return Object.fromEntries(Object.entries(claims).filter(([name]) => schemaProperties.includes(name)));
}
