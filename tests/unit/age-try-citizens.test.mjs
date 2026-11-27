// The public "try it yourself" test citizens. What breaks if this fails: a
// stranger's typed input reaches the registry unchecked, a credential outlives
// the demo, or the cleanup deletes a real (seeded) citizen.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTryRequest,
  newTryCitizenId,
  tryCitizenCreatedAt,
  tryExpiration,
  createTryHandler,
  cleanupTryCitizens,
  TRY_WALLET_FORMATS,
} from '../../services/age-issuer/src/try-citizens.mjs';

const NOW = new Date('2026-11-27T10:00:00Z');
const ok = { name: 'Ana Ribeiro', dateOfBirth: '2010-03-14', wallet: 'paradym' };

test('wallets map to the formats they hold', () => {
  assert.deepEqual(TRY_WALLET_FORMATS, { paradym: 'vc+sd-jwt', inji: 'ldp_vc' });
});

test('a valid request passes, trimmed', () => {
  assert.deepEqual(validateTryRequest({ ...ok, name: '  Ana Ribeiro ' }, NOW), { ok: true, value: ok });
});

test("names: letters of any script, spaces and .'- only, 1–60 chars", () => {
  assert.equal(validateTryRequest({ ...ok, name: "Zoë O'Neil-Dubois Jr." }, NOW).ok, true);
  assert.equal(validateTryRequest({ ...ok, name: 'Ηλέκτρα' }, NOW).ok, true);
  for (const name of ['', 'x'.repeat(61), '<img src=x onerror=alert(1)>', 'Ana1', 'a\nb']) {
    assert.deepEqual(validateTryRequest({ ...ok, name }, NOW).field, 'name', name);
  }
});

test('dates: strict calendar dates from 1900-01-01 to today', () => {
  assert.equal(validateTryRequest({ ...ok, dateOfBirth: '2026-11-27' }, NOW).ok, true);
  assert.equal(validateTryRequest({ ...ok, dateOfBirth: '2008-02-29' }, NOW).ok, true);
  for (const d of ['2010-02-30', '2026-11-28', '1899-12-31', '14/03/2010', '', undefined]) {
    assert.equal(validateTryRequest({ ...ok, dateOfBirth: d }, NOW).field, 'dateOfBirth', String(d));
  }
});

test('wallet must be paradym or inji', () => {
  for (const wallet of ['sdk', 'openid', '', undefined]) {
    assert.equal(validateTryRequest({ ...ok, wallet }, NOW).field, 'wallet');
  }
});

test('ids are TRY- prefixed and carry their creation time', () => {
  const id = newTryCitizenId(NOW);
  assert.match(id, /^TRY-[0-9A-Z]+-[0-9A-Z]{4}$/);
  assert.equal(tryCitizenCreatedAt(id).getTime(), NOW.getTime());
  assert.equal(tryCitizenCreatedAt('AGE-000001'), null);
});

test('expiry: 7 days unless a birthday flips an answer sooner', () => {
  assert.equal(tryExpiration('1990-01-01', NOW), '2026-12-04T10:00:00.000Z');
  // Turns 18 on 2026-11-29: the credential expires then, not in 7 days.
  assert.equal(tryExpiration('2008-11-29', NOW), '2026-11-29T00:00:00.000Z');
});

test("handler: creates the citizen, issues in the wallet's format, returns only what the page needs", async () => {
  const created = [];
  const issued = [];
  const handle = createTryHandler({
    registry: { createCitizen: async (r) => created.push(r), countTryCitizens: async () => 0 },
    issueOffer: async (id, format, opts) => {
      issued.push({ id, format, opts });
      return { status: 201, body: { offerId: 'o1', qrData: 'openid-credential-offer://x' } };
    },
    now: () => NOW,
  });
  const res = await handle({ ...ok, wallet: 'inji' });
  assert.equal(res.status, 201);
  assert.match(res.body.citizenId, /^TRY-/);
  assert.deepEqual(created[0], { citizenId: res.body.citizenId, name: 'Ana Ribeiro', dateOfBirth: '2010-03-14' });
  assert.equal(issued[0].format, 'ldp_vc');
  assert.equal(issued[0].opts.expirationDate, tryExpiration('2010-03-14', NOW));
  assert.deepEqual(Object.keys(res.body).sort(), [
    'ageOver16',
    'ageOver18',
    'citizenId',
    'expirationDate',
    'offerId',
    'qrData',
  ]);
  assert.equal(res.body.ageOver16, true);
  assert.equal(res.body.ageOver18, false);
});

test('handler: 400 names the field; 503 demo_busy at the cap; nothing written', async () => {
  const created = [];
  const reg = (n) => ({ createCitizen: async (r) => created.push(r), countTryCitizens: async () => n });
  const bad = await createTryHandler({ registry: reg(0), issueOffer: async () => {}, now: () => NOW })({
    ...ok,
    dateOfBirth: '2010-02-30',
  });
  assert.deepEqual([bad.status, bad.body.error, bad.body.field], [400, 'invalid_request', 'dateOfBirth']);
  const busy = await createTryHandler({ registry: reg(1000), issueOffer: async () => {}, now: () => NOW })(ok);
  assert.deepEqual([busy.status, busy.body.error], [503, 'demo_busy']);
  assert.equal(created.length, 0);
});

test('cleanup deletes only TRY- citizens older than 24 h', async () => {
  const old = newTryCitizenId(new Date(NOW - 25 * 3600e3));
  const fresh = newTryCitizenId(new Date(NOW - 1 * 3600e3));
  const deleted = [];
  const n = await cleanupTryCitizens({
    now: NOW,
    registry: {
      listTryCitizens: async () => [
        { osid: 'a', citizenId: old },
        { osid: 'b', citizenId: fresh },
        { osid: 'c', citizenId: 'AGE-000001' },
      ],
      deleteCitizen: async (osid) => deleted.push(osid),
    },
  });
  assert.equal(n, 1);
  assert.deepEqual(deleted, ['a']);
});

test('names in scripts with combining marks, and decomposed accents, are accepted', () => {
  for (const name of ['प्रिया शर्मा', 'Jo\u0061\u0303o Silva', 'தமிழ் செல்வி']) {
    const res = validateTryRequest({ ...ok, name }, NOW);
    assert.equal(res.ok, true, name);
    assert.equal(res.value.name, name.normalize('NFC'));
  }
  assert.equal(validateTryRequest({ ...ok, name: '\u0303Ana' }, NOW).field, 'name');
});

test('cleanup keeps a test citizen for 2 hours only by default', async () => {
  const deleted = [];
  const registry = {
    listTryCitizens: async () => [
      { osid: 'old', citizenId: newTryCitizenId(new Date(NOW - 2.5 * 3600e3)) },
      { osid: 'new', citizenId: newTryCitizenId(new Date(NOW - 1.5 * 3600e3)) },
    ],
    deleteCitizen: async (osid) => deleted.push(osid),
  };
  await cleanupTryCitizens({ now: NOW, registry });
  assert.deepEqual(deleted, ['old']);
});
