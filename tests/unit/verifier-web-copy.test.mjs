// "Copy link" is one of the three PRD presentation methods. What breaks for a
// reader if this fails: on a page without clipboard access (plain http, a
// denied permission) the button does nothing and the method is unavailable.

import test from 'node:test';
import assert from 'node:assert/strict';
import { copyText } from '../../services/verifier-web/copy.js';

test('copies through the clipboard when it works', async () => {
  let written;
  let fellBack = false;
  const result = await copyText('openid4vp://x', {
    clipboard: { writeText: async (t) => { written = t; } },
    fallback: () => { fellBack = true; },
  });
  assert.equal(result, 'copied');
  assert.equal(written, 'openid4vp://x');
  assert.equal(fellBack, false);
});

test('falls back when there is no clipboard', async () => {
  let shown;
  assert.equal(await copyText('openid4vp://x', { clipboard: undefined, fallback: (t) => { shown = t; } }), 'fallback');
  assert.equal(shown, 'openid4vp://x');
});

test('falls back when the clipboard refuses', async () => {
  let shown;
  const result = await copyText('openid4vp://x', {
    clipboard: { writeText: async () => { throw new Error('NotAllowedError'); } },
    fallback: (t) => { shown = t; },
  });
  assert.equal(result, 'fallback');
  assert.equal(shown, 'openid4vp://x');
});
