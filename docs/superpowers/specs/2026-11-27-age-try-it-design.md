# "Try it yourself": self-serve age verification demo — design

**Date:** 27 Nov 2026 · **Branch:** `feat/age-inji-pex` · **Status:** reviewed, awaiting approval

## Why

The current demo needs a presenter, a prepared phone and an operator port. Country teams
who find the link cannot experience it alone. The model is Pramax's "enter your number →
your phone rings": the visitor makes the thing happen to **themselves**, on **their own
phone**, in a few minutes.

Success: a country-team member, unattended, on their own phone, within ~5 minutes:
1. becomes a test citizen,
2. receives an age credential in a wallet they installed from an app store,
3. gets into (or is refused by) an age-restricted site, and sees that the site never
   learned their name or date of birth.

## Goals, non-goals, anti-goals

| Goals | Non-goals | Anti-goals (a failure even if it works) |
|---|---|---|
| Self-serve, public, no help needed | Real identities, real phone numbers, SMS/OTP | Looking like a self-declared age gate ("type your birthday, you're in") |
| Works with an app-store wallet (Paradym) | Production-grade abuse protection | Storing visitor data beyond 24 h, or showing one visitor another's data |
| The PRD's own use cases (social media 16+, age-restricted products 18+) | Accounts, login, analytics | Hiding the real components behind demo-only code paths |
| EN / FR / PT / ES, like the existing verifier page | New core (`age_verifier`) changes, unless the wallet check (Phase 0) forces one | |

## Decisions taken (by Kartheek, 27 Nov)

- **Audience:** country teams, on their own phones, public and unattended.
- **Where the date of birth comes from:** option C. A **random test citizen with an
  editable date of birth**, labelled "pretend you are this citizen; in a real deployment
  this record comes from the national registry". The record **is written to the registry**
  and the credential is issued from it, so the real issuance path runs.
- **How:** approach 1, extend existing services. No new service.
- **Build now**, in parallel with Anand's answer on offer-QR issuance (plan B2). Without
  the QR there is no app-store self-serve demo, so a "no" would drop the demo rather than
  change how it is built.
- **Home: dev only** (`https://age.98.70.36.106.sslip.io/try/`). No sandbox deployment in
  this work; hardening is sized for a shared dev host (rate limit, cap, 24 h cleanup).

## Approaches considered

| Approach | Trade-off | Outcome |
|---|---|---|
| **1. Extend existing services** (age-issuer, verifier, verifier-web, nginx) | Smallest change; the demo runs on the real components | **Chosen** |
| 2. Separate "playground" service with its own database | Cleaner separation, but a second copy of the citizen logic, for a demo | Rejected |
| 3. Skip the registry; put the typed DOB straight into the offer | Simplest, but becomes self-declared age, which breaks the "authoritative source" message | Rejected |

## Phase 0: store-wallet check (gate, before any build)

Paradym has only been proven on a device with **our own build** (`6d4fd6d`, a fork with
the issuer URL baked in). Public visitors install the **store** build.

Run on a phone with Paradym from Google Play, against dev (`https://age.98.70.36.106.sslip.io`):
1. An SD-JWT credential offer for a seeded citizen, created from the operator port: scan → accepted?
2. `/verifier/?wallet=openid&age=18` (DCQL): scan → consent screen → APPROVED?

| Result | Then |
|---|---|
| Both pass | Paradym is the default wallet. Build as designed |
| Offer fails | Find out why (trust list, metadata, format) before building. If not fixable on our side, stop and bring it back to Kartheek: the design's main promise depends on it |
| Verify fails | Same |

Record the app version and the result in the plan's test matrix (B1).

**Result, 27 Nov: PASSED.** Paradym **1.24.0 from Google Play** (installer
`com.android.vending`), Samsung Galaxy A05, against dev: SD-JWT offer for `AGE-000001`
accepted; `/verifier/?wallet=openid&age=18` → "Over 18 — approved". No custom build needed.

## What the visitor sees

One public page, `/try/` (same visual language as `/verifier/`: two columns, a language switch).

```
┌ Try age verification ──────────────────────┐ ┌ LIVE ──────────────────────────────┐
│ 1  Become a test citizen    ⟳ new citizen  │ │ Step 1 of 3                         │
│    Name          [ Ana Ribeiro         ]   │ │ "Pretend you are Ana. In a real     │
│    Date of birth [ 2010-03-14 ]  → 16: yes │ │  deployment this record comes from  │
│                                   18: no   │ │  the national registry."            │
│    Wallet  (•) Paradym  ( ) Inji           │ │                                     │
│    [ Get my credential ]                   │ │  ▣ QR / "Open in wallet" (phone)    │
│                                            │ │  Waiting for your wallet…           │
│ 2  Use it at an age-restricted site        │ │  ✓ Credential received              │
│    [ SocialApp: sign up (16+) ]            │ │                                     │
│    [ ShopNow: buy (18+) ]                  │ │                                     │
│ 3  What the site learned → (panel)         │ │                                     │
└────────────────────────────────────────────┘ └─────────────────────────────────────┘
 Recent checks (anyone, last 24 h, no personal data)
 time   site        asked  wallet   result    checks
 12:04  ShopNow     18+    Paradym  refused   9/9 passed — holder is under 18
 11:58  SocialApp   16+    Inji     allowed   9/9 passed
```

- **Wallet choice:** Paradym (default, app store, with store links) or Inji Wallet
  (marked "advanced: Android APK", linking MOSIP's end-user guide on docs.inji.io, which
  is where the collab build `io.mosip.inji.collab` 1.0.0-alpha.1 that passed on 26 Nov came
  from). The choice sets the credential format: Paradym → SD-JWT; Inji → `ldp_vc`.
- **No Brazil SDK app option for now** *(Kartheek, 27 Nov)*. The SDK app collects
  credentials only by signing in through Keycloak (no credential-offer handling), and a
  `TRY-` citizen has no Keycloak account. **Later option (preferred, agreed shape):** give
  each test citizen a temporary Keycloak login linked by the `citizenId` attribute, created
  and deleted with the citizen, plus a public APK download under `/try/downloads/`. No app
  changes needed. Not part of this work.
- **On a phone:** "Open in wallet" deep link instead of (and as well as) the QR, same as
  the verifier page today.
- **The two sites** are small branded pages (`/try/social/`, `/try/shop/`) that look like
  a real sign-up and a real checkout, each with one "Verify age with your wallet" button.
  The result is the site's own behaviour: "Welcome to SocialApp" / "Sorry, you must be 16
  or older"; "Order placed" / "This item needs 18+". A "What did the site learn?" link opens
  the existing behind-the-scenes panel (requested vs. not asked, the 9 checks).
- **Refusal on purpose:** the editable date of birth lets the visitor make themselves 15 or
  17 and watch a site refuse; the ⟳ button cycles adult / minor / "turns 18 tomorrow".

## Components and changes

### age-issuer — public "test citizen" endpoint

`POST /try/citizens` `{ name, dateOfBirth, wallet }` →
`{ citizenId, ageOver16, ageOver18, expiresAt, offerId, qrData }`

1. Validate: `name` 1–60 characters, letters, spaces and `.'-` only; `dateOfBirth` an ISO
   date between 1900-01-01 and today; `wallet` ∈ `paradym | inji`.
2. Create an `AgeCitizen` in the registry with `citizenId` `TRY-<random 8>` (the prefix
   marks it as a demo record for cleanup and for the trust panel).
3. Issue an offer through the existing `issueOffer` path, format from the wallet, with
   `expirationDate` = the earlier of the existing birthday-flip rule and **7 days**
   (try-it credentials must not live forever in strangers' wallets).

Served publicly as `/api/try/citizens` (nginx), unlike `POST /offers`, which stays on the
operator port.

**Cleanup:** an interval in age-issuer deletes `TRY-` citizens older than **2 h** through the
registry API (changed from 24 h after review: one rate-limited client could otherwise hold
the 1,000 cap). Credentials already in wallets stay valid until their 7-day expiry.

### Did the wallet collect it? ("✓ Credential received")

The live panel should flip when the wallet redeems the offer. **Open for the builder:**
check whether oid4vc-service already exposes whether an offer's pre-authorised code was
redeemed (e.g. `GET /oid4vc/offer/:id` after redemption). If it does, age-issuer adds
`GET /try/offers/:id` and the page polls it. If it does not, do **not** change core for
this. The page shows "Got it in your wallet? → Continue" instead.

### verifier — "recent checks"

`GET /api/verifier/recent` → the last 50 finished checks from the last 24 h:
`{ at, site, threshold, wallet, outcome, checksPassed, checksTotal, reason }`, where
`wallet` is the verifier's existing family (`openid` shown as "OpenID wallet", `inji` as
"Inji") *(builder's call: no new wallet parameter on the shared API)*. A check is recorded
once, when its session first reaches a final state, not on every poll.

- In memory only, a fixed-size ring buffer: the verifier's DESIGN forbids a durable
  history of holder activity, and this keeps to it. Lost on restart; that is fine.
- No citizen ID, name, date of birth, IP or transaction ID. `site` comes from the session
  request (`social` / `shop` / `verifier`).
- The existing session API gains an optional `site` parameter; nothing else changes.

### verifier-web — the pages

`/try/`, `/try/social/`, `/try/shop/` as static ES modules next to `/verifier/`, reusing
`i18n.js`, `steps.js` and the behind-the-scenes rendering. No build step, as today.

### nginx

- Public: `/try/` static; `POST /api/try/citizens`, `GET /api/try/offers/` → age-issuer.
- `limit_req` on `/api/try/citizens`: 5 per minute per visitor IP, burst 5. On dev the
  age nginx sits behind demo-oid4vc's nginx, which already sends `X-Real-IP`; the age
  nginx uses `set_real_ip_from` (Docker bridge range) + `real_ip_header X-Real-IP`, so no
  change to demo-oid4vc is needed.
- A cap on live `TRY-` citizens (e.g. 1,000) enforced in age-issuer; over it, `503` with
  "demo is busy, try again later".

## Constraints

- Public internet: input validation, rate limit, the cap, no free text echoed unescaped.
- No real data: the page says "demo data only; do not enter your real name or birth date".
- Four languages for every new string. Native-speaker review is already an open question
  for Anand.
- The existing `/verifier/` page and all current tests keep working unchanged.

## Known conflict, settled here

The Iteration 01 note in `age-issuer/src/server.mjs` says issuance must start inside the
wallet, with **no issuance QR**. That was for the earlier showcase. Store Paradym cannot be
pre-configured with our issuer, so a public, app-store-wallet demo needs an offer QR. This
design brings the QR back for `/try/` only, and the plan's open question B2 (Anand: is
offer-QR issuance acceptable?) covers it.

## Also answered during review

- **Inji re-check in Phase 0:** not needed; the collab build passed offer-QR issuance and
  `?wallet=inji` verification on 26 Nov. Re-run it in step 5 through `/try/`.

## Left to the builder

- Persona name lists (international, mixed gender) and the three ⟳ presets.
- Site branding for SocialApp and ShopNow (generic, not resembling real brands).
- Exact copy, within the four-language rule.
- The "received" signal (see above).
- Tests: unit tests for validation, the expiry cap, cleanup selection and the ring buffer;
  an end-to-end run with the scripted wallet (`scripts/wallet.mjs`) through `/try/`.

## Order of work

1. Phase 0 store-Paradym check (with Kartheek's phone).
2. age-issuer endpoint + cleanup + nginx routes.
3. Verifier `site` + recent checks.
4. Pages.
5. Deploy to dev; run all three wallets through `/try/`; record in the B1 matrix.
