#!/usr/bin/env bash
# Configures the Education topology in the Authority Service, so that oid4vc-school and
# oid4vc-college issue SD-JWT credentials whose CLAIMS come from an approved,
# Authority-managed record rather than from the registry directly.
#
# The Agriculture counterpart of this is scripts/bootstrap-agriculture-authority.sh, and
# this follows it deliberately rather than inventing a second way of doing the same thing.
#
# Two Authorities, each PRIMARY for its own tenant, sharing one Authority Service and one
# managed Registry:
#
#     School Authority                College Authority
#       tenant  T-EDU-SCHOOL            tenant  T-EDU-COLLEGE
#       binding SchoolRecord            binding CollegeRecord
#       issuer  ISS-SCHOOL              issuer  ISS-COLLEGE
#       profile P-SCHOOL                profile P-COLLEGE
#
# Neither tenant can read the other's records, and each oid4vc issuer is given only its own
# profile map and its own client credentials, so one Education issuer cannot be made to
# produce the other's credential.
#
# What this does NOT do, on purpose: it does not touch the wallet, either verifier, the
# University route, or Sunbird RC core. It adds no live Education status checks. The
# credential format, the DCQL requests and the policies all stay exactly as they are.
#
# Idempotent. Every step looks for what it would create and reports it instead. Re-running
# is the normal case — this is configuration, not a migration.
set -euo pipefail

BASE="${AUTHORITY_URL:-http://localhost:3334}"
API="$BASE/api/v1"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT/deploy/.env}"
. "$ROOT/scripts/lib/authority-auth.sh"

VC_CONTEXT_URI="${VC_CONTEXT_URI:-https://www.w3.org/2018/credentials/v1}"
CONTEXT_URI="${CONTEXT_URI:-https://w3id.org/sunbird-rc/education/v1}"

# Same defaults as the Agriculture bootstrap. key-0 is not arbitrary: the identity service
# mints its first verification method as #key-0, and a signing-key reference pointing at a
# method that does not exist fails at SIGNING time — the credentials service returns 500 and
# the Authority Service records the issuance as ORPHANED, with an error that names neither
# keys nor fragments.
ISSUER_KEY_ALGORITHM="${ISSUER_KEY_ALGORITHM:-Ed25519}"
ISSUER_KEY_ID="${ISSUER_KEY_ID:-key-0}"
# Where a credential schema is published and read back from. The default is the operator
# port on the demo stack, not a public route.
SCHEMA_BASE="${SCHEMA_BASE:-http://127.0.0.1:8088}"

green() { printf '  \033[32m✓\033[0m %s\n' "$1" >&2; }
info()  { printf '  \033[2m·\033[0m %s\n' "$1" >&2; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
head1() { printf '\n\033[1m%s\033[0m\n' "$1" >&2; }

api() {
  local method="$1" path="$2" body="${3:-}" out status
  authority_headers BOOTSTRAP
  local args=(-sS --max-time 30 -X "$method" "$API$path" "${AUTH_H[@]}"
              -H 'Content-Type: application/json' -w '\n%{http_code}')
  [ -n "$body" ] && args+=(-d "$body")
  out="$(curl "${args[@]}")" || die "$method $path — could not reach $BASE"
  status="${out##*$'\n'}"
  body="${out%$'\n'*}"
  case "$status" in
    2*) printf '%s' "$body" ;;
    409) die "$method $path -> 409: $(printf '%s' "$body" | head -c 200)
    This resource already exists but is not visible to the principal this script uses.
    Switching a deployment between authentication modes does that: tenants belong to the
    principal that created them. Bootstrap a clean deployment instead." ;;
    *)  die "$method $path -> $status: $(printf '%s' "$body" | head -c 300)" ;;
  esac
}

# Python rather than jq: the repository already depends on python3 and not on jq.
# api() dies on a non-2xx, but `die` inside $( ) ends only the subshell, so a failed call
# arrives here as an EMPTY string. Return nothing and let require_id say so, rather than
# letting a traceback bury the error printed a line earlier.
_json() {
  python3 -c "
import json, sys
raw = sys.stdin.read().strip()
if not raw: raise SystemExit(0)
try: d = json.loads(raw)
except ValueError: raise SystemExit(0)
$1" "$@" 2>/dev/null || true
}
field()      { _json 'print(d.get(sys.argv[1], "") if isinstance(d, dict) else "")' "$1"; }
id_by_code() { _json 'print(next((x["id"] for x in (d if isinstance(d, list) else d.get("data", [])) if x.get("code") == sys.argv[1]), ""))' "$1"; }
id_by_entity(){ _json 'print(next((x["id"] for x in (d if isinstance(d, list) else d.get("data", [])) if x.get("entityName") == sys.argv[1]), ""))' "$1"; }

require_id() {
  case "$2" in
    ????????-????-????-????-????????????) : ;;
    *) die "$1 did not come back as an id (got \"${2:-empty}\") — refusing to continue" ;;
  esac
}

ensure_tenant() {
  local existing; existing="$(api GET /tenants | id_by_code "$1")"
  if [ -n "$existing" ]; then info "tenant $1 already present"; printf '%s' "$existing"; return; fi
  info "tenant $1 created"
  api POST /tenants "$(printf '{"code":"%s","name":"%s"}' "$1" "$2")" | field id
}

ensure_authority() {
  local existing; existing="$(api GET /authorities | id_by_code "$1")"
  if [ -n "$existing" ]; then info "authority $1 already present"; printf '%s' "$existing"; return; fi
  info "authority $1 created, PRIMARY for its tenant"
  api POST /authorities "$(printf '{"code":"%s","name":"%s","tenantId":"%s"}' "$1" "$2" "$3")" | field id
}

# ensure_binding AUTHORITY_ID ENTITY NAME UNIQUE_FIELD ROW_KEY
# The row key and declared CSV types are set here rather than by a database seed: they are
# now on the create DTO, so an administrator configuring CSV onboarding is an API call.
ensure_binding() {
  local existing; existing="$(api GET "/authorities/$1/registries" | id_by_entity "$2")"
  if [ -n "$existing" ]; then info "binding $2 already present"; printf '%s' "$existing"; return; fi
  info "binding $2 created, unique on $4 within the tenant, CSV row key $5"
  api POST "/authorities/$1/registries" "$(python3 -c '
import json, sys
name, rc, entity, unique, rowkey = sys.argv[1:6]
print(json.dumps({
    "name": name, "rcInstanceRef": rc, "entityName": entity,
    "uniqueFields": [unique],
    "csvRowKeyField": rowkey,
    "csvFieldTypes": {"percentage": "number", "completionYear": "number"},
}))' "$3" "${RC_REGISTRY_URL:-http://registry:8081}" "$2" "$4" "$5")" | field id
}

ensure_issuer() {
  local existing; existing="$(api GET "/authorities/$1/issuers" | id_by_code "$2")"
  if [ -n "$existing" ]; then info "issuer $2 already present"; printf '%s' "$existing"; return; fi
  info "issuer $2 created"
  api POST "/authorities/$1/issuers" \
    "$(printf '{"code":"%s","displayName":{"en":"%s"}}' "$2" "$3")" | field id
}

map() {
  api PUT "/credential-profiles/$1/claim-mappings" "$2" >/dev/null
  info "  $(printf '%s' "$2" | python3 -c 'import sys,json;print(json.load(sys.stdin)["targetClaim"])')"
}

direct() {
  python3 -c '
import json, sys
source, target, required = sys.argv[1:4]
print(json.dumps({"targetClaim": target, "source": "DIRECT", "sourcePath": source,
                  "required": required == "true"}))' "$1" "$2" "${3:-true}"
}

set_env() {
  touch "$ENV_FILE"
  if grep -qE "^$1=" "$ENV_FILE"; then
    grep -vE "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
}

# --- helpers shared in spirit with the Agriculture bootstrap ------------------------------
# Copied from scripts/bootstrap-agriculture-authority.sh rather than extracted into a shared
# library, deliberately and with a date on it: Agriculture is signed-off and running, and
# refactoring its bootstrap days before a showcase trades a real regression risk for a
# tidiness gain. The duplication is the smaller risk today and the worse answer next month —
# when Iteration 4 is accepted, these belong in scripts/lib/authority-topology.sh and both
# bootstraps should source them.

ensure_membership() {
  local tenant="$1" key="$2" role="$3" pair issuer subject existing
  pair="$(authority_principal "$key")"
  issuer="${pair%%$'\t'*}"
  subject="${pair##*$'\t'}"

  existing="$(api GET "/tenants/$tenant/memberships" \
    | python3 -c '
import sys, json
issuer, subject, role = sys.argv[1], sys.argv[2], sys.argv[3]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("items", [])
print(next((m["id"] for m in items
            if m.get("subject") == subject and m.get("issuer") == issuer
            and m.get("role") == role), ""))
' "$issuer" "$subject" "$role")"
  if [ -n "$existing" ]; then info "membership $key ($role) already present"; return; fi
  api POST "/tenants/$tenant/memberships" \
    "$(printf '{"issuer":"%s","subject":"%s","role":"%s"}' "$issuer" "$subject" "$role")" >/dev/null
  info "membership $key ($role) created as $subject"
}

ensure_issuer_did() {
  local issuer_id="$1" did="$2" label="$3" var="$4" current version
  if [ -z "$did" ]; then
    warn "$label has no DID — set $var to publish it at /trust/issuers"
    return
  fi
  if [ "$(did_looks_internal "$did")" = internal ] && [ "${ALLOW_LOCAL_ISSUER_DID:-}" = true ]; then
    # Opt-in, loud, and never the default. The reference stack mints
    # did:web:localhost:<uuid> from PUBLIC_URL, so a local end-to-end run cannot use a
    # publishable DID — the demo's own issuers are unresolvable from anywhere but this
    # machine. Allowing that quietly would turn the guard into a formality, so it says what
    # it is permitting every time.
    warn "ALLOW_LOCAL_ISSUER_DID=true — publishing a DID that cannot be resolved off this"
    warn "  machine: $did"
    warn "  Acceptable for a local run. Never for anything a verifier outside this host reads."
  elif [ "$(did_looks_internal "$did")" = internal ]; then
    die "refusing to set $label to a DID that names an internal or unresolvable host:
    $did
    This is published verbatim, unauthenticated, at GET /trust/issuers/{id}. A DID minted by
    the demo identity service is built from WEB_DID_BASE_URL (http://identity:3332/did/web by
    default) and is both a disclosure of internal topology and unresolvable from outside.
    Point WEB_DID_BASE_URL at the Authority's public origin, or supply a did:web you host."
  fi
  current="$(api GET "/issuers/$issuer_id" | field did)"
  if [ "$current" = "$did" ]; then info "$label DID already set"; return; fi
  version="$(api GET "/issuers/$issuer_id" | field version)"
  authority_headers BOOTSTRAP
  curl -sS --max-time 25 -X PATCH "$API/issuers/$issuer_id" "${AUTH_H[@]}" \
    -H 'Content-Type: application/json' -H "If-Match: $version" \
    -d "$(printf '{"did":"%s"}' "$did")" -o /dev/null -w '' || die "could not set $label DID"
  green "$label DID set"
}

ensure_issuer_key() {
  local issuer_id="$1" key_ref="$2" label="$3" existing
  [ -n "$key_ref" ] || return 0
  if [ "$(did_looks_internal "$key_ref")" = internal ] && [ "${ALLOW_LOCAL_ISSUER_DID:-}" = true ]; then
    warn "ALLOW_LOCAL_ISSUER_DID=true — attaching an unresolvable key reference to $label"
  elif [ "$(did_looks_internal "$key_ref")" = internal ]; then
    die "refusing to attach a key to $label whose reference names an internal host:
    $key_ref
    Key references are published in verificationMethods at GET /trust/issuers/{id}, with the
    same consequences as an internal issuer DID."
  fi
  existing="$(api GET "/issuers/$issuer_id/keys" | python3 -c '
import sys, json
want = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("items", [])
print(next((k["id"] for k in items if k.get("keyRefUri") == want), ""))
' "$key_ref")"
  if [ -n "$existing" ]; then info "$label key already attached"; return; fi
  api POST "/issuers/$issuer_id/keys" \
    "$(printf '{"keyRefType":"IDENTITY_SERVICE_DID","keyRefUri":"%s","kid":"%s","algorithm":"%s"}' \
       "$key_ref" "$ISSUER_KEY_ID" "$ISSUER_KEY_ALGORITHM")" >/dev/null
  green "$label key attached"
}

register_schema() {
  local name="$1" vct="$2" sid="$3" props="$4" required="$5" author="$6" existing body
  existing="$(curl -fsS --max-time 25 "$SCHEMA_BASE/credential-schema/oid4vci-configs" 2>/dev/null \
    | python3 -c '
import json, sys
want = sys.argv[1]
for c in json.load(sys.stdin):
    if c.get("name") == want:
        print(c.get("schemaId", "")); break
' "$name")"
  if [ -n "$existing" ]; then info "schema $name already registered"; printf '%s' "$existing"; return; fi

  body="$(python3 -c '
import json, sys
name, vct, sid, props, required, author = sys.argv[1:7]
print(json.dumps({
    "schema": {
        "type": "https://w3c-ccg.github.io/vc-json-schemas/",
        "version": "1.0.0",
        "id": sid,
        "name": name,
        "author": author,
        "authored": "2026-01-01T00:00:00.000Z",
        "schema": {
            "$id": sid,
            "$schema": "https://json-schema.org/draft/2019-09/schema",
            "description": name,
            "type": "object",
            "properties": json.loads(props),
            "required": json.loads(required),
            # Must be true: issuance adds credentialSubject.id, which is not one of the
            # schema own claims, and a false here rejects every issuance with an opaque 500.
            "additionalProperties": True,
        },
    },
    "tags": ["agriculture", "authority-service"],
    # PUBLISHED, or the schema exists and is invisible as an issuable credential.
    "status": "PUBLISHED",
    "oid4vciConfig": {
        # FALSE, and this matters. These credentials are issued through the credential
        # service, never offered over OID4VCI. Enabling it makes the schema appear in the
        # OID4VCI metadata of whichever oid4vc issuer shares this author DID, so the Farmer
        # issuer starts advertising two credentials and "each issuer advertises only its own
        # credential" stops being true.
        "oid4vciEnabled": False,
        "oid4vciFormats": ["vc+sd-jwt"],
        "vct": vct,
        "display": [{"name": name, "locale": "en-US"}],
    },
}))' "$name" "$vct" "$sid" "$props" "$required" "$author")"

  # schema.id in the response is the GENERATED did:schema: identifier, not the $id that was
  # submitted. That is the one everything else refers to.
  existing="$(curl -fsS --max-time 30 -X POST "$SCHEMA_BASE/credential-schema" \
    -H 'content-type: application/json' -d "$body" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["schema"]["id"])')" \
    || die "registering schema $name failed"
  case "$existing" in
    did:schema:*) : ;;
    *) die "schema $name did not return a did:schema: identifier (got \"$existing\")" ;;
  esac
  info "schema $name registered"
  printf '%s' "$existing"
}

ensure_profile() {
  local existing
  existing="$(api GET "/credential-profiles?authorityId=$1" | id_by_code "$4")"
  if [ -n "$existing" ]; then
    # Whatever schema this profile was created against is the schema it issues against.
    # credentialSchemaId is deliberately not patchable — changing it would make this a
    # different credential rather than an edit — and profiles cannot be deleted, so there is
    # nothing to converge and nothing useful to do but use it.
    #
    # An earlier version retired a mismatched profile and created a replacement. That is a
    # one-off repair, not a bootstrap step: it fights itself on the next run, because the
    # retired profile still holds the code and the replacement cannot be created.
    info "profile $4 already present"
    printf '%s' "$existing"; return
  fi
  info "profile $4 created"
  api POST /credential-profiles "$(python3 -c '
import json, sys
authority, binding, issuer, code, name, ctype, context, schema_id, vc_context = sys.argv[1:10]
print(json.dumps({
    "authorityId": authority,
    "registryBindingId": binding,
    "issuerId": issuer,
    "code": code,
    "name": name,
    "credentialType": ["VerifiableCredential", ctype],
    "credentialSchemaId": schema_id,
    "credentialSchemaVersion": "1.0.0",
    # claimVocabulary is deliberately unset: every claim is mapped by the context above, and
    # a vocabulary fallback would let an unmapped claim through as a guess.
    "contextUris": [vc_context, context],
}))' "$1" "$2" "$3" "$4" "$5" "$6" "$CONTEXT_URI" "$7" "$VC_CONTEXT_URI")" | field id
}

head1 "Education topology in the Authority Service"
info "authority service at $BASE"

# --- the two ecosystems ------------------------------------------------------------------
# Deliberately separate tenants. A single Education tenant would make the isolation claim
# untestable: the demo asserts that the School Authority cannot read College records, and
# that only holds if they are different tenants.

head1 "School"
TENANT_SCHOOL="$(ensure_tenant T-EDU-SCHOOL 'State School Board')"
require_id 'school tenant' "$TENANT_SCHOOL"
AUTH_SCHOOL="$(ensure_authority A-EDU-SCHOOL 'State School Board' "$TENANT_SCHOOL")"
require_id 'school authority' "$AUTH_SCHOOL"
BIND_SCHOOL="$(ensure_binding "$AUTH_SCHOOL" SchoolRecord 'School records' learnerId schoolStudentId)"
require_id 'school binding' "$BIND_SCHOOL"
ISS_SCHOOL="$(ensure_issuer "$AUTH_SCHOOL" ISS-SCHOOL 'State School Board')"
require_id 'school issuer' "$ISS_SCHOOL"

head1 "College"
TENANT_COLLEGE="$(ensure_tenant T-EDU-COLLEGE 'Regional Polytechnic College')"
require_id 'college tenant' "$TENANT_COLLEGE"
AUTH_COLLEGE="$(ensure_authority A-EDU-COLLEGE 'Regional Polytechnic College' "$TENANT_COLLEGE")"
require_id 'college authority' "$AUTH_COLLEGE"
BIND_COLLEGE="$(ensure_binding "$AUTH_COLLEGE" CollegeRecord 'College records' learnerId collegeStudentId)"
require_id 'college binding' "$BIND_COLLEGE"
ISS_COLLEGE="$(ensure_issuer "$AUTH_COLLEGE" ISS-COLLEGE 'Regional Polytechnic College')"
require_id 'college issuer' "$ISS_COLLEGE"

# --- memberships -------------------------------------------------------------------------
# One operator and one officer per tenant, never one account spanning both. Entering a
# record and approving it are different roles; the workflow checks the ROLE and not whether
# the two are different people, and the UI must not imply otherwise.
head1 "Memberships"
ensure_membership "$TENANT_SCHOOL"  SCHOOL_OPERATOR  OPERATOR
ensure_membership "$TENANT_SCHOOL"  SCHOOL_OFFICER   AUTHORISED_OFFICER
ensure_membership "$TENANT_COLLEGE" COLLEGE_OPERATOR OPERATOR
ensure_membership "$TENANT_COLLEGE" COLLEGE_OFFICER  AUTHORISED_OFFICER

# --- issuer identities and signing keys --------------------------------------------------
head1 "Issuer identities"
ensure_issuer_did  "$ISS_SCHOOL"  state-school-board
ensure_issuer_did  "$ISS_COLLEGE" regional-polytechnic-college
ensure_issuer_key  "$ISS_SCHOOL"
ensure_issuer_key  "$ISS_COLLEGE"

# --- credential profiles -----------------------------------------------------------------
head1 "Credential profiles"
SCHEMA_SCHOOL="$(register_schema SchoolRecordCredential "$ISS_SCHOOL")"
SCHEMA_COLLEGE="$(register_schema CollegeRecordCredential "$ISS_COLLEGE")"
PROFILE_SCHOOL="$(ensure_profile "$AUTH_SCHOOL" "$BIND_SCHOOL" "$ISS_SCHOOL" P-SCHOOL \
  'School Record Credential' SchoolRecordCredential "$SCHEMA_SCHOOL")"
require_id 'school profile' "$PROFILE_SCHOOL"
PROFILE_COLLEGE="$(ensure_profile "$AUTH_COLLEGE" "$BIND_COLLEGE" "$ISS_COLLEGE" P-COLLEGE \
  'College Record Credential' CollegeRecordCredential "$SCHEMA_COLLEGE")"
require_id 'college profile' "$PROFILE_COLLEGE"

# --- claim mappings ----------------------------------------------------------------------
# Every claim is copied from the approved record. nationalId is mapped by NEITHER profile:
# it is an issuer-side lookup value, and the Education policies never request it.
head1 "Claims"
info "School:"
map "$PROFILE_SCHOOL" "$(direct learnerId        learnerId        true)"
map "$PROFILE_SCHOOL" "$(direct completionStatus completionStatus true)"
map "$PROFILE_SCHOOL" "$(direct percentage       percentage       false)"
map "$PROFILE_SCHOOL" "$(direct completionYear   completionYear   false)"
info "College:"
map "$PROFILE_COLLEGE" "$(direct learnerId        learnerId        true)"
map "$PROFILE_COLLEGE" "$(direct completionStatus completionStatus true)"
map "$PROFILE_COLLEGE" "$(direct qualification    qualification    false)"
map "$PROFILE_COLLEGE" "$(direct specialization   specialization   false)"
map "$PROFILE_COLLEGE" "$(direct percentage       percentage       false)"
map "$PROFILE_COLLEGE" "$(direct completionYear   completionYear   false)"

# --- what the issuers need ---------------------------------------------------------------
# Each issuer gets ONLY its own profile map, so neither can produce the other's credential.
# The map is keyed on the credential name the wallet asks for.
head1 "Writing deploy/.env"
set_env AUTHORITY_BASE_URL "http://authority-service:3334"
set_env EDU_CLAIM_SOURCE authority
set_env AUTHORITY_PROFILE_MAP_SCHOOL  "{\"School Record Credential\":\"$PROFILE_SCHOOL\"}"
set_env AUTHORITY_PROFILE_MAP_COLLEGE "{\"College Record Credential\":\"$PROFILE_COLLEGE\"}"
set_env AUTHORITY_ISSUER_SCHOOL  "$ISS_SCHOOL"
set_env AUTHORITY_ISSUER_COLLEGE "$ISS_COLLEGE"
green "profile ids and claim source written to deploy/.env"

head1 "Done"
info "School  tenant=$TENANT_SCHOOL  binding=$BIND_SCHOOL  profile=$PROFILE_SCHOOL"
info "College tenant=$TENANT_COLLEGE binding=$BIND_COLLEGE profile=$PROFILE_COLLEGE"
green "recreate the Education issuers to pick this up:"
info "  cd deploy && docker compose up -d oid4vc-school oid4vc-college"
