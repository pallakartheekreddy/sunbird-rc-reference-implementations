# Age verifier page — redesign

**Date:** 2026-11-26 · **Page:** `services/verifier-web` (served at `/verifier/`) · **Status:** draft for approval

## Why

This is the reference implementation we show to other countries, and their
teams will **try it themselves** with their own phones and wallets. The page has
two jobs at once:

1. Be the age-restricted service a citizen uses: pick the rule, present from a
   wallet by any of the three PRD methods, get an answer.
2. Show the visiting team what just happened, so the privacy and trust claims
   are visibly proven rather than asserted: only "over 16: yes" travelled, the
   signature, holder binding, revocation, algorithm and issuer were checked.

Today it is one centred card with two dropdowns and a cloud of chips; the
verification detail the service already returns is barely shown, copy-paste
(a required PRD method) has no button, and "accepts" lists all six showcase
issuers, including ones that cannot vouch for age.

## Goals

- Two-column layout: **The service** (left) and **Behind the scenes** (right).
- All three presentation methods visible together while waiting: QR code,
  **Open in wallet** (same device), **Copy link** (copy-paste).
- Every state of a check rendered in both columns (table below).
- **English, French, Portuguese, Spanish**, switchable on the page.
- Visual structure taken from the reference dashboards (white cards, thin
  borders, small uppercase section labels, big-number hierarchy, status pills,
  legends) — the structure, not their look.
- A neutral, country-agnostic look a country can rebrand in one line: one
  `--accent` colour variable, the service name in the header, "Powered by
  Sunbird RC" in the footer.

## Non-goals

- No change to the bank and education pages.
- No new decisions in the page: APPROVED/DENIED still arrives decided from the
  verifier service.
- Mobile verifier app (`services/verifier-mobile`) is not part of this.
- No short-code copy-paste yet (pending Anand on where Brazil implemented it);
  "Copy link" copies the full `openid4vp://` request.

## Anti-goals (would make this a failure even if it works)

- A page that *looks* like it verified something it only displayed — every
  tick on the right must come from the service's response, never be drawn by
  default.
- Translations that change meaning ("eligible" vs "approved", "not over 16" vs
  "under 16" are not interchangeable in a legal context).
- A QR code that got smaller or denser to fit the new layout (the Galaxy A05
  lessons in the current code stay: whole-pixel modules, viewBox, enlarge).

## Constraints

- Static page, no build step, no new dependencies (nginx serves the folder).
- Does NOT use the Sunbird look (user's call, 2026-11-26). The page stops
  loading the shared `web-assets/styles.css` and gets its own
  `services/verifier-web/age.css`: off-white page, white cards with thin slate
  borders, slate text, one calm-blue `--accent` for actions, green / amber / red
  only for outcomes, system UI font stack (no font file; good coverage for
  EN/FR/PT/ES; works offline).
- Talks only to `/api/verifier` (policy, sessions, cancel), as today.
- Everything from the server rendered as text, never markup (as today).
- Element `#qr[data-session-id]` stays, for the scripted wallet and demo capture.

## Approaches

| | Approach | Trade-off | |
|---|---|---|---|
| A | **Rework the static page** with its own stylesheet | Fits the project's no-build rule; nothing new to deploy | **Chosen** |
| B | React/Vite single-page app | Build step, `node_modules`, a container, for one page; more for a country team to deploy and audit | Rejected |
| C | Restyle the shared `styles.css` | Silently changes the bank and education demos | Rejected |

## Layout

```
┌ ▣ Age-restricted service · Demo                       [EN|FR|PT|ES] ┐
│                                                                         │
│ ┌ THE SERVICE ──────────────────────┐ ┌ BEHIND THE SCENES ────────────┐ │
│ │ Prove you are over 16             │ │ WHAT WE ASK                    │ │
│ │ Minimum age   [ 16+ | 18+ ]       │ │  ageOver16          requested  │ │
│ │ Your wallet   [ OpenID | Inji ]   │ │  date of birth ·name ·ageOver18│ │
│ │ [ Start age check ]               │ │                    not asked   │ │
│ │ ┌───────────┐ ● Waiting   4:52    │ │ ACCEPTED ISSUER                │ │
│ │ │    QR     │ [Open in wallet]    │ │  National Identity Authority   │ │
│ │ │           │ [Copy link]         │ │ VERIFICATION      (live)       │ │
│ │ └───────────┘ [Enlarge] [Cancel]  │ │  ✓ issuer signature            │ │
│ │                                   │ │  ✓ holder signature · nonce    │ │
│ │ ┌ RESULT ───────────────────────┐ │ │  ✓ holder binding · not revoked│ │
│ │ │ ✓ APPROVED   over 16          │ │ │  ✓ algorithm ES256 · trusted   │ │
│ │ └───────────────────────────────┘ │ │ WHAT WAS SHARED                │ │
│ └───────────────────────────────────┘ │  ageOver16 = true              │ │
│                                       └────────────────────────────────┘ │
│ footer: synthetic data · decision made by the verifier · Powered by Sunbird RC │
└─────────────────────────────────────────────────────────────────────────┘
```

Below ~900px wide the columns stack (service first). The segmented controls
replace the two `<select>`s; both are disabled once a check starts.

## States

| State (from service) | The service (left) | Behind the scenes (right) |
|---|---|---|
| idle | Rule + wallet choice, Start button | What we ask / not asked; accepted issuer; verification steps listed as *pending* (grey) |
| waiting | QR + Open in wallet + Copy link + countdown; Enlarge, Cancel | Same, header pill "Waiting for wallet" |
| decided APPROVED | Green result card "Over 16 — approved" | Every check ✓; algorithm(s); issuer name; shared `ageOver16 = true`; withheld list |
| decided DENIED | Amber card "Not over 16 — denied" (verified answer, not an error) | Same as approved, shared `ageOver16 = false` |
| rejected | Red card "Could not verify" + failed step in plain words | Checks up to the failure ✓, failed one ✗ and named, rest grey; nothing listed as shared |
| declined | Neutral card "You declined — nothing was shared" | All steps grey; "Nothing was shared" |
| cancelled / expired | Neutral card, matching wording | All steps grey; "Nothing was shared" |

Verification step names map from the service's check keys:
`credentialSignatures`→issuer signature, `holderSignature`+`nonce`+`audience`→holder
signature, `holderBinding`, `revocation`→not revoked, `dcql`/`pex`→matches the
request, `algorithm`→approved algorithm, plus trust (issuer on allowlist) and
disclosure (exactly what was asked), which the service reports through
`state`/`reason`. Unknown keys still show, by their raw name.

## Languages

- Switch in the header; initial choice from `?lang=`, then the browser
  language, then English; remembered in `localStorage`.
- All page strings live in one table in `i18n.js` keyed by message id, with
  `{threshold}`-style placeholders; `<html lang>` follows the choice.
- Server `reason` text is English. The page builds its own sentence from the
  structured fields (`state`, `decision`, `threshold`, `failedCheck`) and shows
  the service's English reason underneath as "Technical detail".
- Claim names (`ageOver16`) and issuer names stay as-is in every language.
- French, Portuguese and Spanish are written by me; they should be checked by a
  native speaker before the country demos (flagged in the page footer comment
  and the PR).

## One small service change

`GET /api/verifier/age/policy` → `trustedIssuers` lists only issuers whose trust
entry covers the age credential (`credentials` includes
"Age Verification Credential"), instead of all six. Unit-tested.

## Left to the builder

Exact spacing and type scale, the exact accent and outcome hues, icons (inline
SVG, no icon library), the copy-link confirmation ("Copied"), and how the
step list animates in (respecting `prefers-reduced-motion`).

## Verification

- Unit: i18n table has every key in all four languages; placeholder sets match;
  check-key → step mapping; age policy filter.
- Headless-Chrome screenshots of each state in each language at 1440px and
  390px, reviewed before deployment; then redeploy the static folder on dev
  (no image rebuild needed).
