#!/usr/bin/env bash
# Seeds synthetic Education fixtures into the registry.
#
# Idempotent — re-running reports what is already present, and updates a record
# whose fixture has changed. Every value is invented; there is no real learner,
# institution or National ID here, and PRODUCT forbids real data.
#
# The fixtures are chosen to cover REQUIREMENTS §9 and, between them, every
# branch of both decision rules. Eight of §9's ten are registry data and are
# seeded here; the other two are presentation-level and are built by the tests —
# see the note above the fixture table. Several are deliberately INCOMPLETE — an account
# whose National ID has no records at all, and a learner missing one institution's
# record — because "fails safely" is a requirement and cannot be demonstrated
# without a case that fails.
#
# Two fixtures carry the whole argument of the iteration:
#
#   EDU-L-004512  meets both policies
#   EDU-L-006733  university 65%: passes the job rule, fails the Master's 70%
#
# and EDU-L-007841 sits exactly ON all three thresholds at once (60.00 school,
# 60.00 college, 70.00 university), because PRODUCT writes both rules with >= and
# a boundary that is only asserted in a unit test is not demonstrated end to end.
#
# The registry cannot express the cross-entity rule that matters — that all three
# institution records for a learner carry the SAME learnerId — so this script
# builds every record for a learner from one row and refuses to seed a mismatch,
# rather than leaving the decision module to meet impossible data. The one
# deliberate mismatch fixture is written explicitly and labelled as such.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The registry API is an operator route, served only on the loopback operator
# listener (see deploy/nginx/routes-ops.conf).
BASE="${BASE:-http://127.0.0.1:${OPS_PORT:-8088}}"
REG="$BASE/api/v1"

green() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
info()  { printf '  \033[2m·\033[0m %s\n' "$1"; }
warn()  { printf '  \033[33m!\033[0m %s\n' "$1"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$1" >&2; exit 1; }

for entity in EducationLearner SchoolRecord CollegeRecord UniversityRecord; do
  curl -fksS -o /dev/null --max-time 10 -X POST "$REG/$entity/search" \
    -H 'content-type: application/json' -d '{"filters":{}}' \
    || die "the registry API is not answering at $REG/$entity/search — is the stack up and $entity.json mounted?"
done

# Returns the existing record as JSON, or empty when absent.
fetch_record() {
  local entity="$1" field="$2" value="$3"
  curl -fsS -X POST "$REG/$entity/search" -H 'content-type: application/json' \
    -d "{\"filters\":{\"$field\":{\"eq\":\"$value\"}}}" \
    | python3 -c '
import json, sys
d = json.load(sys.stdin)
rows = d if isinstance(d, list) else d.get("data", [])
print(json.dumps(rows[0]) if rows else "")
'
}

# seed <entity> <key-field> <key-value> <label> <json-body>
#
# Creates when absent, updates in place when the fixture has changed, and says so
# either way. An update matters more than it sounds: a re-run after editing a
# fixture must change the record, or the demo silently keeps telling the old
# story.
# ONLY=Entity[,Entity...] restricts this to some of the four entities. The case that needs
# it: once School and College records are owned by the Authority Service, this script must
# not touch them. It would -- it finds them by learnerId and patches any field that differs
# from its own fixture, and its College fixture hardcodes specialization COMPUTER_SCIENCE
# for every learner while the MIS pull correctly produces INFORMATION_TECHNOLOGY and
# MECHANICAL for two of them. The patch would succeed and quietly change managed records.
#
#   ONLY=EducationLearner,UniversityRecord ./scripts/seed-education.sh
#
# Filtered here, in seed(), because every fixture including the structural ones goes through
# it -- guarding the call sites instead would leave the ones added later unguarded.
wants() {
  [ -z "${ONLY:-}" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

seed() {
  local entity="$1" field="$2" value="$3" label="$4" body="$5" existing osid updated
  wants "$entity" || return 0
  existing="$(fetch_record "$entity" "$field" "$value")"

  if [ -z "$existing" ]; then
    curl -fsS -X POST "$REG/$entity" -H 'content-type: application/json' -d "$body" >/dev/null \
      || die "creating $entity $value failed"
    green "$value  $label"
    return 0
  fi

  osid="$(printf '%s' "$existing" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("osid",""))')"
  updated="$(python3 -c '
import json, sys
existing, wanted = json.loads(sys.argv[1]), json.loads(sys.argv[2])
# Compare only the fields this fixture declares: the registry adds osid and
# internal metadata, and treating those as drift would rewrite every record on
# every run.
drift = {k: v for k, v in wanted.items() if existing.get(k) != v}
print(json.dumps(drift))
' "$existing" "$body")"

  if [ "$updated" = "{}" ]; then
    info "$value  $label (already present)"
    return 0
  fi
  if [ -z "$osid" ]; then
    warn "$value differs from the fixture but has no osid to update"
    return 0
  fi
  curl -fsS -X PUT "$REG/$entity/$osid" -H 'content-type: application/json' -d "$body" >/dev/null \
    || die "updating $entity $value failed"
  green "$value  $label (updated)"
}


printf '\033[1mSeeding synthetic Education fixtures at %s\033[0m\n' "$REG"

# --- the fixture table -------------------------------------------------------
#
# One row per learner, so the three institution records cannot drift out of
# agreement by accident. Columns:
#
#   nat | learnerId | schoolPct | schoolStatus | collegePct | collegeStatus
#       | uniPct | uniStatus | degreeLevel | fieldOfStudy | label
#
# REQUIREMENTS §9 lists ten fixtures. Eight of them are properties of registry
# DATA and so live here. The table below covers six of them in eight rows: §9
# says "fails the Master's School OR College rule", and both halves are worth
# having separately, and one extra row sits exactly ON all three thresholds
# (60.00 / 60.00 / 70.00), which is where a comparison is most likely to be
# wrong. The mismatched-learnerId case and the missing-records case follow the
# table, because neither can be expressed as a well-formed row.
#
# The remaining two — "credentials from different holders" and "a valid credential
# from an untrusted issuer for each role" — are properties of the PRESENTATION,
# not of the records. Nothing in a registry can express them: they need a second
# holder key and a second issuing DID respectively. They are built by the tests
# and by the demo, not seeded, and are named here so that a reader counting to ten
# does not conclude two were forgotten.
fixtures() {
  cat <<'ROWS'
NAT-70011234|EDU-L-004512|78.50|COMPLETED|71.20|COMPLETED|74.00|COMPLETED|BACHELOR|COMPUTER_SCIENCE|meets both policies
NAT-70022345|EDU-L-006733|72.00|COMPLETED|68.40|COMPLETED|65.00|COMPLETED|BACHELOR|INFORMATION_TECHNOLOGY|job yes, master's no (university 65%)
NAT-70033456|EDU-L-007841|60.00|COMPLETED|60.00|COMPLETED|70.00|COMPLETED|BACHELOR|SOFTWARE_ENGINEERING|exactly on every boundary: both policies pass
NAT-70044567|EDU-L-008120|59.50|COMPLETED|74.00|COMPLETED|81.00|COMPLETED|BACHELOR|COMPUTER_SCIENCE|fails the master's school 60% rule
NAT-70055678|EDU-L-009002|81.00|COMPLETED|58.90|COMPLETED|77.50|COMPLETED|BACHELOR|COMPUTER_SCIENCE|fails the master's college 60% rule
NAT-70066789|EDU-L-009315|68.00|COMPLETED|64.00|COMPLETED|55.25|COMPLETED|BACHELOR|COMPUTER_SCIENCE|fails the job university 60% rule
NAT-70077890|EDU-L-010447|76.00|COMPLETED|70.00|COMPLETED|79.00|IN_PROGRESS|BACHELOR|COMPUTER_SCIENCE|university not completed
NAT-70088901|EDU-L-011238|84.00|COMPLETED|79.00|COMPLETED|88.00|COMPLETED|BACHELOR|MECHANICAL|unsupported field of study
ROWS
}

printf '\n  Learner directory\n'
fixtures | while IFS='|' read -r nat lid spct sst cpct cst upct ust lvl fld label; do
  [ -n "$nat" ] || continue
  seed EducationLearner learnerId "$lid" "$label" \
    "$(python3 -c '
import json, sys
print(json.dumps({"learnerId": sys.argv[1], "nationalId": sys.argv[2]}))
' "$lid" "$nat")"
done

printf '\n  School\n'
fixtures | while IFS='|' read -r nat lid spct sst cpct cst upct ust lvl fld label; do
  [ -n "$nat" ] || continue
  seed SchoolRecord learnerId "$lid" "school $spct% $sst" \
    "$(python3 -c '
import json, sys
lid, nat, pct, status = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
print(json.dumps({
    "schoolStudentId": "SCH-2019-" + lid[-4:],
    "learnerId": lid, "nationalId": nat,
    "completionStatus": status, "completionYear": 2019, "percentage": pct,
}))
' "$lid" "$nat" "$spct" "$sst")"
done

printf '\n  College\n'
fixtures | while IFS='|' read -r nat lid spct sst cpct cst upct ust lvl fld label; do
  [ -n "$nat" ] || continue
  seed CollegeRecord learnerId "$lid" "college $cpct% $cst" \
    "$(python3 -c '
import json, sys
lid, nat, pct, status = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4]
print(json.dumps({
    "collegeStudentId": "COL-2022-" + lid[-4:],
    "learnerId": lid, "nationalId": nat,
    "qualification": "DIPLOMA", "specialization": "COMPUTER_SCIENCE",
    "completionStatus": status, "completionYear": 2022, "percentage": pct,
}))
' "$lid" "$nat" "$cpct" "$cst")"
done

printf '\n  University\n'
fixtures | while IFS='|' read -r nat lid spct sst cpct cst upct ust lvl fld label; do
  [ -n "$nat" ] || continue
  seed UniversityRecord learnerId "$lid" "university $upct% $ust $lvl $fld" \
    "$(python3 -c '
import json, sys
lid, nat, pct, status, lvl, fld = sys.argv[1], sys.argv[2], float(sys.argv[3]), sys.argv[4], sys.argv[5], sys.argv[6]
print(json.dumps({
    "universityStudentId": "UNI-2026-" + lid[-4:],
    "learnerId": lid, "nationalId": nat,
    "degreeLevel": lvl, "fieldOfStudy": fld,
    "completionStatus": status, "graduationYear": 2026, "percentage": pct,
}))
' "$lid" "$nat" "$upct" "$ust" "$lvl" "$fld")"
done

# --- the two structural fixtures ---------------------------------------------
#
# 9. MISMATCHED learnerIds. Every other row is built from a single learnerId so
#    the three records cannot disagree by accident; this one disagrees ON PURPOSE,
#    which is the only way to demonstrate that correlation across three
#    credentials is checked. The College record names a different learner.
printf '\n  Deliberate mismatch (REQUIREMENTS §9)\n'
MISMATCH_NAT=NAT-70099012
MISMATCH_LID=EDU-L-012550
MISMATCH_OTHER=EDU-L-012551
seed EducationLearner learnerId "$MISMATCH_LID" "mismatch fixture: the learner directory entry" \
  "$(python3 -c 'import json,sys; print(json.dumps({"learnerId": sys.argv[1], "nationalId": sys.argv[2]}))' "$MISMATCH_LID" "$MISMATCH_NAT")"
seed SchoolRecord learnerId "$MISMATCH_LID" "mismatch fixture: school agrees" \
  "$(python3 -c '
import json, sys
print(json.dumps({"schoolStudentId": "SCH-2019-MM01", "learnerId": sys.argv[1], "nationalId": sys.argv[2],
                  "completionStatus": "COMPLETED", "completionYear": 2019, "percentage": 75.0}))
' "$MISMATCH_LID" "$MISMATCH_NAT")"
seed CollegeRecord learnerId "$MISMATCH_OTHER" "mismatch fixture: COLLEGE NAMES A DIFFERENT LEARNER" \
  "$(python3 -c '
import json, sys
print(json.dumps({"collegeStudentId": "COL-2022-MM01", "learnerId": sys.argv[1], "nationalId": sys.argv[2],
                  "qualification": "DIPLOMA", "specialization": "COMPUTER_SCIENCE",
                  "completionStatus": "COMPLETED", "completionYear": 2022, "percentage": 73.0}))
' "$MISMATCH_OTHER" "$MISMATCH_NAT")"
seed UniversityRecord learnerId "$MISMATCH_LID" "mismatch fixture: university agrees" \
  "$(python3 -c '
import json, sys
print(json.dumps({"universityStudentId": "UNI-2026-MM01", "learnerId": sys.argv[1], "nationalId": sys.argv[2],
                  "degreeLevel": "BACHELOR", "fieldOfStudy": "COMPUTER_SCIENCE",
                  "completionStatus": "COMPLETED", "graduationYear": 2026, "percentage": 80.0}))
' "$MISMATCH_LID" "$MISMATCH_NAT")"

# 10. A learner with NO university record, and an account with no records at all.
#     Both are absences, so there is nothing to seed — they are listed here so a
#     reader looking for the tenth fixture finds it rather than assuming it was
#     forgotten.
printf '\n'
info "EDU-L-013001 / NAT-70100123  no university record, on purpose (partial issuance fails safely)"
seed EducationLearner learnerId EDU-L-013001 "partial fixture: directory entry only" \
  "$(python3 -c 'import json; print(json.dumps({"learnerId": "EDU-L-013001", "nationalId": "NAT-70100123"}))')"
seed SchoolRecord learnerId EDU-L-013001 "partial fixture: school only" \
  "$(python3 -c '
import json
print(json.dumps({"schoolStudentId": "SCH-2019-PT01", "learnerId": "EDU-L-013001", "nationalId": "NAT-70100123",
                  "completionStatus": "COMPLETED", "completionYear": 2019, "percentage": 70.0}))')"
info "NAT-70111234  no record in any Education entity, on purpose (unmapped account)"

printf '\n'
count() { curl -fsS -X POST "$REG/$1/search" -H 'content-type: application/json' -d '{"filters":{}}' \
  | python3 -c 'import json,sys; d=json.load(sys.stdin); print(len(d if isinstance(d,list) else d.get("data",[])))'; }
printf '  %s learner(s), %s school, %s college, %s university record(s) in the registry\n' \
  "$(count EducationLearner)" "$(count SchoolRecord)" "$(count CollegeRecord)" "$(count UniversityRecord)"
