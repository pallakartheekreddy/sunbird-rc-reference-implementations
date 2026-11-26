// Gate on the cryptographic verification result before anything else runs.
//
// Sunbird RC returns a map of named checks and a `verified` flag. Treating a
// missing check as a pass would be the classic way to make a demo green, so the
// required set is enumerated here and every one of them must be 'OK'.

/**
 * Checks oid4vc-service reports for an SD-JWT VC presentation.
 *
 * `audience` is included: the SD-JWT branch sets it (the Key Binding JWT's `aud`
 * is checked against the request's client_id), and its absence would mean the
 * presentation was never bound to this verifier.
 */
export const REQUIRED_CHECKS = [
  'holderSignature',
  'nonce',
  'audience',
  'credentialSignatures',
  'holderBinding',
  'revocation',
  'dcql',
];

/**
 * Signatures of a holder REFUSING, rather than of a broken presentation.
 *
 * OpenID4VP gives a wallet two ways to say no, and neither is distinguishable
 * from a technical fault without this list. It can post an OAuth error
 * (`access_denied`), or it can post a response with no `vp_token` at all — which
 * upstream reports as a failure indistinguishable from a malformed presentation.
 *
 * Calling that "verification failed" tells the holder they hit a bug when in fact
 * the system did exactly what they asked. Worth naming.
 */
const REFUSAL_SIGNATURES = [/access_denied/i, /user_?cancell?ed/i, /missing vp_token/i];

const isRefusal = (error) =>
  typeof error === 'string' && REFUSAL_SIGNATURES.some((pattern) => pattern.test(error));

/**
 * The query check names which query language the wallet satisfied: `dcql` for
 * an SD-JWT/DCQL session, `pex` for an ldp_vc/Presentation Exchange one. A
 * session requires its own and only its own, so a PEX result can never satisfy
 * a DCQL session or the reverse.
 */
export const QUERY_CHECKS = ['dcql', 'pex'];

/**
 * @param {{status?: string, verified?: boolean, checks?: Record<string,string>, error?: string}} status
 * @param {{query?: 'dcql'|'pex'}} [options] the query language the session asked in
 * @returns {{ok: true} | {ok: false, reason: string, failedCheck?: string, declined?: boolean}}
 */
export function evaluateChecks(status, { query = 'dcql' } = {}) {
  if (!QUERY_CHECKS.includes(query)) throw new Error(`unknown query mode ${String(query)}`);
  const required = REQUIRED_CHECKS.map((name) => (name === 'dcql' ? query : name));
  if (!status || typeof status !== 'object') return { ok: false, reason: 'no verification result' };
  if (status.status === 'pending') return { ok: false, reason: 'pending' };
  if (status.verified !== true) {
    if (isRefusal(status.error)) {
      return { ok: false, reason: 'the holder declined the request', declined: true };
    }
    return { ok: false, reason: status.error ? 'verification failed' : 'not verified' };
  }
  const checks = status.checks || {};
  for (const name of required) {
    if (checks[name] !== 'OK') {
      return { ok: false, reason: `check ${name} did not pass`, failedCheck: name };
    }
  }
  return { ok: true };
}
