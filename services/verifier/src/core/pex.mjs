// Presentation Exchange (DIF PEX v2) request construction, for wallets that
// present W3C ldp_vc credentials and do not speak DCQL: Inji Wallet, and apps
// that embed the Inji SDK.
//
// The counterpart of dcql.mjs, built from the same request descriptors so a
// domain module states what it needs once. What differs is the wire format and
// one thing the format forces: an ldp_vc has no selectively-disclosable `iss`
// claim, so the issuer and the credential type are asked for as
// credential-level fields and mapped back by pexClaims() before any check runs.

import { ISSUER_CLAIM } from './dcql.mjs';

/** The W3C Data Integrity credential format, as PEX and OpenID4VP name it. */
export const LDP_VC_FORMAT = 'ldp_vc';

/**
 * The proof suite Sunbird RC's credentials-service signs ldp_vc credentials
 * with. Inji-based wallets read it from the descriptor's format to choose which
 * credential to offer.
 */
const LDP_PROOF_TYPES = ['Ed25519Signature2020'];

/**
 * A credential type name the wallet will use as a regex pattern: letters,
 * digits, spaces, `_` and `-` only, so it matches literally. Spaces because
 * oid4vc-service types an ldp_vc with its schema NAME ("Age Verification
 * Credential").
 */
const PLAIN_TYPE = /^[A-Za-z][A-Za-z0-9 _-]*$/;

/**
 * @param {Array<{id: string, credentialType?: string, claims: string[]}>} requests
 * @param {{purpose?: string}} [options]
 */
export function buildPresentationDefinition(requests, { purpose } = {}) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new Error('at least one credential request is required');
  }
  // Same rule as the DCQL request: present-but-blank is a bug in a policy.
  if (purpose !== undefined && purpose !== null && (typeof purpose !== 'string' || purpose.trim() === '')) {
    throw new Error('a credential request purpose must be a non-empty string');
  }
  const format = { [LDP_VC_FORMAT]: { proof_type: LDP_PROOF_TYPES } };
  return {
    id: requests.map((r) => r.id).join('+'),
    ...(purpose ? { purpose } : {}),
    input_descriptors: requests.map((request) => {
      if (!request.credentialType) throw new Error(`credential request ${request.id} has no credential type`);
      if (!PLAIN_TYPE.test(request.credentialType)) {
        throw new Error(`credential request ${request.id} has a credential type that is not a plain name`);
      }
      if (!Array.isArray(request.claims) || request.claims.length === 0) {
        // An input descriptor with no fields matches any credential of the
        // format and discloses all of it — never for this showcase.
        throw new Error(`credential request ${request.id} must name the claims it needs`);
      }
      return {
        id: request.id,
        format,
        ...(purpose ? { purpose } : {}),
        constraints: {
          fields: [
            // Pins the type. `{type:'object', pattern}` is the shape the Brazil
            // verifiers send Inji-based wallets; the pattern is a substring
            // match, so pexClaims() re-checks the type list exactly.
            { path: ['$.type'], filter: { type: 'object', pattern: request.credentialType } },
            // No value filter on domain claims: constraining ageOver18 to true
            // would turn a legitimate minor into "no credential matched" instead
            // of a verified DENIED.
            ...request.claims.map((claim) => ({ path: [`$.credentialSubject.${claim}`] })),
            // The issuer, for the trust allowlist. Not holder data.
            { path: ['$.issuer'] },
          ],
        },
      };
    }),
  };
}

/**
 * Maps one matched PEX descriptor onto the claim shape the DCQL path produces,
 * so the exact-disclosure, trust and domain steps run unchanged.
 *
 * `type` is consumed here (exact membership, since the wallet-side filter is a
 * pattern). `issuer` becomes `iss`. Everything else passes through untouched —
 * including anything unrequested, which the exact-disclosure check refuses.
 *
 * @param {Record<string, unknown>} matched as /vp/status returns it for the descriptor
 * @param {{credentialType: string}} request
 * @returns {Record<string, unknown>}
 */
export function pexClaims(matched, request) {
  const { type, issuer, ...rest } = matched || {};
  if (!Array.isArray(type) || !type.includes(request.credentialType)) {
    throw new Error(`presented credential is not of type ${request.credentialType}`);
  }
  const iss = typeof issuer === 'string' ? issuer : issuer && typeof issuer === 'object' ? issuer.id : undefined;
  return { ...rest, ...(typeof iss === 'string' && iss ? { [ISSUER_CLAIM]: iss } : {}) };
}
