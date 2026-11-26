// Client for Sunbird RC's OID4VP verifier endpoints.
//
// The verifier role in v2.1.0 is two calls: create a DCQL request (which yields
// the QR payload), then poll the transaction. All cryptography lives behind
// those endpoints — this service must not reimplement it, and does not.

/**
 * @param {{baseUrl: string}} config
 */
export function oid4vcClient({ baseUrl }) {
  const base = baseUrl.replace(/\/+$/, '');

  async function json(path, init) {
    const res = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(init?.headers || {}) },
    });
    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : undefined;
    } catch {
      body = text;
    }
    if (!res.ok) {
      const detail =
        typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body ?? {}).slice(0, 300);
      throw Object.assign(new Error(`oid4vc ${init?.method || 'GET'} ${path} -> ${res.status}: ${detail}`), {
        status: res.status,
      });
    }
    return body;
  }

  return {
    /**
     * Creates an OID4VP transaction and returns the wallet deep link.
     *
     * `signed: true` is not a preference. Credo-based wallets (Paradym) fetch
     * the request object as application/oauth-authz-req+jwt and answer 406 to
     * an unsigned one. Signing in turn requires oid4vc-service to hold a
     * wallet-resolvable VERIFIER_DID, which bootstrap.sh mints as a did:web.
     *
     * @param {object} dcqlQuery
     */
    async createRequest(dcqlQuery) {
      return json('/vp/request', {
        method: 'POST',
        body: JSON.stringify({ dcql_query: dcqlQuery, signed: true }),
      });
    },

    /**
     * Creates an OID4VP transaction from a Presentation Exchange definition,
     * for wallets that present ldp_vc and do not speak DCQL (Inji Wallet and
     * the Inji SDK).
     *
     * Unsigned, by value, with the redirect_uri client_id prefix: Inji-based
     * wallets verify a signed request object only with EdDSA, which is not
     * what this verifier's DID signs with, and they accept redirect_uri.
     * oid4vc-service re-checks at response time that the client_id names the
     * exact endpoint the response is posted to.
     *
     * @param {object} presentationDefinition
     */
    async createPresentationRequest(presentationDefinition) {
      return json('/vp/request', {
        method: 'POST',
        body: JSON.stringify({ presentation_definition: presentationDefinition, signed: false }),
      });
    },

    /**
     * Reads the transaction result.
     *
     * Shape: {status, verified, checks{...}, claims{[queryId]: {...}}, holderDid}.
     * `claims` contains ONLY what the DCQL query matched — anything else the
     * wallet chose to disclose never reaches this service, which is a privacy
     * property worth keeping rather than working around.
     *
     * @param {string} transactionId
     */
    async getStatus(transactionId) {
      return json(`/vp/status/${encodeURIComponent(transactionId)}`);
    },

    async health() {
      return json('/health');
    },
  };
}
