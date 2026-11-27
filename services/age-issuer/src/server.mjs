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
import { deriveAgeClaims, ageClaimsValidUntil } from './age-claims.mjs';
import { registryClient } from './registry.mjs';
import { oid4vcClient } from './oid4vc.mjs';
import { offerFormat, claimsForSchema } from './formats.mjs';
import { createTryHandler, cleanupTryCitizens } from './try-citizens.mjs';

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

async function issueOffer(citizenId, format = CREDENTIAL_FORMAT, { expirationDate: expirationOverride } = {}) {
  const record = await registry.findCitizen(citizenId);
  if (!record) {
    return { status: 404, body: { error: 'unknown_citizen', citizenId } };
  }

  // Derived here, from the authoritative record. Nothing a caller sends can
  // influence the age assertion — the request body carries an identifier only.
  const derived = deriveAgeClaims(record);

  const config = await oid4vc.resolveCredentialConfig({
    name: CREDENTIAL_NAME,
    format,
    issuerDid: ISSUER_DID || undefined,
  });

  // Only what this format's schema declares: the ldp_vc schema has no name or
  // date of birth, because an ldp_vc is presented whole.
  const claims = claimsForSchema(derived, config.claimNames);

  // The answers change on a birthday (a minor's "not over 18"); the credential
  // expires that day. Adults get no expiry. A /try/ test citizen passes its own,
  // shorter expiry (see try-citizens.mjs), which already accounts for the birthday.
  const expirationDate = expirationOverride || ageClaimsValidUntil(record.dateOfBirth);

  const offer = await oid4vc.createOffer({
    configurationId: config.configurationId,
    format,
    claims,
    expirationDate,
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
      ...(expirationDate ? { expirationDate } : {}),
      vct: config.vct,
      // Names only. Returning the values here would hand the caller the very
      // claims the credential exists to keep in the holder's control.
      claimNames: Object.keys(claims).sort(),
    },
  };
}

const handleTry = createTryHandler({ registry, issueOffer });

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

  // PUBLIC (via nginx, rate-limited): anyone can create a test citizen. An
  // unexpected failure answers a fixed error, never the upstream message, which
  // can name internal hosts or echo registry payloads to a stranger.
  'POST /try/citizens': async (body) => {
    try {
      return await handleTry(body);
    } catch (err) {
      console.error(`[age-issuer] /try/citizens failed: ${err.message}`);
      return { status: 502, body: { error: 'issuance_failed' } };
    }
  },
};

// Test citizens are deleted 2 h after creation (see try-citizens.mjs). Every 15 minutes, and once
// shortly after start so a restart does not postpone cleanup by a full period.
const runCleanup = () =>
  cleanupTryCitizens({ registry })
    .then((n) => n && console.log(`[age-issuer] deleted ${n} expired test citizen(s)`))
    .catch((err) => console.error(`[age-issuer] test-citizen cleanup failed: ${err.message}`));
setTimeout(runCleanup, 30_000).unref();
setInterval(runCleanup, 15 * 60_000).unref();

// The public /try/ endpoint takes a few hundred bytes; anything larger is not a
// legitimate request and is refused before it is buffered.
const MAX_BODY_BYTES = 16 * 1024;

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
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) return send(413, { error: 'body_too_large' });
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString('utf8');
      try {
        body = raw ? JSON.parse(raw) : {};
      } catch {
        return send(400, { error: 'invalid_json' });
      }
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
