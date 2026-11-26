// The Presentation Exchange request, for wallets that speak PEX + ldp_vc (Inji
// Wallet, apps built on the Inji SDK). Same two properties as the DCQL request:
// it asks for the minimum, and it does not constrain the answer. Plus one PEX
// adds: what comes back has to be mapped onto the shape the rest of the verifier
// already checks, without loosening any of those checks.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPresentationDefinition,
  pexClaims,
  LDP_VC_FORMAT,
} from '../../services/verifier/src/core/pex.mjs';
import { ISSUER_CLAIM, expectedClaimNames } from '../../services/verifier/src/core/dcql.mjs';
import { assertExactClaims } from '../../services/verifier/src/core/claim-policy.mjs';

const ageRequest = {
  id: 'age_cred',
  vct: 'http://localhost/vct/age-verification-credential',
  credentialType: 'AgeVerificationCredential',
  claims: ['ageOver18'],
};

const fieldsOf = (definition) => definition.input_descriptors[0].constraints.fields;

test('one input descriptor per request, keyed by the request id, for ldp_vc', () => {
  const definition = buildPresentationDefinition([ageRequest]);
  assert.equal(definition.input_descriptors.length, 1);
  const [descriptor] = definition.input_descriptors;
  assert.equal(descriptor.id, 'age_cred', '/vp/status keys matched claims by descriptor id');
  assert.deepEqual(Object.keys(descriptor.format), [LDP_VC_FORMAT]);
  assert.equal(LDP_VC_FORMAT, 'ldp_vc');
});

test('asks for exactly the domain claim, the credential type and the issuer', () => {
  const paths = fieldsOf(buildPresentationDefinition([ageRequest])).map((f) => f.path[0]);
  assert.deepEqual(paths.sort(), ['$.credentialSubject.ageOver18', '$.issuer', '$.type']);
});

test('pins the credential type with a filter every field-filtering wallet accepts', () => {
  const typeField = fieldsOf(buildPresentationDefinition([ageRequest])).find((f) => f.path[0] === '$.type');
  // `type` is required by wallets, which reject a filter without one. This is
  // the shape the Brazil verifiers send to Inji-based wallets.
  assert.deepEqual(typeField.filter, { type: 'object', pattern: 'AgeVerificationCredential' });
});

test('does NOT constrain the value of the age claim', () => {
  // A const:true filter would turn a legitimate minor into "no credential
  // matched" instead of a verified DENIED — the same rule as the DCQL request.
  const claimField = fieldsOf(buildPresentationDefinition([ageRequest])).find((f) =>
    f.path[0].endsWith('ageOver18'),
  );
  assert.equal(claimField.filter, undefined);
});

test('carries the purpose when the use case declares one', () => {
  const definition = buildPresentationDefinition([ageRequest], { purpose: 'Applying for crop credit' });
  assert.equal(definition.purpose, 'Applying for crop credit');
  assert.equal(buildPresentationDefinition([ageRequest]).purpose, undefined);
  assert.throws(() => buildPresentationDefinition([ageRequest], { purpose: '  ' }), /non-empty string/);
});

test('refuses a request it cannot express safely', () => {
  assert.throws(() => buildPresentationDefinition([]), /at least one/);
  assert.throws(() => buildPresentationDefinition([{ ...ageRequest, claims: [] }]), /must name the claims/);
  assert.throws(() => buildPresentationDefinition([{ ...ageRequest, credentialType: undefined }]), /no credential type/);
  // The type is a regex pattern on the wallet side; a type that is not a plain
  // identifier could match more than the one credential type meant.
  assert.throws(() => buildPresentationDefinition([{ ...ageRequest, credentialType: 'Age.*' }]), /credential type/);
});

test('pexClaims maps issuer onto iss, so trust and exact-disclosure checks run unchanged', () => {
  const claims = pexClaims(
    { type: ['VerifiableCredential', 'AgeVerificationCredential'], ageOver18: true, issuer: 'did:web:issuer.example' },
    ageRequest,
  );
  assert.deepEqual(claims, { ageOver18: true, [ISSUER_CLAIM]: 'did:web:issuer.example' });
  assert.deepEqual(assertExactClaims(expectedClaimNames(ageRequest), claims), { ok: true });
});

test('pexClaims accepts an issuer given as an object with an id', () => {
  const claims = pexClaims(
    { type: ['AgeVerificationCredential'], ageOver18: false, issuer: { id: 'did:web:issuer.example', name: 'X' } },
    ageRequest,
  );
  assert.equal(claims[ISSUER_CLAIM], 'did:web:issuer.example');
  assert.equal(claims.ageOver18, false, 'false is an answer, not a missing claim');
});

test('pexClaims refuses a credential whose type list does not name the requested type', () => {
  // The wallet-side filter is a substring pattern; this is the exact check.
  for (const type of [['VerifiableCredential'], ['VerifiableCredential', 'AgeVerificationCredentialV2'], 'AgeVerificationCredential', undefined]) {
    assert.throws(
      () => pexClaims({ type, ageOver18: true, issuer: 'did:web:issuer.example' }, ageRequest),
      /not of type AgeVerificationCredential/,
      JSON.stringify(type),
    );
  }
});

test('pexClaims leaves an absent issuer absent, for the trust check to refuse', () => {
  const claims = pexClaims({ type: ['AgeVerificationCredential'], ageOver18: true }, ageRequest);
  assert.equal(ISSUER_CLAIM in claims, false);
});

test('pexClaims passes extra disclosures through, for the exact-disclosure check to refuse', () => {
  const claims = pexClaims(
    { type: ['AgeVerificationCredential'], ageOver18: true, issuer: 'did:x', name: 'Meera' },
    ageRequest,
  );
  assert.equal(assertExactClaims(expectedClaimNames(ageRequest), claims).ok, false);
});
