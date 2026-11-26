#!/usr/bin/env bash
# Seeds synthetic AgeCitizen records into the registry.
#
# Idempotent — re-running reports what is already present. Every record is
# invented; there is no real person here, and PRODUCT forbids real data.
#
# Two kinds of fixture, deliberately:
#
#   * Fixed dates of birth for the main cases, so the demo tells the same story
#     every time it is run.
#   * COMPUTED dates for the two boundary cases. "Turns 18 today" cannot be
#     expressed as a constant — a fixed date drifts into "turned 18 years ago"
#     and stops testing the boundary at all. The property is what must be
#     repeatable, not the literal value. Exact-boundary arithmetic is also
#     covered with frozen dates in tests/unit/age-claims.test.mjs.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/deploy/.env"
envval() { { grep -E "^$1=" "$ENV_FILE" 2>/dev/null || true; } | cut -d= -f2- | tr -d '\r' | tail -1; }

# The registry API is an operator route, served only on the loopback operator
# listener (see deploy/nginx/routes-ops.conf).
BASE="${BASE:-http://127.0.0.1:${OPS_PORT:-8088}}"
REG="$BASE/api/v1"

green() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info()  { printf '  \033[2m·\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

curl -fksS -o /dev/null --max-time 10 -X POST "$REG/AgeCitizen/search" \
  -H 'content-type: application/json' -d '{"filters":{}}' \
  || die "the registry API is not answering at $REG/AgeCitizen/search — is the stack up and AgeCitizen.json mounted?"

# Boundary dates, computed against today IN UTC so they mean the same thing wherever this
# runs — and, more to the point, so they mean the same thing as the issuer.
#
# date.today() is the LOCAL date, and the age-issuer derives age in UTC. Anywhere east of
# Greenwich that is a different day for the hours between local midnight and 00:00Z: the
# seed writes a date of birth that is "18 today" locally while the issuer still reads it as
# 17, and both boundary fixtures land on the same side of 18. The suite catches it and
# reports stale fixtures, which sends you to re-seed rather than to the timezone.
TURNS_18_TODAY="$(python3 -c "
from datetime import datetime, timezone
t = datetime.now(timezone.utc).date()
print(t.replace(year=t.year - 18).isoformat())
")"
TURNS_18_TOMORROW="$(python3 -c "
from datetime import datetime, timedelta, timezone
t = datetime.now(timezone.utc).date() + timedelta(days=1)
print(t.replace(year=t.year - 18).isoformat())
")"

# Returns the existing record for a citizen as JSON, or empty when absent.
fetch_record() {
  curl -fsS -X POST "$REG/AgeCitizen/search" -H 'content-type: application/json' \
    -d "{\"filters\":{\"citizenId\":{\"eq\":\"$1\"}}}" \
    | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("data", [])
print(json.dumps(rows[0]) if rows else "")
'
}

seed() {
  local citizen_id="$1" body="$2" label="$3" existing
  existing="$(fetch_record "$citizen_id")"
  if [ -n "$existing" ]; then info "$citizen_id already present"; return 0; fi
  curl -fsS -X POST "$REG/AgeCitizen" -H 'content-type: application/json' -d "$body" >/dev/null \
    && green "$label" || die "seeding $citizen_id failed"
}

# Keeps a boundary fixture meaningful.
#
# "Turns 18 today" and "turns 18 tomorrow" are computed against the day of
# SEEDING, so the morning after, both citizens are over 18 and the pair has
# quietly stopped testing the boundary it exists to test. (Found exactly that
# way: the e2e boundary assertion failed the next day.) So refresh the date of
# birth when it has drifted, rather than reporting "already present" and moving
# on. tests/e2e/age-verification.test.mjs asserts the pair still straddles 18.
refresh_boundary() {
  local citizen_id="$1" want_dob="$2" label="$3" existing osid current
  existing="$(fetch_record "$citizen_id")"
  [ -z "$existing" ] && return 1   # absent: the caller's seed() will create it
  osid="$(printf '%s' "$existing" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("osid",""))')"
  current="$(printf '%s' "$existing" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("dateOfBirth",""))')"
  if [ "$current" = "$want_dob" ]; then
    info "$citizen_id boundary date still correct ($current)"
    return 0
  fi
  [ -z "$osid" ] && { warn "$citizen_id has no osid; cannot refresh"; return 0; }
  local updated
  updated="$(printf '%s' "$existing" | python3 -c "
import json, sys
r = json.load(sys.stdin)
r['dateOfBirth'] = '$want_dob'
for k in ('osid', '_osSignedData', '@type', 'osOwner'):
    r.pop(k, None)
print(json.dumps(r))
")"
  curl -fsS -X PUT "$REG/AgeCitizen/$osid" -H 'content-type: application/json' -d "$updated" >/dev/null \
    && green "$label refreshed: $current -> $want_dob" \
    || warn "$citizen_id refresh failed; the boundary test will report it as stale"
}

printf '\033[1mSeeding synthetic AgeCitizen records at %s\033[0m\n' "$REG"

seed AGE-000001 \
  '{"citizenId":"AGE-000001","name":"Meera Nair","dateOfBirth":"1998-04-02","gender":"Female","district":"Ernakulam","state":"Kerala"}' \
  'AGE-000001 Meera Nair — adult, expects APPROVED'

# A minor on purpose. ageOver18 must be present and FALSE, not missing: the
# verifier has to reach a verified DENIED rather than fail verification.
seed AGE-000002 \
  '{"citizenId":"AGE-000002","name":"Arjun Das","dateOfBirth":"2012-08-30","gender":"Male","district":"Kozhikode","state":"Kerala"}' \
  'AGE-000002 Arjun Das — minor, expects DENIED'

seed AGE-000003 \
  "{\"citizenId\":\"AGE-000003\",\"name\":\"Nikhil Rao\",\"dateOfBirth\":\"$TURNS_18_TODAY\",\"gender\":\"Male\",\"district\":\"Dharwad\",\"state\":\"Karnataka\"}" \
  "AGE-000003 Nikhil Rao — turns 18 TODAY ($TURNS_18_TODAY), expects APPROVED"

seed AGE-000004 \
  "{\"citizenId\":\"AGE-000004\",\"name\":\"Sana Iqbal\",\"dateOfBirth\":\"$TURNS_18_TOMORROW\",\"gender\":\"Female\",\"district\":\"Hyderabad\",\"state\":\"Telangana\"}" \
  "AGE-000004 Sana Iqbal — turns 18 TOMORROW ($TURNS_18_TOMORROW), expects DENIED"

# The two records above are only a boundary pair on the day they were seeded, so
# bring their dates forward if the calendar has moved on.
refresh_boundary AGE-000003 "$TURNS_18_TODAY"    'AGE-000003 (turns 18 today)'
refresh_boundary AGE-000004 "$TURNS_18_TOMORROW" 'AGE-000004 (turns 18 tomorrow)'

# Born on a leap day: the derivation compares calendar fields, so 29 February
# must not shift by a day or resolve to "no birthday this year".
seed AGE-000005 \
  '{"citizenId":"AGE-000005","name":"Leela Menon","dateOfBirth":"1996-02-29","gender":"Female","district":"Thrissur","state":"Kerala"}' \
  'AGE-000005 Leela Menon — leap-day date of birth, expects APPROVED'

# One citizen inside each band the 16/18 thresholds create that the
# records above do not already cover. Dates of birth are relative to today, and a
# record is only rewritten once its holder has aged out of the band, so a rerun
# normally changes nothing.
#
# seed_aged <citizenId> <age> <name> <gender> <label>
seed_aged() {
  local citizen_id="$1" age="$2" name="$3" gender="$4" label="$5" want existing current_age
  want="$(python3 -c "
from datetime import datetime, timedelta, timezone
t = datetime.now(timezone.utc).date() - timedelta(days=182)
try:
    print(t.replace(year=t.year - $age).isoformat())
except ValueError:  # 29 February in a non-leap target year
    print(t.replace(year=t.year - $age, day=28).isoformat())
")"
  existing="$(fetch_record "$citizen_id")"
  if [ -z "$existing" ]; then
    seed "$citizen_id" \
      "{\"citizenId\":\"$citizen_id\",\"name\":\"$name\",\"dateOfBirth\":\"$want\",\"gender\":\"$gender\"}" \
      "$citizen_id $name — $label"
    return 0
  fi
  current_age="$(printf '%s' "$existing" | python3 -c '
import json, sys
from datetime import datetime, timezone
b = datetime.strptime(json.load(sys.stdin).get("dateOfBirth", ""), "%Y-%m-%d").date()
t = datetime.now(timezone.utc).date()
print(t.year - b.year - ((t.month, t.day) < (b.month, b.day)))
' 2>/dev/null)"
  if [ "$current_age" = "$age" ]; then
    info "$citizen_id still aged $age"
  else
    refresh_boundary "$citizen_id" "$want" "$citizen_id (aged $age)"
  fi
}

seed_aged AGE-000006 15 'Alex Moreau' 'Male'   'aged 15: under both thresholds, expects DENIED at 16+'
seed_aged AGE-000007 17 'Dana Okafor' 'Female' 'aged 17: APPROVED at 16+, DENIED at 18+'

TOTAL="$(curl -fsS -X POST "$REG/AgeCitizen/search" -H 'content-type: application/json' -d '{"filters":{}}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("data",[])))')"
printf '\n  %s AgeCitizen record(s) in the registry\n' "$TOTAL"
