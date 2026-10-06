#!/usr/bin/env bash
# Prepares the machine principals the Authority Service accepts when authentication is ON.
#
# Keycloak imports deploy/keycloak/realm-authority.json with five confidential clients and
# NO secrets — a secret committed to a repository is not a secret. Keycloak generates one
# per client on import. This script reads them out, together with each client's service
# account subject, and writes both into deploy/.env, which is gitignored.
#
# The subject matters as much as the secret. The Authority reduces a token to (iss, sub)
# and looks that pair up in its own TenantMembership table; for a client-credentials token
# `sub` is the service account user's id, which Keycloak generates. So the memberships
# cannot be written ahead of time — bootstrap-agriculture-authority.sh reads these values
# and creates memberships for the subjects that will actually arrive.
#
# Idempotent: re-running re-reads the same values and rewrites the same lines.
#
#   scripts/bootstrap-authority-realm.sh
#   OPS_URL=http://127.0.0.1:18088 scripts/bootstrap-authority-realm.sh   (remote, forwarded)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
OPS="${OPS_URL:-http://127.0.0.1:${OPS_PORT:-8088}}"
OPS="${OPS%/}"
REALM="${AUTHORITY_REALM:-authority}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info()  { printf '  \033[2m·\033[0m %s\n' "$*"; }
say()   { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()   { red "ERROR: $*"; exit 1; }

# The clients, and the .env key each one's values are stored under.
#   client id            key suffix
CLIENTS="
authority-bootstrap    BOOTSTRAP
agri-farmer-operator   FARMER_OPERATOR
agri-land-operator     LAND_OPERATOR
agri-farmer-officer    FARMER_OFFICER
agri-land-officer      LAND_OFFICER
edu-school-operator    SCHOOL_OPERATOR
edu-college-operator   COLLEGE_OPERATOR
edu-school-officer     SCHOOL_OFFICER
edu-college-officer    COLLEGE_OFFICER
"

envval() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -1
}

set_env() {
  local key="$1" value="$2"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    grep -vE "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

json() { python3 -c "import json,sys; d=json.load(sys.stdin); print($1)"; }

say "1. Keycloak"
realm_doc="$(curl -fsS --max-time 10 "$OPS/auth/realms/$REALM" 2>/dev/null)" \
  || die "the '$REALM' realm is not reachable at $OPS/auth/realms/$REALM
  Is the stack up, and did Keycloak import deploy/keycloak/realm-authority.json?
  A realm file with an unknown top-level field makes Keycloak crash-loop on start:
    docker compose -f deploy/docker-compose.yml logs keycloak | grep -i 'Unrecognized field'"

# The issuer every token from this realm will carry. Pinned by the realm's frontendUrl, so
# it does not depend on whether the caller reached Keycloak internally or through nginx.
ISSUER="$(printf '%s' "$realm_doc" | json 'd["token-service"].rsplit("/protocol",1)[0]')"
green "realm '$REALM' reachable; issuer $ISSUER"

ADMIN_USER="${KEYCLOAK_ADMIN_USER:-$(envval KEYCLOAK_ADMIN_USER)}"
ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-$(envval KEYCLOAK_ADMIN_PASSWORD)}"
[ -n "$ADMIN_PASSWORD" ] || die "no Keycloak admin password.
  Set KEYCLOAK_ADMIN_PASSWORD in the environment or in deploy/.env."

admin_token="$(curl -fsS --max-time 15 -X POST \
  "$OPS/auth/realms/master/protocol/openid-connect/token" \
  -H 'content-type: application/x-www-form-urlencoded' \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'client_id=admin-cli' \
  --data-urlencode "username=$ADMIN_USER" \
  --data-urlencode "password=$ADMIN_PASSWORD" \
  | json 'd["access_token"]')" \
  || die "could not authenticate to Keycloak as '$ADMIN_USER'"
green "authenticated to the Keycloak admin API"

say "2. Client credentials"
ADMIN="$OPS/auth/admin/realms/$REALM"
bootstrap_subject=""

while read -r client_id key; do
  [ -n "$client_id" ] || continue

  uuid="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$ADMIN/clients?clientId=$client_id" | json 'd[0]["id"] if d else ""')"
  [ -n "$uuid" ] || die "client '$client_id' is not in the '$REALM' realm.
  The realm file defines it, so this means an older realm is still imported. Keycloak
  skips a realm that already exists: recreate the container to re-import it."

  secret="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$ADMIN/clients/$uuid/client-secret" | json 'd.get("value","")')"
  # A confidential client imported from the realm file can exist with NO secret yet:
  # Keycloak materialises one on demand rather than at import. Reading it then returns an
  # empty value, which is not the same as "this is a public client" -- the old message said
  # exactly that and sent the reader to inspect a realm file that was already correct.
  # Regenerating is the documented way to obtain one, and is safe here because nothing has
  # the old value: this script is the only thing that stores it.
  if [ -z "$secret" ]; then
    secret="$(curl -fsS --max-time 15 -X POST -H "authorization: Bearer $admin_token" \
      "$ADMIN/clients/$uuid/client-secret" | json 'd.get("value","")')"
    [ -n "$secret" ] && printf '  \033[2m·\033[0m %s  secret generated on first use\n' "$client_id"
  fi
  [ -n "$secret" ] || die "client '$client_id' has neither a secret nor one that can be
  generated. Confirm it is confidential (publicClient false) in deploy/keycloak/realm-authority.json."

  subject="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$ADMIN/clients/$uuid/service-account-user" | json 'd.get("id","")')"
  [ -n "$subject" ] || die "client '$client_id' has no service account user.
  serviceAccountsEnabled must be true for the client_credentials grant."

  set_env "AUTHORITY_CLIENT_${key}" "$client_id"
  set_env "AUTHORITY_SECRET_${key}" "$secret"
  set_env "AUTHORITY_SUBJECT_${key}" "$subject"
  [ "$key" = BOOTSTRAP ] && bootstrap_subject="$subject"

  # The subject is an identifier, not a credential, so it is safe to show. The secret
  # is never printed — not here, not in an error, not in a summary.
  green "$client_id  subject $subject  secret stored"
done <<< "$(printf '%s' "$CLIENTS" | sed '/^[[:space:]]*$/d')"

say "3. Realm issuer and the bootstrap administrator"
set_env AUTHORITY_OIDC_ISSUER "$ISSUER"
set_env AUTHORITY_OIDC_JWKS_URI "$ISSUER/protocol/openid-connect/certs"
set_env AUTHORITY_TOKEN_URL "$ISSUER/protocol/openid-connect/token"
green "AUTHORITY_OIDC_ISSUER=$ISSUER"

# Root tenant creation is allowed only for a principal named here, spelled issuer|subject.
[ -n "$bootstrap_subject" ] || die "no bootstrap subject was resolved"
set_env BOOTSTRAP_ADMINS "$ISSUER|$bootstrap_subject"
green "BOOTSTRAP_ADMINS=$ISSUER|$bootstrap_subject"

cat <<NEXT

Next
  The Authority Service reads BOOTSTRAP_ADMINS and the OIDC settings at start, so it has
  to be recreated before it will accept any of this:

    docker compose -f deploy/docker-compose.yml up -d --force-recreate --no-deps authority-service
    scripts/bootstrap-agriculture-authority.sh

  Secrets are in deploy/.env, which is gitignored. Nothing above printed one.
NEXT
