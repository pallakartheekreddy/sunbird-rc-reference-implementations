#!/usr/bin/env bash
# Prepares the Age stack: Vault kv engine, the three did:web identities, and the
# credential schemas.
#
# Idempotent — safe to re-run after `docker compose restart`. Each step reports
# what it found or created.
#
#   cd deploy && cp env.example .env && docker compose up -d
#   ../scripts/bootstrap.sh
#
# What it creates, and why three DIDs:
#   * National Identity Authority — issues AgeVerificationCredential. Its DID is
#     the credential's `iss`, and the one entry in the trust allowlist.
#   * Age-restricted service — the VERIFIER's DID, used to sign OID4VP request
#     objects. A separate identity because it is a separate party; a demo that
#     signed verifier requests with the issuer's key would quietly conflate them.
#   * Unlisted issuer — a second, deliberately untrusted issuer publishing the
#     SAME credential type, so "wrong issuer is rejected" can be tested with a
#     cryptographically VALID credential rather than a broken one.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
# COMPOSE_EXTRA lets a local overlay ride along — an arm64 development machine needs one,
# because the compose file pins platform: linux/amd64 on every Sunbird RC service. That pin
# is correct for the demo host, but on Apple silicon it makes compose treat a present local
# image as missing and try to pull it, surfacing as a misleading "pull access denied".
#
# Step 6 recreates services. Without this, it would recreate them from the base file alone
# and undo whatever the stack was actually started with.
#
#   COMPOSE_EXTRA=deploy/compose.arm64.yml scripts/bootstrap.sh
COMPOSE=(docker compose -f "$DEPLOY/docker-compose.yml")
if [ -n "${COMPOSE_EXTRA:-}" ]; then
  # Not die(): the helpers are defined below this point.
  [ -f "$COMPOSE_EXTRA" ] || {
    printf '  \033[31m✗\033[0m COMPOSE_EXTRA=%s does not exist\n' "$COMPOSE_EXTRA" >&2
    exit 1
  }
  COMPOSE+=(-f "$COMPOSE_EXTRA")
fi

green() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info()  { printf '  \033[2m·\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
say()   { printf '\n\033[1m%s\033[0m\n' "$1"; }

# `|| true` is load-bearing: under `set -euo pipefail` a missing key makes grep
# exit 1 and would kill the script before it printed anything.
envval() {
  { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | cut -d= -f2- | tr -d '\r' | tail -1
}

# Writes KEY=value into .env, replacing any existing line for that key.
# Writes KEY=value, replacing any existing line for that key. Also drops any
# line that is neither a comment, a blank, nor a single-line KEY=VALUE — a value
# that once contained a newline leaves an orphan fragment behind, and compose
# would go on interpreting it.
#
# The alternation is spelled with three separate branches rather than one group
# containing an empty alternative: BSD grep (the macOS default) rejects
# '(...|...|)' with "empty (sub)expression", and the `|| true` below then turns
# that failure into an EMPTY file — which silently truncated .env on the first
# run, taking the DIDs with it.
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  { grep -vE "^$key=" "$ENV_FILE" 2>/dev/null || true; } \
    | grep -E '^[A-Za-z_][A-Za-z0-9_]*=|^#|^$' > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  mv "$tmp" "$ENV_FILE"
}

[ -f "$ENV_FILE" ] || { cp "$DEPLOY/env.example" "$ENV_FILE"; green "created deploy/.env from env.example"; }

# Two different addresses, and conflating them is a real bug:
#
#   PUBLIC — what gets PUBLISHED (the credential type, issuer metadata, DIDs).
#            It must be the address a wallet can reach.
#   BASE   — where this script SENDS its setup requests. On a cloud VM that
#            usually cannot be the public address: NAT hairpinning is often
#            disabled, so the host cannot curl its own public IP (verified:
#            HTTP 000 on the sandbox VM).
#
# Overriding BASE alone used to change the published `vct` too, which silently
# produced schemas advertising http://localhost while the verifier asked for the
# public host — so DCQL matched nothing and every presentation failed.
PUBLIC="${PUBLIC_URL:-$(envval PUBLIC_URL)}"
: "${PUBLIC:=http://localhost}"
# Everything this script does is operator work — minting DIDs, creating schemas,
# seeding, restarting services — and those routes are served ONLY on the operator
# listener (nginx/routes-ops.conf), which Docker publishes on 127.0.0.1. So the
# default target is that listener, not the public origin. It also sidesteps NAT
# hairpinning, which is what the note above was working around.
OPS_PORT="${OPS_PORT:-8088}"
BASE="${BASE:-http://127.0.0.1:$OPS_PORT}"
VAULT_TOKEN_VALUE="$(envval VAULT_TOKEN)"
: "${VAULT_TOKEN_VALUE:=local-root-token}"

printf '\033[1mBootstrapping the Age stack\033[0m\n'
printf '  publishing as : %s\n' "$PUBLIC"
printf '  setting up via: %s (operator listener)\n' "$BASE"

# --- 1. wait for the stack ---------------------------------------------------
say "1. Waiting for services"
wait_for() {
  local label="$1" url="$2" tries="${3:-60}"
  for _ in $(seq 1 "$tries"); do
    if curl -fksS -o /dev/null --max-time 5 "$url" 2>/dev/null; then green "$label"; return 0; fi
    sleep 5
  done
  die "$label did not become healthy at $url"
}
wait_for "gateway"           "$BASE/gateway-health"
wait_for "identity-service"  "$BASE/identity-health"
wait_for "credential-schema" "$BASE/schema-health"
wait_for "credentials"       "$BASE/credential-health"
wait_for "keycloak"          "$BASE/auth/realms/age/.well-known/openid-configuration" 90
# Both realms are imported from the same mount, so the second is ready at
# roughly the same moment — but waiting for it explicitly is what turns "the
# agriculture realm did not import" into a named failure here instead of a
# confusing 404 during the first wallet sign-in.
wait_for "keycloak (agriculture)" "$BASE/auth/realms/agriculture/.well-known/openid-configuration" 60
wait_for "keycloak (education)"   "$BASE/auth/realms/education/.well-known/openid-configuration" 60
wait_for "oid4vc-service"    "$BASE/health"
# The Java registry takes minutes under amd64 emulation. That is not a hang.
wait_for "registry"          "$BASE/registry-health" 90

# --- 2. Vault kv engine ------------------------------------------------------
say "2. Vault"
# Dev-mode Vault mounts kv-v2 at secret/, but identity-service is configured
# with VAULT_ROOT_PATH=kv, so the kv/ mount has to be created.
if "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$VAULT_TOKEN_VALUE" vault sh -c \
     'vault secrets list -format=json 2>/dev/null | grep -q "\"kv/\""'; then
  green "kv/ already mounted"
else
  "${COMPOSE[@]}" exec -T -e VAULT_TOKEN="$VAULT_TOKEN_VALUE" vault sh -c \
    'vault secrets enable -path=kv -version=2 kv' >/dev/null \
    && green "kv/ mounted (kv-v2)" \
    || die "could not mount kv/ (is Vault unsealed and VAULT_TOKEN correct?)"
fi

# --- 3. identities -----------------------------------------------------------
say "3. Identities (did:web, so standards wallets can resolve them)"
# did:web and not did:rcw. Two independent reasons:
#   * oid4vc-service REFUSES to sign an OID4VP request object with a did:rcw,
#     because a did:rcw resolves only from identity-service's own database and no
#     third-party wallet could verify the signature. Paradym needs that signed
#     request, so the verifier DID must be a did:web.
#   * Standards wallets reject an issuer DID they cannot resolve.
# Caveat inherent to localhost: did:web mandates https, so a strict external
# resolver will look for https://localhost/<uuid>/did.json and fail.
# identity-service resolves its own DIDs from its database, so issuance and
# verification work locally; only third-party resolution needs the HTTPS host.
# Everything this function reports goes to STDERR. Its stdout is the DID itself,
# captured by $(...) — a status line printed there ends up inside the value,
# which then reaches .env, the schema `author` field and the trust allowlist.
# (Found exactly that way on the first run: the allowlist held an ANSI-coloured
# sentence and the verifier trusted nobody real.)
# The host the published origin implies, e.g. `demo.example.org` from
# https://demo.example.org. A did:web spells its host into the identifier,
# so this is what a reusable DID has to match.
PUBLIC_DID_HOST="$(printf '%s' "${PUBLIC#*://}" | cut -d/ -f1 | cut -d: -f1)"

REUSE_PROBE_VC='{"@context":["https://www.w3.org/2018/credentials/v1"],"type":["VerifiableCredential"],"issuer":"did:example:probe","issuanceDate":"2020-01-01T00:00:00Z","credentialSubject":{"id":"did:example:probe"}}'

mint_did() {
  local env_key="$1" label="$2" existing resp did
  existing="$(envval "$env_key")"
  if [ -n "$existing" ] && [ "${existing#did:}" != "$existing" ] \
     && [ "${existing#did:web:$PUBLIC_DID_HOST}" = "$existing" ]; then
    # A DID minted under a DIFFERENT origin. identity-service still resolves it
    # from its own database, so the reuse check below would happily keep it --
    # and every credential would carry an issuer identifier that no external
    # wallet can resolve. Mint a new one instead, and say why.
    warn "$label: $existing was minted under another host; minting under $PUBLIC_DID_HOST" >&2
    existing=""
  fi
  # Reuse means "this DID can still SIGN", which is not what /did/resolve
  # answers: the DID document comes out of identity-service's database, while
  # the private key lives in Vault. Vault here is `server -dev`, whose storage
  # is in-memory, so a Vault restart drops every key and the kv/ mount while
  # the database keeps all of the DIDs. Resolution then still succeeds, the DID
  # is reused, and nothing fails until issuance -- as "Error signing the
  # document", which names neither Vault nor the key. Found with 1584 DIDs in
  # the database and one key in Vault, every issuer on the stack silently dead.
  # So prove the key by using it. A failure here is not fatal: it means the DID
  # is spent, and the mint below replaces it.
  # The payload must be an expandable JSON-LD credential: identity-service signs
  # with Ed25519Signature2020 under jsonld safe mode, so a bare string fails
  # canonicalisation and would make EVERY did look spent.
  if [ -n "$existing" ] && [ "${existing#did:}" != "$existing" ] \
     && curl -fksS -o /dev/null --max-time 10 -X POST "$BASE/utils/sign" \
          -H 'content-type: application/json' \
          -d "{\"DID\":\"$existing\",\"payload\":$REUSE_PROBE_VC}" 2>/dev/null; then
    green "$label: reusing $existing" >&2
    printf '%s' "$existing"
    return 0
  fi
  if [ -n "$existing" ] && [ "${existing#did:}" != "$existing" ]; then
    warn "$label: $existing resolves but can no longer sign (Vault lost its key); minting a replacement" >&2
  fi
  resp="$(curl -fsS -X POST "$BASE/did/generate" -H 'content-type: application/json' \
    -d "{\"content\":[{\"alsoKnownAs\":[\"$label\"],\"method\":\"web\",\"services\":[]}]}")" \
    || die "minting a did:web for $label failed"
  did="$(printf '%s' "$resp" | python3 -c 'import json,sys; d=json.load(sys.stdin); print((d[0] if isinstance(d,list) else d)["id"])')" \
    || die "could not read the DID out of: $(printf '%s' "$resp" | head -c 200)"
  # Fail loudly rather than write a malformed identity into the trust model.
  case "$did" in
    did:web:*) ;;
    *) die "expected a did:web for $label, got: $(printf '%s' "$did" | head -c 120)" ;;
  esac
  green "$label: $did" >&2
  printf '%s' "$did"
}

AGE_ISSUER_DID="$(mint_did AGE_ISSUER_DID       'National Identity Authority')"
VERIFIER_DID="$(mint_did   VERIFIER_DID         'Age-restricted service (verifier)')"
UNTRUSTED_DID="$(mint_did  UNTRUSTED_ISSUER_DID 'Unlisted issuer (negative fixture)')"
# Iteration 02. Separate DIDs and therefore separate signing keys: the two
# registries must be independent issuers, and a shared key would make "two
# issuers" a label rather than a fact.
FARMER_ISSUER_DID="$(mint_did FARMER_ISSUER_DID  'Farmer Registry')"
LAND_ISSUER_DID="$(mint_did   LAND_ISSUER_DID    'Land Registry')"
# The BANK's verifier identity. A wallet names the requesting party from the key
# that signed the request object, so sharing the age verifier's DID made the
# farmer's consent screen read "Do you trust Age Check?" while applying for crop
# credit. Separate parties, separate keys — the same reason the issuer and the
# verifier above do not share one.
BANK_VERIFIER_DID="$(mint_did BANK_VERIFIER_DID  'Gramin Bank (farm credit verifier)')"
# Iteration 03. Five more keys, and every one of them earns its place.
#
# Three issuers, because the verifier has to pin a DIFFERENT trusted issuer to
# each of the school, college and university slots — REQUIREMENTS §8's
# "wrong-role credential" case is only refusable if the three roles have three
# keys. Sharing one would make a College diploma presented as a degree
# indistinguishable from the real thing.
SCHOOL_ISSUER_DID="$(mint_did     SCHOOL_ISSUER_DID     'State School Board')"
COLLEGE_ISSUER_DID="$(mint_did    COLLEGE_ISSUER_DID    'Regional Polytechnic College')"
UNIVERSITY_ISSUER_DID="$(mint_did UNIVERSITY_ISSUER_DID 'State University')"
# Two verifiers, because they are two unrelated relying parties asking for
# different things, and the wallet names the requesting party from the key that
# signed the request object. One key would make the employer's consent screen
# read "University Admissions" — the same defect Iteration 02 hit with the bank.
UNIVERSITY_VERIFIER_DID="$(mint_did UNIVERSITY_VERIFIER_DID "University Admissions (master's verifier)")"
EMPLOYER_VERIFIER_DID="$(mint_did   EMPLOYER_VERIFIER_DID   'Employer (interview shortlisting verifier)')"

set_env AGE_ISSUER_DID      "$AGE_ISSUER_DID"
set_env VERIFIER_DID        "$VERIFIER_DID"
set_env UNTRUSTED_ISSUER_DID "$UNTRUSTED_DID"
set_env FARMER_ISSUER_DID   "$FARMER_ISSUER_DID"
set_env LAND_ISSUER_DID     "$LAND_ISSUER_DID"
set_env BANK_VERIFIER_DID   "$BANK_VERIFIER_DID"
set_env SCHOOL_ISSUER_DID     "$SCHOOL_ISSUER_DID"
set_env COLLEGE_ISSUER_DID    "$COLLEGE_ISSUER_DID"
set_env UNIVERSITY_ISSUER_DID "$UNIVERSITY_ISSUER_DID"
set_env UNIVERSITY_VERIFIER_DID "$UNIVERSITY_VERIFIER_DID"
set_env EMPLOYER_VERIFIER_DID   "$EMPLOYER_VERIFIER_DID"
green "DIDs recorded in deploy/.env"

# --- 4. credential schemas ---------------------------------------------------
say "4. Credential schema: Age Verification Credential (vc+sd-jwt)"
# The schema stores the vct as a bare SLUG, not an absolute URL, and
# oid4vc-service normalises it to <publicUrl>/vct/<slug> in issuer metadata.
# Two reasons that matters, both found the hard way:
#
#   1. The service serves SD-JWT VC Type Metadata at /vct/<slug> ONLY for
#      schemas whose stored vct is relative — an absolute one is taken to be
#      somebody else's document to host, so our own URL 404s. Credo (and
#      therefore Paradym) fetches that document to render the credential.
#   2. A relative vct follows PUBLIC_URL, so changing the public origin does not
#      leave the credential type pointing at the old host.
VCT_SLUG="age-verification-credential"
VCT="$PUBLIC/vct/$VCT_SLUG"

# The schema body generator lives in a temp file rather than a heredoc inside
# $(...): bash 3.2 — still the default on macOS — cannot parse that combination
# inside a function body and fails with an unhelpful "unexpected EOF".
SCHEMA_PY="$(mktemp -t agevcschema.XXXXXX)"
FIND_PY="$(mktemp -t agevcfind.XXXXXX)"
STALE_PY="$(mktemp -t agevcstale.XXXXXX)"
trap 'rm -f "$SCHEMA_PY" "$FIND_PY"' EXIT

cat > "$SCHEMA_PY" <<'SPEC'
import json, sys

# One generator for every credential this showcase issues. The caller passes a
# JSON spec rather than positional claim arguments: the three credentials differ
# in their claims, and a positional list would be unreadable at the call site and
# unextendable at the next iteration.
spec = json.loads(sys.argv[1])

print(json.dumps({
    "schema": {
        "type": "https://w3c-ccg.github.io/vc-json-schemas/",
        "version": "1.0.0",
        "id": spec["id"],
        "name": spec["name"],
        "author": spec["author"],
        "authored": "2026-01-01T00:00:00.000Z",
        "schema": {
            "$id": spec["id"],
            "$schema": "https://json-schema.org/draft/2019-09/schema",
            "description": spec["description"],
            "type": "object",
            "properties": spec["properties"],
            "required": spec["required"],
            # MUST be true. Issuance always adds credentialSubject.id (the holder
            # DID), which is not one of the schema's own claims; with this false,
            # credentials-service rejects every issuance and the wallet sees only
            # an opaque 500.
            "additionalProperties": True,
        },
    },
    "tags": spec["tags"],
    # PUBLISHED is required: getOid4vciConfigs only looks at published schemas,
    # so a DRAFT one exists but is invisible as an issuable credential.
    "status": "PUBLISHED",
    # The flag is `oid4vciEnabled` and the formats key is `oid4vciFormats`; a
    # plausible `enabled`/`formats` is silently ignored and the credential never
    # appears in issuer metadata.
    "oid4vciConfig": {
        "oid4vciEnabled": True,
        "oid4vciFormats": ["vc+sd-jwt"],
        "vct": spec["vct"],
        # `locale` is REQUIRED on a display entry. Without it a wallet fetching
        # the SD-JWT VC Type Metadata fails to parse it and shows only
        # "something went wrong", with no clue that the cause is here.
        "display": [{"name": spec["name"], "locale": "en-US"}],
    },
}))
SPEC

cat > "$FIND_PY" <<'PY'
import json, sys
want_name, want_author = sys.argv[1], sys.argv[2]
for c in json.load(sys.stdin):
    if c.get("name") == want_name and c.get("author") == want_author:
        print(c.get("schemaId", ""))
        break
PY

# Every PUBLISHED schema sharing this name but authored by a DIFFERENT did.
cat > "$STALE_PY" <<'PY'
import json, sys
want_name, keep_author = sys.argv[1], sys.argv[2]
for c in json.load(sys.stdin):
    if c.get("name") == want_name and c.get("author") != keep_author:
        print("%s|%s|%s" % (c.get("schemaId", ""), c.get("version", "1.0.0"), c.get("author", "")))
PY

# A schema is matched by (name, author), so re-minting an issuer DID makes
# create_schema miss the old entry and publish a SECOND schema with the same
# name -- and the stale one, authored by a DID whose key Vault no longer holds,
# sorts FIRST in /credential-schema/oid4vci-configs. Anything resolving by name
# or vct then picks the dead one, and issuance fails at signing with "Error
# signing SD-JWT", four services away from the cause. Deprecating is the
# service's own mechanism for this, and is reversible with
# PUT /credential-schema/publish/{id}/{ver}.
deprecate_stale_schemas() {
  local name="$1" keep_author="$2" stale sid ver author
  stale="$(curl -fsS "$BASE/credential-schema/oid4vci-configs" \
    | python3 "$STALE_PY" "$name" "$keep_author" 2>/dev/null)" || return 0
  [ -n "$stale" ] || return 0
  while IFS='|' read -r sid ver author; do
    [ -n "$sid" ] || continue
    if curl -fsS -X PUT "$BASE/credential-schema/deprecate/$sid/$ver" -o /dev/null 2>/dev/null; then
      warn "$name: deprecated a stale copy authored by ${author##*:}"
    else
      warn "$name: could NOT deprecate the stale copy authored by ${author##*:}"
    fi
  done <<EOF
$stale
EOF
}

# create_schema <spec-json>. The spec carries name, id, author, vct, tags,
# description, properties and required - see SCHEMA_PY above.
create_schema() {
  local spec="$1" name author existing body resp
  name="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')"
  author="$(printf '%s' "$spec" | python3 -c 'import json,sys; print(json.load(sys.stdin)["author"])')"
  existing="$(curl -fsS "$BASE/credential-schema/oid4vci-configs" | python3 "$FIND_PY" "$name" "$author")"
  if [ -n "$existing" ]; then
    green "$name (author ${author##*:}) already present"
    deprecate_stale_schemas "$name" "$author"
    return 0
  fi
  body="$(python3 "$SCHEMA_PY" "$spec")"
  # POST to /credential-schema — the controller is mounted at that prefix and
  # serves POST at its root.
  resp="$(curl -fsS -X POST "$BASE/credential-schema" -H 'content-type: application/json' -d "$body")" \
    || die "creating schema $name failed"
  printf '%s' "$resp" | python3 -c 'import json,sys; print(json.load(sys.stdin)["schema"]["id"])' >/dev/null \
    || die "no schema id returned for $name"
  green "$name (author ${author##*:}) created"
}

SPECS="$ROOT/scripts/credential-specs.py"
create_schema "$(python3 "$SPECS" age "$AGE_ISSUER_DID" "$VCT_SLUG")"

# Iteration 02. Two credentials, two authors: the schema `author` DID is what
# becomes the credential's `iss`, so it is what makes these two INDEPENDENT
# issuers rather than one issuer publishing two credential types. Each vct slug
# is served by its own oid4vc-service instance under its own path prefix.
create_schema "$(python3 "$SPECS" farmer "$FARMER_ISSUER_DID" 'farmer-identity-credential')"
create_schema "$(python3 "$SPECS" land   "$LAND_ISSUER_DID"   'land-ownership-credential')"

# Iteration 03. Three credentials, three authors, three vct slugs — and the
# authors are what make the roles pinnable: the schema `author` DID becomes the
# credential's `iss`, so the verifier can require that the credential in the
# University slot was signed by the University and nothing else.
create_schema "$(python3 "$SPECS" school     "$SCHOOL_ISSUER_DID"     'school-record-credential')"
create_schema "$(python3 "$SPECS" college    "$COLLEGE_ISSUER_DID"    'college-record-credential')"
create_schema "$(python3 "$SPECS" university "$UNIVERSITY_ISSUER_DID" 'university-record-credential')"

# The negative fixture — a valid credential from an issuer outside the trust
# allowlist — is NOT created here. It used to be, and it showed up in the
# wallet's issuer directory beside the real credential, because issuer metadata
# is built from every published schema with no filter. A customer-facing stack
# should advertise one credential.
#
# The tests that need it now provision it themselves (ensureNegativeFixture in
# tests/e2e/lib/stack.mjs) and deprecate it afterwards, which is where a test
# fixture belongs. UNTRUSTED_ISSUER_DID is still minted above, because a DID on
# its own is advertised nowhere and both the suite and demo.sh read it from
# deploy/.env.

# --- 5. demo citizen passwords ------------------------------------------------
say "5. Demo citizen sign-in"
# Generated, not committed. Anand's answer 3: "Do not commit passwords or
# secrets. Reproducible demo credentials may be supplied through local
# configuration or generated during setup and shown to the demo operator."
#
# Reproducible across re-runs because the generated value is kept in the
# gitignored .env, so a second bootstrap does not silently change the password
# an operator already wrote down.
CITIZEN_PASSWORD="$(envval DEMO_CITIZEN_PASSWORD)"
if [ -z "$CITIZEN_PASSWORD" ]; then
  # python3, not `tr < /dev/urandom | head`: head closes the pipe, tr takes a
  # SIGPIPE, and under `set -euo pipefail` that kills the script mid-step with no
  # message at all. (It did exactly that on the first run.)
  CITIZEN_PASSWORD="demo-$(python3 -c 'import secrets; print(secrets.token_hex(5))')"
  set_env DEMO_CITIZEN_PASSWORD "$CITIZEN_PASSWORD"
  green "generated a demo password and recorded it in deploy/.env"
else
  info "reusing the demo password already in deploy/.env"
fi

KC_ADMIN_USER="$(envval KEYCLOAK_ADMIN_USER)"; : "${KC_ADMIN_USER:=admin}"
KC_ADMIN_PASS="$(envval KEYCLOAK_ADMIN_PASSWORD)"; : "${KC_ADMIN_PASS:=admin}"

# Admin work runs through Keycloak's own CLI *inside* the container, on
# localhost. Not a style choice: the master realm requires TLS for requests that
# arrive proxied, so the same call through the gateway is refused with
# "HTTPS required" even though the credentials are correct. Talking to
# 127.0.0.1 from inside the container is treated as local and allowed.
kcadm() {
  "${COMPOSE[@]}" exec -T keycloak /opt/keycloak/bin/kcadm.sh "$@"
}

kcadm config credentials --server http://localhost:8080/auth \
  --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASS" >/dev/null 2>&1 \
  || die "could not authenticate to Keycloak as $KC_ADMIN_USER"

# The image starts with admin/admin. Keycloak's admin console is restricted to
# the operator allowlist in nginx, but a default credential should not survive a
# deployment either way, so rotate it once and record it beside the demo
# password. Re-runs reuse the recorded value.
if [ "$KC_ADMIN_PASS" = "admin" ]; then
  NEW_KC_PASS="kcadmin-$(python3 -c 'import secrets; print(secrets.token_hex(6))')"
  if kcadm set-password -r master --username "$KC_ADMIN_USER" --new-password "$NEW_KC_PASS" >/dev/null 2>&1; then
    set_env KEYCLOAK_ADMIN_PASSWORD "$NEW_KC_PASS"
    KC_ADMIN_PASS="$NEW_KC_PASS"
    kcadm config credentials --server http://localhost:8080/auth \
      --realm master --user "$KC_ADMIN_USER" --password "$KC_ADMIN_PASS" >/dev/null 2>&1 \
      || die "rotated the Keycloak admin password but could not re-authenticate"
    green "rotated the Keycloak admin password and recorded it in deploy/.env"
  else
    warn "could not rotate the Keycloak admin password; it is still the image default"
  fi
else
  info "reusing the Keycloak admin password already in deploy/.env"
fi

# The wallet's OAuth redirect URI for THIS deployment's public origin.
#
# The realm imports ship only localhost entries, because a redirect URI is
# deployment-specific and hardcoding one operator's host into a published
# configuration file both leaks that host and breaks every other deployment.
# Keycloak refuses an authorization request whose redirect_uri it does not know,
# and the wallet reports that as a bare "something went wrong", so this is
# registered here from PUBLIC_URL instead of being typed into the JSON.
#
# Skipped when the origin is already localhost: the imports cover it.
register_redirect() {
  local realm="$1" uri="$2" client
  client="$(kcadm get clients -r "$realm" -q clientId=id.animo.paradym --fields id --format csv --noquotes 2>/dev/null | tr -d '\r' | head -1)"
  [ -n "$client" ] || { warn "$realm: wallet client not found; redirect URI not registered"; return; }
  local existing
  existing="$(kcadm get "clients/$client" -r "$realm" --fields redirectUris --format json 2>/dev/null | tr -d '\r\n ')"
  case "$existing" in
    *"\"$uri\""*) info "$realm: redirect URI already registered"; return;;
  esac
  # kcadm appends to the array rather than replacing it, so the imported
  # localhost entries survive and a re-run stays idempotent.
  if kcadm update "clients/$client" -r "$realm" \
       --args '[{"op":"add","path":"/redirectUris/-","value":"'"$uri"'"}]' >/dev/null 2>&1 \
     || kcadm update "clients/$client" -r "$realm" -s 'redirectUris+="'"$uri"'"' >/dev/null 2>&1; then
    green "$realm: registered redirect URI $uri"
  else
    warn "$realm: could not register $uri — wallet sign-in will fail on this origin"
  fi
}

case "$PUBLIC" in
  http://localhost|http://localhost:*|"")
    info "public origin is localhost; the realm imports already cover it" ;;
  *)
    for r in age agriculture education; do
      register_redirect "$r" "${PUBLIC%/}/wallet/redirect"
    done ;;
esac

for u in citizen.meera citizen.arjun citizen.nikhil citizen.sana citizen.unmapped; do
  if kcadm set-password -r age --username "$u" --new-password "$CITIZEN_PASSWORD" >/dev/null 2>&1; then
    green "$u ready"
  else
    warn "could not set the password for $u"
  fi
done

# Every realm whose users carry an attribute has to ALLOW unmanaged attributes, and
# none of them does by default.
#
# Keycloak's declarative user profile defaults unmanagedAttributePolicy to DISABLED, and
# realm IMPORT bypasses the policy while the admin API does not. So the seeded users have
# their citizenId/nationalId and anything added later silently loses it — no error, no
# warning, the attribute is simply dropped. Issuance resolves a holder's claims BY that
# attribute, so such a user gets a credential with no link to its source record, and the
# first sign of it is a presentation the verifier cannot satisfy.
#
# One PUT per realm, and it is idempotent.
for r in age agriculture education; do
  if kcadm get users/profile -r "$r" > /tmp/kc-profile-$r.json 2>/dev/null \
     && python3 -c '
import json, sys
p = sys.argv[1]
d = json.load(open(p))
if d.get("unmanagedAttributePolicy") == "ENABLED":
    sys.exit(3)                      # already set; nothing to do
d["unmanagedAttributePolicy"] = "ENABLED"
json.dump(d, open(p, "w"))
' "/tmp/kc-profile-$r.json"; then
    if "${COMPOSE[@]}" exec -T keycloak sh -c 'cat > /tmp/kc-profile-in.json' < "/tmp/kc-profile-$r.json" \
       && kcadm update users/profile -r "$r" -f /tmp/kc-profile-in.json >/dev/null 2>&1; then
      green "$r allows unmanaged user attributes"
    else
      warn "could not allow unmanaged user attributes on $r"
    fi
  fi
  rm -f "/tmp/kc-profile-$r.json"
done

# Iteration 02's farmers, in their own realm. The same generated password: it is
# a demo secret that lives only in deploy/.env, and a second one would be a
# second thing to keep out of Git for no gain.
# The two terminal.* accounts exist so the inactivation and revocation cases have
# subjects of their own. Neither state can be undone — the Authority refuses
# INACTIVE -> ACTIVE, and idempotent issuance means a revoked credential stays the one
# that subject gets — so spending a shared fixture on either would spend it for the
# life of the deployment.
# farmer.film is reserved for the same reason: the showcase ends on a revocation, so
# each take spends its subject. See scripts/seed-agriculture-authority.sh.
for u in farmer.ravi farmer.lakshmi farmer.suresh farmer.geeta farmer.unregistered \
         farmer.noland farmer.norecord farmer.unmapped \
         farmer.terminal.inactive farmer.terminal.revoked farmer.film farmer.film2; do
  if kcadm set-password -r agriculture --username "$u" --new-password "$CITIZEN_PASSWORD" >/dev/null 2>&1; then
    green "$u ready"
  else
    warn "could not set the password for $u"
  fi
done

# Iteration 03's learners, in the education realm. Same generated password, same
# reason as above.
for u in learner.priya learner.rohan learner.fatima learner.rahul learner.divya \
         learner.kiran learner.anita learner.vikram learner.mismatch \
         learner.nouniversity learner.norecord learner.unmapped; do
  if kcadm set-password -r education --username "$u" --new-password "$CITIZEN_PASSWORD" >/dev/null 2>&1; then
    green "$u ready"
  else
    warn "could not set the password for $u"
  fi
done

# --- 6. apply the new configuration -----------------------------------------
say "6. Applying configuration"

# An Authority-resolved trust policy survives a stack reset in deploy/.env; the issuers it
# names do not. The verifier resolves them at boot and REFUSES TO START when one is
# missing — correctly — so recreating it below would crash-loop, and the `wait_for` that
# follows would hang until it gave up. The whole bootstrap then fails at the last step,
# reporting a verifier problem, when what actually happened is that the Authority
# Service's database was emptied and has not been re-bootstrapped yet.
#
# So: if the selected policy names issuers this Authority does not publish, fall back to
# the default policy for THIS boot only. deploy/.env is left alone —
# bootstrap-agriculture-authority.sh rewrites the policy with live identifiers and the
# verifier is recreated again there.
authority_policy_is_stale() {
  local policy="$ROOT/config/trust/issuers.authority.json" base ids id code
  [ "$(envval VERIFIER_TRUST_POLICY_FILE)" = /app/config/trust/issuers.authority.json ] || return 1
  [ -f "$policy" ] || return 1
  ids="$(python3 -c '
import json, sys
policy = json.load(open(sys.argv[1]))
print(" ".join(i["authorityIssuer"] for i in policy.get("issuers", []) if i.get("authorityIssuer")))
' "$policy" 2>/dev/null)" || return 1
  [ -n "$ids" ] || return 1
  base="${AUTHORITY_URL:-http://localhost:3334}"
  for id in $ids; do
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$base/api/v1/trust/issuers/$id" 2>/dev/null || echo 000)"
    [ "$code" = 200 ] || return 0
  done
  return 1
}

if authority_policy_is_stale; then
  warn "the Agriculture trust policy names issuers this Authority does not publish"
  info "using the default trust policy for this boot; run scripts/bootstrap-agriculture-authority.sh"
  # Exported, so it beats deploy/.env for the compose commands below without editing it.
  export VERIFIER_TRUST_POLICY_FILE=/app/config/trust/issuers.json
fi

# oid4vc-service reads VERIFIER_DID/ISSUER_DID and the verifier reads
# AGE_ISSUER_DID at boot, so both need recreating now that .env has them.
"${COMPOSE[@]}" up -d --force-recreate --no-deps \
  oid4vc-service oid4vc-farmer oid4vc-land oid4vc-bank \
  oid4vc-school oid4vc-college oid4vc-university \
  oid4vc-university-vp oid4vc-employer-vp \
  verifier age-issuer >/dev/null 2>&1 \
  || die "could not recreate the issuer and verifier services"
wait_for "oid4vc-service (restarted)" "$BASE/health"
wait_for "verifier"                   "$BASE/verifier-health"
wait_for "age-issuer"                 "$BASE/issuer-health"

say "Ready"
cat <<SUMMARY
  Issuer   National Identity Authority   $AGE_ISSUER_DID
  Verifier Age-restricted service        $VERIFIER_DID
  Verifier Gramin Bank (farm credit)     $BANK_VERIFIER_DID
  Issuer   State School Board            $SCHOOL_ISSUER_DID
  Issuer   Regional Polytechnic College  $COLLEGE_ISSUER_DID
  Issuer   State University              $UNIVERSITY_ISSUER_DID
  Verifier University Admissions         $UNIVERSITY_VERIFIER_DID
  Verifier Employer (shortlisting)       $EMPLOYER_VERIFIER_DID
  Unlisted negative-fixture issuer       $UNTRUSTED_DID
  Credential type                        $VCT

  Demo sign-in (password printed once, and kept in deploy/.env)
    citizen.meera     -> AGE-000001  adult,  expects APPROVED
    citizen.arjun     -> AGE-000002  minor,  expects DENIED
    citizen.nikhil    -> AGE-000003  turns 18 today
    citizen.sana      -> AGE-000004  turns 18 tomorrow
    citizen.unmapped  -> no citizen record: must receive NO credential
    password          -> $CITIZEN_PASSWORD

  Next:
    ./scripts/seed-age-citizens.sh     synthetic citizens
    ./scripts/demo.sh                  scripted positive + negative walkthrough
    open $BASE/verifier/               the web verifier
SUMMARY
