// The age page in four languages. What breaks for a reader if these fail: a
// key missing in one language shows a raw message id on screen; a placeholder
// dropped in translation shows "Over — approved" with no age in it.

import test from 'node:test';
import assert from 'node:assert/strict';
import { LANGS, MESSAGES, t, pickLang } from '../../services/verifier-web/i18n.js';

test('exactly the four languages', () => {
  assert.deepEqual(LANGS, ['en', 'fr', 'pt', 'es']);
});

test('every language has exactly the English keys', () => {
  for (const lang of LANGS) {
    assert.deepEqual(Object.keys(MESSAGES[lang]).sort(), Object.keys(MESSAGES.en).sort(), lang);
  }
});

test('placeholders match English in every language', () => {
  const ph = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(MESSAGES.en)) assert.deepEqual(ph(MESSAGES[lang][k]), ph(v), `${lang}.${k}`);
  }
});

test('no empty translations', () => {
  for (const lang of LANGS) {
    for (const [k, v] of Object.entries(MESSAGES[lang])) assert.ok(v.trim(), `${lang}.${k}`);
  }
});

test('t fills placeholders and falls back', () => {
  assert.match(t('en', 'result.approved', { t: 16 }), /16/);
  assert.match(t('pt', 'result.denied', { t: 18 }), /18/);
  assert.equal(t('xx', 'start'), MESSAGES.en.start);
  assert.equal(t('fr', 'no.such.key'), 'no.such.key');
});

test('pickLang: query, then stored, then browser, then English', () => {
  assert.equal(pickLang({ query: 'pt', stored: 'fr', browser: ['es'] }), 'pt');
  assert.equal(pickLang({ query: 'xx', stored: 'fr' }), 'fr');
  assert.equal(pickLang({ browser: ['pt-BR', 'en'] }), 'pt');
  assert.equal(pickLang({ browser: ['es-419'] }), 'es');
  assert.equal(pickLang({ query: 'FR' }), 'fr');
  assert.equal(pickLang({ query: 'de', stored: 'it', browser: ['ja'] }), 'en');
  assert.equal(pickLang({}), 'en');
});

test('the keys the page uses all exist', () => {
  const used = ['app.service', 'lede', 'rule.label', 'wallet.label', 'wallet.openid', 'wallet.inji', 'start', 'waiting',
    'secondsLeft', 'openWallet', 'copyLink', 'copied', 'copyFallback', 'enlarge', 'shrink', 'cancel', 'again', 'behind',
    'ask.title', 'ask.requested', 'ask.notAsked', 'ask.dob', 'ask.name', 'issuer.title', 'steps.title', 'shared.title',
    'shared.nothing', 'withheld', 'algorithms', 'result.approved', 'result.denied', 'result.rejected', 'result.declined',
    'result.cancelled', 'result.expired', 'reason.approved', 'reason.denied', 'reason.declined', 'reason.cancelled',
    'reason.expired', 'reason.failed', 'technical', 'step.request', 'step.issuerSignature', 'step.holderSignature',
    'step.holderBinding', 'step.revocation', 'step.algorithm', 'step.trust', 'step.disclosure', 'step.decision',
    'status.pending', 'status.ok', 'status.fail', 'footer.synthetic', 'footer.decision', 'footer.powered', 'lang.label'];
  for (const key of used) assert.ok(key in MESSAGES.en, key);
});

test('a step marked passed never reuses the decision words', () => {
  // On a DENIED result the panel shows nine "passed" labels next to the verdict;
  // in Portuguese "aprovado" there read as nine approvals beside "negado".
  for (const lang of LANGS) {
    const ok = MESSAGES[lang]['status.ok'].toLowerCase();
    for (const key of ['result.approved', 'result.denied']) {
      assert.ok(!MESSAGES[lang][key].toLowerCase().includes(ok), `${lang}: status.ok "${ok}" appears in ${key}`);
    }
  }
});

test('messages for a check that could not start, and a failure at the decision', () => {
  for (const key of ['result.unavailable', 'reason.unavailable', 'reason.failedDecision']) assert.ok(key in MESSAGES.en, key);
  // "failed at: Decision. No decision was made." contradicts itself.
  assert.doesNotMatch(MESSAGES.en['reason.failedDecision'], /\{step\}/);
});
