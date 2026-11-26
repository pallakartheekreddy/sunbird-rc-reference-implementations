# Age Verifier Page Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild `/verifier/` as a two-column, four-language reference page — the service on the left, a live "behind the scenes" verification panel on the right — in a neutral look a country can rebrand.

**Architecture:** Static page, ES modules, no build step. Two pure modules carry the logic that can be unit-tested in Node (`i18n.js`: messages + language choice; `steps.js`: service result → verification-step statuses); `app.js` is DOM wiring only. One small verifier-service change narrows the age policy's issuer list.

**Tech Stack:** Vanilla HTML/CSS/ES modules, `node --test`, headless Chrome for screenshots.

**Spec:** `docs/superpowers/specs/2026-11-26-age-verifier-ui-design.md`

## Global Constraints

- No build step, no new dependencies; nginx serves `services/verifier-web` as-is.
- Page no longer loads `/assets/styles.css`; its own `services/verifier-web/age.css`. Bank and education pages untouched.
- One `--accent` CSS variable for actions; green / amber / red only for outcomes; system UI font stack.
- Languages exactly `en`, `fr`, `pt`, `es`; claim names (`ageOver16`) and issuer names never translated.
- Talks only to `/api/verifier`; everything from the server rendered with `textContent`, never `innerHTML` — except `qrSvg`, which the service generates (as today).
- `#qr` keeps `data-session-id` (scripted wallet / demo capture).
- Footer carries "Powered by Sunbird RC".

## Review Focus

1. Portuguese/French strings are ~30% longer than English — buttons, segmented controls and pills must not overflow at 390px. → Task 4 screenshot check in `pt` at 390px.
2. Clipboard API unavailable (non-secure context, permission denied) — "Copy link" must still give the user the link. → Task 4: `copyText()` falls back to selecting a visible read-only field; test in Task 4 Step 1.
3. `?lang=xx`, a stored unknown language, or `navigator.languages` like `pt-BR` / `es-419` — must resolve to a supported language, defaulting to `en`. → Task 1 tests.
4. A rejection the step map cannot attribute (new server reason) — must still show a failure, never all-green. → Task 2 test "unattributed rejection fails the decision step".
5. The QR must not shrink in the two-column layout — module pitch is what makes it scannable. → Task 4: `.qr` min width 320px; screenshot check at 1440px.

---

### Task 1: Messages and language choice

**Files:**
- Create: `services/verifier-web/i18n.js`
- Test: `tests/unit/verifier-web-i18n.test.mjs`

**Interfaces:**
- Produces:
  - `LANGS: ['en','fr','pt','es']`
  - `MESSAGES: Record<lang, Record<key, string>>`
  - `t(lang: string, key: string, params?: Record<string, string|number>): string` — `{name}` placeholders; falls back to `en`, then to the key itself.
  - `pickLang({ query?: string|null, stored?: string|null, browser?: readonly string[] }): string` — first supported of query, stored, each browser tag's primary subtag; else `'en'`.
  - Message keys used by Task 4 (all four languages): `app.title`, `app.service`, `lede`, `rule.label`, `wallet.label`, `wallet.openid`, `wallet.inji`, `start`, `waiting`, `secondsLeft` (`{s}`), `openWallet`, `copyLink`, `copied`, `copyFallback`, `enlarge`, `shrink`, `cancel`, `again`, `behind`, `ask.title`, `ask.requested`, `ask.notAsked`, `ask.dob`, `ask.name`, `issuer.title`, `steps.title`, `shared.title`, `shared.nothing`, `withheld`, `algorithms`, `result.approved` (`{t}`), `result.denied` (`{t}`), `result.rejected`, `result.declined`, `result.cancelled`, `result.expired`, `reason.approved` (`{t}`), `reason.denied` (`{t}`), `reason.declined`, `reason.cancelled`, `reason.expired`, `reason.failed` (`{step}`), `technical`, `step.request`, `step.issuerSignature`, `step.holderSignature`, `step.holderBinding`, `step.revocation`, `step.algorithm`, `step.trust`, `step.disclosure`, `step.decision`, `status.pending`, `status.ok`, `status.fail`, `footer.synthetic`, `footer.decision`, `footer.powered`, `lang.label`.

- [ ] **Step 1: Write the failing tests**

```js
test('every language has exactly the English keys', () => {
  for (const lang of LANGS) assert.deepEqual(Object.keys(MESSAGES[lang]).sort(), Object.keys(MESSAGES.en).sort(), lang);
});
test('placeholders match English in every language', () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const lang of LANGS) for (const [k, v] of Object.entries(MESSAGES.en)) assert.deepEqual(ph(MESSAGES[lang][k]), ph(v), `${lang}.${k}`);
});
test('no empty translations', () => { for (const lang of LANGS) for (const [k, v] of Object.entries(MESSAGES[lang])) assert.ok(v.trim(), `${lang}.${k}`); });
test('t fills placeholders and falls back', () => {
  assert.equal(t('en', 'result.approved', { t: 16 }).includes('16'), true);
  assert.equal(t('xx', 'start'), MESSAGES.en.start);
  assert.equal(t('fr', 'no.such.key'), 'no.such.key');
});
test('pickLang order and normalisation', () => {
  assert.equal(pickLang({ query: 'pt', stored: 'fr', browser: ['es'] }), 'pt');
  assert.equal(pickLang({ query: 'xx', stored: 'fr' }), 'fr');
  assert.equal(pickLang({ browser: ['pt-BR', 'en'] }), 'pt');
  assert.equal(pickLang({ browser: ['es-419'] }), 'es');
  assert.equal(pickLang({ query: 'de', stored: 'it', browser: ['ja'] }), 'en');
  assert.equal(pickLang({}), 'en');
});
```

- [ ] **Step 2: Run, expect FAIL** — `node --test tests/unit/verifier-web-i18n.test.mjs` → cannot find module.
- [ ] **Step 3: Implement `i18n.js`** with the keys above. Copy rules: approved = "Over {t} — approved"; denied = "Not over {t} — denied" (never "under {t}"); a denial is a verified answer, not an error. FR/PT/ES written carefully; file header notes "translations to be checked by a native speaker".
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(verifier-web): messages in English, French, Portuguese and Spanish`.

### Task 2: Verification steps from a service result

**Files:**
- Create: `services/verifier-web/steps.js`
- Test: `tests/unit/verifier-web-steps.test.mjs`

**Interfaces:**
- Produces:
  - `STEP_IDS: ['request','issuerSignature','holderSignature','holderBinding','revocation','algorithm','trust','disclosure','decision']`
  - `stepStatuses(result: {state?: string, checks?: Record<string,string>, failedCheck?: string, reason?: string}): Array<{id: string, status: 'pending'|'ok'|'fail'}>`
  - `extraChecks(checks: Record<string,string>): string[]` — check keys no step covers (shown raw).
- Check-key mapping: `request` ← `dcql` or `pex`; `issuerSignature` ← `credentialSignatures`; `holderSignature` ← `holderSignature`, `nonce`, `audience` (all); `holderBinding` ← `holderBinding`; `revocation` ← `revocation`; `algorithm` ← `algorithm`.
- Rules: `decided` → all `ok`. `rejected` → mapped steps from checks (`OK`→ok, present-not-OK→fail, absent→pending); `failedCheck==='algorithm'` → algorithm fail; otherwise reason attributes the failure: `/allowlist|issuer identifier/` → trust, `/claims|not of type|matched no/` → disclosure; if no step is `fail` after that, `decision` is `fail`. Steps after the first `fail` are `pending`. Any other state → all `pending`.

- [ ] **Step 1: Write the failing tests**

```js
const ALL = { holderSignature:'OK', nonce:'OK', audience:'OK', credentialSignatures:'OK', holderBinding:'OK', revocation:'OK', dcql:'OK', algorithm:'OK' };
const st = (r) => Object.fromEntries(stepStatuses(r).map((s) => [s.id, s.status]));
test('decided: every step ok', () => assert.ok(Object.values(st({ state:'decided', checks: ALL })).every((s) => s === 'ok')));
test('waiting / declined / expired: every step pending', () => { for (const state of ['waiting','declined','cancelled','expired', undefined]) assert.ok(Object.values(st({ state })).every((s) => s === 'pending'), String(state)); });
test('pex satisfies the request step', () => { const { dcql, ...rest } = ALL; assert.equal(st({ state:'decided', checks:{ ...rest, pex:'OK' } }).request, 'ok'); });
test('untrusted issuer fails trust, later steps pending', () => {
  const s = st({ state:'rejected', checks: ALL, reason:'issuer is not in the demo trust allowlist' });
  assert.equal(s.trust, 'fail'); assert.equal(s.revocation, 'ok'); assert.equal(s.disclosure, 'pending'); assert.equal(s.decision, 'pending');
});
test('over-disclosure fails disclosure', () => assert.equal(st({ state:'rejected', checks: ALL, reason:'presentation disclosed unrequested claims: name' }).disclosure, 'fail'));
test('algorithm rejection fails algorithm', () => assert.equal(st({ state:'rejected', checks:{ ...ALL, algorithm: undefined }, failedCheck:'algorithm' }).algorithm, 'fail'));
test('failed upstream check fails its step', () => assert.equal(st({ state:'rejected', checks:{ ...ALL, revocation:'NOK' }, failedCheck:'revocation' }).revocation, 'fail'));
test('unattributed rejection fails the decision step, never all-green', () => {
  const s = st({ state:'rejected', checks: ALL, reason:'something new' }); assert.equal(s.decision, 'fail');
});
test('extraChecks lists unmapped keys', () => assert.deepEqual(extraChecks({ ...ALL, mdocDeviceAuth:'OK' }), ['mdocDeviceAuth']));
```

- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement `steps.js`** per the mapping and rules above.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `feat(verifier-web): derive verification steps from the service result`.

### Task 3: Age policy lists only issuers that vouch for age

**Files:**
- Modify: `services/verifier/src/core/trust.mjs` (add export), `services/verifier/src/server.mjs` (age `policy()`)
- Test: `tests/unit/trust.test.mjs`

**Interfaces:**
- Produces: `issuersFor(issuers: Array<{name: string, credentials: string[]}>, credentialName: string): Array<{name, credentials}>`
- Server: `AGE_CREDENTIAL_NAME = process.env.AGE_CREDENTIAL_NAME || 'Age Verification Credential'`; age `policy().trustedIssuers = issuersFor(trust.issuers, AGE_CREDENTIAL_NAME).map((i) => i.name)`. Trust *checking* is unchanged.

- [ ] **Step 1: Failing test** `issuersFor keeps only issuers whose credentials include the name`: with the six names from `config/trust/issuers.json`, `issuersFor(list, 'Age Verification Credential').map(i=>i.name)` deep-equals `['National Identity Authority']`; an issuer with no `credentials` is excluded.
- [ ] **Step 2: Run** `node --test tests/unit/trust.test.mjs` → FAIL.
- [ ] **Step 3: Implement** `issuersFor` and use it in the age policy.
- [ ] **Step 4: Run** `npm test` → all pass.
- [ ] **Step 5: Commit** `fix(verifier): the age policy lists only issuers that vouch for age`.

### Task 4: The page

**Files:**
- Rewrite: `services/verifier-web/index.html`, `services/verifier-web/app.js`
- Create: `services/verifier-web/age.css`
- Test: `tests/unit/verifier-web-copy.test.mjs` (for `copyText`)

**Interfaces:**
- Consumes: Task 1 `t`, `pickLang`, `LANGS`; Task 2 `stepStatuses`, `extraChecks`, `STEP_IDS`; service `/policy` (`thresholds`, `defaultThreshold`, `wallets`, `trustedIssuers`, `approvedAlgorithms`) and session bodies (`state`, `decision`, `reason`, `checks`, `issuer`, `threshold`, `disclosed`, `failedCheck`, `diagnostic`, `qrData`, `qrSvg`, `expiresInSeconds`, `sessionId`).
- Produces: `copyText(text: string, { clipboard?, fallback: (text) => void }): Promise<'copied'|'fallback'>` exported from `app.js`'s sibling `copy.js` (pure, testable).

- [ ] **Step 1: Failing test for `copy.js`**: resolves `'copied'` when `clipboard.writeText` resolves; `'fallback'` and calls `fallback(text)` when `clipboard` is undefined or `writeText` rejects.
- [ ] **Step 2: Run, expect FAIL; implement `services/verifier-web/copy.js`; run, expect PASS.**
- [ ] **Step 3: `index.html`** — `<script type="module" src="app.js">`, `<link rel="stylesheet" href="age.css">` only. Header: service name + `[EN FR PT ES]` segmented control. Main grid: `section#service` (title with `.age-threshold`, segmented `#rule` and `#wallet`, `#start`, waiting block with `#qr[data-session-id]`, `#open-wallet`, `#copy-link`, read-only `#link-field` (hidden until fallback), `#enlarge`, `#cancel`, countdown; result card `#result`, `#again`) and `section#behind` (What we ask; Accepted issuer; Verification steps list built from `STEP_IDS`; What was shared; Algorithms; Technical detail). Every visible string has `data-i18n="key"`.
- [ ] **Step 4: `age.css`** — tokens: `--bg #f6f7f9`, `--card #fff`, `--line #e3e6eb`, `--text #1d2330`, `--muted #5f6b7a`, `--accent #2453d6`, `--ok #13865a`, `--warn #b26a00`, `--bad #c2352b`; system UI font stack; cards radius 12px, 1px border; uppercase 11px letter-spaced section labels; pills; two columns ≥900px (`minmax(0,1.1fr) minmax(0,1fr)`), stacked below; `.qr` min width 320px, keeps `body.qr-large` behaviour; `prefers-reduced-motion` disables step transitions; buttons wrap text, no fixed widths.
- [ ] **Step 5: `app.js`** — language from `pickLang({query, stored: localStorage, browser: navigator.languages})`, persisted on change, sets `<html lang>`, re-renders all `[data-i18n]` and the current state. Policy → rule/wallet controls (wallet control hidden unless `wallets` has `inji`), "What we ask" (requested `ageOver{t}`; not asked: date of birth, name, other thresholds), issuer list. Start → `POST /sessions?threshold=&wallet=`, waiting block, poll every 1500 ms (unchanged semantics incl. 404→expired, cancel → `POST /sessions/{id}/cancel`). Result card text built from `t()` with structured fields; service `reason`/`diagnostic` shown under "Technical detail" in English. Steps list from `stepStatuses(body)`; `extraChecks` appended raw. Shared: `disclosed` key=value, plus withheld list; nothing-shared states show `shared.nothing`. Copy link uses `copyText` with fallback revealing and selecting `#link-field`.
- [ ] **Step 6: Screenshot check** — local harness (scratchpad, not committed): static server for `services/verifier-web` + stub `/api/verifier` returning policy and a scenario chosen by query. Headless Chrome at 1440×1000 and 390×1600 for: idle, waiting, approved (16), denied (16), rejected-trust, declined, expired — in `en` and `pt`; plus approved in `fr`, `es`. Expected: no overflow, QR ≥ 320px wide at 1440, all-pending steps in non-result states, ✗ on the right step for rejected.
- [ ] **Step 7: `npm test`** → all pass. **Commit** `feat(verifier-web): two-column age check in four languages`.

### Task 5: Deploy to dev

- [ ] **Step 1:** Push `feat/age-inji-pex`; on dev `git -C ~/age-verification/showcase pull --ff-only`.
- [ ] **Step 2:** `docker compose -f docker-compose.yml -f ../../compose.dev.yml up -d --build verifier` (Task 3); page is a bind mount, no rebuild.
- [ ] **Step 3:** From outside: `https://age.98.70.36.106.sslip.io/verifier/` → 200; `/api/verifier/policy` `trustedIssuers == ["National Identity Authority"]`; headless screenshot of the live page in `en` and `pt`.
