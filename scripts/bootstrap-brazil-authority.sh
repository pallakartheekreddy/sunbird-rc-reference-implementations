#!/usr/bin/env bash
# The three institutes of the Brazil demo, and the nine memberships that make the admin
# console show three different things to three different people.
#
# Horizonte, Atlantico and Aurora are structurally identical: same StudentRecord schema,
# same roles, same everything except osTenantId. That is deliberate. A demo where the
# tenants differ in shape can pass while isolation is broken, because a cross-tenant read
# would fail on the schema rather than on the boundary. Identical tenants mean the ONLY
# thing keeping them apart is the thing under test.
#
# The nine memberships are 3 institutes x 3 roles, but not 3 people x 3:
#   admin          ADMINISTRATOR       in all three  (platform-wide administrator)
#   <institute>.operator  OPERATOR            in its own institute only
#   <institute>.officer   AUTHORISED_OFFICER  in its own institute only
# So the administrator sees three tenants, each operator sees exactly one, and no operator
# can approve. That asymmetry IS the demo.
#
# These are Keycloak PEOPLE, not service accounts, so their subjects cannot come from
# deploy/.env the way the issuing services' do -- they are resolved by username against the
# realm, which is also what makes this re-runnable after a realm rebuild.
#
# Idempotent: every step checks before it writes.
#
#   scripts/bootstrap-brazil-authority.sh
#   OPS_URL=http://127.0.0.1:18088 scripts/bootstrap-brazil-authority.sh   (remote, forwarded)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export ROOT
ENV_FILE="$ROOT/deploy/.env"
BASE="${AUTHORITY_URL:-http://localhost:3334}"; BASE="${BASE%/}"
API="$BASE/api/v1"
OPS="${OPS_URL:-http://127.0.0.1:${OPS_PORT:-8088}}"; OPS="${OPS%/}"
REALM="${AUTHORITY_REALM:-authority}"
RC_REGISTRY_URL="${RC_REGISTRY_URL:-http://registry:8081}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info()  { printf '  \033[2m·\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
say()   { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()   { red "ERROR: $*"; exit 1; }

# shellcheck source=lib/authority-auth.sh
. "$ROOT/scripts/lib/authority-auth.sh"

envval() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

api() {
  local method="$1" path="$2" body="${3:-}" out code
  authority_headers BOOTSTRAP
  if [ -n "$body" ]; then
    out="$(curl -sS --max-time 30 -X "$method" "$API$path" "${AUTH_H[@]}" \
      -H 'Content-Type: application/json' -d "$body" -w '\n%{http_code}')"
  else
    out="$(curl -sS --max-time 30 -X "$method" "$API$path" "${AUTH_H[@]}" -w '\n%{http_code}')"
  fi
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in 2*) printf '%s' "$out" ;;
    *) die "$method $path -> $code: $out" ;;
  esac
}

api_try() {
  local method="$1" path="$2" body="${3:-}" out code
  local -a args=(-sS --max-time 30 -X "$method" "$API$path" -H 'Content-Type: application/json')
  authority_headers BOOTSTRAP
  # An ARRAY, not ${body:+-d "$body"}. That expansion is unquoted, so the JSON body is split
  # on every space -- curl then sees -d '{"name":"Instituto' and the request fails for a
  # reason that looks exactly like the server rejecting the field.
  [ -n "$body" ] && args+=(-d "$body")
  out="$(curl "${args[@]}" "${AUTH_H[@]}" -w '\n%{http_code}')" || return 1
  code="${out##*$'\n'}"; out="${out%$'\n'*}"
  case "$code" in 2*) printf '%s' "$out" ;; *) return 1 ;; esac
}

field() { python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('$1',''))"; }
items() { python3 -c "
import json,sys
d=json.load(sys.stdin)
print(json.dumps(d if isinstance(d,list) else d.get('items',d.get('data',[]))))"; }

# --- the institutes ----------------------------------------------------------------------
# code | tenant code | display name
# A plain array, iterated WITHOUT a pipeline. `printf ... | while` would put the loop in a
# subshell, so every tenant id it resolved would be lost at the end of the loop and the
# memberships would have nothing to attach to.
INSTITUTES=(
  "horizonte|T-BR-HORIZONTE|Instituto Horizonte"
  "atlantico|T-BR-ATLANTICO|Instituto Atlantico"
  "aurora|T-BR-AURORA|Instituto Aurora"
)

say "1. Preflight"
[ "$(authority_mode)" = token ] && green "authentication is ON" || warn "authentication is OFF (dev headers)"

ISSUER="$(curl -fsS --max-time 10 "$OPS/auth/realms/$REALM" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token-service"].rsplit("/protocol",1)[0])')" \
  || die "the '$REALM' realm is not reachable at $OPS"
green "realm issuer $ISSUER"

# The memberships this script writes are keyed on that issuer. If it does not match what the
# Authority validates, every row it creates would be invisible the moment it is written --
# the exact failure scripts/migrate-authority-issuer.sh exists to prevent, and worth
# refusing here rather than discovering through an empty console.
CONFIGURED="$(envval AUTHORITY_OIDC_ISSUER)"
[ -z "$CONFIGURED" ] || [ "$CONFIGURED" = "$ISSUER" ] \
  || die "the realm mints $ISSUER but deploy/.env configures $CONFIGURED.
  Memberships written now would never match a token. Run scripts/migrate-authority-issuer.sh first."

ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-$(envval KEYCLOAK_ADMIN_PASSWORD)}"
[ -n "$ADMIN_PASSWORD" ] || die "no Keycloak admin password (KEYCLOAK_ADMIN_PASSWORD)"
ADMIN_USER="${KEYCLOAK_ADMIN_USER:-$(envval KEYCLOAK_ADMIN_USER)}"; ADMIN_USER="${ADMIN_USER:-admin}"
admin_token="$(curl -fsS --max-time 20 -X POST \
  "$OPS/auth/realms/master/protocol/openid-connect/token" \
  --data-urlencode 'grant_type=password' --data-urlencode 'client_id=admin-cli' \
  --data-urlencode "username=$ADMIN_USER" --data-urlencode "password=$ADMIN_PASSWORD" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')" \
  || die "could not authenticate to Keycloak"
[ -n "$admin_token" ] || die "Keycloak returned no admin token"
green "Keycloak admin session"

# subject_of USERNAME -> the Keycloak user id, or empty
subject_of() {
  curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$OPS/auth/admin/realms/$REALM/users?username=$1&exact=true" 2>/dev/null \
    | python3 -c 'import json,sys; d=json.load(sys.stdin); print(d[0]["id"] if d else "")'
}

# --- topology ----------------------------------------------------------------------------
ensure_tenant() {
  local code="$1" name="$2" existing
  existing="$(api GET "/tenants" | python3 -c '
import json,sys
code=sys.argv[1]
d=json.load(sys.stdin); its=d if isinstance(d,list) else d.get("items",[])
print(next((t["id"] for t in its if t.get("code")==code), ""))' "$code")"
  if [ -n "$existing" ]; then info "tenant $code already present" >&2; printf '%s' "$existing"; return; fi
  api POST "/tenants" "$(printf '{"code":"%s","name":"%s"}' "$code" "$name")" | field id
}

# Authorities are a FLAT collection carrying tenantId, not a sub-resource of the tenant.
# /tenants/{id}/authorities is a 404, which the service reports as a generic NOT_FOUND and
# reads exactly like a missing tenant.
ensure_authority() {
  local tenant="$1" code="$2" name="$3" existing
  existing="$(api GET "/authorities" | python3 -c '
import json,sys
code=sys.argv[1]
d=json.load(sys.stdin); its=d if isinstance(d,list) else d.get("items",[])
print(next((a["id"] for a in its if a.get("code")==code), ""))' "$code")"
  if [ -n "$existing" ]; then info "authority $code already present" >&2; printf '%s' "$existing"; return; fi
  api POST "/authorities" \
    "$(printf '{"code":"%s","name":"%s","tenantId":"%s"}' "$code" "$name" "$tenant")" | field id
}

# A binding created before this script could set csvRowKeyField keeps NULL for it forever,
# and "already present" would report success while CSV import silently expects a "rowKey"
# column. Converge rather than assume.
converge_binding_csv() {
  local id="$1" current version
  current="$(api GET "/registries/$id")" || return 0
  printf '%s' "$current" | python3 -c '
import json, sys
b = json.load(sys.stdin)
ok = b.get("csvRowKeyField") == "studentId" and (b.get("csvFieldTypes") or {}) != {}
sys.exit(0 if ok else 1)' 2>/dev/null && return 0
  version="$(printf '%s' "$current" | field version)"
  authority_headers BOOTSTRAP
  if curl -sS --max-time 30 -X PATCH "$API/registries/$id" "${AUTH_H[@]}" \
       -H 'Content-Type: application/json' -H "If-Match: $version" \
       -d '{"csvRowKeyField":"studentId","csvFieldTypes":{"percentage":"number","enrolmentYear":"number"}}' \
       -o /dev/null -w '' 2>/dev/null; then
    green "binding StudentRecord: CSV row key studentId set" >&2
  else
    warn "binding StudentRecord: could not set csvRowKeyField" >&2
  fi
}

ensure_binding() {
  local authority="$1" name="$2" existing body created
  existing="$(api GET "/authorities/$authority/registries" | python3 -c '
import json,sys
d=json.load(sys.stdin); its=d if isinstance(d,list) else d.get("items",[])
print(next((b["id"] for b in its if b.get("entityName")=="StudentRecord"), ""))')"
  if [ -n "$existing" ]; then
    converge_binding_csv "$existing"
    info "binding StudentRecord already present" >&2; printf '%s' "$existing"; return
  fi
  # uniqueFields is studentId and NOT nationalId: the same person may legitimately be
  # enrolled at two institutes, and uniqueness is per-tenant anyway.
  body="$(python3 -c '
import json,sys
name, rc = sys.argv[1], sys.argv[2]
print(json.dumps({"name": name, "rcInstanceRef": rc, "entityName": "StudentRecord",
                  "uniqueFields": ["studentId"],
                  "csvRowKeyField": "studentId",
                  "csvFieldTypes": {"percentage": "number", "enrolmentYear": "number"}}))' \
    "$name" "$RC_REGISTRY_URL")"
  created="$(api_try POST "/authorities/$authority/registries" "$body" | field id || true)"
  if [ -n "$created" ]; then printf '%s' "$created"; return; fi
  warn "this authority-service does not accept csvRowKeyField — creating without it" >&2
  api POST "/authorities/$authority/registries" \
    "$(printf '{"name":"%s","rcInstanceRef":"%s","entityName":"StudentRecord","uniqueFields":["studentId"]}' \
       "$name" "$RC_REGISTRY_URL")" | field id
}

# ensure_membership TENANT_ID USERNAME ROLE
ensure_membership() {
  local tenant="$1" username="$2" role="$3" subject existing
  subject="$(subject_of "$username")"
  [ -n "$subject" ] || { warn "no Keycloak user '$username' — run scripts/bootstrap-authority-realm.sh"; return; }
  existing="$(api GET "/tenants/$tenant/memberships" | python3 -c '
import json,sys
issuer, subject, role = sys.argv[1], sys.argv[2], sys.argv[3]
d=json.load(sys.stdin); its=d if isinstance(d,list) else d.get("items",[])
print(next((m["id"] for m in its if m.get("subject")==subject
            and m.get("issuer")==issuer and m.get("role")==role), ""))' \
    "$ISSUER" "$subject" "$role")"
  if [ -n "$existing" ]; then info "$username ($role) already a member"; return; fi
  api POST "/tenants/$tenant/memberships" \
    "$(printf '{"issuer":"%s","subject":"%s","role":"%s"}' "$ISSUER" "$subject" "$role")" >/dev/null
  green "$username ($role)"
}

say "2. Institutes and their memberships"
for entry in "${INSTITUTES[@]}"; do
  IFS='|' read -r code tcode name <<<"$entry"
  upper="$(printf '%s' "$code" | tr '[:lower:]' '[:upper:]')"

  tenant="$(ensure_tenant "$tcode" "$name")"
  [ -n "$tenant" ] || die "could not resolve a tenant id for $tcode"
  authority="$(ensure_authority "$tenant" "A-BR-$upper" "$name")"
  [ -n "$authority" ] || die "could not resolve an authority id for A-BR-$upper"
  binding="$(ensure_binding "$authority" "$name - student records")"

  green "$name"
  info "  tenant=$tenant"
  info "  authority=$authority  binding=$binding"

  # The platform-wide administrator is a member of EVERY institute. That is what makes it
  # platform-wide: the Authority has no notion of a global role, so breadth is spelled out
  # as rows and stays visible in the console rather than hiding in a claim.
  ensure_membership "$tenant" admin ADMINISTRATOR
  ensure_membership "$tenant" "$code.operator" OPERATOR
  ensure_membership "$tenant" "$code.officer"  AUTHORISED_OFFICER
done

say "Done"
info "Each operator and officer sees exactly one institute; admin sees all three."
info "Verify in the console: sign in as horizonte.operator, then as admin."
