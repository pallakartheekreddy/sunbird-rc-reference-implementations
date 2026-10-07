# Authenticating to the Authority Service, from a shell script.
#
# Sourced, not executed:
#
#     . "$(dirname "${BASH_SOURCE[0]}")/lib/authority-auth.sh"
#     authority_headers FARMER_OFFICER          # sets AUTH_H
#     curl -fsS "${AUTH_H[@]}" "$API/authorities"
#
# There are two ways to reach the administrative API and the scripts must work with both:
#
#   ENABLE_AUTH=false   x-dev-issuer / x-dev-subject headers name the caller directly.
#                       A local development escape hatch.
#   ENABLE_AUTH=true    an OAuth2 client-credentials token from the `authority` realm.
#                       What a deployment actually runs.
#
# Which one is in force is DISCOVERED from the service rather than configured here, so a
# script cannot be run in the wrong mode and quietly authenticate as nobody.
#
# Tokens are cached per principal and re-acquired a little before they expire. The realm
# issues 60-second tokens deliberately, and a seeding run is longer than that, so "fetch
# once at the top" would fail partway through with a 401 that looks like a permissions
# problem.

# macOS ships bash 3.2, which has neither associative arrays nor mapfile, and every
# other script here stays within that. The per-principal cache is therefore held in
# dynamically named plain variables (_AUTH_TOKEN_FARMER_OFFICER and so on) rather than
# in one associative array, and headers come back in the global AUTH_H.
_AUTH_MODE=""            # dev | token, resolved once
AUTH_H=()                # set by authority_headers

_auth_envval() {
  local file="${AUTHORITY_ENV_FILE:-$ROOT/deploy/.env}"
  [ -f "$file" ] || return 0
  sed -n "s/^$1=//p" "$file" | tail -1
}

_auth_die() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

# Ask the service which mode it is in. An unauthenticated administrative route answers
# 401 when authentication is on, and 200/403 when it is off.
authority_mode() {
  if [ -z "$_AUTH_MODE" ]; then
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "${API:-$BASE/api/v1}/tenants" || echo 000)"
    if [ "$code" = "401" ]; then _AUTH_MODE=token; else _AUTH_MODE=dev; fi
  fi
  printf '%s' "$_AUTH_MODE"
}

# authority_token KEY -> an access token for that principal, cached until nearly expired.
authority_token() {
  local key="$1" now secret client url body token expires cached expiry
  now="$(date +%s)"

  eval "cached=\"\${_AUTH_TOKEN_$key:-}\""
  eval "expiry=\"\${_AUTH_EXPIRY_$key:-0}\""
  if [ -n "$cached" ] && [ "$now" -lt "$expiry" ]; then
    printf '%s' "$cached"
    return 0
  fi

  client="${AUTHORITY_CLIENT_OVERRIDE:-$(_auth_envval "AUTHORITY_CLIENT_${key}")}"
  secret="$(_auth_envval "AUTHORITY_SECRET_${key}")"

  [ -n "$client" ] || _auth_die "no client id for $key. Run scripts/bootstrap-authority-realm.sh first."
  [ -n "$secret" ] || _auth_die "no client secret for $key. Run scripts/bootstrap-authority-realm.sh first."

  # Built from the operator listener rather than from AUTHORITY_TOKEN_URL, so this keeps
  # working whichever host the realm's pin happens to name. The token is byte-for-byte the
  # same either way, which is the whole point of pinning the issuer: where you ask does not
  # change who the token says you are. (The pin now names this same listener, because the
  # admin console signs operators in through a browser — see deploy/keycloak/README.md.)
  url="${OPS_URL:-http://127.0.0.1:${OPS_PORT:-8088}}"
  url="${url%/}/auth/realms/${AUTHORITY_REALM:-authority}/protocol/openid-connect/token"

  body="$(curl -fsS --max-time 20 -X POST "$url" \
    -H 'content-type: application/x-www-form-urlencoded' \
    --data-urlencode 'grant_type=client_credentials' \
    --data-urlencode "client_id=$client" \
    --data-urlencode "client_secret=$secret" 2>/dev/null)" \
    || _auth_die "could not get a token for $client from $url"

  token="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("access_token",""))')"
  expires="$(printf '%s' "$body" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("expires_in",60))')"
  [ -n "$token" ] || _auth_die "the token response for $client carried no access_token"

  # Re-acquire with a margin, so a token cannot expire between this check and the request
  # that uses it. Never less than 5 seconds of life.
  if [ "$expires" -gt 15 ]; then expiry=$(( now + expires - 10 )); else expiry=$(( now + 5 )); fi
  eval "_AUTH_TOKEN_$key=\"\$token\""
  eval "_AUTH_EXPIRY_$key=\"\$expiry\""
  printf '%s' "$token"
}

# authority_headers KEY -> sets the global AUTH_H array to curl header arguments.
#
# KEY is a principal: BOOTSTRAP, FARMER_OPERATOR, LAND_OPERATOR, FARMER_OFFICER,
# LAND_OFFICER. In dev mode it becomes an x-dev-subject; with auth on it selects the
# client credentials to present. The SAME call site works either way, which is the point:
# the scripts describe who is acting, not how the deployment authenticates them.
authority_headers() {
  local key="$1" subject

  if [ "$(authority_mode)" = dev ]; then
    case "$key" in
      BOOTSTRAP)       subject="${BOOTSTRAP_SUBJECT:-bootstrap}" ;;
      FARMER_OPERATOR) subject="${FARMER_OPERATOR:-agri-farmer-operator}" ;;
      LAND_OPERATOR)   subject="${LAND_OPERATOR:-agri-land-operator}" ;;
      FARMER_OFFICER)  subject="${FARMER_OFFICER:-agri-farmer-officer}" ;;
      LAND_OFFICER)    subject="${LAND_OFFICER:-agri-land-officer}" ;;
      *) _auth_die "unknown principal $key" ;;
    esac
    AUTH_H=(-H "x-dev-issuer: ${BOOTSTRAP_ISSUER:-https://idp.test}" -H "x-dev-subject: $subject")
    return 0
  fi

  AUTH_H=(-H "authorization: Bearer $(authority_token "$key")")
}

# The (issuer, subject) pair a membership must name for KEY to be recognised.
# In dev mode that is the header pair; with auth on it is the realm issuer and the
# service account's id, both written to deploy/.env by bootstrap-authority-realm.sh.
authority_principal() {
  local key="$1"
  if [ "$(authority_mode)" = dev ]; then
    case "$key" in
      BOOTSTRAP)       printf '%s\t%s' "${BOOTSTRAP_ISSUER:-https://idp.test}" "${BOOTSTRAP_SUBJECT:-bootstrap}" ;;
      FARMER_OPERATOR) printf '%s\t%s' "${MEMBER_ISSUER:-https://idp.test}" "${FARMER_OPERATOR:-agri-farmer-operator}" ;;
      LAND_OPERATOR)   printf '%s\t%s' "${MEMBER_ISSUER:-https://idp.test}" "${LAND_OPERATOR:-agri-land-operator}" ;;
      FARMER_OFFICER)  printf '%s\t%s' "${MEMBER_ISSUER:-https://idp.test}" "${FARMER_OFFICER:-agri-farmer-officer}" ;;
      LAND_OFFICER)    printf '%s\t%s' "${MEMBER_ISSUER:-https://idp.test}" "${LAND_OFFICER:-agri-land-officer}" ;;
      *) _auth_die "unknown principal $key" ;;
    esac
    return 0
  fi
  local issuer subject
  issuer="${AUTHORITY_OIDC_ISSUER:-$(_auth_envval AUTHORITY_OIDC_ISSUER)}"
  subject="$(_auth_envval "AUTHORITY_SUBJECT_${key}")"
  [ -n "$issuer" ] && [ -n "$subject" ] \
    || _auth_die "no issuer/subject for $key. Run scripts/bootstrap-authority-realm.sh first."
  printf '%s\t%s' "$issuer" "$subject"
}
