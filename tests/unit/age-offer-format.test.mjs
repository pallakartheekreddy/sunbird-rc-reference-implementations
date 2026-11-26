// Which format an age credential offer is made in. What breaks if this fails:
// an Inji-based wallet is offered an SD-JWT it cannot hold, or a caller picks a
// format the schema does not publish and gets an opaque 500 from issuance.

import test from 'node:test';
import assert from 'node:assert/strict';
import { offerFormat, OFFER_FORMATS } from '../../services/age-issuer/src/formats.mjs';

test('the two formats the age credential is published in', () => {
  assert.deepEqual(OFFER_FORMATS, ['vc+sd-jwt', 'ldp_vc']);
});

test('no format asked for: the configured default', () => {
  assert.equal(offerFormat(undefined, 'vc+sd-jwt'), 'vc+sd-jwt');
  assert.equal(offerFormat('', 'ldp_vc'), 'ldp_vc');
});

test('a published format is honoured', () => {
  assert.equal(offerFormat('ldp_vc', 'vc+sd-jwt'), 'ldp_vc');
  assert.equal(offerFormat('vc+sd-jwt', 'ldp_vc'), 'vc+sd-jwt');
});

test('anything else is refused with a 400, not passed through', () => {
  for (const bad of ['jwt_vc_json', 'mso_mdoc', 'LDP_VC', 'ldp_vc ', 42, {}]) {
    assert.throws(() => offerFormat(bad, 'vc+sd-jwt'), (e) => e.status === 400 && /unsupported format/.test(e.message), String(bad));
  }
});
