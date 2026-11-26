// The installed mobile verifier, Flow 3.
//
// Versions are pinned to the exact set already proven on this hardware by the
// wallet build (Expo 56.0.12 / React Native 0.85.3 / React 19.2.3), so the
// Android toolchain — NDK 27, Gradle 9.3.1, build-tools 36 — is known to work
// rather than hoped to.
//
// Which use case this build IS is decided here, not at runtime. Same reason the
// wallet's issuer directory is baked in with CREDENTIAL_ISSUER_URLS: the
// Agriculture demo must not put an Age option in front of anyone, and a picker
// on the idle screen does exactly that. One app, one channel, chosen at build
// time:
//
//   VERIFIER_USE_CASE=age                ->  "Age Check"              /api/verifier
//   VERIFIER_USE_CASE=agriculture        ->  "Farm Credit"            /api/verifier/agriculture
//   VERIFIER_USE_CASE=education-masters  ->  "Master's Admissions"    /api/verifier/education/masters
//   VERIFIER_USE_CASE=education-job      ->  "Interview Shortlisting" /api/verifier/education/job
//
// Iteration 03 adds TWO channels rather than one "Education Verifier", because it
// has two relying parties, not one: a university admissions office and an
// employer are as different from each other as either is from the bank, and they
// sign with different DIDs. One app named for both would be the same mislabelling
// this build-time channel exists to prevent — and it is what put "Farm Credit" on
// the home screen during an Education demo.
//
// The PACKAGE deliberately does not change. PRODUCT.md lists an
// "Agriculture-specific mobile verifier application" as out of scope, so this
// stays one application serving both channels rather than becoming two apps —
// which is also why the two builds replace each other on a device, as the wallet
// builds do.
const USE_CASE = process.env.VERIFIER_USE_CASE ?? 'age';
const NAMES = {
  age: 'Age Check',
  agriculture: 'Farm Credit',
  'education-masters': "Master's Admissions",
  'education-job': 'Interview Shortlisting',
};
// The Age build's threshold is fixed at build time too: a real age-restricted
// service has one legal minimum, not a menu. Must be one the verifier supports.
const AGE_THRESHOLD = Number(process.env.VERIFIER_AGE_THRESHOLD ?? 18);
if (![16, 18].includes(AGE_THRESHOLD)) {
  throw new Error(
    `VERIFIER_AGE_THRESHOLD must be one of 16, 18, got '${process.env.VERIFIER_AGE_THRESHOLD}'`,
  );
}
if (!NAMES[USE_CASE]) {
  throw new Error(
    `VERIFIER_USE_CASE must be one of ${Object.keys(NAMES).join(', ')}, got '${USE_CASE}'`,
  );
}

export default {
  expo: {
    name: NAMES[USE_CASE],
    slug: 'age-verifier-mobile',
    version: '1.0.0',
    orientation: 'portrait',
    userInterfaceStyle: 'light',
    newArchEnabled: true,
    android: {
      // Its own package, so it installs beside the wallet rather than over it.
      package: 'id.sunbird.ageverifier',
      versionCode: 1,
    },
    plugins: ['./plugins/with-openid4vp-query'],
    extra: {
      // Where the reusable verifier service lives. The app makes exactly two
      // calls to it and renders the answer; it never inspects a credential.
      verifierBaseUrl: process.env.VERIFIER_BASE_URL ?? 'http://localhost',
      // The one channel this build serves. Read once, at start-up.
      useCase: USE_CASE,
      // Only read by the Age channel.
      ageThreshold: AGE_THRESHOLD,
    },
  },
};
