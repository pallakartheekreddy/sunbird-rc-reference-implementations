# Keycloak realm for the Age demo

`realm-age.json` is imported at container start, so the stack comes up ready with
no manual clicking. The commentary lives here rather than in the JSON: Keycloak
rejects unknown fields outright, so a `_comment` key in the realm file fails the
import with `Unrecognized field "_comment"` and takes the whole container down.

## What the realm carries, and what it deliberately does not

**No passwords.** Anand's answer 3: *"Do not commit passwords or secrets.
Reproducible demo credentials may be supplied through local configuration or
generated during setup and shown to the demo operator."* So `scripts/bootstrap.sh`
generates one demo password, sets it on every citizen through the admin API,
prints it once, and records it in the gitignored `deploy/.env` so a re-run does not
silently change what the operator wrote down.

**The account-to-citizen mapping**, which is the part that must be deterministic
and reviewable:

| Account | Citizen record | Expected outcome |
|---|---|---|
| `citizen.meera` | `AGE-000001` (adult) | credential issued, later APPROVED |
| `citizen.arjun` | `AGE-000002` (minor) | credential issued, later DENIED |
| `citizen.nikhil` | `AGE-000003` (turns 18 today) | boundary fixture |
| `citizen.sana` | `AGE-000004` (turns 18 tomorrow) | boundary fixture |
| `citizen.unmapped` | *none* | authenticates, receives **no credential** |

The mapping travels as the `citizenId` **token claim**, delivered by the
`citizen-record` client scope, not as a username lookup. Usernames and emails
change and an unverified email is not an identity; the issuer resolves the claim
against the registry and nothing the wallet sends can override it.

`citizen.unmapped` exists on purpose — it is the negative case the charter
requires, and it can only be tested if such an account exists.

## The wallet client

`id.animo.paradym` is a public client with PKCE (S256). Its redirect list covers
every host the stack is demoed on — the wallet sends exactly one
(`allowedRedirectBaseUrls[0]`), and a host that is not listed makes sign-in
succeed while the authorization code never reaches the app. Both values come from the
wallet itself, not from preference: `clientId` is the app scheme and the redirect
URIs are what the wallet actually sends — see `apps/wallet/app.config.js` and
`apps/wallet/src/constants.ts` in the wallet repository, where `walletClient` reads
`allowedRedirectBaseUrls[0]`. Change them there and they must change here too.

## Why `/auth`

Keycloak runs with `--http-relative-path=/auth` so the login page, the issuer and
the verifier all share one origin behind nginx. That keeps the redirect URI stable
and avoids the classic failure where Keycloak builds absolute URLs from its own
container address and the wallet is sent somewhere it cannot reach.

## `realm-authority.json` — the realm with no people in it

The other three realms hold citizens, farmers and learners: identities that log in.
Every principal in `authority` is a service, and there is no login page.

**Why a fourth realm rather than more clients in `agriculture`.** The Authority Service
reduces a token to `(iss, sub)` and looks that pair up in its own `TenantMembership`
table. An issuing service living in the `agriculture` realm would present the same
`iss` as a farmer's login, and the only thing between a farmer's token and an
administrative route would be that no membership row happens to match its subject.
That is one row away from being wrong. A separate realm makes it structural: a citizen
token cannot address the administrative API however its subject is spelled.

**Why `attributes.frontendUrl` is pinned.** Keycloak otherwise derives `iss` from the
request it received, so the same client credentials yield
`http://keycloak:8080/auth/realms/authority` for an issuing service on the container
network and `https://<public-host>/auth/realms/authority` for a setup script coming
through the gateway. The Authority compares `iss` against one configured value, so one
of those callers would always be rejected — reported only as `Invalid token`. The citizen
realms keep the dynamic behaviour their wallet redirects need.

**Why the pin names `127.0.0.1:8088` and not the container.** It named
`http://keycloak:8080/auth` for as long as no browser visited this realm. The admin
console broke that premise: it signs operators in through a real browser, and `frontendUrl`
governs not just `iss` but every absolute URL Keycloak hands back mid-login — so Keycloak
answered the authorization request by redirecting the browser to `http://keycloak:8080/...`,
a hostname that exists only on the container network. The login form rendered and the next
hop died. Pointing the pin at the loopback operator listener keeps the one property that
made pinning worth doing — one `iss` regardless of where the token was requested — while
making that one value client-reachable. It stays a single constant across deployments
because the operator surface is loopback-only in both: directly here, over `ssh -L` on the
sandbox.

`OIDC_JWKS_URI` is therefore deliberately **not** derived from the issuer. The issuer is a
name tokens are compared against; the JWKS URI is an address the Authority must actually
fetch from, inside the container network, where `127.0.0.1` is the Authority itself.
Collapsing the two back into one value is what breaks the moment the pin stops naming a
routable host.

Changing this pin rewrites the `iss` of every token the realm mints, and
`TenantMembership` rows store that string — so an existing deployment needs its rows and
its `BOOTSTRAP_ADMINS` migrated in the same step, or every tenant goes invisible to its own
administrator. The `actorIssuer` columns are audit history and must be left alone.

**Why the 60-second access token.** A static token in an environment variable cannot
outlive its own expiry, so a deployment that works when configured stops issuing quietly
some minutes later. A lifespan shorter than a full journey run means the acceptance
suite cannot pass unless the issuing services genuinely re-acquire tokens: the refresh is
proven by the run rather than asserted in a comment.

**No secrets here.** Each client's secret is generated by Keycloak on import and read
into `deploy/.env` (gitignored) by `scripts/bootstrap-authority-realm.sh`.

**No `_comment` keys in these files.** Keycloak's realm parser rejects unknown
top-level fields outright and crash-loops the container on start. Rationale goes here;
per-client `description` is a real field and is used.
