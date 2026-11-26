#!/usr/bin/env python3
"""Credential schema specs for scripts/bootstrap.sh.

A file rather than heredocs inside bootstrap.sh: six credentials with real
claim descriptions is far more text than a shell script can carry legibly, and
bash 3.2 (still the default on macOS) cannot parse a heredoc inside $(...) in a
function body at all.

Usage: credential-specs.py <age|farmer|land|school|college|university> <author-did> <vct-slug>
Prints one JSON spec for scripts/bootstrap.sh's create_schema.
"""
import json
import sys

SPECS = {
    "age": {
        "name": "Age Verification Credential",
        "id": "AgeVerificationCredential",
        "tags": ["age"],
        "description": (
            "Issuer-derived age assertions. ageOver16 and ageOver18 are computed by the issuer "
            "from the authoritative AgeCitizen date of birth; name and dateOfBirth travel as "
            "selectively-disclosable claims the holder is expected NOT to reveal to an "
            "age-restricted service."
        ),
        "properties": {
            "ageOver16": {"type": "boolean", "description": "Derived at issuance from dateOfBirth."},
            "ageOver18": {"type": "boolean", "description": "Derived at issuance from dateOfBirth."},
            "name": {"type": "string"},
            "dateOfBirth": {"type": "string", "format": "date"},
        },
        "required": ["ageOver18"],
        # SD-JWT VC for OpenID4VP 1.0 wallets (Paradym, walt.id); W3C ldp_vc for
        # Inji Wallet and apps embedding the Inji SDK, which cannot hold SD-JWT.
        # ldp_vc has no selective disclosure: the verifier still RECEIVES only
        # the claims its Presentation Exchange request asks for.
        "formats": ["vc+sd-jwt", "ldp_vc"],
    },
    "farmer": {
        "name": "Farmer Identity Credential",
        "id": "FarmerIdentityCredential",
        "tags": ["agriculture"],
        "description": (
            "Identity of a registered farmer, from the Farmer Registry's authoritative record. "
            "farmerId is the Agriculture correlation identifier a lender matches against the "
            "Land credential. nationalId is deliberately ABSENT: it is the issuer's lookup key "
            "and must never reach a verifier. farmerCategory and district travel as "
            "selectively-disclosable claims a bank does not request."
        ),
        "properties": {
            "farmerReference": {
                "type": "string",
                "description": (
                    "Canonical reference to the farmer record, qualified by the issuing "
                    "Authority and the jurisdiction. A bare local number would not do: two "
                    "jurisdictions may each hold FRM-KA-0041, and a credential carrying the "
                    "bare value would present them as the same person."
                ),
            },
            "registrationStatus": {
                "type": "boolean",
                "description": "Whether the Authority lists this person as a registered farmer.",
            },
            # Technical linkage, not an Agriculture business term. It names the Authority
            # Service credential this one was issued against, so a verifier can ask that
            # Authority whether the record still stands. Disclosed only in journeys that
            # need live status; a lender checking eligibility alone never requests it.
            "authorityCredentialId": {
                "type": "string",
                "description": (
                    "Identifier of the Authority Service credential this one is anchored to. "
                    "Set by the issuer from the Authority's issuance response; never supplied "
                    "by a holder or caller."
                ),
            },
            "farmerCategory": {"type": "string", "description": "Landholding category."},
            "district": {"type": "string"},
        },
        "required": ["farmerReference", "registrationStatus"],
    },
    "land": {
        "name": "Land Ownership Credential",
        "id": "LandOwnershipCredential",
        "tags": ["agriculture"],
        "description": (
            "Ownership and cultivation of one land parcel, from the Land Registry's "
            "authoritative record. farmerId is carried so a lender can correlate this "
            "credential with the Farmer credential; cropType and cultivatedAreaAcres are the "
            "verified inputs to a crop-based loan calculation. nationalId is deliberately "
            "ABSENT. landId, landAreaAcres and district travel as selectively-disclosable "
            "claims a bank does not request: the loan uses cultivated area only, so total "
            "holding size stays with the farmer."
        ),
        "properties": {
            "parcelReference": {
                "type": "string",
                "description": "Canonical reference to the parcel, in the Land Authority namespace.",
            },
            "farmerReference": {
                "type": "string",
                "description": (
                    "The owning farmer, in the FARMER Authority's namespace, so a lender can "
                    "correlate this credential with the Farmer credential."
                ),
            },
            "ownershipStatus": {
                "type": "string",
                "description": "ACTIVE, INACTIVE, DISPUTED or TRANSFERRED. Only ACTIVE is fundable.",
            },
            "landAreaAcres": {"type": "number", "description": "Total parcel area."},
            "cropType": {"type": "string", "description": "Controlled vocabulary; the rate is looked up from policy."},
            "cultivatedArea": {
                "type": "number",
                "description": (
                    "Cultivated area in acres, the authoritative input to the loan calculation, "
                    "at most two decimals. The unit is fixed by the term rather than restated."
                ),
            },
            "district": {"type": "string"},
            # Technical linkage, not an Agriculture business term — see the farmer spec.
            "authorityCredentialId": {
                "type": "string",
                "description": (
                    "Identifier of the Authority Service credential this one is anchored to. "
                    "Set by the issuer from the Authority's issuance response; never supplied "
                    "by a holder or caller."
                ),
            },
        },
        "required": ["parcelReference", "farmerReference", "ownershipStatus", "cropType", "cultivatedArea"],
    },
    # --- Iteration 03 -------------------------------------------------------
    #
    # Three credentials from three authorities that have never heard of each
    # other. Every one of them carries `learnerId` and NOT `nationalId`: the
    # National ID is each issuer's own lookup key and must never reach a verifier
    # (REQUIREMENTS §7), while learnerId is the only thing the three have in
    # common and therefore the only thing correlation can be built on.
    #
    # `percentage` is present on all three because the Master's rule needs all
    # three. The job rule needs only the University one, and the job portal simply
    # does not ask for the other two — disclosure is decided per request, not by
    # issuing two versions of a certificate.
    "school": {
        "name": "School Record Credential",
        "id": "SchoolRecordCredential",
        "tags": ["education"],
        "description": (
            "School completion, from the State School Board's authoritative record. learnerId is "
            "the Education correlation identifier the verifier matches across all three "
            "credentials. nationalId and schoolStudentId are deliberately ABSENT: the first is "
            "the issuer's lookup key, the second identifies the learner to this institution and "
            "no verifier needs it. completionYear travels as a selectively-disclosable claim "
            "neither policy requests."
        ),
        "properties": {
            "learnerId": {
                "type": "string",
                "description": "Education correlation identifier, e.g. EDU-L-004512.",
            },
            "completionStatus": {
                "type": "string",
                "description": "COMPLETED, IN_PROGRESS, DISCONTINUED or FAILED. Only COMPLETED satisfies a policy.",
            },
            "percentage": {
                "type": "number",
                "description": "Aggregate percentage, 0-100, at most two decimals. Requested only by the Master's rule.",
            },
            "completionYear": {"type": "integer"},
        },
        "required": ["learnerId", "completionStatus"],
    },
    "college": {
        "name": "College Record Credential",
        "id": "CollegeRecordCredential",
        "tags": ["education"],
        "description": (
            "College completion, from the Regional Polytechnic College's authoritative record. "
            "Carries learnerId for correlation. nationalId and collegeStudentId are deliberately "
            "ABSENT. qualification, specialization and completionYear travel as "
            "selectively-disclosable claims: neither policy gates on the college specialization, "
            "so it stays with the learner."
        ),
        "properties": {
            "learnerId": {"type": "string", "description": "The same correlation identifier, for correlation."},
            "completionStatus": {
                "type": "string",
                "description": "COMPLETED, IN_PROGRESS, DISCONTINUED or FAILED. Only COMPLETED satisfies a policy.",
            },
            "percentage": {
                "type": "number",
                "description": "Aggregate percentage, 0-100, at most two decimals. Requested only by the Master's rule.",
            },
            "qualification": {"type": "string", "description": "DIPLOMA, ADVANCED_DIPLOMA or CERTIFICATE."},
            "specialization": {"type": "string"},
            "completionYear": {"type": "integer"},
        },
        "required": ["learnerId", "completionStatus"],
    },
    "university": {
        "name": "University Record Credential",
        "id": "UniversityRecordCredential",
        "tags": ["education"],
        "description": (
            "Degree award, from the State University's authoritative record. The only credential "
            "authoritative for degreeLevel and fieldOfStudy, which both policies gate on, and the "
            "only one whose percentage the job rule requests. Carries learnerId for correlation; "
            "nationalId and universityStudentId are deliberately ABSENT. graduationYear travels as "
            "a selectively-disclosable claim neither policy requests, so a graduation date cannot "
            "be used to infer age."
        ),
        "properties": {
            "learnerId": {"type": "string", "description": "The same correlation identifier, for correlation."},
            "completionStatus": {
                "type": "string",
                "description": "COMPLETED, IN_PROGRESS, DISCONTINUED or FAILED. Only COMPLETED satisfies a policy.",
            },
            "degreeLevel": {
                "type": "string",
                "description": "BACHELOR, MASTER, DOCTORATE or INTEGRATED. Both policies require BACHELOR.",
            },
            "fieldOfStudy": {
                "type": "string",
                "description": "Controlled vocabulary; the accepted set is policy, not schema.",
            },
            "percentage": {
                "type": "number",
                "description": "Aggregate percentage, 0-100, at most two decimals. Both policies gate on it.",
            },
            "graduationYear": {"type": "integer"},
        },
        "required": ["learnerId", "completionStatus", "degreeLevel", "fieldOfStudy"],
    },
}


def main() -> int:
    if len(sys.argv) != 4:
        print(__doc__.strip(), file=sys.stderr)
        return 2
    which, author, vct = sys.argv[1:4]
    spec = SPECS.get(which)
    if spec is None:
        print(f"unknown credential '{which}'; expected one of {', '.join(SPECS)}", file=sys.stderr)
        return 2
    if not author.startswith("did:"):
        print(f"author must be a DID, got '{author}'", file=sys.stderr)
        return 2
    print(json.dumps({**spec, "author": author, "vct": vct}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
