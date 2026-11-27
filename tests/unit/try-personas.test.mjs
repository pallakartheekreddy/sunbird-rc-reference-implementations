// The "new citizen" button on /try/. What breaks if this fails: a persona meant
// to be refused at 18+ is actually an adult (or the reverse), so the demo shows
// the wrong outcome and looks broken.

import test from 'node:test';
import assert from 'node:assert/strict';
import { randomPersona, PERSONA_KINDS, completedYears } from '../../services/verifier-web/try/personas.js';
import { deriveAgeClaims } from '../../services/age-issuer/src/age-claims.mjs';

const NOW = new Date('2026-11-27T10:00:00Z');

test('each kind lands on the intended side of 16 and 18', () => {
  const want = { adult: [true, true], teen: [true, false], child: [false, false], turns18Tomorrow: [true, false] };
  for (const kind of PERSONA_KINDS) {
    for (let i = 0; i < 50; i++) {
      const p = randomPersona(kind, '2026-11-27', Math.random);
      const c = deriveAgeClaims({ citizenId: 'TRY-X', dateOfBirth: p.dateOfBirth }, NOW);
      assert.deepEqual([c.ageOver16, c.ageOver18], want[kind], `${kind} ${p.dateOfBirth}`);
      assert.match(p.name, /^[\p{L}][\p{L} .'-]{0,59}$/u);
    }
  }
});

test('turns 18 tomorrow means tomorrow', () => {
  assert.equal(randomPersona('turns18Tomorrow', '2026-11-27').dateOfBirth, '2008-11-28');
  assert.equal(randomPersona('turns18Tomorrow', '2026-12-31').dateOfBirth, '2009-01-01');
});

test('the live 16/18 preview counts completed years, birthday included', () => {
  assert.equal(completedYears('2008-11-28', '2026-11-27'), 17);
  assert.equal(completedYears('2008-11-27', '2026-11-27'), 18);
  assert.equal(completedYears('2008-02-29', '2026-02-28'), 17);
  assert.equal(completedYears('not a date', '2026-11-27'), null);
});
