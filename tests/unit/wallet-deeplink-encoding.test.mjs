import test, { describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * The wallet's post-unlock redirect, encoded in +native-intent.tsx and decoded in
 * authenticate.tsx.
 *
 * The pair was mismatched: encoded with toBase64Url (UNPADDED) and decoded with
 * fromBase64 (REQUIRES padding). So a presentation deeplink opened or died on the
 * LENGTH of its url alone -- admissions worked, employment did not, on the same
 * deployment, differing only by which verifier they name. This asserts the property
 * that made it length-dependent, over both real urls.
 */

const toBase64Url = (s) =>
  Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** What authenticate.tsx used to do. Rejects anything needing padding. */
const fromBase64Strict = (s) => {
  if (s.length % 4 !== 0) throw new Error('Could not decode data from base64 string');
  return Buffer.from(s, 'base64').toString('utf8');
};

/** What it does now: the counterpart of toBase64Url, which tolerates no padding. */
const fromBase64Url = (s) =>
  Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

const redirect = (host, vp, session) =>
  `/notifications/openIdPresentation?uri=${encodeURIComponent(
    `openid4vp://?client_id=${encodeURIComponent(`did:web:${host}:4bf472aa-8229-4fd9-b901-1bc71753bf2b`)}` +
      `&request_uri=${encodeURIComponent(`https://${host}/${vp}/vp/request-object/${session}`)}`,
  )}`;

const ADMISSIONS = redirect('sandbox-rc.sunbird.org', 'university-vp', '24dd1a76-68ff-4ac0-b1b7-2cfe69c8e065');
const EMPLOYER = redirect('sandbox-rc.sunbird.org', 'employer-vp', '7104840c-8d4a-424f-9363-342ab95fac83');

describe('the wallet deeplink redirect', () => {
  test('the two real verifiers encode to different lengths mod 4', () => {
    // Not incidental: this is why the defect looked intermittent rather than total.
    const a = toBase64Url(ADMISSIONS).length % 4;
    const e = toBase64Url(EMPLOYER).length % 4;
    assert.notEqual(a, e, 'if both were padded alike the defect would never have shown');
  });

  test('the OLD decoder fails on whichever url needs padding', () => {
    const failures = [ADMISSIONS, EMPLOYER].filter((p) => {
      try {
        fromBase64Strict(toBase64Url(p));
        return false;
      } catch {
        return true;
      }
    });
    assert.equal(failures.length, 1, 'exactly one of the two should have been undecodable');
  });

  test('the matching decoder round-trips BOTH, padded or not', () => {
    for (const path of [ADMISSIONS, EMPLOYER]) {
      assert.equal(fromBase64Url(toBase64Url(path)), path);
    }
  });

  test('round-trips at every length, so no url can be unlucky again', () => {
    for (let n = 1; n <= 64; n += 1) {
      const path = `/notifications/openIdPresentation?uri=${'x'.repeat(n)}`;
      assert.equal(fromBase64Url(toBase64Url(path)), path, `failed at length ${n}`);
    }
  });
});
