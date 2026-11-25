#!/usr/bin/env bash
# Scripted walkthrough: the positive case and the headline negative cases, driven
# end to end through the real protocol with the scripted wallet.
#
# This is the demo that runs without a phone. The on-device run with Paradym
# covers the one thing a script cannot: the consent screen the holder sees.
#
# Plain text, no colour: this output gets pasted into evidence.
#
#   ./scripts/demo.sh              positive + negatives
#   ./scripts/demo.sh AGE-000002   one specific citizen
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export CITIZEN="${1:-}"

cd "$ROOT"
[ -d node_modules/jose ] || { printf '  installing test dependencies...\n'; npm install --silent; }

node --input-type=module <<'NODE'
import {
  deployEnv, requireStack, issueOfferFor, issueAsIssuer, ensureNegativeFixture,
  retireNegativeFixture, startVerification, readVerification, verifierPolicy,
  disclosedClaimNames,
} from './tests/e2e/lib/stack.mjs';
import {
  createHolder, collectCredential, presentSdJwt, disclosableClaims,
  fetchRequestObject, submitPresentation, forgeDisclosureValue,
} from './tests/e2e/lib/wallet.mjs';

const { base, untrustedIssuerDid } = deployEnv();
const problem = await requireStack(base);
if (problem) {
  console.error(`\n  ${problem}\n`);
  process.exit(1);
}

const step = (n, s) => console.log(`   ${n}. ${s}`);

const policy = await verifierPolicy(base);
console.log(`\nAge verification demo - ${base}`);
console.log(`  verifier requests: ${policy.requestedClaims.join(', ')}`);
console.log(`  accepted issuers:  ${policy.trustedIssuers.join(', ')}`);

let provisionedFixtureSchemaId = null;

async function runCase({ label, citizenId, expect, mutate = {}, issuer }) {
  console.log(`\n${label}`);
  const holder = await createHolder();

  let offer;
  if (issuer === 'untrusted') {
    // Not created by bootstrap any more — see ensureNegativeFixture's comment.
    // Recorded so it can be retired again at the end: leaving it advertised puts
    // a second credential in the wallet's issuer directory, which is precisely
    // what the showcase review asked us to remove.
    provisionedFixtureSchemaId = (await ensureNegativeFixture(untrustedIssuerDid))?.schemaId;
    offer = await issueAsIssuer({
      base,
      issuerDid: untrustedIssuerDid,
      credentialName: 'Age Verification Credential (unlisted issuer)',
      claims: { ageOver18: true, ageOver21: true, name: 'Impostor', dateOfBirth: '1990-01-01' },
    });
    step(1, `an UNLISTED issuer creates an offer (${untrustedIssuerDid})`);
  } else {
    offer = await issueOfferFor(base, citizenId);
    step(1, `National Identity Authority issues for ${citizenId} [claims: ${offer.claimNames.join(', ')}]`);
  }

  const { credential } = await collectCredential({ base, offer, holder });
  step(2, 'wallet collected the credential (holder-bound: cnf.jwk is this wallet key)');
  step(3, `credential can disclose: ${disclosableClaims(credential).join(', ')}`);

  const session = await startVerification(base);
  step(4, `verifier shows a QR (${session.qrData.slice(0, 48)}...)`);

  const request = await fetchRequestObject({ base, transactionId: session.sessionId });
  const presentation = await presentSdJwt({
    credential,
    disclose: ['ageOver18'],
    holder: mutate.signWith ? await createHolder() : holder,
    nonce: mutate.nonce ?? request.nonce,
    audience: mutate.audience ?? request.client_id,
    tamperDisclosures: mutate.tamper
      ? (ds) => ds.map((d) => (d.name === 'ageOver18' ? forgeDisclosureValue(d, true) : d))
      : undefined,
  });
  step(5, `holder consents, discloses: ${disclosedClaimNames(presentation).join(', ')} (withheld: name, dateOfBirth, ageOver13, ageOver16, ageOver21)`);

  const submitted = await submitPresentation({
    base,
    state: request.state,
    queryId: 'age_cred',
    presentation,
  });
  const { body } = await readVerification(base, session.sessionId);

  const verdict = body.decision ?? `NOT VERIFIED (${body.reason})`;
  const ok = expect === 'rejected' ? body.state === 'rejected' : body.decision === expect;
  step(6, `verifier says: ${verdict} [submission HTTP ${submitted.status}]`);
  if (body.checks && Object.keys(body.checks).length) {
    console.log(`      checks: ${Object.entries(body.checks).map(([k, v]) => `${k}:${v}`).join('  ')}`);
  }
  console.log(ok ? '   => as expected' : `   => UNEXPECTED, wanted ${expect}`);
  return ok;
}

const results = [];
if (process.env.CITIZEN) {
  results.push(await runCase({
    label: `Citizen ${process.env.CITIZEN}`,
    citizenId: process.env.CITIZEN,
    expect: 'APPROVED',
  }));
} else {
  results.push(await runCase({
    label: '1) Adult - expects APPROVED',
    citizenId: 'AGE-000001',
    expect: 'APPROVED',
  }));
  results.push(await runCase({
    label: '2) Minor - expects a verified DENIED (not a failure)',
    citizenId: 'AGE-000002',
    expect: 'DENIED',
  }));
  results.push(await runCase({
    label: '3) Tampered disclosure - expects rejection',
    citizenId: 'AGE-000002',
    expect: 'rejected',
    mutate: { tamper: true },
  }));
  results.push(await runCase({
    label: '4) Unlisted issuer with a valid signature - expects rejection',
    expect: 'rejected',
    issuer: 'untrusted',
  }));
}

// Take the untrusted-issuer fixture back out of the advertised credentials. A
// demo run must not leave a second credential in the wallet's issuer directory.
await retireNegativeFixture(provisionedFixtureSchemaId);

const failed = results.filter((r) => !r).length;
console.log(
  failed === 0
    ? `\nAll ${results.length} case(s) behaved as expected\n`
    : `\n${failed} case(s) did NOT behave as expected\n`,
);
process.exit(failed === 0 ? 0 : 1);
NODE
