// End-to-end evidence for Iteration 01, against the running stack.
//
// Every test drives the real protocol: a real OpenID4VCI issuance into a
// scripted wallet, then a real OpenID4VP presentation answered through
// direct_post, verified by Sunbird RC and decided by the verifier service.
// Nothing here mocks a verification result.
//
//   cd deploy && docker compose up -d && ../scripts/bootstrap.sh
//   ../scripts/seed-age-citizens.sh
//   npm run test:e2e
//
// The npm script pins --test-concurrency=1. Both e2e files drive ONE shared
// stack, and data-isolation.test.mjs shells into Docker; running the files in
// parallel produced a flaky failure here that never reproduced alone. Serial is
// the honest configuration for integration tests against a shared deployment.

import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  deployEnv,
  requireStack,
  issueOfferFor,
  issueAsIssuer,
  ensureNegativeFixture,
  retireNegativeFixture,
  startVerification,
  readVerification,
  cancelVerification,
  issuerMetadata,
  verifierPolicy,
  disclosedClaimNames,
  json,
} from './lib/stack.mjs';
import { deriveAgeClaims } from '../../services/age-issuer/src/age-claims.mjs';
import {
  createHolder,
  collectCredential,
  presentSdJwt,
  parseSdJwt,
  disclosableClaims,
  fetchRequestObject,
  submitPresentation,
  tryRedeemCode,
  forgeDisclosureValue,
  declinePresentation,
  parseSdJwt as parseCredential,
} from './lib/wallet.mjs';

const { base, opsBase, ageIssuerDid, verifierDid, untrustedIssuerDid } = deployEnv();
const QUERY_ID = 'age_cred';
const ADULT = 'AGE-000001';
const MINOR = 'AGE-000002';

let skip = null;
/** The registry's own id for the fixture, needed to retire it afterwards. */
let negativeFixtureSchemaId = null;
before(async () => {
  skip = await requireStack(base);
  if (!skip && !ageIssuerDid) skip = 'deploy/.env has no AGE_ISSUER_DID — run scripts/bootstrap.sh';
  // The untrusted-issuer fixture is created here rather than by bootstrap.sh:
  // issuer metadata advertises every published schema, so a fixture that exists
  // at setup time shows up in the wallet's issuer directory next to the real
  // credential. It belongs to the test that needs it.
  if (!skip && untrustedIssuerDid) {
    try {
      const fixture = await ensureNegativeFixture(untrustedIssuerDid);
      negativeFixtureSchemaId = fixture?.schemaId;
    } catch (err) {
      skip = `could not provision the untrusted-issuer fixture: ${err.message}`;
    }
  }
});

// Takes it back out of the advertised credentials, so a test run never leaves a
// customer-facing stack showing two credentials.
after(async () => {
  await retireNegativeFixture(negativeFixtureSchemaId);
});
const guard = () => {
  if (skip) throw new Error(skip);
};

/** Issues a credential for a seeded citizen into a fresh scripted wallet. */
async function walletWithCredential(citizenId) {
  const holder = await createHolder();
  const offer = await issueOfferFor(base, citizenId);
  const { credential } = await collectCredential({ base, offer, holder });
  return { holder, credential, offer };
}

/** Runs one full presentation and returns the verifier's answer. */
async function present({ credential, holder, disclose = ['ageOver18'], signWith, nonce, audience, tamperDisclosures, tamperJws }) {
  const session = await startVerification(base);
  const request = await fetchRequestObject({ base, transactionId: session.sessionId });
  const presentation = await presentSdJwt({
    credential,
    disclose,
    nonce: nonce ?? request.nonce,
    audience: audience ?? request.client_id,
    holder: signWith ?? holder,
    tamperDisclosures,
    tamperJws,
  });
  const submission = await submitPresentation({
    base,
    state: request.state,
    queryId: QUERY_ID,
    presentation,
  });
  const result = await readVerification(base, session.sessionId);
  return { session, request, presentation, submission, result: result.body, resultStatus: result.status };
}

describe('positive flow', () => {
  test('an adult is APPROVED, with every verification check passing', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result, submission } = await present({ credential, holder });

    assert.equal(submission.status, 200, 'the wallet submission itself must be accepted');
    assert.equal(result.state, 'decided');
    assert.equal(result.decision, 'APPROVED');
    assert.equal(result.issuer, 'National Identity Authority');
    for (const [name, value] of Object.entries(result.checks)) {
      assert.equal(value, 'OK', `check ${name} must be OK`);
    }
    for (const required of ['holderSignature', 'nonce', 'audience', 'credentialSignatures', 'holderBinding', 'dcql']) {
      assert.equal(result.checks[required], 'OK', `${required} must be reported`);
    }
  });

  test('the credential is holder-bound to the wallet key that requested it', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const { payload } = parseSdJwt(credential);
    // cnf is what a later presentation's Key Binding JWT is checked against.
    const boundJwk = payload.cnf?.jwk;
    assert.ok(boundJwk, 'the issued credential must carry a cnf key');
    assert.equal(boundJwk.x, holder.publicJwk.x, 'bound to THIS wallet key, not a server-side one');
    assert.equal(boundJwk.y, holder.publicJwk.y);
    assert.equal(payload.iss, ageIssuerDid, 'issued by the National Identity Authority');
  });
});

describe('issuer-side backend', () => {
  test('the offer is a standards OpenID4VCI offer, and carries no QR', async () => {
    guard();
    // The charter forbids an issuance QR, so the issuer no longer renders one.
    // The offer itself must still be a spec-shaped credential offer, because the
    // wallet-driven flow dereferences the same object.
    const offer = await issueOfferFor(base, ADULT);
    assert.match(offer.qrData, /^openid-credential-offer:\/\/\?credential_offer_uri=/);
    assert.equal(offer.qrSvg, undefined, 'no rendered QR may come back from the issuer');
    assert.equal(offer.claimNames.length, 4);
  });

  test('the response never carries claim VALUES', async () => {
    guard();
    // Names only. A counter response that echoed the values would hand the
    // caller the very data the credential exists to keep in the holder's hands.
    const offer = await issueOfferFor(base, MINOR);
    const serialised = JSON.stringify(offer);
    assert.equal(/Arjun|2012-08-30/.test(serialised), false, 'no identity values in the offer response');
    assert.deepEqual(offer.claimNames, ['ageOver16', 'ageOver18', 'dateOfBirth', 'name']);
  });

  test('an unknown citizen is refused', async () => {
    guard();
    const res = await json(`${opsBase}/api/issuer/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ citizenId: 'AGE-999999' }),
    });
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'unknown_citizen');
  });

  test('a caller cannot dictate the claims that get issued', async () => {
    guard();
    // Names the minor, but also tries to assert adulthood in every shape the
    // endpoint might plausibly accept. The registry record must win.
    const holder = await createHolder();
    const res = await json(`${opsBase}/api/issuer/offers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        citizenId: MINOR,
        claims: { ageOver18: true },
        ageOver18: true,
        name: 'Someone Else',
        dateOfBirth: '1980-01-01',
      }),
    });
    assert.equal(res.status, 201);

    const { credential } = await collectCredential({ base, offer: res.body, holder });
    const values = Object.fromEntries(parseSdJwt(credential).disclosures.map((d) => [d.name, d.value]));
    assert.equal(values.ageOver18, false, 'the caller must not be able to assert adulthood');
    assert.equal(values.name, 'Arjun Das', 'the caller must not be able to rename the holder');
    assert.equal(values.dateOfBirth, '2012-08-30');
  });
});

describe('privacy and minimum disclosure', () => {
  test('the verifier asks for one claim only', async () => {
    guard();
    const policy = await verifierPolicy(base);
    assert.deepEqual(policy.requestedClaims, ['ageOver18']);
  });

  test('the credential CAN disclose more, and the holder does not', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);

    // The credential genuinely carries the identity claims. Without this, a
    // "nothing leaked" result would only prove the credential was empty.
    assert.deepEqual(disclosableClaims(credential), ['ageOver16', 'ageOver18', 'dateOfBirth', 'name']);

    const { presentation, result } = await present({ credential, holder });
    assert.equal(result.decision, 'APPROVED');

    // What actually travelled: exactly one disclosure.
    assert.deepEqual(disclosedClaimNames(presentation), ['ageOver18']);

    // And the withheld values are absent from the wire, not merely unread. The
    // signed payload holds salted digests, so they are unrecoverable.
    const seeded = await json(`${opsBase}/api/v1/AgeCitizen/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filters: { citizenId: { eq: ADULT } } }),
    });
    const record = (Array.isArray(seeded.body) ? seeded.body : seeded.body?.data || [])[0];
    for (const secret of [record.dateOfBirth, record.name]) {
      assert.ok(secret, 'fixture must have the value we claim is withheld');
      assert.equal(presentation.includes(secret), false, `${secret} must not appear in the presentation`);
      assert.equal(
        Buffer.from(presentation).toString('base64url').includes(Buffer.from(secret).toString('base64url')),
        false,
        `${secret} must not appear base64-encoded either`,
      );
    }
  });

  test('the verifier surfaces only the requested claim, and never the holder identifier', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result } = await present({ credential, holder });

    assert.deepEqual(Object.keys(result.disclosed), ['ageOver18']);
    const serialised = JSON.stringify(result);
    assert.equal(/holderDid|did:jwk/.test(serialised), false, 'no holder identifier in the verifier response');
    assert.equal(/dateOfBirth|1998-04-02/.test(serialised), false, 'no date of birth anywhere in the response');
  });

  test('over-disclosure by the wallet is refused outright', async () => {
    guard();
    // A wallet that ignores the request and sends everything.
    //
    // This used to be DECIDED. Upstream DCQL returned only the matched claims,
    // so the surplus was invisible to the verifier and the decision still stood
    // on the requested claim alone — contained, and asserted as such here. What
    // it did not cover is that the values had still left the wallet and reached
    // the protocol service, so "the verifier never receives it" was true of the
    // relying party and not of the boundary.
    //
    // The DCQL matcher now compares the disclosed claim names against the query
    // and refuses the credential. Age gains that with Iteration 03's fix to the
    // shared oid4vc-service, which is why an Iteration 01 test changed: the
    // guarantee got stronger, not different. Nothing in the Age demonstration
    // shows this path — it needs a wallet that deliberately over-discloses, and
    // only this suite has one.
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result, submission } = await present({
      credential,
      holder,
      disclose: ['ageOver18', 'ageOver16', 'name', 'dateOfBirth'],
    });
    assert.equal(submission.status, 403, 'the stack must refuse the presentation outright');
    assert.equal(result.state, 'rejected');
    assert.equal(result.decision, undefined, 'and reach no decision');
    assert.equal(result.disclosed, undefined, 'and disclose nothing to the page');
    // The refusal names the claims that were not asked for, and none of their
    // values — the whole point being not to disclose what it just refused.
    assert.equal(/Meera|1998-04-02/.test(JSON.stringify(result)), false);
  });

  test('and the same wallet is accepted when it discloses only what was asked', async () => {
    guard();
    // The control. Without it the refusal above could come from anything about
    // this fixture rather than from the surplus disclosure.
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result } = await present({ credential, holder, disclose: ['ageOver18'] });
    assert.equal(result.state, 'decided');
    assert.deepEqual(Object.keys(result.disclosed), ['ageOver18']);
  });
});

describe('domain decision', () => {
  test('a minor is DENIED — verified, not failed', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(MINOR);
    const { result } = await present({ credential, holder });

    assert.equal(result.state, 'decided', 'a truthful "no" must still be a verified presentation');
    assert.equal(result.decision, 'DENIED');
    assert.equal(result.disclosed.ageOver18, false);
    for (const [name, value] of Object.entries(result.checks)) {
      assert.equal(value, 'OK', `check ${name} must still pass for a minor: ${name}`);
    }
  });

  test('the boundary fixtures decide correctly', async () => {
    guard();
    // AGE-000003 was seeded as "turns 18 today" and AGE-000004 as "turns 18
    // tomorrow" — relative to the day they were SEEDED, which is not
    // necessarily the day this test runs. Hardcoding APPROVED/DENIED per
    // citizen therefore passes only on seeding day, and fails the morning
    // after (found exactly that way).
    //
    // So derive the expectation from the authoritative record instead, with the
    // issuer's own rule. That asserts the property actually worth asserting —
    // the verifier's decision agrees with what the registry's date of birth
    // implies today — and it holds on any day.
    for (const citizenId of ['AGE-000003', 'AGE-000004']) {
      const seeded = await json(`${opsBase}/api/v1/AgeCitizen/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filters: { citizenId: { eq: citizenId } } }),
      });
      const record = (Array.isArray(seeded.body) ? seeded.body : seeded.body?.data || [])[0];
      assert.ok(record?.dateOfBirth, `${citizenId} must be seeded`);
      const expected = deriveAgeClaims(record).ageOver18 ? 'APPROVED' : 'DENIED';

      const { holder, credential } = await walletWithCredential(citizenId);
      const { result } = await present({ credential, holder });
      assert.equal(
        result.decision,
        expected,
        `${citizenId} (dob ${record.dateOfBirth}) must be ${expected} today`,
      );
    }
  });

  test('the boundary fixtures still straddle the 18th birthday', async () => {
    guard();
    // The pair is only a boundary test while one is over 18 and the other is
    // not. Once the calendar moves past both, they still pass the test above
    // while having stopped testing the boundary — so say so out loud rather
    // than let the suite look stronger than it is.
    const dobs = {};
    for (const citizenId of ['AGE-000003', 'AGE-000004']) {
      const seeded = await json(`${opsBase}/api/v1/AgeCitizen/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ filters: { citizenId: { eq: citizenId } } }),
      });
      const record = (Array.isArray(seeded.body) ? seeded.body : seeded.body?.data || [])[0];
      dobs[citizenId] = deriveAgeClaims(record).ageOver18;
    }
    assert.notEqual(
      dobs['AGE-000003'],
      dobs['AGE-000004'],
      'boundary fixtures have gone stale: both citizens now fall the same side of 18. ' +
        'Re-seed with ./scripts/seed-age-citizens.sh on a clean stack.',
    );
  });

  test('a leap-day date of birth is handled', async () => {
    guard();
    const { holder, credential } = await walletWithCredential('AGE-000005');
    const { result } = await present({ credential, holder });
    assert.equal(result.decision, 'APPROVED');
  });
});

describe('negative flows', () => {
  test('a tampered disclosure value is rejected', async () => {
    guard();
    // The minor's credential, edited to claim adulthood. The value is not in the
    // signed payload — only its digest is — so re-encoding the disclosure breaks
    // the digest match.
    const { holder, credential } = await walletWithCredential(MINOR);
    const { result, submission } = await present({
      credential,
      holder,
      tamperDisclosures: (disclosures) =>
        disclosures.map((d) => (d.name === 'ageOver18' ? forgeDisclosureValue(d, true) : d)),
    });

    assert.equal(submission.status, 403, 'the stack must refuse the presentation outright');
    assert.equal(result.state, 'rejected');
    assert.notEqual(result.decision, 'APPROVED');
  });

  test('a tampered issuer signature is rejected', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result, submission } = await present({
      credential,
      holder,
      // Flip one character of the signed payload segment.
      tamperJws: (jws) => {
        const [header, payload, signature] = jws.split('.');
        const flipped = payload.slice(0, -1) + (payload.at(-1) === 'A' ? 'B' : 'A');
        return [header, flipped, signature].join('.');
      },
    });
    assert.equal(submission.status, 403);
    assert.equal(result.state, 'rejected');
  });

  test('a valid credential from an issuer outside the allowlist is rejected', async () => {
    guard();
    // Genuinely signed, correct vct, all six upstream checks pass. The ONLY
    // thing wrong with it is who issued it — which is the check Sunbird RC
    // v2.1.0 does not perform and the verifier service adds.
    const holder = await createHolder();
    const offer = await issueAsIssuer({
      base,
      issuerDid: untrustedIssuerDid,
      credentialName: 'Age Verification Credential (unlisted issuer)',
      claims: { ageOver18: true, ageOver16: true, name: 'Impostor', dateOfBirth: '1990-01-01' },
    });
    const { credential } = await collectCredential({ base, offer, holder });
    assert.equal(parseSdJwt(credential).payload.iss, untrustedIssuerDid);

    const { result, submission } = await present({ credential, holder });
    assert.equal(submission.status, 200, 'upstream verification passes — the signature is real');
    assert.equal(result.state, 'rejected');
    assert.match(result.reason, /trust allowlist/);
    assert.equal(result.decision, undefined, 'no decision may be produced for an untrusted issuer');
  });

  test('a presentation signed by the wrong holder key is rejected', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const impostor = await createHolder();
    const { result, submission } = await present({ credential, holder, signWith: impostor });
    assert.equal(submission.status, 403);
    assert.equal(result.state, 'rejected');
  });

  test('a wrong nonce is rejected', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result, submission } = await present({ credential, holder, nonce: 'not-the-requested-nonce' });
    assert.equal(submission.status, 403);
    assert.equal(result.state, 'rejected');
  });

  test('a presentation bound to a different audience is rejected', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const { result, submission } = await present({
      credential,
      holder,
      audience: 'did:web:localhost:someone-else',
    });
    assert.equal(submission.status, 403, 'a presentation made to another verifier must not be accepted here');
    assert.equal(result.state, 'rejected');
  });

  test('replaying a verified presentation is rejected', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const session = await startVerification(base);
    const request = await fetchRequestObject({ base, transactionId: session.sessionId });
    const presentation = await presentSdJwt({
      credential,
      disclose: ['ageOver18'],
      nonce: request.nonce,
      audience: request.client_id,
      holder,
    });

    const first = await submitPresentation({ base, state: request.state, queryId: QUERY_ID, presentation });
    assert.equal(first.status, 200);
    const replay = await submitPresentation({ base, state: request.state, queryId: QUERY_ID, presentation });
    assert.equal(replay.status, 400, 'the transaction is single-use');
    assert.match(JSON.stringify(replay.body), /not pending/);
  });

  test('an unknown or expired transaction state is rejected', async () => {
    guard();
    const { holder, credential } = await walletWithCredential(ADULT);
    const presentation = await presentSdJwt({
      credential,
      disclose: ['ageOver18'],
      nonce: 'whatever',
      audience: 'whatever',
      holder,
    });
    // Same code path a genuinely expired transaction takes: the state index is
    // gone from the session store, whether by TTL or because it never existed.
    const res = await submitPresentation({ base, state: 'expired-or-never-existed', queryId: QUERY_ID, presentation });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /unknown or expired state/);
  });

  test('a pre-authorised code cannot be redeemed twice', async () => {
    guard();
    const holder = await createHolder();
    const offer = await issueOfferFor(base, ADULT);
    const collected = await collectCredential({ base, offer, holder });
    const reuse = await tryRedeemCode({ base, code: collected.preAuthorizedCode });
    assert.equal(reuse.status, 400);
    assert.match(JSON.stringify(reuse.body), /bad or used code/);
  });

  test('a holder who never responds produces no claims and no approval', async () => {
    guard();
    const session = await startVerification(base);
    const result = await readVerification(base, session.sessionId);
    assert.equal(result.body.state, 'waiting');
    assert.equal(result.body.decision, undefined);
    assert.equal(result.body.disclosed, undefined);
  });

  test('a holder who declines is reported as declined, not as a failure', async () => {
    guard();
    // The distinction the review asked for: refusing must not look like a broken
    // presentation. Nothing is disclosed, no decision is produced, and the state
    // says why.
    const session = await startVerification(base);
    const request = await fetchRequestObject({ base, transactionId: session.sessionId });
    const submission = await declinePresentation({ base, state: request.state });
    assert.ok(submission.status < 500, `declining should not fault the service, got ${submission.status}`);

    const result = await readVerification(base, session.sessionId);
    assert.equal(result.body.state, 'declined');
    assert.equal(result.body.decision, undefined);
    assert.equal(result.body.disclosed, undefined);
    assert.match(result.body.reason, /declined/i);
    // And no claim values leak into the refusal path.
    assert.equal(JSON.stringify(result.body).includes('ageOver18'), false);
  });
});

describe('the credential artefact', () => {
  test('what the issuer returns is an SD-JWT VC, holder-bound and selectively disclosable', async () => {
    guard();
    // Elsewhere this suite treats the credential as an opaque string that happens
    // to split on '~'. This test states what the artefact actually is, because
    // "we issue SD-JWT VCs with holder binding" is a technical claim in the
    // handoff and should be asserted rather than implied.
    const { holder, credential } = await walletWithCredential(ADULT);
    const { header, payload, disclosures } = parseCredential(credential);

    // The media type is what makes this an SD-JWT VC rather than a plain JWT.
    assert.equal(header.typ, 'vc+sd-jwt');
    assert.equal(header.alg, 'ES256', 'the approved signing algorithm');

    // Selective disclosure: the payload carries salted digests, and the claim
    // values live outside the signature in the disclosures.
    assert.equal(payload._sd_alg, 'sha-256');
    assert.ok(Array.isArray(payload._sd) && payload._sd.length === disclosures.length,
      `expected one digest per disclosure, got ${payload._sd?.length} digests for ${disclosures.length} disclosures`);
    for (const name of ['ageOver18', 'dateOfBirth', 'name']) {
      assert.equal(Object.hasOwn(payload, name), false, `${name} must be a disclosure, not a plain claim`);
    }

    // Type and issuer, so a wallet knows what it received and from whom. The
    // credential's `vct` must be the one the issuer advertised, because that is
    // the URL a wallet resolves for type metadata when it renders the card.
    const metadata = await issuerMetadata(base);
    const advertised = Object.values(metadata.credential_configurations_supported)
      .map((c) => c.vct)
      .filter(Boolean);
    assert.ok(advertised.includes(payload.vct),
      `the credential's vct '${payload.vct}' is not advertised: ${advertised.join(', ')}`);
    // Absolute, so a wallet can fetch the Type Metadata. Deliberately not
    // asserting https: a real device needs it (did:web mandates it, and the
    // deployment has a certificate), but a local stack runs on plain http and
    // this test's subject is the credential, not the deployment's scheme.
    assert.match(payload.vct, /^https?:\/\//, 'the type must be an absolute, resolvable URL');
    assert.equal(payload.iss, ageIssuerDid);

    // Holder binding: the credential names the wallet's own public key, which is
    // what the Key Binding JWT later proves possession of.
    assert.ok(payload.cnf?.jwk, 'the credential must carry a holder key');
    const bound = payload.cnf.jwk;
    const held = holder.publicJwk;
    assert.equal(bound.kty, held.kty);
    assert.equal(bound.crv, held.crv);
    assert.equal(bound.x, held.x, 'the bound key must be the key this wallet holds');
    assert.equal(bound.y, held.y);
    assert.equal(bound.d, undefined, 'a private key must never appear in a credential');
  });
});

describe('the customer-facing issuer directory', () => {
  test('the issuer advertises exactly one credential', async () => {
    guard();
    // What a wallet shows after the citizen picks the National Identity
    // Authority. The negative-test fixture is provisioned by this file and
    // retired again in after(), so a stack a customer sees offers one credential
    // and not a menu — the review asked for this explicitly. Asserting it here
    // rather than only in verify.sh means a regression fails the suite.
    const metadata = await issuerMetadata(base);
    const configurations = Object.entries(metadata.credential_configurations_supported || {});
    const offered = configurations.filter(([, c]) => !/unlisted/i.test(c.display?.[0]?.name || ''));

    assert.equal(offered.length, 1,
      `expected one advertised credential, got ${offered.length}: ${offered.map(([id]) => id).join(', ')}`);
    const [, configuration] = offered[0];
    assert.equal(configuration.format, 'vc+sd-jwt');
    assert.match(configuration.display?.[0]?.name || '', /age/i);
  });
});

describe('session lifecycle', () => {
  test('a cancelled check stays cancelled, even if a valid presentation arrives afterwards', async () => {
    guard();
    // Cancellation has to be enforced by the verifier, not merely drawn by the
    // page: if abandoning a session were a client-side label, a presentation
    // that landed a moment later would still produce an approval on a check the
    // operator had already given up on.
    const { holder, credential } = await walletWithCredential(ADULT);
    const session = await startVerification(base);
    const request = await fetchRequestObject({ base, transactionId: session.sessionId });

    const cancelled = await cancelVerification(base, session.sessionId);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.state, 'cancelled');

    const afterCancel = await readVerification(base, session.sessionId);
    assert.equal(afterCancel.body.state, 'cancelled');
    assert.equal(afterCancel.body.decision, undefined);

    // Now the holder answers anyway, with a genuinely valid presentation.
    const presentation = await presentSdJwt({
      credential,
      disclose: ['ageOver18'],
      nonce: request.nonce,
      audience: request.client_id,
      holder,
    });
    const submission = await submitPresentation({
      base,
      state: request.state,
      queryId: QUERY_ID,
      presentation,
    });
    assert.ok(submission.status < 500, `a late presentation must not fault the service, got ${submission.status}`);

    const afterPresentation = await readVerification(base, session.sessionId);
    assert.equal(afterPresentation.body.state, 'cancelled', 'a cancelled session must never report a decision');
    assert.equal(afterPresentation.body.decision, undefined);
    assert.equal(afterPresentation.body.disclosed, undefined);
    assert.equal(JSON.stringify(afterPresentation.body).includes('ageOver18'), false);
  });

  test('cancelling a session the verifier does not hold is reported expired, not cancelled', async () => {
    guard();
    const attempt = await cancelVerification(base, 'session-that-never-existed');
    assert.equal(attempt.status, 404);
    assert.equal(attempt.body.state, 'expired');
  });

  test('a session the verifier no longer holds is expired, and never decided', async () => {
    guard();
    // Sessions are held in memory with a TTL and swept on access, so a session
    // that has aged out is indistinguishable from one that never existed: the
    // read finds nothing and reports 'expired'. That shared path is what this
    // asserts, rather than sleeping out the deployment's TTL — which is minutes
    // long, and a test that sleeps for minutes is a test that gets skipped.
    const unknown = await readVerification(base, 'session-that-never-existed');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.state, 'expired');
    assert.equal(unknown.body.decision, undefined);
    assert.equal(unknown.body.disclosed, undefined);

    // And a live session does carry a finite lifetime, so expiry is reachable.
    const session = await startVerification(base);
    assert.ok(session.expiresInSeconds > 0, 'a session must expire');
    assert.ok(session.expiresInSeconds <= 600,
      `a demo session should be short-lived, got ${session.expiresInSeconds}s`);
  });
});

describe('what a real wallet needs in order to name us', () => {
  test('the verifier identifies itself with a bare did:web under the deployment host', async () => {
    guard();
    // A wallet decides whether to show "Do you trust <name>?" or "Organization
    // not verified" by matching this client id against its configured trust
    // entities. Ours is a bare `did:web:` — the pre-draft-26 form — and the
    // wallet fork's trust entry is scoped to the host so it survives a
    // re-bootstrap minting a new uuid. Both halves of that arrangement are
    // asserted here, because if the verifier ever emitted a different form or a
    // DID under a different host, the wallet would silently go back to calling
    // us unknown and only a human looking at a phone would notice.
    const session = await startVerification(base);
    const clientId = new URL(session.qrData).searchParams.get('client_id');

    assert.ok(clientId, 'the request must carry a client_id');
    assert.match(clientId, /^did:web:/, 'the wallet resolves this DID to learn who is asking');
    assert.equal(clientId.startsWith('decentralized_identifier:'), false,
      'we send the bare form; a prefixed client id would need OpenID4VP draft 26 on both sides');

    const host = new URL(base).host;
    assert.ok(clientId.startsWith(`did:web:${host}`),
      `the verifier DID must live under the deployment host so host-scoped trust matches: ${clientId}`);
    if (verifierDid) {
      assert.equal(clientId, verifierDid, 'and it must be the verifier identity this deployment minted');
    }
  });

  test('the issuer identifies itself with the deployment origin, and its logo resolves', async () => {
    guard();
    // The issuance screen is matched on an issuer prefix rather than a DID, so
    // what has to hold is that the advertised `credential_issuer` is the origin
    // the wallet was configured with. The logo is part of the same screen: a
    // trusted entity with an unreachable logo shows a placeholder, which looks
    // like a half-configured issuer to anyone watching a demo.
    const metadata = await issuerMetadata(base);
    assert.equal(metadata.credential_issuer, base);
    assert.equal(metadata.display?.[0]?.name, 'National Identity Authority');

    for (const logo of ['national-identity-authority', 'age-check']) {
      const res = await fetch(`${base}/assets/logos/${logo}.png`);
      assert.equal(res.status, 200, `${logo}.png must be served for the wallet's trust screen`);
      assert.match(res.headers.get('content-type') || '', /image\/png/);
    }
  });
});
