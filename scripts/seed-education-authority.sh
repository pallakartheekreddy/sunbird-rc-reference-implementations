#!/usr/bin/env bash
# Seeds the Education fixtures through the Authority Service.
#
# The Agriculture counterpart is scripts/seed-agriculture-authority.sh, and this follows it
# rather than inventing a second way of doing the same thing. One difference is deliberate
# and is the point of the School half: School records arrive by CSV ONBOARDING, not one API
# call per record. School is the greenfield institution in Iteration 4 — it has no source
# system to pull from, so an operator uploads a file, and the demo has to exercise that path
# rather than describe it.
#
# The fixtures are the ones in scripts/seed-education.sh, unchanged and deliberately so:
# they are the accepted Iteration 03 baseline, they cover every branch of both Education
# policies, and changing the data while changing the write path would make a regression
# indistinguishable from a fixture edit.
#
# Records still arrive in a state. The CSV import creates them as DRAFT; they are then
# submitted by the OPERATOR and approved by an AUTHORISED OFFICER — a different subject,
# because approval by whoever entered the record is what separation of duties forbids.
#
# Every record here is invented. There is no real learner, school or National ID.
#
# Idempotent twice over: the CSV row key makes a re-import skip rows already committed, and
# submit/approve are skipped for records that are already APPROVED.
set -euo pipefail

BASE="${AUTHORITY_URL:-http://localhost:3334}"
API="$BASE/api/v1"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
. "$ROOT/scripts/lib/authority-auth.sh"

green() { printf '  \033[32m✓\033[0m %s\n' "$1" >&2; }
info()  { printf '  \033[2m·\033[0m %s\n' "$1" >&2; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1" >&2; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }
head1() { printf '\n\033[1m%s\033[0m\n' "$1" >&2; }

# call SUBJECT METHOD PATH [BODY] [CONTENT_TYPE] -> body, then status on its own line.
call() {
  local subject="$1" method="$2" path="$3" body="${4:-}" ctype="${5:-application/json}"
  authority_headers "$subject"
  local args=(-sS --max-time 60 -X "$method" "$API$path" "${AUTH_H[@]}"
              -H "Content-Type: $ctype" -w '\n%{http_code}')
  [ -n "$body" ] && args+=(--data-binary "$body")
  curl "${args[@]}"
}

ok() {
  local out status
  out="$(call "$@")" || die "$2 $3 — could not reach $BASE"
  status="${out##*$'\n'}"
  case "$status" in
    2*) printf '%s' "${out%$'\n'*}" ;;
    *)  die "$2 $3 -> $status: $(printf '%s' "${out%$'\n'*}" | head -c 300)" ;;
  esac
}

pyget() { python3 -c "$1" "${@:2}"; }

command -v python3 >/dev/null || die "python3 is required"
curl -sS --max-time 10 "$BASE/health" >/dev/null 2>&1 \
  || die "Authority Service is not answering at $BASE (set AUTHORITY_URL)"

# --- discover the topology -------------------------------------------------------------
# By code and entity name, never by id: ids change on every stack reset, and a seed that
# has to be edited after a reset will be run with stale ids sooner or later.
head1 "Topology"
AUTHORITIES="$(ok BOOTSTRAP GET /authorities)"
authority_id() {
  printf '%s' "$AUTHORITIES" | pyget '
import sys, json
want = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("items", [])
print(next((a["id"] for a in items if a.get("code") == want), ""))
' "$1"
}
AUTH_SCHOOL="$(authority_id A-EDU-SCHOOL)"
[ -n "$AUTH_SCHOOL" ] \
  || die "A-EDU-SCHOOL is not configured — run scripts/bootstrap-education-authority.sh first"

binding_id() {
  ok BOOTSTRAP GET "/authorities/$1/registries" | pyget '
import sys, json
want = sys.argv[1]
data = json.load(sys.stdin)
items = data if isinstance(data, list) else data.get("items", [])
print(next((b["id"] for b in items if b.get("entityName") == want), ""))
' "$2"
}
BIND_SCHOOL="$(binding_id "$AUTH_SCHOOL" SchoolRecord)"
[ -n "$BIND_SCHOOL" ] || die "the SchoolRecord binding is missing — re-run the bootstrap"
AUTH_COLLEGE="$(authority_id A-EDU-COLLEGE)"
[ -n "$AUTH_COLLEGE" ] \
  || die "A-EDU-COLLEGE is not configured — run scripts/bootstrap-education-authority.sh first"
BIND_COLLEGE="$(binding_id "$AUTH_COLLEGE" CollegeRecord)"
[ -n "$BIND_COLLEGE" ] || die "the CollegeRecord binding is missing — re-run the bootstrap"

# Which column the CSV must key on. Read from the binding rather than assumed: it is
# configurable, and a file keyed on the wrong column is rejected wholesale with a message
# about a missing column, which reads like a malformed file rather than a misconfiguration.
ROW_KEY="$(ok BOOTSTRAP GET "/registries/$BIND_SCHOOL" | pyget '
import sys, json
print(json.load(sys.stdin).get("csvRowKeyField") or "rowKey")')"
green "SchoolRecord binding resolved, CSV row key \"$ROW_KEY\""

# --- fixtures --------------------------------------------------------------------------
# One row per learner, matching scripts/seed-education.sh exactly. Columns:
#   nat | learnerId | schoolPct | schoolStatus
# The School half of that script's table; the other institutions' columns are omitted
# because this seeds the School tenant only.
fixtures() {
  cat <<'ROWS'
NAT-70011234|EDU-L-004512|78.50|COMPLETED
NAT-70022345|EDU-L-006733|72.00|COMPLETED
NAT-70033456|EDU-L-007841|60.00|COMPLETED
NAT-70044567|EDU-L-008120|59.50|COMPLETED
NAT-70055678|EDU-L-009002|81.00|COMPLETED
NAT-70066789|EDU-L-009315|68.00|COMPLETED
NAT-70077890|EDU-L-010447|76.00|COMPLETED
NAT-70088901|EDU-L-011238|84.00|COMPLETED
ROWS
}

# The two structural fixtures, which are not well-formed rows of the table above: the
# mismatched-learnerId case (School agrees, College will name someone else) and the
# partial case (School only, no university record). Their student ids are fixed rather
# than derived, exactly as in seed-education.sh.
structural() {
  cat <<'ROWS'
SCH-2019-MM01|EDU-L-012550|NAT-70099012|75.00
SCH-2019-PT01|EDU-L-013001|NAT-70100123|70.00
ROWS
}

head1 "School — CSV onboarding"
CSV="$(
  printf '%s,learnerId,nationalId,completionStatus,completionYear,percentage\n' "$ROW_KEY"
  fixtures | while IFS='|' read -r nat lid pct status; do
    [ -n "$nat" ] || continue
    # SCH-2019-<last four of the learner id>, the same derivation seed-education.sh uses.
    printf 'SCH-2019-%s,%s,%s,%s,2019,%s\n' "${lid: -4}" "$lid" "$nat" "$status" "$pct"
  done
  structural | while IFS='|' read -r sid lid nat pct; do
    [ -n "$sid" ] || continue
    printf '%s,%s,%s,COMPLETED,2019,%s\n' "$sid" "$lid" "$nat" "$pct"
  done
)"
ROWS_SENT="$(( $(printf '%s\n' "$CSV" | wc -l) - 1 ))"
info "$ROWS_SENT rows prepared"

# text/csv as the raw body. There is no multipart here on purpose, so there is no multipart
# dependency in the service; the file is parsed and never stored.
authority_headers SCHOOL_OPERATOR
BATCH="$(curl -sS --max-time 90 -X POST "$API/registries/$BIND_SCHOOL/batches/csv" \
  "${AUTH_H[@]}" -H 'Content-Type: text/csv' \
  -H 'X-Source-Reference: seed-education-authority.sh' \
  --data-binary "$CSV")" || die "the CSV upload could not be sent"

printf '%s' "$BATCH" | pyget '
import sys, json
b = json.load(sys.stdin)
if "batchId" not in b and "id" not in b:
    sys.exit("the upload did not return a batch: " + json.dumps(b)[:300])
' || die "unexpected response: $(printf '%s' "$BATCH" | head -c 300)"

BATCH_ID="$(printf '%s' "$BATCH" | pyget '
import sys, json
b = json.load(sys.stdin); print(b.get("batchId") or b.get("id") or "")')"
[ -n "$BATCH_ID" ] || die "no batch id in the upload response"

STATUS="$(ok SCHOOL_OPERATOR GET "/batches/$BATCH_ID")"
printf '%s' "$STATUS" | pyget '
import sys, json
b = json.load(sys.stdin)
counts = b.get("counts") or {}
print("  status %s  %s" % (b.get("status", "?"),
      "  ".join("%s=%s" % (k, v) for k, v in sorted(counts.items()) if v)), file=sys.stderr)
# Row errors are the useful part of a partial batch, and a count alone hides which learner
# is missing from the demo. Print every failed row, not a sample.
for r in b.get("rows", []) or []:
    if (r.get("status") or "").upper() not in ("COMMITTED", "SKIPPED_ALREADY_COMMITTED"):
        print("  row %s %s: %s" % (r.get("rowNumber"), r.get("rowKey"), r.get("reason")), file=sys.stderr)
'

# --- submit and approve ------------------------------------------------------------------
# The import leaves every new record DRAFT. Nothing can be issued against a record that was
# never approved, so a seed that stopped here would look successful and produce no
# credential — which is exactly the failure this walks through instead.
# approve_all BINDING OPERATOR OFFICER ID_FIELD
# Nothing can be issued against a record that was never approved, so a seed that stopped at
# creation would look successful and produce no credential. Shared by both halves: School
# records arrive by CSV and College records by the pull adapter, but both arrive as DRAFT.
approve_all() {
  local binding="$1" operator="$2" officer="$3" field="$4"
  ok "$operator" POST "/registries/$binding/records/search" '{"filters":{},"limit":200}' | pyget '
import sys, json
field = sys.argv[1]
for r in json.load(sys.stdin).get("data", []):
    state = (r.get("authorityState") or {}).get("workflowState") or "DRAFT"
    print(r["osid"], state, r.get(field) or "?")
' "$field" | while read -r osid state sid; do
    case "$state" in
      APPROVED) info "$sid  already approved" ;;
      DRAFT)
        ok "$operator" POST "/registries/$binding/records/$osid/submit" '{"reason":"seed"}' >/dev/null
        ok "$officer"  POST "/registries/$binding/records/$osid/approve" '{"reason":"seed"}' >/dev/null
        green "$sid  submitted and approved"
        ;;
      *)
        ok "$officer" POST "/registries/$binding/records/$osid/approve" '{"reason":"seed"}' >/dev/null
        green "$sid  approved (resumed from $state)"
        ;;
    esac
  done
}

head1 "School — submit and approve"
approve_all "$BIND_SCHOOL" SCHOOL_OPERATOR SCHOOL_OFFICER schoolStudentId

# --- College ------------------------------------------------------------------------------
# The brownfield half. College records are PULLED from a synthetic MIS export through the
# Authority Service rather than entered: the institution already has a system, which is the
# whole point of the scenario. The adapter is tools/college-pull.mjs in the Authority Service
# repository; it is not vendored here, so its location is configurable and its absence is a
# skip with a reason rather than a failure — the School half above is independently useful.
head1 "College — pull from the MIS"
COLLEGE_PULL="${COLLEGE_PULL:-$ROOT/../sunbird-rc-multitenant-registry/work/component/tools/college-pull.mjs}"
COLLEGE_SOURCE="${COLLEGE_SOURCE:-$ROOT/demo/fixtures/college-mis/students.json}"

if [ ! -f "$COLLEGE_PULL" ]; then
  warn "no pull adapter at $COLLEGE_PULL"
  warn "  Set COLLEGE_PULL to tools/college-pull.mjs in the Authority Service repository."
  warn "  School is seeded; College is not, so the three-card journey will not complete."
elif [ ! -f "$COLLEGE_SOURCE" ]; then
  die "no MIS export at $COLLEGE_SOURCE (set COLLEGE_SOURCE)"
else
  command -v node >/dev/null || die "node is required to run the pull adapter"
  # The adapter writes through the Authority as the College OPERATOR. With authentication on
  # it needs a bearer token; authority_token mints one for the same principal the memberships
  # name, so the pull is attributable to an operator rather than to a shared admin.
  COLLEGE_TOKEN=""
  [ "$(authority_mode)" = token ] && COLLEGE_TOKEN="$(authority_token COLLEGE_OPERATOR)"
  node "$COLLEGE_PULL" \
    --base "$API" \
    --binding "$BIND_COLLEGE" \
    --source "$COLLEGE_SOURCE" \
    ${COLLEGE_TOKEN:+--token "$COLLEGE_TOKEN"} 2>&1 | sed 's/^/  /' >&2 \
    || die "the College pull failed"

  head1 "College — submit and approve"
  approve_all "$BIND_COLLEGE" COLLEGE_OPERATOR COLLEGE_OFFICER collegeStudentId
fi

head1 "Result"
tally() {
  ok "$2" POST "/registries/$1/records/search" '{"filters":{},"limit":200}' | pyget '
import sys, json
from collections import Counter
rows = json.load(sys.stdin).get("data", [])
c = Counter((r.get("authorityState") or {}).get("workflowState") or "DRAFT" for r in rows)
print("  %-14s %d record(s)  %s" % (sys.argv[1], len(rows),
      ", ".join("%s: %d" % kv for kv in sorted(c.items()))), file=sys.stderr)
' "$3"
}
tally "$BIND_SCHOOL"  SCHOOL_OPERATOR  SchoolRecord
tally "$BIND_COLLEGE" COLLEGE_OPERATOR CollegeRecord
