import { createBaseConfig } from './base.app.config'
import { version } from './package.json'

const mediatorDids = {
  development: 'did:web:mediator.dev.paradym.id',
  preview: 'did:web:mediator.paradym.id',
  production: 'did:web:mediator.paradym.id',
}

const config = createBaseConfig({
  name: 'Sunbird Wallet',
  scheme: 'id.animo.paradym',
  icon: './assets/paradym/icon.png',
  // NOTE: android requires paths referenced directly in code
  // to only contain _ a-Z 0-9, so we use _ for all files
  adaptiveIcon: './assets/paradym/adaptive_icon.png',
  splash: './assets/paradym/splash.png',
  splashIcon: './assets/paradym/splash_icon.png',
  slug: 'paradym-wallet',
  version,
  bundleId: 'id.paradym.wallet',
  additionalInvitationSchemes: ['didcomm'],
  associatedDomains: ['paradym.id', 'dev.paradym.id', 'paradymwallet.app'],
  // Animo's EAS project id is deliberately not carried into this repository: it
  // would point builds and OTA updates at their Expo project. The showcase builds
  // locally, never through EAS.
  assets: ['./assets/paradym/icon.png'],
  extraConfig: {
    mediatorDid: mediatorDids[process.env.APP_VARIANT || 'production'],
    // [0] is what the wallet actually sends as redirect_uri (see constants.ts).
    // Pointed at our own sslip.io host rather than paradym.id/paradymwallet.app
    // because those domains' assetlinks.json can't list a debug-signed cert,
    // so App Link verification fails for local dev/preview builds.
    // paradymwallet.app is fallback domain, to allow for better universal linking if both Paradym and Paradym Wallet are used (both on paradym.id)
    // Overridable at build time. Set WALLET_REDIRECT_BASE_URLS to an empty
    // string and the wallet falls back to `<scheme>:///wallet/redirect`
    // (constants.ts), which needs no App Link verification — the right choice
    // for a build talking to a demo host whose assetlinks.json cannot list a
    // locally signed certificate.
    allowedRedirectBaseUrls: (
      process.env.WALLET_REDIRECT_BASE_URLS ??
      'https://paradym.id/invitation/redirect,https://paradymwallet.app/oauth2/redirect'
    )
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    // Comma-separated list of OID4VCI credential issuer base urls to show in the
    // issuer directory. Empty by default, which hides the directory entirely.
    credentialIssuerUrls: (process.env.CREDENTIAL_ISSUER_URLS ?? '')
      .split(',')
      .map((url) => url.trim())
      .filter(Boolean),
    // The showcase deployment this build trusts, as JSON:
    //
    //   {"baseUrl":"https://host","verifierDids":{"age":"did:web:...","bank":"did:web:..."}}
    //
    // Deployment-specific values are supplied at BUILD TIME rather than pinned in
    // src/constants.ts, because those DIDs carry the deployment's host and a uuid that
    // changes on every re-bootstrap. Pinning them put a sandbox address into a public
    // repository and went stale invisibly. Absent or unparseable yields no entries, which
    // is correct for a build not pointed at a showcase.
    showcaseDeployment: (() => {
      const raw = process.env.SHOWCASE_DEPLOYMENT
      if (!raw) return null
      try {
        return JSON.parse(raw)
      } catch (error) {
        // Failing loudly: a typo here silently produces a wallet that trusts nothing and
        // names no organisation, which looks like a deployment fault rather than a build one.
        throw new Error(`SHOWCASE_DEPLOYMENT is not valid JSON: ${error.message}`)
      }
    })(),
  },
})

export default () => config
