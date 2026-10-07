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

say "2. Clients the realm file defines"
# Keycloak imports a realm only when it does not already exist, so a client added to the
# realm file later never appears on a deployment that has been up once. The loop below
# handles the confidential clients because it needs their secrets; this handles every
# client in the file, including PUBLIC ones that have no secret to store and so are absent
# from the CLIENTS table entirely -- the operator console is one.
ADMIN="$OPS/auth/admin/realms/$REALM"
REALM_FILE="${REALM_FILE:-$ROOT/deploy/keycloak/realm-authority.json}"

python3 -c '
import json, sys
for c in json.load(open(sys.argv[1])).get("clients", []):
    print(c["clientId"])
' "$REALM_FILE" | while read -r client_id; do
  [ -n "$client_id" ] || continue
  uuid="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$ADMIN/clients?clientId=$client_id" | json 'd[0]["id"] if d else ""')"
  [ -n "$uuid" ] && continue
  definition="$(python3 -c '
import json, sys
want = sys.argv[2]
for c in json.load(open(sys.argv[1])).get("clients", []):
    if c["clientId"] == want:
        for k in ("id", "protocolMappers", "defaultClientScopes", "optionalClientScopes"):
            c.pop(k, None)
        print(json.dumps(c)); break
else:
    sys.exit("%s is not in %s" % (want, sys.argv[1]))
' "$REALM_FILE" "$client_id")" || die "$client_id is not defined in $REALM_FILE"
  curl -fsS --max-time 20 -X POST -H "authorization: Bearer $admin_token" \
    -H 'content-type: application/json' -d "$definition" "$ADMIN/clients" >/dev/null \
    || die "could not create client '$client_id'"
  printf '  \033[2m·\033[0m %s  created (absent from the already-imported realm)\n' "$client_id"
done

say "2. Client credentials"
ADMIN="$OPS/auth/admin/realms/$REALM"
REALM_FILE="${REALM_FILE:-$ROOT/deploy/keycloak/realm-authority.json}"
bootstrap_subject=""

while read -r client_id key; do
  [ -n "$client_id" ] || continue

  uuid="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$ADMIN/clients?clientId=$client_id" | json 'd[0]["id"] if d else ""')"
  # Absent means the realm predates this client: Keycloak SKIPS a realm that already
  # exists, so a client added to the realm file later never appears. Recreating the
  # container to force a re-import is the obvious fix and the wrong one -- it rebuilds
  # every service account, and the Authority Service's TenantMembership rows go on naming
  # the previous subjects, which makes every existing tenant invisible to its own
  # administrator. Create the one missing client instead, from the same definition the
  # realm file carries, and leave every other client untouched.
  if [ -z "$uuid" ]; then
    definition="$(python3 - "$REALM_FILE" "$client_id" <<'PYEOF'
import json, sys
realm = json.load(open(sys.argv[1]))
want = sys.argv[2]
for c in realm.get("clients", []):
    if c.get("clientId") == want:
        # Drop fields that belong to the exporting realm rather than to this client.
        for k in ("id", "protocolMappers", "defaultClientScopes", "optionalClientScopes"):
            c.pop(k, None)
        print(json.dumps(c))
        break
else:
    sys.exit("'%s' is not defined in %s" % (want, sys.argv[1]))
PYEOF
)" || die "$client_id is not defined in $REALM_FILE"
    curl -fsS --max-time 20 -X POST -H "authorization: Bearer $admin_token" \
      -H 'content-type: application/json' -d "$definition" "$ADMIN/clients" >/dev/null \
      || die "could not create client '$client_id' in the '$REALM' realm"
    uuid="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
      "$ADMIN/clients?clientId=$client_id" | json 'd[0]["id"] if d else ""')"
    [ -n "$uuid" ] || die "created client '$client_id' but it cannot be read back"
    printf '  \033[2m·\033[0m %s  created (absent from the already-imported realm)\n' "$client_id"
  fi

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

say "3. Console sign-in accounts"
# People, not service accounts. The realm file defines them, but Keycloak imports a realm
# only when it does not already exist -- so on any deployment that has been up once, the
# users in that file never appear. Same trap as the clients above. Create what is missing.
#
# Every field here is load-bearing, and the failure is misleading: a user without an EMAIL
# cannot sign in at all, failing with "Account is not fully set up" while its own
# requiredActions list is empty, because VERIFY_PROFILE demands one even though it is not a
# default action. Found by probing a live realm, not by reading the realm file.
#
# Passwords are demo values from the realm file. They are not secrets, and they are not
# written to deploy/.env: nothing here needs to read them back.
users_json="$(python3 -c '
import json, sys
realm = json.load(open(sys.argv[1]))
print(json.dumps(realm.get("users", [])))
' "$REALM_FILE")"

printf '%s' "$users_json" | python3 -c '
import json, sys
for u in json.load(sys.stdin):
    pw = (u.get("credentials") or [{}])[0].get("value", "")
    print("\t".join([u["username"], u.get("firstName",""), u.get("lastName",""),
                     u.get("email",""), pw]))
' | while IFS="$(printf '\t')" read -r username first last email password; do
  [ -n "$username" ] || continue
  uuid="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
    "$ADMIN/users?username=$username&exact=true" | json 'd[0]["id"] if d else ""')"
  if [ -z "$uuid" ]; then
    curl -fsS --max-time 20 -X POST -H "authorization: Bearer $admin_token" \
      -H 'content-type: application/json' "$ADMIN/users" \
      -d "$(python3 -c '
import json, sys
u, f, l, e = sys.argv[1:5]
print(json.dumps({"username": u, "enabled": True, "emailVerified": True,
                  "firstName": f, "lastName": l, "email": e, "requiredActions": []}))
' "$username" "$first" "$last" "$email")" >/dev/null \
      || die "could not create user '$username'"
    uuid="$(curl -fsS --max-time 15 -H "authorization: Bearer $admin_token" \
      "$ADMIN/users?username=$username&exact=true" | json 'd[0]["id"] if d else ""')"
    [ -n "$uuid" ] || die "created user '$username' but it cannot be read back"
    created=" created"
  else
    created=""
  fi
  # Set the password every time. A run that creates the user and then fails before this
  # leaves an account that exists and cannot sign in, which is worse than no account.
  curl -fsS --max-time 20 -X PUT -H "authorization: Bearer $admin_token" \
    -H 'content-type: application/json' "$ADMIN/users/$uuid/reset-password" \
    -d "$(python3 -c 'import json,sys; print(json.dumps({"type":"password","value":sys.argv[1],"temporary":False}))' "$password")" \
    >/dev/null || die "could not set the password for '$username'"
  green "$username  subject $uuid$created"
done

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
