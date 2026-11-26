// National Identity Authority issuer-side backend.
//
// One job: turn "issue an age credential for citizen X" into an OpenID4VCI offer
// whose claims came from the registry and were derived here.
//
// SCOPE NOTE after the Iteration 01 review: the charter now requires issuance to
// be initiated and completed INSIDE the wallet, authenticated through Keycloak,
// with no issuance QR and no issuer-counter page. So this service no longer
// renders a QR or lists citizens, and the wallet-driven path will resolve claims
// in oid4vc-service from the authenticated subject instead. What remains here is
// kept for automated protocol evidence until that lands, and its derivation
// rules (src/age-claims.mjs) stay as the reference implementation.
//
// It holds no keys and stores no credentials — signing lives in identity-service
// (keys stay in Vault) and the credential itself only ever exists in the
// wallet. It is domain-specific by design; the reusable half of this iteration
// is services/verifier.

import { createServer } from 'node:http';
import { deriveAgeClaims } from './age-claims.mjs';
import { registryClient } from './registry.mjs';
import { oid4vcClient } from './oid4vc.mjs';
import { offerFormat } from './formats.mjs';

const PORT = Number(process.env.PORT || 4200);
const CREDENTIAL_NAME = process.env.CREDENTIAL_NAME || 'Age Verification Credential';
const CREDENTIAL_FORMAT = process.env.CREDENTIAL_FORMAT || 'vc+sd-jwt';
const ISSUER_DID = process.env.AGE_ISSUER_DID || '';

const registry = registryClient(process.env.REGISTRY_BASE_URL || 'http://registry:8081');
const oid4vc = oid4vcClient({
  oid4vcBaseUrl: process.env.OID4VC_BASE_URL || 'http://oid4vc-service:3400',
  schemaBaseUrl: process.env.SCHEMA_BASE_URL || 'http://credential-schema:3333',
});

/**
 * Claim names the verifier is allowed to ask for. Logged in place of values, so
 * an operator can see WHICH claims were issued without the log becoming a
 * second copy of the citizen's identity data.
 */
const summarise = (claims) => Object.keys(claims).sort().join(',');

async function issueOffer(citizenId, format = CREDENTIAL_FORMAT) {
  const record = await registry.findCitizen(citizenId);
  if (!record) {
    return { status: 404, body: { error: 'unknown_citizen', citizenId } };
  }

  // Derived here, from the authoritative record. Nothing a caller sends can
  // influence the age assertion — the request body carries an identifier only.
  const claims = deriveAgeClaims(record);

  const config = await oid4vc.resolveCredentialConfig({
    name: CREDENTIAL_NAME,
    format,
    issuerDid: ISSUER_DID || undefined,
  });

  const offer = await oid4vc.createOffer({
    configurationId: config.configurationId,
    format,
    claims,
  });

  console.log(
    `[age-issuer] offer ${offer.offer_id} for ${citizenId}: claims=${summarise(claims)} ` +
      `config=${config.configurationId}`,
  );

  return {
    status: 201,
    body: {
      offerId: offer.offer_id,
      // The deep link a wallet scans. NOT logged: it carries the
      // pre-authorised code, which is a bearer secret until redeemed.
      qrData: offer.qr_data,
      credentialOfferUri: offer.credential_offer_uri,
      credentialConfigurationId: config.configurationId,
      format,
      vct: config.vct,
      // Names only. Returning the values here would hand the caller the very
      // claims the credential exists to keep in the holder's control.
      claimNames: Object.keys(claims).sort(),
    },
  };
}

const routes = {
  'GET /healthz': async () => ({ status: 200, body: { status: 'UP', service: 'age-issuer' } }),

  'GET /readyz': async () => {
    const [registryHealth, oid4vcHealth] = await Promise.allSettled([
      registry.health(),
      oid4vc.health(),
    ]);
    const ready = registryHealth.status === 'fulfilled' && oid4vcHealth.status === 'fulfilled';
    return {
      status: ready ? 200 : 503,
      body: {
        status: ready ? 'UP' : 'DOWN',
        registry: registryHealth.status === 'fulfilled' ? 'UP' : 'DOWN',
        oid4vc: oid4vcHealth.status === 'fulfilled' ? 'UP' : 'DOWN',
      },
    };
  },

  'POST /offers': async (body) => {
    const citizenId = String(body?.citizenId || '').trim();
    if (!citizenId) return { status: 400, body: { error: 'citizenId is required' } };
    // Optional: 'ldp_vc' for Inji-based wallets; defaults to CREDENTIAL_FORMAT.
    return issueOffer(citizenId, offerFormat(body?.format, CREDENTIAL_FORMAT));
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const key = `${req.method} ${url.pathname.replace(/\/+$/, '') || '/'}`;
  const handler = routes[key];

  const send = (status, body) => {
    const payload = JSON.stringify(body ?? {});
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(payload);
  };

  if (!handler) return send(404, { error: 'not_found', route: key });

  try {
    let body;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks).toString('utf8');
      body = raw ? JSON.parse(raw) : {};
    }
    const result = await handler(body);
    send(result.status, result.body);
  } catch (err) {
    // Message only, never the stack or the upstream payload: an issuance error
    // can carry claim values or a pre-authorised code.
    console.error(`[age-issuer] ${key} failed: ${err.message}`);
    send(err.status && err.status < 500 ? err.status : 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[age-issuer] listening on ${PORT}; credential=${CREDENTIAL_NAME} (${CREDENTIAL_FORMAT})`);
});
