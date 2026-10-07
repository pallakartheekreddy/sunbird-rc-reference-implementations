#!/usr/bin/env bash
# Moves the `authority` realm's pinned issuer to the value deploy/keycloak/realm-authority.json
# now names, and migrates the state that stores the old string with it.
#
# WHY THIS EXISTS. The realm pins `attributes.frontendUrl`, which fixes the `iss` claim of
# every token it mints regardless of where the token was requested. That pin named
# `http://keycloak:8080/auth` for as long as nothing but services visited the realm. The
# admin console broke that premise: it signs operators in through a real browser, and
# frontendUrl governs not just `iss` but every absolute URL Keycloak hands back mid-login —
# so Keycloak answered the authorization request by redirecting the browser to
# `http://keycloak:8080/...`, a hostname that exists only on the container network.
#
# Repointing the pin at the loopback operator listener keeps the property that made pinning
# worth doing (one `iss` everywhere) while making that one value client-reachable. But it
# rewrites `iss` for every token, and TenantMembership rows store that string — so the realm
# attribute, the rows, and deploy/.env have to move in ONE step. Move the realm alone and
# every tenant goes invisible to its own administrator, reported only as a 404.
#
# Idempotent: re-running when already migrated re-asserts each step and changes nothing.
#
#   scripts/migrate-authority-issuer.sh
#   DRY_RUN=1 scripts/migrate-authority-issuer.sh          show the plan, change nothing
#   FORCE=1   scripts/migrate-authority-issuer.sh          skip the confirmation prompt
#   OPS_URL=http://127.0.0.1:18088 scripts/migrate-authority-issuer.sh   (remote, forwarded)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPLOY="$ROOT/deploy"
ENV_FILE="$DEPLOY/.env"
COMPOSE=(docker compose -f "$DEPLOY/docker-compose.yml")
REALM="${AUTHORITY_REALM:-authority}"
# Two different surfaces: the operator listener fronts Keycloak and the schemas, while the
# Authority's own API is published separately. Probing the API on $OPS returns 404 from
# nginx, which looks exactly like a service that failed to come back.
OPS="${OPS_URL:-http://127.0.0.1:${OPS_PORT:-8088}}"; OPS="${OPS%/}"
BASE="${AUTHORITY_URL:-http://localhost:3334}"; BASE="${BASE%/}"
API="$BASE/api/v1"
DRY_RUN="${DRY_RUN:-0}"
FORCE="${FORCE:-0}"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
info()  { printf '  \033[2m·\033[0m %s\n' "$*"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$*"; }
say()   { printf '\n\033[1m%s\033[0m\n' "$*"; }
die()   { red "ERROR: $*"; exit 1; }

envval() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }

set_env() {
  local key="$1" value="$2"
  touch "$ENV_FILE"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    grep -vE "^${key}=" "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  fi
  printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
}

psql_q() { "${COMPOSE[@]}" exec -T db psql -U postgres -d authority -At -c "$1"; }

# A token is not evidence on its own: it has to carry the new issuer AND still resolve to a
# membership. The second is what the row migration was for, and the only thing that catches
# a half-applied migration. Run on the "already migrated" path too — an end state worth
# asserting is worth proving.
prove_end_to_end() {
  local token iss code
  # shellcheck source=lib/authority-auth.sh
  BASE="$BASE" API="$API" . "$ROOT/scripts/lib/authority-auth.sh"

  token="$(authority_token BOOTSTRAP)" || die "could not get a bootstrap token"
  iss="$(printf '%s' "$token" | python3 -c '
import base64, json, sys
p = sys.stdin.read().split(".")[1]
print(json.loads(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)))["iss"])')"
  [ "$iss" = "$NEW_ISSUER" ] || die "a freshly minted token still claims iss=$iss"
  green "a fresh machine token claims iss=$NEW_ISSUER"

  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 \
    -H "authorization: Bearer $token" "$API/tenants")"
  [ "$code" = 200 ] || die "that token was not recognised by the Authority (HTTP $code).
  The membership rows and the realm are out of step. Replay the newest backup:
    ls -t $ROOT/.migrate-authority-issuer-*.sql | head -1"
  green "the Authority recognised it and listed tenants (HTTP 200)"
}

# ---------------------------------------------------------------------------
say "1. What the repository now says the issuer should be"

[ -f "$DEPLOY/keycloak/realm-$REALM.json" ] || die "no deploy/keycloak/realm-$REALM.json"

# The realm file is the default, and TARGET_FRONTEND_URL overrides it. A deployment
# published on a public origin needs an issuer a public browser can reach, and that origin
# differs per environment -- so it is passed in rather than committed, which would force the
# loopback deployments to carry one host's public name.
FRONTEND_URL="${TARGET_FRONTEND_URL:-$(python3 -c "
import json
d = json.load(open('$DEPLOY/keycloak/realm-$REALM.json'))
print(d.get('attributes', {}).get('frontendUrl', '').rstrip('/'))")}"
FRONTEND_URL="${FRONTEND_URL%/}"

[ -n "$FRONTEND_URL" ] || die "realm-$REALM.json has no attributes.frontendUrl.
  This migration only makes sense for a realm whose issuer is PINNED. Without the pin
  Keycloak derives iss from each request and there is no single value to migrate to."

NEW_ISSUER="$FRONTEND_URL/realms/$REALM"
# Deliberately NOT derived from the issuer. The issuer is a name tokens are compared
# against; this is an address the Authority must actually fetch keys from, from inside the
# container network, where 127.0.0.1 is the Authority itself.
NEW_JWKS="http://keycloak:8080/auth/realms/$REALM/protocol/openid-connect/certs"
# Same rule, and the one that is easy to get wrong: four issuing CONTAINERS read this from
# deploy/.env. Pointing it at the loopback listener aims them at themselves. Scripts never
# use it — scripts/lib/authority-auth.sh builds the token URL from the operator listener.
NEW_TOKEN_URL="http://keycloak:8080/auth/realms/$REALM/protocol/openid-connect/token"

green "target issuer  $NEW_ISSUER"
info  "signing keys stay on the container network: $NEW_JWKS"

# ---------------------------------------------------------------------------
say "2. What the running deployment currently says"

realm_doc="$(curl -fsS --max-time 10 "$OPS/auth/realms/$REALM" 2>/dev/null)" \
  || die "the '$REALM' realm is not reachable at $OPS/auth/realms/$REALM
  Is the stack up?  ${COMPOSE[*]} ps"

LIVE_ISSUER="$(printf '%s' "$realm_doc" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["token-service"].rsplit("/protocol",1)[0])')"
info "realm currently mints  $LIVE_ISSUER"

"${COMPOSE[@]}" exec -T db true >/dev/null 2>&1 || die "cannot reach the db service"

OLD_ISSUERS="$(psql_q "select distinct issuer from \"TenantMembership\" where issuer <> '$NEW_ISSUER'")"
AT_TARGET="$(psql_q "select count(*) from \"TenantMembership\" where issuer = '$NEW_ISSUER'")"

if [ -n "$OLD_ISSUERS" ]; then
  count="$(printf '%s\n' "$OLD_ISSUERS" | grep -c .)"
  [ "$count" = 1 ] || die "TenantMembership carries $count different issuers:
$(printf '%s\n' "$OLD_ISSUERS" | sed 's/^/    /')
  This script migrates exactly one. Resolve by hand — rewriting all of them would
  silently merge two populations of principals into one."
  OLD_ISSUER="$OLD_ISSUERS"
  TO_MOVE="$(psql_q "select count(*) from \"TenantMembership\" where issuer = '$OLD_ISSUER'")"
else
  OLD_ISSUER=""
  TO_MOVE=0
fi

printf '\n'
info "memberships already on the target issuer: $AT_TARGET"
if [ -n "$OLD_ISSUER" ]; then
  warn "memberships still on  $OLD_ISSUER: $TO_MOVE"
else
  green "no membership rows carry a stale issuer"
fi

if [ "$LIVE_ISSUER" = "$NEW_ISSUER" ] && [ -z "$OLD_ISSUER" ] \
   && [ "$(envval AUTHORITY_OIDC_ISSUER)" = "$NEW_ISSUER" ] \
   && [ "$(envval AUTHORITY_TOKEN_URL)" = "$NEW_TOKEN_URL" ] \
   && [ "$(envval AUTHORITY_OIDC_JWKS_URI)" = "$NEW_JWKS" ]; then
  say "Already migrated — re-proving the end state"
  prove_end_to_end
  exit 0
fi

# ---------------------------------------------------------------------------
say "3. Plan"

cat <<PLAN
  realm attribute   $LIVE_ISSUER
               ->   $NEW_ISSUER
  TenantMembership  $TO_MOVE row(s) rewritten  (actorIssuer columns left alone: they are
                    audit history and record what actually happened)
  deploy/.env       AUTHORITY_OIDC_ISSUER, AUTHORITY_TOKEN_URL, AUTHORITY_OIDC_JWKS_URI,
                    BOOTSTRAP_ADMINS
  restart           authority-service recreated (it reads these only at start)
PLAN

if [ "$DRY_RUN" = 1 ]; then
  say "DRY_RUN=1 — nothing changed."
  exit 0
fi

if [ "$FORCE" != 1 ]; then
  printf '\n  Type \033[1mmigrate\033[0m to apply: '
  read -r reply
  [ "$reply" = migrate ] || die "aborted; nothing changed"
fi

# ---------------------------------------------------------------------------
say "4. Backup"

STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="$ROOT/.migrate-authority-issuer-$STAMP.sql"
psql_q "select 'update \"TenantMembership\" set issuer = ' || quote_literal(issuer) ||
        ' where id = ' || quote_literal(id) || ';' from \"TenantMembership\"" > "$BACKUP"
green "membership issuers captured as replayable SQL: ${BACKUP#$ROOT/}"
info  "to undo the row change:  ${COMPOSE[*]} exec -T db psql -U postgres -d authority -f /dev/stdin < ${BACKUP#$ROOT/}"

# ---------------------------------------------------------------------------
say "5. Keycloak realm attribute"

ADMIN_USER="${KEYCLOAK_ADMIN_USER:-$(envval KEYCLOAK_ADMIN_USER)}"; ADMIN_USER="${ADMIN_USER:-admin}"
ADMIN_PASSWORD="${KEYCLOAK_ADMIN_PASSWORD:-$(envval KEYCLOAK_ADMIN_PASSWORD)}"
[ -n "$ADMIN_PASSWORD" ] || die "no Keycloak admin password.
  Set KEYCLOAK_ADMIN_PASSWORD in the environment or in deploy/.env."

admin_token="$(curl -fsS --max-time 20 -X POST \
  "$OPS/auth/realms/master/protocol/openid-connect/token" \
  --data-urlencode 'grant_type=password' \
  --data-urlencode 'client_id=admin-cli' \
  --data-urlencode "username=$ADMIN_USER" \
  --data-urlencode "password=$ADMIN_PASSWORD" 2>/dev/null \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')" \
  || die "could not authenticate to Keycloak as '$ADMIN_USER'"
[ -n "$admin_token" ] || die "Keycloak returned no admin access token"

# The realm file is imported only when the realm is ABSENT, so editing it does not reach a
# realm that already exists. This is the write that actually moves a running deployment.
current="$(curl -fsS --max-time 20 -H "authorization: Bearer $admin_token" \
  "$OPS/auth/admin/realms/$REALM")" || die "could not read realm '$REALM'"

printf '%s' "$current" | python3 -c "
import json, sys
d = json.load(sys.stdin)
d.setdefault('attributes', {})['frontendUrl'] = '$FRONTEND_URL'
json.dump(d, sys.stdout)" > /tmp/realm-$$.json

code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 -X PUT \
  -H "authorization: Bearer $admin_token" -H 'content-type: application/json' \
  --data-binary "@/tmp/realm-$$.json" "$OPS/auth/admin/realms/$REALM")"
rm -f "/tmp/realm-$$.json"
case "$code" in 204|200) green "frontendUrl set to $FRONTEND_URL" ;;
  *) die "Keycloak refused the realm update (HTTP $code)" ;;
esac

# The pin is only worth anything if BOTH routes report the same issuer. Checking one would
# miss exactly the failure this migration is about.
via_ops="$(curl -fsS --max-time 10 "$OPS/auth/realms/$REALM/.well-known/openid-configuration" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["issuer"])')"
# Whichever fetcher the image happens to ship — this container has curl and no wget, and
# an empty body here is indistinguishable from a genuinely wrong issuer if left unchecked.
via_net_raw="$("${COMPOSE[@]}" exec -T authority-service sh -c \
  "curl -fsS --max-time 10 http://keycloak:8080/auth/realms/$REALM/.well-known/openid-configuration 2>/dev/null \
   || wget -qO- http://keycloak:8080/auth/realms/$REALM/.well-known/openid-configuration 2>/dev/null" 2>/dev/null)"
[ -n "$via_net_raw" ] || die "could not read the realm from inside the container network.
  Neither curl nor wget returned anything from authority-service."
via_net="$(printf '%s' "$via_net_raw" | python3 -c 'import json,sys; print(json.load(sys.stdin)["issuer"])')"

[ "$via_ops" = "$NEW_ISSUER" ] || die "through the operator listener the realm still mints $via_ops"
[ "$via_net" = "$NEW_ISSUER" ] || die "on the container network the realm still mints $via_net"
green "both routes mint $NEW_ISSUER — the pin holds"

# ---------------------------------------------------------------------------
say "6. TenantMembership"

if [ -n "$OLD_ISSUER" ]; then
  moved="$(psql_q "with u as (
             update \"TenantMembership\" set issuer = '$NEW_ISSUER'
             where issuer = '$OLD_ISSUER' returning 1)
           select count(*) from u")"
  green "$moved membership row(s) moved to the new issuer"
else
  info "no rows needed moving"
fi

left="$(psql_q "select count(*) from \"TenantMembership\" where issuer <> '$NEW_ISSUER'")"
[ "$left" = 0 ] || die "$left membership row(s) still carry a different issuer"

# ---------------------------------------------------------------------------
say "7. deploy/.env"

set_env AUTHORITY_OIDC_ISSUER "$NEW_ISSUER"
set_env AUTHORITY_OIDC_JWKS_URI "$NEW_JWKS"
set_env AUTHORITY_TOKEN_URL "$NEW_TOKEN_URL"
green "AUTHORITY_OIDC_ISSUER, AUTHORITY_OIDC_JWKS_URI, AUTHORITY_TOKEN_URL"

admins="$(envval BOOTSTRAP_ADMINS)"
if [ -n "$admins" ] && [ -n "$OLD_ISSUER" ]; then
  # Spelled issuer|subject, possibly several separated by commas. Only the issuer half
  # moves; the subjects are Keycloak's service-account ids and have not changed.
  updated="$(OLD="$OLD_ISSUER" NEW="$NEW_ISSUER" ADMINS="$admins" python3 -c '
import os
print(os.environ["ADMINS"].replace(os.environ["OLD"], os.environ["NEW"]))')"
  set_env BOOTSTRAP_ADMINS "$updated"
  green "BOOTSTRAP_ADMINS reissued"
elif [ -z "$admins" ]; then
  warn "BOOTSTRAP_ADMINS is not set in deploy/.env — root tenant creation will be refused"
fi

# ---------------------------------------------------------------------------
say "8. Restart the Authority Service"

# Recreated, not restarted: OIDC_ISSUER and BOOTSTRAP_ADMINS are read from the environment
# at start, and `restart` reuses the container's existing environment.
"${COMPOSE[@]}" up -d --force-recreate --no-deps authority-service >/dev/null 2>&1 \
  || die "could not recreate authority-service"

for _ in $(seq 1 60); do
  code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$API/tenants" || echo 000)"
  case "$code" in 200|401|403) break ;; esac
  sleep 2
done
case "$code" in 200|401|403) green "authority-service is answering on $BASE (HTTP $code)" ;;
  *) die "authority-service did not come back (last HTTP $code from $API/tenants)" ;;
esac

# ---------------------------------------------------------------------------
say "9. Prove it end to end"

prove_end_to_end

say "Done."
cat <<NEXT
  The browser flow can now be retested: open the console, Sign in, and Keycloak's
  redirect will stay on $FRONTEND_URL instead of a container hostname.

  Backup kept at ${BACKUP#$ROOT/} — delete it once the console sign-in is confirmed.

  The sandbox needs this same migration. Run it ON that host rather than over a
  forwarded port: both 8088 and 3334 are published on its own loopback, so nothing
  needs forwarding, and DRY_RUN first shows its row count before anything moves.
    ssh rc@<host>
    cd <deploy checkout> && DRY_RUN=1 scripts/migrate-authority-issuer.sh
    scripts/migrate-authority-issuer.sh
NEXT
