// The reusable verifier service.
//
// Everything here is generic except one import: the Age domain module. The order
// of operations is the point of the whole component —
//
//   1. cryptographic verification passed (all checks OK, upstream);
//   2. the disclosure is exactly what was requested;
//   3. the issuer is on the demo trust allowlist;
//   4. only then, a domain decision.
//
// Iterations 2 and 3 add domain modules and credential requests. They must not
// need to touch steps 1-3.

import { createServer } from 'node:http';
import { oid4vcClient } from './core/oid4vc-client.mjs';
import { loadAlgorithmPolicy } from './core/algorithms.mjs';
import { buildDcqlQuery, expectedClaimNames, ISSUER_CLAIM } from './core/dcql.mjs';
import { evaluateChecks } from './core/checks.mjs';
import { resolveTrustPolicy } from './core/trust.mjs';
import { credentialStatusChecker } from './core/credential-status.mjs';
import { assertExactClaims } from './core/claim-policy.mjs';
import { sessionStore } from './core/sessions.mjs';
import { ageCredentialRequest, decideAge, AGE_CLAIM } from './domains/age/index.mjs';
import {
  agricultureCredentialRequests,
  decideFarmCredit,
  loadCropPolicy,
  FARMER_CLAIMS,
  LAND_CLAIMS,
} from './domains/agriculture/index.mjs';
import { formatIndianRupees } from './domains/agriculture/money.mjs';
import {
  educationCredentialRequests,
  decideEducation,
  POLICIES as EDUCATION_POLICIES,
  ACCEPTED_FIELDS,
  NEVER_REQUESTED,
} from './domains/education/index.mjs';
import QRCode from 'qrcode-svg';

// A QR whose modules land on WHOLE pixels.
//
// qrcode-svg maps the symbol onto whatever width it is given, so a 61-module symbol on a
// 480px canvas gets a module pitch of 7.8688... px and every rect carries a fractional x.
// Combined with shape-rendering:crispEdges -- which snaps each rect independently to the
// device pixel grid -- adjacent modules round different ways and the symbol grows hairline
// white seams and doubled edges. A decoder measures module edges, so that is exactly the
// wrong noise to add, and it gets worse the larger the symbol is drawn.
//
// Measure the module count from a first pass, then regenerate on a canvas that is an exact
// multiple of it. The symbol is unchanged; only its geometry becomes integral.
//
// The Education request pins THREE credential types and so carries the longest payload in
// the showcase, which is where this was found: a Galaxy A05 could not lock onto it.
function crispQrSvg(content) {
  const opts = { content, padding: 4, ecl: 'L' };
  const probe = new QRCode({ ...opts, width: 480, height: 480 }).svg();
  // Every module rect shares one width. Ignore the full-canvas background rect.
  const widths = [...probe.matchAll(/width="([0-9.]+)"/g)].map((m) => Number(m[1]));
  const pitch = Math.min(...widths.filter((w) => w > 0 && w < 480));
  const modules = Number.isFinite(pitch) && pitch > 0 ? Math.round(480 / pitch) : 0;
  if (!modules) return probe;
  // 8px per module keeps a dense symbol well above what a phone camera needs at arm's
  // length, without making the canvas unreasonable on a laptop screen.
  const side = modules * 8;
  const svg = new QRCode({ ...opts, width: side, height: side }).svg();

  // A viewBox, which qrcode-svg does not emit. Without one the SVG cannot SCALE: the
  // module rects keep their absolute coordinates, so any CSS that renders the element
  // smaller than the generated canvas simply CLIPS the symbol instead of shrinking it.
  // Measured on the admissions page: a 488px symbol rendered into 272px, cutting off 44%
  // of it -- a QR missing its right-hand side and bottom-right alignment pattern, which no
  // decoder can read and which looks, at a glance, like a perfectly ordinary QR code.
  // With a viewBox the geometry above is a coordinate system rather than a pixel size, so
  // the symbol stays whole at whatever size the page gives it.
  return svg.replace('<svg ', `<svg viewBox="0 0 ${side} ${side}" preserveAspectRatio="xMidYMid meet" `);
}

const PORT = Number(process.env.PORT || 4300);
const PUBLIC_URL = (process.env.PUBLIC_URL || 'http://localhost').replace(/\/+$/, '');
const AGE_VCT = process.env.AGE_VCT || `${PUBLIC_URL}/vct/age-verification-credential`;
const FARMER_VCT = process.env.FARMER_VCT || `${PUBLIC_URL}/vct/farmer-identity-credential`;
const LAND_VCT = process.env.LAND_VCT || `${PUBLIC_URL}/vct/land-ownership-credential`;
const SCHOOL_VCT = process.env.SCHOOL_VCT || `${PUBLIC_URL}/vct/school-record-credential`;
const COLLEGE_VCT = process.env.COLLEGE_VCT || `${PUBLIC_URL}/vct/college-record-credential`;
const UNIVERSITY_VCT = process.env.UNIVERSITY_VCT || `${PUBLIC_URL}/vct/university-record-credential`;
const TRUST_POLICY_FILE = process.env.TRUST_POLICY_FILE || '/app/config/trust/issuers.json';
// Where to resolve issuers the trust policy names rather than spells out. Unset
// is fine for a policy of literal DIDs; an entry that needs it will say so and
// refuse to start.
const AUTHORITY_BASE_URL = process.env.AUTHORITY_BASE_URL || '';

// Asks the issuing Authority whether a credential is still one it stands behind. The
// endpoint is not configured here: it comes from the trust policy entry for the issuer that
// signed the credential, so a credential can never point this at somewhere of its choosing.
const credentialStatus = credentialStatusChecker();
// The claim carrying an Agriculture credential's identifier at the issuing Authority.
//
// Checking live status is the DEFAULT for this journey, not an option. A lender deciding on
// a credential whose source may since have been suspended is the failure this iteration
// exists to remove, and a check that ships off by default is a check most deployments will
// never turn on.
//
// Set AGRICULTURE_STATUS_CLAIM='' to disable it deliberately. A credential that carries no
// such identifier is then refused rather than waved through — an unlinked credential has
// unknown standing, which is not the same as good standing.
const AGRICULTURE_STATUS_CLAIM =
  process.env.AGRICULTURE_STATUS_CLAIM === undefined
    ? 'authorityCredentialId'
    : process.env.AGRICULTURE_STATUS_CLAIM;
const CROP_POLICY_FILE = process.env.CROP_POLICY_FILE || '/app/config/policy/crop-rates.json';
const ALG_POLICY_FILE = process.env.ALG_POLICY_FILE || '/app/config/policy/algorithms.json';
// Mirrors oid4vc-service's VP_TXN_TTL default. A verifier session outliving the
// protocol transaction would show a QR that can no longer be answered.
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_SECONDS || 300);

/**
 * The OID4VP signers, one per requesting PARTY.
 *
 * A wallet names the requesting party from the key that signed the request
 * object, so two verifiers sharing one signer are one party as far as any wallet
 * can tell — the farmer's consent screen read "Do you trust Age Check?" while
 * applying for crop credit. Separate identities for separate parties is the rule
 * bootstrap.sh already applies between the issuer and the verifier; this is the
 * same rule between the two verifiers.
 *
 * Falls back to the age signer when no bank instance is configured, so a
 * deployment that has not been re-bootstrapped still works — it just names the
 * wrong party, which is a demo defect and not an outage.
 */
const signers = {
  age: oid4vcClient({ baseUrl: process.env.OID4VC_BASE_URL || 'http://oid4vc-service:3400' }),
  bank: oid4vcClient({
    baseUrl:
      process.env.OID4VC_BANK_BASE_URL || process.env.OID4VC_BASE_URL || 'http://oid4vc-service:3400',
  }),
  // Iteration 03's two relying parties. A university admissions office and an
  // employer are as different from each other as either is from the bank, and
  // the learner presents to both from the same wallet in the same demo — so if
  // they shared a key, the second consent screen would name the first party.
  universityAdmissions: oid4vcClient({
    baseUrl:
      process.env.OID4VC_UNIVERSITY_VP_BASE_URL ||
      process.env.OID4VC_BASE_URL ||
      'http://oid4vc-service:3400',
  }),
  employer: oid4vcClient({
    baseUrl:
      process.env.OID4VC_EMPLOYER_VP_BASE_URL || process.env.OID4VC_BASE_URL || 'http://oid4vc-service:3400',
  }),
};
// Health and readiness stay the age instance's: it is the one every deployment
// has, and the readiness probe must not start failing on an optional service.
const oid4vc = signers.age;
const sessions = sessionStore({ ttlSeconds: SESSION_TTL_SECONDS });

// Resolved once, at boot, before the listener opens — see the bottom of this
// file. Deliberately allowed to throw: a verifier that cannot tell which issuers
// it trusts must not start and accept presentations.
//
// Assigned rather than const because resolution reads the Authority Service for
// any issuer the policy names instead of spelling out, and that is asynchronous.
// Nothing reads it before listen(), which is the ordering that matters.
let trust;

// Same rule as the trust allowlist: a verifier that cannot read the lending
// policy must not start and then quote a rupee figure it made up.
const cropPolicy = loadCropPolicy({ file: CROP_POLICY_FILE });
// Deliberately allowed to throw: a verifier that cannot read its algorithm
// policy must not start and silently accept anything, which is exactly the
// failure mode Iteration 01 refused to ship.
const algPolicy = loadAlgorithmPolicy({ file: ALG_POLICY_FILE });

/**
 * Strips anything that looks like a token, credential or disclosure out of an
 * upstream diagnostic before it reaches a browser or a log.
 *
 * Upstream messages are short and structural ('nonce mismatch'), but they are
 * built by interpolating an error, so a future one could carry a JWT or a claim
 * value. Long base64url runs are the giveaway.
 */
function sanitiseDiagnostic(message) {
  if (typeof message !== 'string') return undefined;
  return message
    .replace(/[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{8,}[.~][A-Za-z0-9_.~-]*/g, '[redacted]')
    .replace(/[A-Za-z0-9_-]{40,}/g, '[redacted]')
    .slice(0, 200);
}

/**
 * Strips the protocol-level issuer claim from a disclosed claim set.
 *
 * `iss` arrives with every credential and is consumed by the trust check; it is
 * not something the holder chose to disclose, so listing it under "shared with
 * us" would overstate what the learner gave away.
 */
function holderDisclosed(claims) {
  const { [ISSUER_CLAIM]: _issuer, ...rest } = claims;
  return rest;
}

/**
 * One Education use case, from a policy id and a signing identity.
 *
 * Both portals ask the same three issuers for the same three credential types.
 * Everything that differs — which claims are requested, which thresholds apply,
 * what the eligible wording is — comes out of POLICIES, so the two use cases
 * cannot drift apart in behaviour that PRODUCT says is shared, and cannot
 * accidentally converge on behaviour PRODUCT says differs.
 */
function educationUseCase(policyId, signer) {
  const policy = EDUCATION_POLICIES[policyId];
  if (!policy) throw new Error(`unknown education policy ${policyId}`);
  const requests = () =>
    educationCredentialRequests({
      policy: policyId,
      schoolVct: SCHOOL_VCT,
      collegeVct: COLLEGE_VCT,
      universityVct: UNIVERSITY_VCT,
    });

  return {
    signer,
    requests,
    // Exactly the string /policy publishes and the result page prints, so the
    // wallet's consent screen, the portal and the response cannot disagree.
    purpose: () => policy.purpose,
    describe: () => `requesting the school, college and university credentials for ${policy.purpose}`,
    requestedClaims: () => policy.claims,
    decide: (verified) => decideEducation(verified, policyId),
    respond: (outcome, { status, issuer, verified }) => ({
      state: 'decided',
      decision: outcome.outcome,
      reason: outcome.reason,
      checks: status.checks,
      issuer,
      policy: policy.id,
      purpose: policy.purpose,
      // The exact wording PRODUCT specifies, from the policy rather than from
      // this file: 'eligible to apply' is not admission and 'round one' is not
      // employment, and a paraphrase written at the response layer is how that
      // distinction gets lost.
      headline: outcome.headline,
      detail: outcome.detail,
      learnerId: outcome.learnerId,
      thresholds: outcome.thresholds ?? policy.thresholds,
      // The percentages the decision compared, already formatted, and the one
      // that fell short. Published so a page never formats a percentage itself:
      // the module that owns the arithmetic owns how it reads, exactly as the
      // bank's money is formatted in one place.
      verified: outcome.verified,
      shortfall: outcome.shortfall,
      // Everything the learner disclosed, per credential, with the protocol
      // issuer claim removed. Kept per credential rather than merged: learnerId
      // appearing three times is the correlation the verifier checked, and
      // flattening it would hide the one fact the screen most needs to show.
      disclosed: {
        school: holderDisclosed(verified.school),
        college: holderDisclosed(verified.college),
        university: holderDisclosed(verified.university),
      },
    }),
    policy: () => ({
      policy: policy.id,
      purpose: policy.purpose,
      credentialTypes: { school: SCHOOL_VCT, college: COLLEGE_VCT, university: UNIVERSITY_VCT },
      requestedClaims: policy.claims,
      protocolClaims: [ISSUER_CLAIM],
      thresholds: policy.thresholds,
      acceptedFieldsOfStudy: ACCEPTED_FIELDS,
      // Published so a reader can see that the job portal does not ask for the
      // school or college percentage, rather than taking the page's word for it.
      notRequested: Object.fromEntries(
        Object.entries(EDUCATION_POLICIES.masters.claims).map(([role, all]) => [
          role,
          all.filter((claim) => !policy.claims[role].includes(claim)),
        ]),
      ),
      // What NEITHER portal asks for. Served rather than written into the page,
      // so a privacy claim on screen cannot outrun the request behind it.
      neverRequested: NEVER_REQUESTED,
      trustedIssuers: trust.issuers.map((i) => ({ name: i.name, roles: i.roles })),
      approvedAlgorithms: algPolicy.approved,
    }),
  };
}

/**
 * The use cases this verifier serves.
 *
 * A use case declares which credentials it asks for and what the verified
 * claims mean. Everything between the request and the decision — verification,
 * disclosure policy, issuer trust — is shared, which is the entire reason this
 * service is reusable rather than copied.
 */
// The claim lists the Agriculture journey ACTUALLY requests, derived from the requests
// themselves rather than restated. When the status check is enabled the identifier is
// appended to each request, and a policy that still published the base list would tell a
// wallet to disclose less than the query demands — which fails as "DCQL not satisfied",
// several services away from the mismatch.
const agricultureRequestedClaims = () => {
  const requests = agricultureCredentialRequests({
    farmerVct: FARMER_VCT,
    landVct: LAND_VCT,
    statusClaim: AGRICULTURE_STATUS_CLAIM,
  });
  return Object.fromEntries(requests.map((r) => [r.role, r.claims]));
};

const USE_CASES = {
  age: {
    signer: 'age',
    requests: () => [ageCredentialRequest({ vct: AGE_VCT })],
    describe: () => `requesting ${AGE_CLAIM} only`,
    requestedClaims: () => [AGE_CLAIM],
    decide: (verified, session) => decideAge(verified[session.requests[0].id]),
    respond: (outcome, { status, issuer, verified, session }) => ({
      state: 'decided',
      decision: outcome.decision,
      reason: outcome.reason,
      checks: status.checks,
      issuer,
      // The claim the holder chose to disclose, and nothing else. holderDid is
      // available upstream and deliberately not surfaced or logged.
      disclosed: { [AGE_CLAIM]: verified[session.requests[0].id][AGE_CLAIM] },
    }),
    policy: () => ({
      credentialType: AGE_VCT,
      requestedClaims: [AGE_CLAIM],
      protocolClaims: [ISSUER_CLAIM],
      trustedIssuers: trust.issuers.map((i) => i.name),
      approvedAlgorithms: algPolicy.approved,
    }),
  },
  agriculture: {
    // The bank is a different party from the age-restricted service, so it signs
    // with its own DID and the wallet names it correctly.
    signer: 'bank',
    requests: () =>
      agricultureCredentialRequests({
        farmerVct: FARMER_VCT,
        landVct: LAND_VCT,
        statusClaim: AGRICULTURE_STATUS_CLAIM,
      }),
    // The purpose the wallet shows the farmer BEFORE they consent. Without it Paradym
    // renders "No information was provided on the purpose of the data request. Be
    // cautious" — which is accurate, and is exactly the wrong thing to show someone
    // being asked to share credentials for a loan they came to apply for. It travels
    // in `credential_sets[].purpose`; see core/dcql.mjs for why not client_metadata.
    //
    // Worded as the applicant's own goal, not the bank's internal one: they are
    // applying for crop credit, not "undergoing eligibility assessment".
    purpose: () => 'Applying for crop credit',
    describe: () => 'requesting the farmer and land credentials',
    requestedClaims: () => agricultureRequestedClaims(),
    decide: (verified) => decideFarmCredit({ farmer: verified.farmer, land: verified.land }, cropPolicy),
    respond: (outcome, { status, issuer, verified }) => ({
      state: 'decided',
      decision: outcome.outcome,
      reason: outcome.reason,
      checks: status.checks,
      issuer,
      // EVERYTHING the farmer disclosed, not merely the inputs the policy
      // happened to use. The page prints this under "Shared with us" next to
      // the list of claims that were withheld, so a short list here does not
      // read as brevity — it reads as a stronger privacy guarantee than the
      // request actually made. It listed three claims of the five distinct
      // ones that arrived until this was fixed.
      //
      // farmerReference is taken from the FARMER credential specifically, and
      // the land credential's copy is not spread over it: when the two disagree
      // the decision is CORRELATION_FAILED, and a merge would quietly display
      // one reference for a presentation that carried two.
      disclosed: {
        farmerReference: verified.farmer.farmerReference,
        registrationStatus: verified.farmer.registrationStatus,
        // Reported because the farmer disclosed it. It is technical linkage rather than a
        // business claim, and it is still something they handed over — a "shared with us"
        // list that quietly omitted it would understate what travelled, which is the same
        // dishonesty as overstating what was withheld.
        ...(AGRICULTURE_STATUS_CLAIM && verified.farmer[AGRICULTURE_STATUS_CLAIM] !== undefined
          ? { [AGRICULTURE_STATUS_CLAIM]: verified.farmer[AGRICULTURE_STATUS_CLAIM] }
          : {}),
        ...(verified.land
          ? {
              ownershipStatus: verified.land.ownershipStatus,
              cropType: verified.land.cropType,
              cultivatedArea: verified.land.cultivatedArea,
            }
          : {}),
      },
      loan:
        outcome.outcome === 'ELIGIBLE'
          ? {
              ratePerAcre: outcome.ratePerAcre,
              // Formatted here as well as the total, because the mobile
              // verifier runs on Hermes, where Intl is not guaranteed and
              // Number.toLocaleString('en-IN') silently falls back to plain
              // grouping — so the phone would print a different figure from the
              // web page for the same decision. Money is formatted in one
              // place, by the service that owns the policy.
              ratePerAcreFormatted: formatIndianRupees(outcome.ratePerAcre),
              maximumLoan: outcome.maximumLoan,
              maximumLoanFormatted: formatIndianRupees(outcome.maximumLoan),
              currency: cropPolicy.currency,
            }
          : undefined,
    }),
    policy: () => ({
      credentialTypes: { farmer: FARMER_VCT, land: LAND_VCT },
      requestedClaims: agricultureRequestedClaims(),
      protocolClaims: [ISSUER_CLAIM],
      cropRates: Object.fromEntries(cropPolicy.crops.map((crop) => [crop, cropPolicy.rate(crop)])),
      maxRatePerAcre: cropPolicy.maxRatePerAcre,
      currency: cropPolicy.currency,
      trustedIssuers: trust.issuers.map((i) => ({ name: i.name, roles: i.roles })),
      approvedAlgorithms: algPolicy.approved,
    }),
  },
  // Iteration 03. Two use cases over the SAME three credentials, which is the
  // whole argument: one learner, one wallet, two relying parties, two different
  // requests and two different answers. They are built from one factory because
  // nothing distinguishes them but the policy id — if they needed separate code
  // paths, the claim that disclosure follows purpose would be a coincidence of
  // two implementations rather than a property of one.
  'education/masters': educationUseCase('masters', 'universityAdmissions'),
  'education/job': educationUseCase('job', 'employer'),
};

/**
 * The optional use-case prefix a front end may address its own namespace by.
 *
 * Reading and cancelling are use-case agnostic — the session itself records
 * which use case it belongs to — but a page that POSTs to
 * /api/verifier/agriculture/sessions reasonably expects to GET the result back
 * from the same place. Without this, the bank page's poll landed on no route at
 * all, the 404 was rendered as "the request expired", and the application it
 * described as unanswered had in fact been decided ELIGIBLE. Built from the map
 * so a third use case cannot be added and silently left un-pollable.
 */
const USE_CASE_PREFIX = `(?:/(?:${Object.keys(USE_CASES).join('|')}))?`;
const CANCEL_PATH = new RegExp(`^${USE_CASE_PREFIX}/sessions/([A-Za-z0-9_-]+)/cancel$`);
const READ_PATH = new RegExp(`^${USE_CASE_PREFIX}/sessions/([A-Za-z0-9_-]+)$`);

async function createSession(useCaseName = 'age') {
  const useCase = USE_CASES[useCaseName];
  if (!useCase) throw new Error(`unknown use case ${useCaseName}`);

  const requests = useCase.requests();
  // The purpose the wallet shows the holder before they consent, taken from the
  // use case rather than written here: the string a learner reads has to be the
  // same one the portal's /policy endpoint publishes, or the consent screen and
  // the published policy could disagree about why the data was wanted.
  const query = buildDcqlQuery(requests, { purpose: useCase.purpose?.() });
  const vp = await signers[useCase.signer].createRequest(query);

  const session = sessions.create({
    id: vp.transaction_id,
    useCase: useCaseName,
    // Recorded, not re-derived: the status of a transaction lives in the
    // instance that created it, so reading it from the other one is a 404 the
    // page would render as "expired".
    signer: useCase.signer,
    // One entry per credential the request asks for. Age has exactly one, which
    // is why its behaviour is unchanged by this becoming a list.
    requests: requests.map((request) => ({
      id: request.id,
      role: request.role,
      expectedClaims: expectedClaimNames(request),
      // Carried into the session, or the status check silently does not happen: the
      // decision reads the session's copy of the request, not the one the query was built
      // from, and a field dropped here is a check that looks configured and never runs.
      statusClaim: request.statusClaim,
    })),
    qrData: vp.qr_data,
  });

  console.log(`[verifier] session ${session.id} created (${useCaseName}); ${useCase.describe()}`);

  const requestedClaims = useCase.requestedClaims();

  return {
    status: 201,
    body: {
      sessionId: session.id,
      useCase: useCaseName,
      // The deep link, and a rendering of it. The wallet gets everything it
      // needs from the QR; nothing about the holder is in it.
      qrData: vp.qr_data,
      // Sized and quiet-zoned for a PHONE CAMERA pointed at a laptop screen,
      // which is the actual demo. The payload is ~200 characters (a did:web
      // client_id plus an https request_uri), so the symbol is dense; at 320px
      // with a 2-module quiet zone a Galaxy A05 could not lock onto it. 480px
      // and the spec's 4-module quiet zone fixes it, and 'L' error correction
      // drops a version — fewer, larger modules — which matters far more here
      // than resilience to a smudged print.
      qrSvg: crispQrSvg(vp.qr_data),
      requestedClaims,
      expiresInSeconds: SESSION_TTL_SECONDS,
    },
  };
}

/**
 * Sessions the verifier has given up on.
 *
 * Needed because a wallet that declines tells us NOTHING: Paradym posts no
 * response at all on refusal (observed 27 August 2026), so a declined request is
 * indistinguishable from one the holder simply ignored, and the only terminal
 * signal would be the TTL — minutes of an empty screen.
 *
 * Cancelling is therefore the verifier's own decision: it stops waiting, and it
 * will not report a decision for that request afterwards even if a presentation
 * turns up late. That last part is why this is enforced here rather than by a
 * timer in the UI: a client-side "cancelled" label over a session still capable
 * of returning APPROVED would be a lie.
 */
const abandoned = new Set();

async function readSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) return { status: 404, body: { state: 'expired' } };
  if (abandoned.has(sessionId)) {
    return {
      status: 200,
      body: { state: 'cancelled', reason: 'the check was cancelled before a presentation arrived' },
    };
  }

  let status;
  try {
    status = await signers[session.signer || 'age'].getStatus(sessionId);
  } catch (err) {
    if (err.status === 404) return { status: 404, body: { state: 'expired' } };
    throw err;
  }

  const reject = (reason, extra = {}) => ({
    status: 200,
    body: { state: 'rejected', reason, checks: status.checks || {}, ...extra },
  });

  // 1. Cryptographic verification, upstream. Nothing below runs until this
  //    passes — including, and especially, the domain decision.
  const verification = evaluateChecks(status);
  if (!verification.ok) {
    if (verification.reason === 'pending') {
      // qrData travels with the waiting state so a client that has only a
      // session id can still find the request — a page reloaded mid-session, or
      // the hand-driven wallet in scripts/. It is the transaction the page is
      // already displaying, it names the signer that holds it, and it contains
      // nothing about the holder. Rebuilding that URL from PUBLIC_URL instead
      // would guess a path prefix and reach the wrong signer.
      return { status: 200, body: { state: 'waiting', qrData: session.qrData } };
    }
    // A refusal is not a failure. It gets its own state so the page can say
    // "nothing was shared" instead of showing a red verification error, and so
    // no claim values or checks are reported for a presentation that never
    // legitimately arrived.
    if (verification.declined) {
      console.log(`[verifier] session ${sessionId} declined by the holder`);
      return { status: 200, body: { state: 'declined', reason: verification.reason } };
    }
    console.log(`[verifier] session ${sessionId} rejected: ${verification.reason}`);
    return reject(verification.reason, {
      failedCheck: verification.failedCheck,
      diagnostic: sanitiseDiagnostic(status.error),
    });
  }

  // 1b. The approved-algorithm policy (REQUIREMENTS §8). After cryptographic
  //     verification, because a signature that does not verify is a different
  //     and worse failure; before the disclosure, trust and domain steps,
  //     because none of them should run on a presentation signed with something
  //     we have not approved.
  //
  //     A failure here is a REJECTION, not a business answer — the same class as
  //     an untrusted issuer. Both mean "we could not trust what we were shown".
  const algorithms = algPolicy.check(status.algs);
  if (!algorithms.ok) {
    console.log(`[verifier] session ${sessionId} rejected: ${algorithms.reason}`);
    return reject(algorithms.reason, {
      failedCheck: 'algorithm',
      diagnostic: algorithms.diagnostic,
    });
  }
  // Reported alongside the upstream checks so the enforcement is visible on the
  // page rather than only in this file. An unenforced control that claims a pill
  // would be worse than no pill, which is why this line sits AFTER the check.
  status.checks = { ...(status.checks || {}), algorithm: 'OK' };

  // Steps 2-4, once per credential the request asked for. Age passes through
  // this with a single entry; Agriculture with two. The loop is what makes a
  // multi-credential presentation safe: every credential is disclosure-checked
  // and trust-checked on its own, and one trusted issuer cannot stand in for
  // another's role.
  const verified = {};
  const issuerNames = [];
  for (const request of session.requests) {
    const claims = status.claims?.[request.id];
    if (!claims || typeof claims !== 'object') {
      return reject(
        session.requests.length > 1
          ? `presentation matched no ${request.role || request.id} credential for this request`
          : 'presentation matched no credential for this request',
      );
    }

    // 2. Disclosure policy: exactly what was asked for, nothing more.
    const policy = assertExactClaims(request.expectedClaims, claims);
    if (!policy.ok) {
      console.log(`[verifier] session ${sessionId} rejected: ${policy.reason}`);
      return reject(policy.reason);
    }

    // 3. Issuer trust, pinned to this credential's role. Sunbird RC proved the
    //    signature is valid; this proves it belongs to an issuer this verifier
    //    accepts FOR THIS SLOT.
    const trusted = trust.check(claims[ISSUER_CLAIM], { role: request.role });
    if (!trusted.ok) {
      console.log(`[verifier] session ${sessionId} rejected: ${trusted.reason}`);
      return reject(trusted.reason);
    }

    // 3b. Is the credential still one its Authority stands behind?
    //
    //     Sunbird RC's `revocation` check reports OK without consulting anything, so a
    //     credential whose source record was suspended still verifies. This asks the
    //     issuing Authority, which answers from the credential's own state combined with
    //     the current lifecycle of the record it came from.
    //
    //     Opt-in per request, via the claim that carries the credential's identifier.
    //     Journeys whose credentials carry no such identifier are unchanged rather than
    //     being failed for a check they cannot satisfy — and because the check refuses a
    //     missing identifier, declaring statusClaim on a request whose credential does not
    //     carry one fails closed rather than silently passing.
    if (request.statusClaim) {
      // Resolved against the Authority that vouched for THIS issuer, taken from the trust
      // policy — never from anything the credential carries. The credential supplies only
      // an identifier; where that identifier is looked up is configuration.
      const standing = await credentialStatus.check(
        claims[request.statusClaim],
        trusted.issuer.authorityBaseUrl,
      );
      if (!standing.ok) {
        console.log(`[verifier] session ${sessionId} rejected: ${standing.reason}`);
        return reject(standing.reason);
      }
    }

    verified[request.role || request.id] = claims;
    issuerNames.push(trusted.issuer.name);
  }

  // 4. Business rule, on verified claims only. Which rule, and how its answer is
  //    shaped for a client, are the use case's own business — steps 1-3 above are
  //    identical for all four, which is the reusability claim made good.
  //
  //    Holder binding across the whole presentation is proven upstream and
  //    asserted in step 1: oid4vc-service checks the Key Binding JWT for the
  //    presentation, so two or three credentials arriving in one VP token are
  //    held by one wallet key. That is what lets a domain module treat a matching
  //    farmerReference or learnerId as correlation rather than coincidence.
  const useCase = USE_CASES[session.useCase] || USE_CASES.age;
  let outcome;
  try {
    outcome = useCase.decide(verified, session);
  } catch (err) {
    // A malformed claim or broken correlation is a verification problem, not a
    // business answer. PRODUCT is explicit that it must not be presented as
    // ordinary ineligibility.
    console.log(`[verifier] session ${sessionId} rejected: ${err.message}`);
    return reject(err.message);
  }

  const issuer = issuerNames.length === 1 ? issuerNames[0] : issuerNames;
  const body = useCase.respond(outcome, { status, issuer, verified, session });

  console.log(
    `[verifier] session ${sessionId} ${body.decision} ` +
      `(issuer${issuerNames.length === 1 ? '' : 's'} ${issuerNames.join(', ')})`,
  );

  return { status: 200, body };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/\/+$/, '') || '/';

  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body ?? {}));
  };

  try {
    if (req.method === 'GET' && path === '/healthz') {
      return send(200, {
        status: 'UP',
        service: 'verifier',
        trustedIssuers: trust.issuers.length,
        activeSessions: sessions.size,
      });
    }
    if (req.method === 'GET' && path === '/readyz') {
      await oid4vc.health();
      return send(200, { status: 'UP', oid4vc: 'UP' });
    }
    // Every use case publishes what it asks for and the policy behind the answer
    // it will give, so a demo can prove the request is minimal and the rule fixed
    // rather than taking a page's word for it. `/policy` without a prefix stays
    // the Age one: it is a published surface Iteration 01 was accepted on.
    if (req.method === 'GET' && (path === '/policy' || path === '/age/policy')) {
      return send(200, USE_CASES.age.policy());
    }
    if (req.method === 'GET' && path.endsWith('/policy')) {
      const useCase = USE_CASES[path.slice(1, -'/policy'.length)];
      if (useCase) return send(200, useCase.policy());
    }
    // POST /sessions stays the Age one, for the same reason.
    if (req.method === 'POST' && (path === '/sessions' || path === '/age/sessions')) {
      const result = await createSession('age');
      return send(result.status, result.body);
    }
    if (req.method === 'POST' && path.endsWith('/sessions')) {
      const name = path.slice(1, -'/sessions'.length);
      if (USE_CASES[name]) {
        const result = await createSession(name);
        return send(result.status, result.body);
      }
    }
    const cancelMatch = CANCEL_PATH.exec(path);
    if (req.method === 'POST' && cancelMatch) {
      const id = cancelMatch[1];
      if (!sessions.get(id)) return send(404, { state: 'expired' });
      abandoned.add(id);
      console.log(`[verifier] session ${id} cancelled by the verifier; no decision will be reported`);
      return send(200, { state: 'cancelled' });
    }
    const match = READ_PATH.exec(path);
    if (req.method === 'GET' && match) {
      const result = await readSession(match[1]);
      return send(result.status, result.body);
    }
    return send(404, { error: 'not_found' });
  } catch (err) {
    console.error(`[verifier] ${req.method} ${path} failed: ${sanitiseDiagnostic(err.message)}`);
    return send(500, { error: 'verifier_error' });
  }
});

// Resolve trust first, then listen. The order is the safety property: a verifier
// that opened its port and resolved afterwards would accept presentations during
// the gap with no allowlist, and answer them.
//
// A failure here exits non-zero rather than serving in a degraded state. There is
// no useful degraded state for this — every branch below refuses everything.
try {
  trust = await resolveTrustPolicy({ file: TRUST_POLICY_FILE, baseUrl: AUTHORITY_BASE_URL });
} catch (err) {
  console.error(`[verifier] refusing to start: ${err.message}`);
  process.exit(1);
}

server.listen(PORT, () => {
  console.log(
    `[verifier] listening on ${PORT}; trusting ${trust.issuers.length} issuer(s); ` +
      `use cases ${Object.keys(USE_CASES).join(', ')}; ` +
      `age vct=${AGE_VCT}; agriculture vcts=${FARMER_VCT}, ${LAND_VCT}; ` +
      `education vcts=${SCHOOL_VCT}, ${COLLEGE_VCT}, ${UNIVERSITY_VCT}; ` +
      `crops=${cropPolicy.crops.join(',')}`,
  );
});
