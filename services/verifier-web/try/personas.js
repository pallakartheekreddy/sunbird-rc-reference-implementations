// Random test citizens for the "new citizen" button on /try/. Pure, so the age
// each kind lands on is unit-tested (tests/unit/try-personas.test.mjs).

export const PERSONA_KINDS = ['adult', 'teen', 'child', 'turns18Tomorrow'];

const GIVEN = [
  'Ana', 'Lucas', 'Amara', 'Kwame', 'Priya', 'Arjun', 'Sofia', 'Mateo', 'Aïcha', 'Yusuf',
  'Mei', 'Hiroshi', 'Fatima', 'Omar', 'Chloé', 'Thiago', 'Zanele', 'Tendai', 'Leila', 'Diego',
  'Nadia', 'Rahul', 'Inès', 'João',
];
const FAMILY = [
  'Ribeiro', 'Silva', 'Mensah', 'Okafor', 'Sharma', 'Nair', 'García', 'López', 'Diallo', 'Haddad',
  'Chen', 'Tanaka', 'Rahman', 'Dubois', 'Moreau', 'Dlamini', 'Moyo', 'Costa', 'Fernández', 'Kariuki',
  'Mbeki', 'Pereira',
];
// Completed years per kind; the date of birth is placed inside that year of life.
const YEARS = { adult: [20, 60], teen: [16, 17], child: [13, 15] };

const pick = (list, random) => list[Math.floor(random() * list.length)];
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * @param {'adult'|'teen'|'child'|'turns18Tomorrow'} kind
 * @param {string} today YYYY-MM-DD (UTC)
 * @param {() => number} [random]
 * @returns {{name: string, dateOfBirth: string}}
 */
export function randomPersona(kind, today, random = Math.random) {
  const [y, m, d] = today.split('-').map(Number);
  const name = `${pick(GIVEN, random)} ${pick(FAMILY, random)}`;
  if (kind === 'turns18Tomorrow') {
    const tomorrow = new Date(Date.UTC(y, m - 1, d + 1));
    return {
      name,
      dateOfBirth: iso(Date.UTC(tomorrow.getUTCFullYear() - 18, tomorrow.getUTCMonth(), tomorrow.getUTCDate())),
    };
  }
  const [min, max] = YEARS[kind] || YEARS.adult;
  const age = min + Math.floor(random() * (max - min + 1));
  // `age` years ago, then 1–364 days further back: the birthday has passed this
  // year and the next one is still ahead, so completed years is exactly `age`.
  const daysBack = 1 + Math.floor(random() * 364);
  return { name, dateOfBirth: iso(Date.UTC(y - age, m - 1, d - daysBack)) };
}

/**
 * Completed years between two YYYY-MM-DD dates, by calendar fields (the same rule
 * as the issuer's age-claims.mjs), for the page's live "over 16 / over 18"
 * preview. Null if either is not a date. The issuer's answer is the real one.
 */
export function completedYears(dateOfBirth, today) {
  const re = /^(\d{4})-(\d{2})-(\d{2})$/;
  const b = re.exec(dateOfBirth || '');
  const n = re.exec(today || '');
  if (!b || !n) return null;
  const [by, bm, bd] = b.slice(1).map(Number);
  const [ny, nm, nd] = n.slice(1).map(Number);
  return ny - by - (nm < bm || (nm === bm && nd < bd) ? 1 : 0);
}
