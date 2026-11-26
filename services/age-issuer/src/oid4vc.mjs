// Client for the parts of Sunbird RC's OID4VC façade an issuer-side backend
// uses: discover the credential configuration, then create a pre-authorised
// offer for a specific set of claims.
//
// Note who calls what. POST /oid4vc/offer is an ISSUER-side endpoint — the
// wallet never touches it. The wallet only dereferences the offer, exchanges
// the pre-authorised code and requests the credential. Keeping offer creation
// here (rather than using the registry's built-in offer hook) is what lets the
// dev deployment turn ENABLE_AUTH on later: that hook cannot send a bearer
// token, this service can.

/**
 * @param {{oid4vcBaseUrl: string, schemaBaseUrl: string}} config
 */
export function oid4vcClient({ oid4vcBaseUrl, schemaBaseUrl }) {
  const oid4vc = oid4vcBaseUrl.replace(/\/+$/, '');
  const schemas = schemaBaseUrl.replace(/\/+$/, '');

  async function json(url, init) {
    const res = await fetch(url, {
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
      const detail = typeof body === 'string' ? body.slice(0, 300) : JSON.stringify(body).slice(0, 300);
      throw Object.assign(new Error(`${init?.method || 'GET'} ${url} → ${res.status}: ${detail}`), {
        status: res.status,
      });
    }
    return body;
  }

  return {
    /**
     * Resolves a credential type by display name to the id the issuer metadata
     * publishes.
     *
     * The published `credential_configuration_id` is the bare `schemaId` for a
     * single-format schema and `<schemaId>_<format>` when the schema offers
     * several. Posting a name works as a convenience fallback in
     * oid4vc-service, but it is ambiguous when two schemas share a display name
     * — which the negative-path fixtures deliberately create (a second,
     * untrusted issuer publishing the same credential type). So resolve to the
     * unambiguous id here, filtered by the author DID we mean to issue as.
     *
     * @param {{name: string, format: string, issuerDid?: string}} want
     */
    async resolveCredentialConfig({ name, format, issuerDid }) {
      const configs = await json(`${schemas}/credential-schema/oid4vci-configs`);
      const byName = (Array.isArray(configs) ? configs : []).filter((c) => c.name === name);
      const supported = byName.filter((c) => (c.formats || []).includes(format));
      const candidates = issuerDid
        ? supported.filter((c) => (c.author || '') === issuerDid)
        : supported;

      if (candidates.length === 0) {
        throw new Error(
          `no PUBLISHED, OID4VCI-enabled schema named ${JSON.stringify(name)} supporting ${format}` +
            (issuerDid ? ` authored by ${issuerDid}` : '') +
            ' — run scripts/bootstrap.sh',
        );
      }
      if (candidates.length > 1) {
        throw new Error(
          `${candidates.length} schemas match ${JSON.stringify(name)} for ${format}; ` +
            'issuance would be nondeterministic',
        );
      }
      const cfg = candidates[0];
      const configurationId =
        (cfg.formats || []).length > 1 ? `${cfg.schemaId}_${format}` : cfg.schemaId;
      return {
        configurationId,
        vct: cfg.vct,
        author: cfg.author,
        schemaId: cfg.schemaId,
        // What the schema lets this credential carry; the offer is narrowed to it.
        claimNames: Object.keys(cfg.schema?.properties || {}),
      };
    },

    /**
     * Creates a pre-authorised credential offer.
     *
     * Pre-authorised rather than authorization_code: DESIGN prefers it for the
     * first iteration because it keeps the holder journey to one scan. The code
     * is short-lived and single-use — reusing it is one of the negative tests.
     *
     * @param {{configurationId: string, format: string, claims: Record<string, unknown>, expirationDate?: string}} offer
     */
    async createOffer({ configurationId, format, claims, expirationDate }) {
      return json(`${oid4vc}/oid4vc/offer`, {
        method: 'POST',
        body: JSON.stringify({
          credential_configuration_id: configurationId,
          format,
          claims,
          ...(expirationDate ? { expiration_date: expirationDate } : {}),
        }),
      });
    },

    async health() {
      return json(`${oid4vc}/health`);
    },
  };
}
