#!/usr/bin/env bash
# One command that answers "what is actually done?" for Iteration 01.
#
#   ./scripts/verify.sh              repo + fork state, and the test suites
#   ./scripts/verify.sh --no-tests   skip the suites (fast, ~5 seconds)
#
# It checks CLAIMS, not vibes: every line below either passes or fails, and the
# last section lists what is deliberately NOT done, so a green run can never be
# mistaken for "the iteration is complete".
#
# Plain text, no colour: this output gets pasted into evidence.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FORK="${SUNBIRD_RC_CORE_PATH:-$ROOT/../sunbird-rc-core}"
BASE="${BASE:-http://localhost}"
RUN_TESTS=1
[ "${1:-}" = "--no-tests" ] && RUN_TESTS=0

cd "$ROOT"
PASS=0; FAIL=0; SKIP=0
ok()   { PASS=$((PASS+1)); printf '  PASS  %s\n' "$1"; }
no()   { FAIL=$((FAIL+1)); printf '  FAIL  %s\n' "$1"; }
skip() { SKIP=$((SKIP+1)); printf '  SKIP  %s  (%s)\n' "$1" "$2"; }
head_() { printf '\n%s\n' "$1"; }
# Each body runs in a SUBSHELL, so an `exit` inside one cannot terminate this
# script. That trap had bitten three times: the third was the logo check below,
# whose `for … || exit 1` loop killed the run at check 41 when one PNG 404ed, so
# sixty later checks never ran and no summary was printed. A subshell turns that
# into one FAIL, which is what it always should have been. The `no `exit` in a
# check body' rule noted further down is now belt as well as braces.
check() { if ( eval "$2" ) >/dev/null 2>&1; then ok "$1"; else no "$1"; fi; }
# Inverted check: passes when the thing is ABSENT.
gone()  { if ( eval "$2" ) >/dev/null 2>&1; then no "$1"; else ok "$1"; fi; }

printf 'Iteration 01 verification — %s\n' "$(date -u '+%Y-%m-%d %H:%M UTC')"
# Basenames, not absolute paths: this banner is copied verbatim into the
# committed evidence captures, and an absolute path publishes the operator's
# home directory to every reader of a public repository. The names are what a
# reader needs; the location is theirs, not ours to share.
printf 'repo: %s\nfork: %s\n' "$(basename "$ROOT")" "$(basename "$FORK")"

head_ '1. Branch and working tree'
# Any iteration branch, not one named branch: Iteration 01 is merged and accepted,
# and Iteration 02 continues on its own branch. What must stay true is that this is
# never run as a substitute for review ON main, which the working model forbids.
# No `exit` and no `case` in the body: check() evals in the current shell, so an
# exit here terminates the whole script and every later check is silently skipped.
# That trap has now bitten twice, so the rule is a prefix test on a precomputed
# variable.
BRANCH="$(git branch --show-current)"
check "on an iteration branch, not main ($BRANCH)" '[ -n "$BRANCH" ] && [ "${BRANCH#iteration/}" != "$BRANCH" ]'
check "working tree clean (ignoring node_modules)" '[ -z "$(git status --porcelain | grep -vE "^\?\? ([^ ]*/)?node_modules")" ]'

head_ '2. Revised baseline is the authoritative input'
check "CLAUDE.md carries the scripted-client rule" 'grep -q "scripted protocol client" CLAUDE.md'
check "CLAUDE.md forbids substituting a QR/issuer page" 'grep -q "Do not substitute a QR or issuer web page" CLAUDE.md'
check "charter is the revised, three-journey one" 'grep -q "Do not use a QR code for issuance" iterations/01-age/CHARTER.md'
check "review feedback is on the branch" '[ -f docs/reviews/ITERATION-01-FEEDBACK.md ]'

head_ '3. Branch hygiene (review item)'
gone "docs/start/CLAUDE-START.md removed" '[ -f docs/start/CLAUDE-START.md ]'
gone "docs/start/KARTHEEK-START.md removed" '[ -f docs/start/KARTHEEK-START.md ]'
gone "no handshake files tracked by git" '[ -n "$(git ls-files docs/start)" ]'
gone "README has no dangling handshake links" 'grep -q "docs/start" README.md'

head_ '4. Rejected work removed (review item)'
gone "services/issuer-web deleted" '[ -d services/issuer-web ]'
gone "compose no longer mounts it" 'grep -q "issuer-web" deploy/docker-compose.yml'
gone "nginx no longer routes /issuer/" 'grep -q "location /issuer/" deploy/nginx/routes.conf'
gone "age-issuer dropped the QR dependency" 'grep -q "qrcode-svg" services/age-issuer/package.json'
gone "verifier page no longer prints wallet.sh" 'grep -q "wallet.sh" services/verifier-web/app.js'

head_ '5. Escalation and plan'
check "escalation raised for the Flow 1 gap" '[ -f docs/reviews/ESCALATION-01-oid4vc-authorization-code.md ]'
check "escalation records the Age-database deviation" 'grep -q "Age database deviation" docs/reviews/ESCALATION-01-oid4vc-authorization-code.md'
check "implementation plan reflects Anand's answers" 'grep -q "Decisions now settled" iterations/01-age/IMPLEMENTATION.md'
check "his answers are on the branch" '[ -f docs/reviews/ANSWERS-01-age-from-anand.md ]'
check "escalation is marked resolved" 'grep -q "RESOLVED, 25 August 2026" docs/reviews/ESCALATION-01-oid4vc-authorization-code.md'

head_ '6. Running stack reflects the removals'
if curl -fsS -o /dev/null --max-time 5 "$BASE/gateway-health" 2>/dev/null; then
  check "/issuer/ is gone (404)" '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 8 $BASE/issuer/)" = "404" ]'
  check "/api/issuer/citizens is gone (404)" '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 8 $BASE/api/issuer/citizens)" = "404" ]'
  check "/verifier/ still serves (200)" '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 8 $BASE/verifier/)" = "200" ]'
  gone "issuer response carries no rendered QR" 'curl -s --max-time 10 -X POST $BASE/api/issuer/offers -H "content-type: application/json" -d "{\"citizenId\":\"AGE-000001\"}" | grep -q qrSvg'
  # Adoption of the ported build is now the approved state (answer 1), so the
  # check is no longer "is it unadopted" but "is exactly one service off the
  # official baseline, and is it the pinned build we tested".
  check "oid4vc-service runs the PINNED ported build" 'docker inspect sunbird-rc-age-oid4vc-service-1 --format "{{.Config.Image}}" | grep -q "v2.1.0-authcode\."'
  check "every other Sunbird service still runs an official ghcr image" 'test "$(for c in registry identity credential credential-schema; do docker inspect sunbird-rc-age-$c-1 --format "{{.Config.Image}}" 2>/dev/null; done | grep -cv "^ghcr.io/sunbird-rc/")" = "0"'
  check "Keycloak is serving the age realm" '[ "$(curl -s -o /dev/null -w %{http_code} --max-time 8 $BASE/auth/realms/age/.well-known/openid-configuration)" = "200" ]'
  check "issuer advertises Keycloak first, itself second" 'curl -s --max-time 8 $BASE/.well-known/openid-credential-issuer | python3 -c "import json,sys; a=json.load(sys.stdin)[\"authorization_servers\"]; raise SystemExit(0 if len(a)==2 and \"/realms/age\" in a[0] else 1)"'
  check "issuer names itself, so a wallet issuer list is readable" 'curl -s --max-time 8 $BASE/.well-known/openid-credential-issuer | python3 -c "import json,sys; d=json.load(sys.stdin); raise SystemExit(0 if (d.get(\"display\") or [{}])[0].get(\"name\") else 1)"'
  # Anand's showcase note: only the real credential may appear in a customer-facing
  # issuer directory. The negative fixture is provisioned by the tests that need
  # it and retired again, so a clean stack advertises exactly one.
  check "exactly ONE credential is advertised to wallets" 'curl -s --max-time 8 $BASE/.well-known/openid-credential-issuer | python3 -c "import json,sys; raise SystemExit(0 if len(json.load(sys.stdin)[\"credential_configurations_supported\"])==1 else 1)"'
  # Each Agriculture issuer must advertise ONLY its own credential. This is the
  # check that keeps the demo requirement honest: an Age credential appearing in
  # the Agriculture issuer directory is exactly what DEMO.md's quality gate
  # forbids, and it is what happened before ADVERTISE_OWN_CREDENTIALS_ONLY.
  # Five path-scoped issuers now share one host, so the failure this guards
  # against is five times likelier: the directory a learner reads is built from
  # every published schema, and without ADVERTISE_OWN_CREDENTIALS_ONLY the
  # university would offer a farmer credential.
  for who in farmer land school college university; do
    check "the $who issuer advertises only its own credential" 'curl -s --max-time 8 "$BASE/'"$who"'/.well-known/openid-credential-issuer" | python3 -c "
import json,sys
d = json.load(sys.stdin)
configs = d[\"credential_configurations_supported\"]
names = [c[\"display\"][0][\"name\"] for c in configs.values()]
want = {
    \"farmer\": \"Farmer Identity Credential\",
    \"land\": \"Land Ownership Credential\",
    \"school\": \"School Record Credential\",
    \"college\": \"College Record Credential\",
    \"university\": \"University Record Credential\",
}[\"'"$who"'\"]
raise SystemExit(0 if names == [want] else 1)"'
  done

  # --- Iteration 03 ----------------------------------------------------------
  #
  # The two portals must ask DIFFERENT things of the same three cards and sign as
  # DIFFERENT parties. Both are the kind of property that fails silently: a shared
  # signer still produces a working demo, it just names the wrong organisation on
  # the learner's phone, which only a person holding the phone would notice.
  check "both Education portals publish a policy" 'for p in masters job; do curl -sf --max-time 8 -o /dev/null "$BASE/api/verifier/education/$p/policy" || exit 1; done'
  check "the job portal does not request the school or college percentage" 'curl -s --max-time 8 "$BASE/api/verifier/education/job/policy" | python3 -c "
import json,sys
d = json.load(sys.stdin)
r = d[\"requestedClaims\"]
raise SystemExit(0 if \"percentage\" not in r[\"school\"] and \"percentage\" not in r[\"college\"] and \"percentage\" in r[\"university\"] else 1)"'
  check "the committed Education thresholds are the ones served" 'curl -s --max-time 8 "$BASE/api/verifier/education/masters/policy" | python3 -c "
import json,sys
raise SystemExit(0 if json.load(sys.stdin)[\"thresholds\"] == {\"school\": 60, \"college\": 60, \"university\": 70} else 1)"'
  check "one trusted issuer per Education role" 'curl -s --max-time 8 "$BASE/api/verifier/education/masters/policy" | python3 -c "
import json,sys
roles = [r for i in json.load(sys.stdin)[\"trustedIssuers\"] for r in (i.get(\"roles\") or [])]
edu = sorted(r for r in roles if r in (\"school\", \"college\", \"university\"))
raise SystemExit(0 if edu == [\"college\", \"school\", \"university\"] else 1)"'
  check "the two Education portals sign as two different parties" 'python3 -c "
import json, urllib.request, urllib.parse
ids = []
for policy in (\"masters\", \"job\"):
    req = urllib.request.Request(\"$BASE/api/verifier/education/%s/sessions\" % policy, method=\"POST\")
    with urllib.request.urlopen(req, timeout=10) as r:
        qr = json.load(r)[\"qrData\"]
    ids.append(urllib.parse.parse_qs(urllib.parse.urlparse(qr.replace(\"openid4vp://\", \"https://x\")).query)[\"client_id\"][0])
raise SystemExit(0 if len(set(ids)) == 2 and all(i.startswith(\"did:web:\") for i in ids) else 1)"'
  # The request object the WALLET reads, not the policy the page publishes: the
  # purpose has to be inside the signed JAR or the holder's consent screen still
  # says no reason was given. Asserted equal to the published purpose, because
  # two strings that can differ eventually do.
  check "each Education request tells the wallet why it is asking" 'python3 -c "
import json, urllib.request, urllib.parse, base64
for policy in (\"masters\", \"job\"):
    with urllib.request.urlopen(\"$BASE/api/verifier/education/%s/policy\" % policy, timeout=10) as r:
        published = json.load(r)[\"purpose\"]
    req = urllib.request.Request(\"$BASE/api/verifier/education/%s/sessions\" % policy, method=\"POST\")
    with urllib.request.urlopen(req, timeout=10) as r:
        qr = json.load(r)[\"qrData\"]
    query = urllib.parse.parse_qs(urllib.parse.urlparse(qr.replace(\"openid4vp://\", \"https://x\")).query)
    with urllib.request.urlopen(query[\"request_uri\"][0], timeout=10) as r:
        jwt = r.read().decode()
    payload = jwt.split(\".\")[1]
    payload += \"=\" * (-len(payload) % 4)
    sets = json.loads(base64.urlsafe_b64decode(payload))[\"dcql_query\"].get(\"credential_sets\") or []
    if not sets or sets[0].get(\"purpose\") != published:
        raise SystemExit(1)
    # One required set naming all three credentials: splitting them would make a
    # three-credential request satisfiable by fewer.
    if not sets[0].get(\"required\") or len(sets[0][\"options\"]) != 1 or len(sets[0][\"options\"][0]) != 3:
        raise SystemExit(1)
raise SystemExit(0)"'
  check "both Education portal pages are served" 'for p in admissions employer; do curl -sf --max-time 8 -o /dev/null "$BASE/$p/" || exit 1; done'
  # Two pages, one script: the difference between a university and an employer has
  # to come out of the policy, not out of two separately written front ends.
  check "the two Education pages share one front end" '[ "$(ls services/education-web/*.js | wc -l | tr -d " ")" = "1" ] && grep -q "data-policy=\"masters\"" services/education-web/masters.html && grep -q "data-policy=\"job\"" services/education-web/job.html'

  # The wallet's trust screen renders these. A trusted entity whose logo 404s
  # shows a placeholder, which reads as a half-configured issuer on a demo.
  check "the wallet trust logos are served" 'for l in national-identity-authority age-check farmer-registry land-registry gramin-bank state-school-board polytechnic-college state-university employer; do curl -sf --max-time 8 -o /dev/null "$BASE/assets/logos/$l.png" || exit 1; done'
  gone "no unlisted-issuer credential in the directory" 'curl -s --max-time 8 $BASE/.well-known/openid-credential-issuer | grep -qi unlisted'
else
  skip "running-stack checks" "stack not up at $BASE — cd deploy && docker compose up -d"
fi

head_ '7. Gateway exposure (public deployment)'
check "routes are split by audience" '[ -f deploy/nginx/routes-citizen.conf ] && [ -f deploy/nginx/routes-ops.conf ] && [ -f deploy/nginx/routes-denied.conf ]'
check "the public listeners serve citizen routes plus refusals" 'grep -q "routes-citizen.conf" deploy/nginx/nginx.conf && grep -q "routes-denied.conf" deploy/nginx/nginx.conf && grep -q "routes-denied.conf" deploy/nginx/nginx-tls.conf'
check "operator routes are served ONLY on the loopback listener" '! grep -q "routes-ops.conf" <(awk "/listen 80;/,/^}/" deploy/nginx/nginx.conf) && grep -q "routes-ops.conf" <(awk "/listen 8088;/,/^}/" deploy/nginx/nginx.conf)'
check "the operator listener is published on 127.0.0.1 only" 'grep -q "127.0.0.1:8088:8088" deploy/docker-compose.yml && grep -q "127.0.0.1:8088:8088" deploy/docker-compose.tls.yml'
for route in "/api/issuer/" "/api/v1" "/registry/" "/credential-schema" "/credentials" "/did" "/utils" "/auth/admin"; do
  check "operator-only: $route" "grep -q \"location $route\" deploy/nginx/routes-ops.conf && ! grep -q \"location $route \" deploy/nginx/routes-citizen.conf"
done
# These sit UNDER wallet-facing prefixes, so omission is not enough - they must
# be refused explicitly or the broader prefix serves them.
for route in "/oid4vc/offer" "/vp/request" "/vp/status" "/auth/admin"; do
  check "refused on public listeners: $route" "grep -q \"$route\" deploy/nginx/routes-denied.conf"
done
check "the TLS overlay exists and mounts the certificate read-only" 'grep -q "/etc/letsencrypt:/etc/letsencrypt:ro" deploy/docker-compose.tls.yml'
check "setup scripts use the operator listener, not the public origin" 'grep -q "127.0.0.1:\$OPS_PORT" scripts/bootstrap.sh && grep -q "127.0.0.1:\${OPS_PORT:-8088}" scripts/seed-age-citizens.sh'
check "the suites know where operator endpoints live" 'grep -q "export function opsBase" tests/e2e/lib/stack.mjs'
check "Keycloak brute-force protection is on in the realm" 'python3 -c "import json;raise SystemExit(0 if json.load(open(\"deploy/keycloak/realm-age.json\"))[\"bruteForceProtected\"] else 1)"'
check "the realm does not interrupt first sign-in with a profile form" 'python3 -c "import json;r=json.load(open(\"deploy/keycloak/realm-age.json\"));raise SystemExit(0 if all(not a[\"enabled\"] for a in r[\"requiredActions\"] if a[\"alias\"]==\"VERIFY_PROFILE\") else 1)"'
check "bootstrap rotates Keycloak's default admin password" 'grep -q "rotated the Keycloak admin password" scripts/bootstrap.sh'
check "schemas store the vct as a slug, so type metadata resolves" 'grep -q "VCT_SLUG" scripts/bootstrap.sh'
check "a DID from another origin is never reused" 'grep -q "was minted under another host" scripts/bootstrap.sh'
check "enabling https is a script, not a runbook" '[ -x scripts/enable-https.sh ]'
check "a refusal is distinguished from a verification failure" 'grep -q "declined" services/verifier/src/server.mjs && grep -q "REFUSAL_SIGNATURES" services/verifier/src/core/checks.mjs'
check "the page renders a refusal without a failure verdict" 'grep -q "NO DATA SHARED" services/verifier-web/app.js && grep -q "decision.neutral" services/web-assets/styles.css'
check "a cancelled check is enforced server-side, not just labelled" 'grep -q "sessions/:id/cancel\|abandoned" services/verifier/src/server.mjs && grep -q "cancel" services/verifier-mobile/App.js'
check "the negative fixture is owned by the tests, not bootstrap" 'grep -q "ensureNegativeFixture" tests/e2e/lib/stack.mjs && ! grep -q "create_schema .Age Verification Credential (unlisted" scripts/bootstrap.sh'
# --- the approved-algorithm policy (REQUIREMENTS §8) -------------------------
# Iteration 01 shipped this as a recorded deviation because `alg` was not
# observable. It is enforced now, and these assert it stays enforced rather than
# decaying back into a policy file nobody reads.
check "the approved-algorithm policy is version-controlled" '[ -f config/policy/algorithms.json ] && python3 -c "import json;d=json.load(open(\"config/policy/algorithms.json\"));assert d[\"approved\"]==[\"ES256\"]"'
check "the verifier enforces it, not just loads it" 'grep -q "algPolicy.check(status.algs)" services/verifier/src/server.mjs && grep -q "failedCheck: .algorithm." services/verifier/src/server.mjs'
# The ORDER is the control, not just the presence of the check: an unapproved
# algorithm has to be refused before the lending rule runs, or the rule has
# already run on a presentation we do not accept. Compared by line number, which
# is crude but readable — the previous attempt nested python inside an eval'd
# single-quoted string and was wrong in a way that took a run to notice.
# Iteration 03 moved the domain decision behind `useCase.decide(...)`, so this
# used to compare against `decideFarmCredit({` — which is now a REFERENCE in the
# use-case map near the top of the file, not the call site. It sat above the
# algorithm check and the assertion silently inverted. Anchored to the call now,
# which is the thing the ordering is actually about.
check "it is checked before the domain decision" '[ "$(grep -n "algPolicy.check" services/verifier/src/server.mjs | head -1 | cut -d: -f1)" -lt "$(grep -n "useCase.decide(" services/verifier/src/server.mjs | head -1 | cut -d: -f1)" ]'
gone  "no algorithm is silently defaulted in the verifier" 'grep -qE "algs \|\| \[.ES256.\]|alg \|\| .ES256." services/verifier/src/core/algorithms.mjs'
check "positive and negative algorithm tests exist" '[ -f tests/unit/algorithm-policy.test.mjs ] && [ -f tests/e2e/algorithm-policy.test.mjs ]'

check "the installed mobile verifier exists and calls the shared service" '[ -f services/verifier-mobile/App.js ] && grep -q "/api/verifier" services/verifier-mobile/App.js'
# The charter's constraint on that app: it "displays results; it does not
# independently trust claims or make cryptographic decisions". The way that
# breaks is a well-meaning change that reaches a protocol endpoint directly, so
# assert the absence rather than trusting the comment at the top of the file.
gone  "the mobile verifier never touches the protocol endpoints" 'grep -qE "\\\$\\{?BASE\\}?/(vp|oid4vc)/|/vp/response|/oid4vc/credential" services/verifier-mobile/App.js'
# An Agriculture build must not put an Age option in front of a farmer, so the
# use case is baked in at build time and there is no on-screen picker.
check "the mobile verifier's use case is a build-time choice" 'grep -q "VERIFIER_USE_CASE" services/verifier-mobile/app.config.js && grep -q "extra?.useCase" services/verifier-mobile/App.js'
gone  "the mobile verifier offers no on-screen use-case picker" 'grep -qE "setUseCaseName|styles.picker" services/verifier-mobile/App.js'
gone "the mobile verifier does not verify anything itself" 'grep -qiE "jose|sd-jwt|verifyJwt|createHash" services/verifier-mobile/App.js'

head_ '8. Data model matches the approved design'
# A generated .env silently overrides both the compose default and env.example.
# That is exactly how the registry ended up still pointing at a per-domain
# database after the design changed to one shared database - it started, failed
# to connect, and reported only "database age does not exist" deep in a pool log.
check "deploy/.env points the registry at the shared database" 'grep -q "^AGE_REGISTRY_JDBC=jdbc:postgresql://db:5432/registry$" deploy/.env'
gone "no per-use-case database remains" 'docker compose -f deploy/docker-compose.yml exec -T db psql -U postgres -At -c "select datname from pg_database" 2>/dev/null | grep -qxE "age|agriculture|education"'

head_ '9. Fork: the prepared oid4vc-service port'
if [ -d "$FORK/.git" ]; then
  check "fork main is untouched (== origin/main)" 'git -C "$FORK" rev-parse main | grep -q "$(git -C "$FORK" rev-parse origin/main)"'
  check "fork main sits on the v2.1.0 tag" 'git -C "$FORK" rev-parse main | grep -q "$(git -C "$FORK" rev-parse v2.1.0)"'
  # Exact count on purpose: the port is meant to stay narrow, so an unexplained
  # extra commit should show up here rather than in review. Raise it deliberately
  # when the port legitimately grows.
  # Raised from 4 to 5 deliberately. The fifth commit lets an issuer advertise
  # only the credentials it authored: credential-schema's /oid4vci-configs is
  # deployment-wide and takes no filter, so with two Agriculture registries
  # sharing one schema service every issuer advertised all three published
  # credentials. No configuration could scope it.
  #
  # Raised from 5 to 7 for Anand's Education review. The sixth closes the hole
  # that fifth one left: it narrowed advertised METADATA only, so the credential
  # endpoint went on issuing any published type and an institution could be made
  # to sign another institution's credential. It also refuses a disclosure the
  # request did not ask for, rather than dropping it downstream. The seventh
  # fixes the wiring that made the second of those inert on the keyed vp_token
  # path — see the commit, which explains why the unit tests missed it.
  check "port branch is 7 commits off v2.1.0 (port, alg, narrowing, issuer display, own credentials, own issuance + disclosure, wiring)" '[ "$(git -C "$FORK" log --oneline v2.1.0..oid4vc-keycloak-as-v2.1.0 | wc -l | tr -d " ")" = "7" ]'
  # The tag compose asks for, whatever it currently is: reading it from compose
  # rather than repeating it here is what stops this check drifting into
  # asserting a build nothing uses.
  check "the image compose pins is actually built" 'docker images -q "$(python3 -c "import re,sys; print(re.search(r\"sunbird-rc-oid4vc-service:v2\\.1\\.0-authcode\\.[0-9a-f]+\", open(\"deploy/docker-compose.yml\").read()).group(0))")" | grep -q .'
  # The two guarantees the Education review sent back, asserted on the RUNNING
  # containers rather than on the source: both are single flags, and a flag that
  # is right in the compose file and unset in the container is exactly the
  # failure this catches.
  check "an issuer is restricted to its own credential type" 'for c in school college university; do docker compose -f deploy/docker-compose.yml exec -T "oid4vc-$c" printenv ADVERTISE_OWN_CREDENTIALS_ONLY 2>/dev/null | grep -qx true || exit 1; done'
  check "an unrequested disclosure is refused, not dropped" 'for c in oid4vc-service oid4vc-bank oid4vc-university-vp oid4vc-employer-vp; do docker compose -f deploy/docker-compose.yml exec -T "$c" printenv REJECT_UNREQUESTED_DISCLOSURES 2>/dev/null | grep -qx true || exit 1; done'
  # Anand's review asked that a reviewer be able to rebuild the pinned image from
  # shared source. The fork branch cannot be published — its only remote is
  # upstream Sunbird RC — so the commits travel as patches on this branch, and
  # these checks are what stop that copy drifting from the image we actually run.
  check "the oid4vc patch series is committed" '[ "$(ls patches/oid4vc-service/000*.patch 2>/dev/null | wc -l | tr -d " ")" = "7" ]'
  check "the patch series has apply-and-build instructions" 'grep -q "docker build --platform linux/amd64" patches/oid4vc-service/README.md && grep -q "^git am " patches/oid4vc-service/README.md'
  # The tag compose pins must BE the last patch's commit, not merely look like a
  # sha: a patch series that stops one commit short of the running image is the
  # exact failure this is here to catch, and nothing else would notice it.
  check "the last patch is the commit the pinned image names" 'python3 -c "
import glob, re, sys
last = sorted(glob.glob(\"patches/oid4vc-service/000*.patch\"))[-1]
sha = None
for line in open(last, encoding=\"utf-8\", errors=\"replace\"):
    if line.startswith(\"From \"):
        sha = line.split()[1]
        break
pinned = re.search(r\"v2\.1\.0-authcode\.([0-9a-f]+)\", open(\"deploy/docker-compose.yml\").read()).group(1)
sys.exit(0 if sha and sha.startswith(pinned) else 1)"'
  check "the patch series records the shared upstream base" 'grep -q "2ade66c24afc2d5da7d05121e9cbbd082ba83cd1" patches/oid4vc-service/README.md'
  # Committed patches are source, and source is where a credential gets pasted by
  # accident. The repo-wide secret backstop does not know this directory exists.
  gone "no private key or credential value in the patches" 'grep -rqE "BEGIN [A-Z ]*PRIVATE KEY|(password|secret|api[_-]?key)[\"'"'"' ]*[:=][\"'"'"' ]*[A-Za-z0-9+/]{12,}" patches/oid4vc-service/'
  check "the ported build is pinned by source commit in its tag" 'grep -qE "sunbird-rc-oid4vc-service:v2.1.0-authcode\.[0-9a-f]{7,}" deploy/docker-compose.yml'
else
  skip "fork checks" "no checkout at $FORK — set SUNBIRD_RC_CORE_PATH"
fi

head_ '10. Committed secrets'
# These used to live inside the fork section above, which meant a checkout
# without the sibling fork skipped them silently. They have nothing to do with
# the fork, and they cover ~500 more files now that the wallet is vendored.
#
# Takes the ACTUAL generated secret and proves it appears in no tracked file. The
# first version grepped for a pattern and matched its own pattern string in this
# file - a check that fails for the wrong reason is barely better than no check.
check "the generated demo password is absent from every tracked file" 'PW=$(grep "^DEMO_CITIZEN_PASSWORD=" deploy/.env 2>/dev/null | cut -d= -f2); test -z "$PW" || ! git ls-files -z | xargs -0 grep -l -- "$PW" 2>/dev/null | grep -q .'
gone "the realm import carries no credentials" 'grep -q "\"credentials\"" deploy/keycloak/realm-age.json'
# The check above tests the LOCAL .env value, so a password set on a different
# host slips through - and one did: `abcd@123` reached a tracked document because
# the local .env still held an older generated value. This is the backstop: the
# shapes of demo password we have actually used, denied outright.
gone "no demo password of any known shape is committed" 'git ls-files -z | xargs -0 grep -lE "abcd@123|demo-[0-9a-f]{10}|kcadmin-[0-9a-f]{12}" 2>/dev/null | grep -v "^scripts/verify.sh$" | grep -q .'

head_ '11. The vendored wallet'
W=vendor/paradym-wallet
check "the wallet is vendored, not a sibling checkout" '[ -f $W/apps/wallet/src/constants.ts ]'
gone  "no wallet .git came along" '[ -e $W/.git ]'
check "upstream's Apache-2.0 licence is retained" 'grep -q "Apache License" $W/LICENSE && grep -q "Apache License" $W/packages/sdk/LICENSE'
check "NOTICE states that files were modified, and by whom" 'grep -q "were modified for the Sunbird RC" $W/NOTICE && grep -q "Animo Solutions" $W/NOTICE'
check "the change index names the upstream commit we forked from" 'grep -q "2d68168" $W/SUNBIRD-CHANGES.md'
# Vendoring must not smuggle in generated or signed material. git archive only
# emits tracked blobs, so these assert the import stayed that way.
gone "no Expo prebuild output is tracked" 'git ls-files $W | grep -qE "/(android|ios)/"'
gone "no build output, APK or keystore is tracked" 'git ls-files $W | grep -qE "node_modules/|\.(apk|aab|keystore|jks|p12|jsbundle)$"'
# Keeps the secret greps above scanning source rather than a 77 MB binary.
check "the vendored tree stays source-only (under 20 MB tracked)" '[ "$(git ls-files -z $W | xargs -0 du -ck 2>/dev/null | tail -1 | cut -f1)" -lt 20480 ]'
# Someone running `eas build` here would build against another organisation's
# Expo project and App Store listing.
# Excluding the change index, which names these identifiers precisely because it
# records their removal. The same trap the demo-password check fell into once.
gone "Animo's release identity is not carried" 'git ls-files -z $W | xargs -0 grep -lE "b5f457fa-bcab-4c6e-8092-8cdf1239027a|ascAppId|owner: .animo-id." 2>/dev/null | grep -v "SUNBIRD-CHANGES.md" | grep -q .'
check "building the wallet is a script, not a runbook" '[ -x scripts/build-wallet.sh ]'
check "the importer is re-runnable for the next upstream bump" '[ -x scripts/vendor-wallet.sh ]'

# The wallet's showcase trust entries are supplied at BUILD TIME and must not be pinned in
# committed source. They carry the deployment's host and a uuid that changes on every
# re-bootstrap, so pinning them did two kinds of damage: it put a sandbox address into a
# public repository, and it went stale invisibly — the prefix lookup falls through to the
# host-scoped entry, the party is still named, and only the logo is wrong. That is how an
# 18+ roundel reached a farmer's crop-credit consent screen.
#
# These checks assert the ABSENCE of deployment detail, which is the inverse of what they
# checked before the trust list moved to configuration.
C="$W/apps/wallet/src/constants.ts"
check "no IP address is pinned in the wallet's trust list" \
  '! grep -qE "[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}" "$C"'
check "the wallet takes its showcase trust from configuration" \
  'grep -q "showcaseDeployment" "$C" && grep -q "SHOWCASE_DEPLOYMENT" "$W/apps/wallet/app.config.js"'

# And, when this checkout knows which deployment it describes, that the host is absent too.
# A hostname is not an IP and would slip past the check above.
PURL="${PUBLIC_URL:-}"
if [ -z "$PURL" ] && [ -f deploy/.env ]; then
  PURL="$(grep '^PUBLIC_URL=' deploy/.env | cut -d= -f2-)"
fi
if [ -n "$PURL" ]; then
  EHOST="$(printf '%s' "$PURL" | sed -E 's|^https?://||; s|/.*$||')"
  check "this deployment's host is not pinned in the wallet's trust list" \
    '! grep -q "$EHOST" "$C"'
else
  skip "wallet host absence" "no PUBLIC_URL in the environment or deploy/.env"
fi

# Drift: when the fork is still around, every vendored blob must match it apart
# from the files the adaptation commit deliberately changed. Compares object
# hashes, so this is content equality and not a file listing.
WFORK="${WALLET_FORK_PATH:-$ROOT/../paradym-wallet}"
if [ -d "$WFORK/.git" ]; then
  # No `exit` in a check body: check() evals in the current shell, so an exit here
  # terminates verify.sh and every later check is silently skipped. Ask instead
  # whether the filtered difference is empty.
  ADAPTED="NOTICE|SUNBIRD-CHANGES\.md|apps/wallet/(app\.config\.js|base\.app\.config\.js|eas\.json)"
  # The tip is READ FROM scripts/vendor-wallet.sh, which is the one place it is
  # pinned. It used to be written out again here, so advancing the fork meant
  # updating the same constant in two files — and the second one was missed: the
  # Education trust entries were vendored and committed, the fork was committed,
  # and this check still compared against the previous tip and reported drift that
  # had already been closed.
  WTIP="$(grep -oE '^TIP="[0-9a-f]+"' scripts/vendor-wallet.sh | head -1 | tr -d 'TIP="')"
  check "the pinned wallet tip exists in the fork" 'git -C "$WFORK" cat-file -e "${WTIP}^{commit}"'
  # ls-tree --format rather than awk: an awk program written inside a string that
  # check() later evals loses its \$3 to the shell, and awk then fails with a
  # syntax error the check reports as drift that does not exist.
  check "the vendored copy matches the fork, apart from the recorded adaptation" \
    '[ -z "$(diff <(git -C "$WFORK" ls-tree -r --format="%(objectname) %(path)" "$WTIP" | sort) <(git ls-tree -r --format="%(objectname) %(path)" "HEAD:$W" | sort) | grep -E "^[<>]" | grep -vE "($ADAPTED)$")" ]'
else
  skip "wallet drift vs the fork" "no checkout at $WFORK - set WALLET_FORK_PATH"
fi

head_ '12. Test suites'
if [ "$RUN_TESTS" = "1" ]; then
  if npm run --silent test:unit >/tmp/verify-unit.log 2>&1; then
    ok "unit: $(grep -E '^. pass' /tmp/verify-unit.log | tail -1 | tr -s ' ')"
  else
    no "unit suite (see /tmp/verify-unit.log)"
  fi
  if curl -fsS -o /dev/null --max-time 5 "$BASE/gateway-health" 2>/dev/null; then
    if npm run --silent test:e2e >/tmp/verify-e2e.log 2>&1; then
      ok "e2e: $(grep -E '^. pass' /tmp/verify-e2e.log | tail -1 | tr -s ' ')"
    else
      no "e2e suite (see /tmp/verify-e2e.log)"
    fi
  else
    skip "e2e suite" "stack not up"
  fi
  if [ -d "$FORK/services/oid4vc-service/node_modules" ]; then
    if (cd "$FORK/services/oid4vc-service" && npx jest --silent >/tmp/verify-fork.log 2>&1); then
      ok "fork port branch: $(grep -E '^Tests:' /tmp/verify-fork.log | tr -s ' ')"
    else
      no "fork suite (see /tmp/verify-fork.log)"
    fi
  else
    skip "fork suite" "dependencies not installed in the fork"
  fi
else
  skip "test suites" "--no-tests"
fi

head_ 'NOT DONE — the three mandatory journeys'
cat <<'JOURNEYS'
  The charter's three journeys, and exactly how far each is evidenced. A green
  run above proves the stack; it does not by itself prove a journey, because a
  journey has to be seen on the real applications.

  Flow 1  authenticated wallet-driven issuance, no QR
          RUN ON A REAL DEVICE (Samsung SM-A055F, Android 15): the wallet listed
          the issuer, signed the citizen in at Keycloak, and fetched the
          credential. Covered end to end by tests/e2e/flow1-wallet-issuance.test.mjs,
          including the credential scope a real wallet actually asks for, and
          recorded for the demo video, including a cold-restart persistence
          take: swiped out of recents, restarted, same card and issue date.
  Flow 2  cross-device web QR — RUN ON A REAL DEVICE, laptop verifier page and
          phone wallet, with APPROVED, DENIED and the neutral NO DATA SHARED all
          recorded. Cancellation is enforced server side, not drawn by the page.
  Flow 3  same-device deep link from an INSTALLED mobile verifier app —
          services/verifier-mobile is built and installed (package
          id.sunbird.ageverifier), the round trip has been run on the device,
          and both outcomes are recorded with the return to the app on screen:
          APPROVED for the adult, DENIED for the minor.

  Trust identity: the wallet names the issuer and the verifier instead of
  reporting an unknown organization, confirmed on the device and on camera. This
  needed a fix in the wallet fork's SDK, not only configuration — see
  docs/design/COMPATIBILITY.md. A refusal now also reaches the verifier from the
  wallet itself, so NO DATA SHARED appears within about two seconds without
  anyone cancelling the check.

  Evidence for a reviewer: docs/evidence/01-age/README.md, the line-by-line
  status in docs/evidence/01-age/VALIDATION.md, and captured runs under
  docs/evidence/01-age/runs/.
JOURNEYS

head_ 'Summary'
printf '  %s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIP"
if [ "$FAIL" -gt 0 ]; then
  printf '  RESULT: something regressed — see the FAIL lines above.\n'
  exit 1
fi
printf '  RESULT: the deployment is intact. See the journeys above for what is evidenced on real devices and what is still missing.\n'
