// The vendored wallet's trust configuration, checked as source.
//
// These invariants are structural, so they belong here rather than in verify.sh:
// they hold on any clean checkout with no stack running and no device attached.
//
// Why bother: the wallet's trust entries are compiled into an APK. Break one and
// nothing fails, nothing logs, and no test goes red — the wallet simply calls the
// verifier an unknown organisation, which is only visible to a person holding the
// phone. That is precisely the failure this iteration was sent back to fix once.
//
// The entries used to be PINNED here, one literal per party, and these tests read
// those literals. They are now GENERATED at build time from SHOWCASE_DEPLOYMENT,
// because the pinned form put a deployment's address into a public repository and
// went stale invisibly on every re-bootstrap. So the same invariants are checked
// one level up: on the tables the generator walks, and on the generator's order.

import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONSTANTS = join(ROOT, 'vendor', 'paradym-wallet', 'apps', 'wallet', 'src', 'constants.ts');
const CONFIG = join(ROOT, 'vendor', 'paradym-wallet', 'apps', 'wallet', 'app.config.js');
const LOGOS = join(ROOT, 'services', 'web-assets', 'logos');

const source = existsSync(CONSTANTS) ? readFileSync(CONSTANTS, 'utf8') : null;
const guard = () => {
  if (!source) throw new Error(`no vendored wallet at ${CONSTANTS} — run ./scripts/vendor-wallet.sh`);
};

/** One of the generator's tables, as `{ …fields }` objects in source order. */
function table(name) {
  const block = source.slice(source.indexOf(`const ${name} = [`));
  const body = block.slice(0, block.indexOf('] as const'));
  return [...body.matchAll(/\{([^}]+)\}/g)].map((m) =>
    Object.fromEntries(
      [...m[1].matchAll(/(\w+):\s*'([^']*)'/g)].map((f) => [f[1], f[2]]),
    ),
  );
}

describe('the vendored wallet pins no deployment', () => {
  test('no host, IP or DID is committed in the trust list', () => {
    guard();
    assert.doesNotMatch(source, /\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/, 'an IP address is pinned in the wallet source');
    // Upstream's own fixed addresses (paradym.id, animo.id) are legitimate; what must
    // not appear is a did:web minted by a deployment this repository provisions.
    const minted = [...source.matchAll(/did:web:([a-z0-9.\-]+):[0-9a-f-]{36}/g)].map((m) => m[1]);
    const ours = minted.filter((host) => !host.endsWith('paradym.id') && !host.endsWith('animo.id'));
    assert.deepEqual(ours, [], `a provisioned deployment's DID is pinned: ${ours.join(', ')}`);
  });

  test('the showcase trust comes from build-time configuration', () => {
    guard();
    assert.match(source, /extra\?\.showcaseDeployment/, 'constants.ts no longer reads showcaseDeployment');
    assert.match(readFileSync(CONFIG, 'utf8'), /SHOWCASE_DEPLOYMENT/, 'app.config.js does not expose SHOWCASE_DEPLOYMENT');
  });

  test('absent configuration yields no entries rather than a broken one', () => {
    guard();
    // Both generators must bail on a missing base url. Naming an organisation the
    // wallet cannot match is worse than not naming it.
    const generators = source.match(/function showcase\w*Entities\(\)[\s\S]*?\n\}/g) ?? [];
    assert.equal(generators.length, 2, 'expected both showcase generators');
    for (const fn of generators) {
      assert.match(fn, /if \(!base\) return \[\]/, `a showcase generator does not bail without a base url:\n${fn.slice(0, 120)}`);
    }
  });
});

describe('the vendored wallet names the right party', () => {
  test('every logo the generator points at is served from this repo', () => {
    guard();
    const logos = [...table('SHOWCASE_PARTIES'), ...table('SHOWCASE_ISSUERS')].map((e) => e.logo);
    assert.ok(logos.length > 0, 'expected the generator tables to carry logos');
    for (const logo of logos) {
      assert.ok(existsSync(join(LOGOS, logo)), `the wallet points at ${logo}, which this repo does not serve`);
    }
    // The host-scoped fallback's mark must stay neutral: when it carried the Age
    // demo's roundel, every party whose exact pin had gone stale borrowed it, and a
    // farmer applying for crop credit was shown an 18+ badge.
    assert.match(source, /showcase-deployment\.png/, 'the host-scoped fallback has no neutral mark');
  });

  test('each showcase party is named', () => {
    guard();
    const names = table('SHOWCASE_PARTIES').map((p) => p.name);
    for (const party of ['Age Check', 'Gramin Bank', 'University Admissions', 'Employer']) {
      assert.ok(names.includes(party), `no showcase party named '${party}'`);
    }
  });

  test('each registry the deployment runs is a trusted issuer', () => {
    guard();
    const paths = table('SHOWCASE_ISSUERS').map((i) => i.path);
    for (const registry of ['/farmer', '/land', '/school', '/college', '/university']) {
      assert.ok(paths.includes(registry), `no trusted issuer entity for ${registry}`);
    }
  });

  test('entries are marked as demonstration entities', () => {
    guard();
    const marks = source.match(/demo: true/g) ?? [];
    assert.ok(marks.length >= 2, 'the generated showcase entries are not marked demo: true');
  });
});

describe('nothing is shadowed by a less specific entry before it', () => {
  // Both lists are resolved by PREFIX with the FIRST hit winning
  // (packages/sdk/src/trust/handlers/did.ts). A host-scoped entry is a prefix of
  // every DID and issuer URL on that host, so listed first it claims all of them —
  // a learner collecting a degree would be told the National Identity Authority
  // issued it, and a farmer would be asked to trust "Age Check".
  test('the host-scoped issuer is last', () => {
    guard();
    const paths = table('SHOWCASE_ISSUERS').map((i) => i.path);
    const hostScoped = paths.indexOf('');
    assert.notEqual(hostScoped, -1, 'no host-scoped issuer entry');
    assert.equal(hostScoped, paths.length - 1,
      `the host-scoped issuer is at ${hostScoped} of ${paths.length}; it is a prefix of every other and must be last`);
  });

  test('the host-scoped DID fallback is appended after the exact entries', () => {
    guard();
    const fn = source.match(/function showcaseEntities\(\)[\s\S]*?\n\}/)?.[0] ?? '';
    const loopEnd = fn.indexOf('}\n\n  //');
    const fallback = fn.indexOf('entityId: `did:web:${host}`');
    assert.ok(fallback > 0, 'no host-scoped DID fallback');
    assert.ok(fallback > loopEnd && loopEnd > 0,
      'the host-scoped DID fallback is not appended after the per-party loop, so it would claim every party');
  });
});
