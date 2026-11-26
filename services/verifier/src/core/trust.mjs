// Demo trust model: a version-controlled allowlist of issuer identifiers
// (DESIGN §6). Not a trust registry — building one is explicitly out of scope.
//
// This exists because Sunbird RC v2.1.0's OID4VP verifier answers "is this
// signature valid?" but never "is this issuer one we accept?". Both questions
// have to be answered before a business rule runs, or any party able to mint the
// same credential type would be believed.

import { readFileSync } from 'node:fs';

/**
 * Expands ${VAR} references from the environment.
 *
 * An unset or still-unexpanded variable is a hard failure. The alternative —
 * treating it as empty — would silently widen the allowlist to "an issuer whose
 * DID is the empty string", and the negative tests would start passing for the
 * wrong reason.
 *
 * @param {string} value
 * @param {Record<string, string|undefined>} env
 */
function expand(value, env) {
  return value.replace(/\$\{([A-Z0-9_]+)\}/g, (_, name) => {
    const resolved = env[name];
    if (!resolved) {
      throw new Error(
        `trust policy references ${name}, which is not set. Run scripts/bootstrap.sh, ` +
          'then recreate the verifier so it picks the value up.',
      );
    }
    return resolved;
  });
}

/**
 * Builds the checker over already-resolved issuers. Shared so that a policy read
 * from a file and one resolved from the Authority Service cannot drift apart in
 * how they answer — the difference between them is where a DID comes from, and
 * nothing else.
 *
 * @param {{name: string, did: string, credentials: string[], roles: string[]}[]} issuers
 * @param {string} source for error messages
 */
function buildPolicy(issuers, source) {
  if (issuers.length === 0) throw new Error(`trust policy ${source} allowlists no issuers`);

  const byDid = new Map(issuers.map((issuer) => [issuer.did, issuer]));

  return {
    issuers,

    /**
     * @param {unknown} iss The `iss` claim as presented.
     * @param {{role?: string}} [expected] The role this credential must satisfy
     *        in a multi-credential request. Omitted for single-credential
     *        requests, which have no roles to confuse.
     * @returns {{ok: true, issuer: {name: string, did: string}} | {ok: false, reason: string}}
     */
    check(iss, expected = {}) {
      if (typeof iss !== 'string' || iss.length === 0) {
        // The DCQL query always requests `iss`, so an absent one means the
        // presentation did not carry an issuer identifier at all.
        return { ok: false, reason: 'presentation carried no issuer identifier' };
      }
      const issuer = byDid.get(iss);
      if (!issuer) return { ok: false, reason: 'issuer is not in the demo trust allowlist' };

      // Being trusted is not the same as being trusted FOR THIS SLOT. Without
      // this, two trusted issuers in one request could substitute for each
      // other: the Farmer Registry's credential could arrive in the Land slot
      // and still pass, because both signatures are valid and both issuers are
      // on the allowlist (REQUIREMENTS §8).
      if (expected.role) {
        if (issuer.roles.length === 0) {
          return {
            ok: false,
            reason: `${issuer.name} is trusted but declares no role, so it cannot satisfy the ${expected.role} credential`,
          };
        }
        if (!issuer.roles.includes(expected.role)) {
          return {
            ok: false,
            reason: `${issuer.name} is not trusted to issue the ${expected.role} credential`,
          };
        }
      }
      return {
        ok: true,
        issuer: {
          name: issuer.name,
          did: issuer.did,
          // Empty for issuers configured as a literal DID: nothing vouches for them that
          // could be asked about status, and a caller must treat that as "cannot check"
          // rather than "nothing to check".
          authorityBaseUrl: issuer.authorityBaseUrl || '',
        },
      };
    },
  };
}

/**
 * Reads the policy file and normalises one entry.
 *
 * @param {any} issuer
 * @param {Record<string, string|undefined>} env
 */
function normalise(issuer, env) {
  return {
    name: issuer.name,
    credentials: issuer.credentials || [],
    // Which role(s) in a multi-credential request this issuer may satisfy.
    // Empty means "no role constraint", which is how the single-credential Age
    // request works and why adding roles did not change its behaviour.
    roles: issuer.roles || [],
    authorityIssuer: issuer.authorityIssuer || null,
    authorityBaseUrl: '',
    did: issuer.did ? expand(String(issuer.did), env) : null,
  };
}

function readPolicy(file) {
  return JSON.parse(readFileSync(file, 'utf8')).issuers || [];
}

/**
 * The original, file-only form. Every issuer must carry a literal DID.
 *
 * @param {{file: string, env?: Record<string, string|undefined>}} config
 */
export function loadTrustPolicy({ file, env = process.env }) {
  const issuers = readPolicy(file).map((issuer) => {
    const entry = normalise(issuer, env);
    if (entry.authorityIssuer) {
      // Refused rather than skipped. Dropping the entry would quietly shrink the
      // allowlist, and the credential it covers would then be rejected as
      // "not in the allowlist" — a confusing symptom a long way from the cause.
      throw new Error(
        `trust policy ${file} entry "${entry.name}" names an Authority Service issuer, ` +
          'which this loader cannot resolve. Use resolveTrustPolicy.',
      );
    }
    if (!entry.did) throw new Error(`trust policy ${file} entry "${entry.name}" has no did`);
    return entry;
  });
  return buildPolicy(issuers, file);
}

/**
 * Resolves the allowlist against the Authority Service.
 *
 * The policy stops naming DIDs and starts naming issuers: "this Authority
 * Service issuer is trusted, go and resolve it". The allowlist itself does not
 * disappear — being resolvable is not the same as being trusted, and the role
 * constraints that stop a Farmer credential satisfying the Land slot live here,
 * not in the Authority Service.
 *
 * Entries carrying a literal `did` are still read from the file. Only two of the
 * six issuers moved behind the Authority Service; Age and the three Education
 * issuers have no Authority Service configuration, and requiring one would break
 * journeys this iteration does not touch.
 *
 * Fails closed, the same way an unset ${VAR} already did: an issuer that cannot
 * be resolved stops the verifier from starting. A verifier that silently drops an
 * unreachable issuer would keep serving, reject that issuer's credentials as
 * untrusted, and look like a credential problem.
 *
 * Resolved once, at boot, like the file it replaces. That means deactivating an
 * issuer in the Authority Service does not reach a running verifier until it
 * restarts — no worse than the file, but no better, and worth knowing before
 * anyone treats this as revocation.
 *
 * @param {{file: string, env?: Record<string, string|undefined>, baseUrl: string,
 *          fetchImpl?: typeof fetch, timeoutMs?: number}} config
 */
export async function resolveTrustPolicy({
  file,
  env = process.env,
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = 5000,
}) {
  const entries = readPolicy(file).map((issuer) => normalise(issuer, env));

  const resolved = await Promise.all(
    entries.map(async (entry) => {
      if (!entry.authorityIssuer) {
        if (!entry.did) throw new Error(`trust policy ${file} entry "${entry.name}" has no did`);
        return entry;
      }
      if (!baseUrl) {
        throw new Error(
          `trust policy ${file} entry "${entry.name}" needs the Authority Service, ` +
            'but no base URL was configured.',
        );
      }

      const url = `${baseUrl.replace(/\/$/, '')}/api/v1/trust/issuers/${encodeURIComponent(entry.authorityIssuer)}`;
      let response;
      try {
        response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
      } catch (cause) {
        throw new Error(
          `could not reach the Authority Service to resolve issuer "${entry.name}": ${cause.message}`,
        );
      }
      if (!response.ok) {
        // 404 is the Authority Service's answer for both "no such issuer" and
        // "not published", deliberately, so that the route cannot be used to
        // discover which issuer identifiers exist. Either way this one is not
        // usable and the verifier must not start.
        throw new Error(
          `Authority Service did not publish issuer "${entry.name}" (${entry.authorityIssuer}): HTTP ${response.status}`,
        );
      }

      const body = await response.json();
      const did = typeof body?.issuer === 'string' ? body.issuer : '';
      if (!did) {
        throw new Error(`Authority Service returned no issuer DID for "${entry.name}"`);
      }
      return {
        ...entry,
        did,
        // The Authority that vouched for this issuer, and therefore the ONLY endpoint its
        // credentials' status may be resolved against. Recorded here, at configuration time,
        // so that a status check can never be pointed somewhere by a credential.
        authorityBaseUrl: baseUrl.replace(/\/$/, ''),
        // The POLICY's name wins; the published one fills a gap.
        //
        // The other way round reads better in principle — an Authority's own name
        // for itself is more authoritative than a relying party's label for it —
        // and it silently rewrote user-visible output: the bank's answer started
        // naming "Farmer Authority" where it had always said "Farmer Registry",
        // and the e2e suite caught it. Which name a relying party shows its own
        // customers is that relying party's decision, and changing it is not
        // something resolving a DID should do on the way past.
        name: entry.name || pickName(body?.name),
      };
    }),
  );

  return buildPolicy(resolved, file);
}

/**
 * The public trust response carries display names keyed by language. Takes
 * English when present, otherwise the first entry, otherwise nothing.
 *
 * @param {unknown} name
 */
function pickName(name) {
  if (typeof name === 'string') return name;
  if (!name || typeof name !== 'object') return '';
  const values = Object.entries(name).filter(([, v]) => typeof v === 'string' && v);
  if (values.length === 0) return '';
  const english = values.find(([k]) => k === 'en');
  return (english || values[0])[1];
}

/**
 * The trusted issuers whose allowlist entry covers one credential type, for a
 * relying party to PUBLISH which issuer it accepts for that credential. Display
 * only: trust checking still runs against the whole allowlist, and the
 * credential type is pinned by the request itself.
 *
 * @param {Array<{name: string, credentials?: string[]}>} issuers
 * @param {string} credentialName
 */
export function issuersFor(issuers, credentialName) {
  return issuers.filter((issuer) => (issuer.credentials || []).includes(credentialName));
}
