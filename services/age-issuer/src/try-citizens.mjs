// Test citizens for the public "try it yourself" page (/try/).
//
// A visitor types a name and a date of birth; this writes them to the registry
// as an AgeCitizen and issues from that record through the normal path, so the
// demo runs the real issuance, not a shortcut around it. Because the input comes
// from anyone on the internet:
//
//   * it is validated here, field by field, before anything is written;
//   * every record is marked by its id (TRY-<creation time>-<random>) and
//     deleted 2 hours later, so the registry does not fill with strangers;
//   * the credential it yields expires within 7 days, so a demo credential does
//     not live on in someone's wallet;
//   * a cap on live test citizens stops one busy afternoon from growing the
//     registry without bound.
//
// The creation time lives in the id rather than in a new registry field: the
// AgeCitizen schema is the authoritative-record schema and should not grow a
// demo-only column.

import { webcrypto } from 'node:crypto';
import { parseCalendarDate, deriveAgeClaims, ageClaimsValidUntil } from './age-claims.mjs';

export const TRY_WALLET_FORMATS = { paradym: 'vc+sd-jwt', inji: 'ldp_vc' };

const TRY_PREFIX = 'TRY-';
// Letters plus combining marks: Devanagari vowel signs and decomposed accents
// (NFD "João", as macOS keyboards can send) are marks, not letters. A name must
// still START with a letter, and nothing here can carry markup.
const NAME = /^\p{L}[\p{L}\p{M} .'-]{0,59}$/u;
const SEVEN_DAYS_MS = 7 * 24 * 3600 * 1000;
// A test citizen is only needed until its offer is redeemed (minutes). Two hours
// keeps one rate-limited client (5/min → 600 in 2 h) below the 1,000 cap, so a
// single script cannot keep the demo "busy". The credential in the wallet is
// unaffected; it carries its own 7-day expiry.
const RETENTION_MS = 2 * 3600 * 1000;

const utcDay = (d) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

/**
 * @returns {{ok: true, value: {name: string, dateOfBirth: string, wallet: string}}
 *         | {ok: false, field: 'name'|'dateOfBirth'|'wallet', error: string}}
 */
export function validateTryRequest(body, now = new Date()) {
  const name = typeof body?.name === 'string' ? body.name.normalize('NFC').trim() : '';
  if (!NAME.test(name)) {
    return { ok: false, field: 'name', error: "1–60 characters: letters, spaces and . ' - only" };
  }

  const dateOfBirth = typeof body?.dateOfBirth === 'string' ? body.dateOfBirth.trim() : '';
  let parsed;
  try {
    parsed = parseCalendarDate(dateOfBirth);
  } catch {
    return { ok: false, field: 'dateOfBirth', error: 'a real calendar date, YYYY-MM-DD' };
  }
  const born = Date.UTC(parsed.year, parsed.month - 1, parsed.day);
  if (born < Date.UTC(1900, 0, 1) || born > utcDay(now)) {
    return { ok: false, field: 'dateOfBirth', error: 'between 1900-01-01 and today' };
  }

  const wallet = body?.wallet;
  if (!Object.hasOwn(TRY_WALLET_FORMATS, wallet)) {
    return { ok: false, field: 'wallet', error: `one of ${Object.keys(TRY_WALLET_FORMATS).join(', ')}` };
  }

  return { ok: true, value: { name, dateOfBirth, wallet } };
}

/** TRY-<ms since epoch, base36>-<4 random base36>, upper case. */
export function newTryCitizenId(now = new Date(), random = (a) => webcrypto.getRandomValues(a)) {
  const bytes = random(new Uint8Array(4));
  const suffix = Array.from(bytes, (b) => (b % 36).toString(36)).join('');
  return `${TRY_PREFIX}${now.getTime().toString(36)}-${suffix}`.toUpperCase();
}

/** The creation time encoded in a TRY- id, or null for any other id. */
export function tryCitizenCreatedAt(citizenId) {
  const match = /^TRY-([0-9A-Z]+)-[0-9A-Z]{4}$/.exec(String(citizenId ?? ''));
  if (!match) return null;
  const ms = parseInt(match[1], 36);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

/** The earlier of now + 7 days and the birthday that would change an answer. */
export function tryExpiration(dateOfBirth, now = new Date()) {
  const week = new Date(now.getTime() + SEVEN_DAYS_MS);
  const flip = ageClaimsValidUntil(dateOfBirth, now); // YYYY-MM-DD or undefined
  const flipAt = flip ? new Date(`${flip}T00:00:00.000Z`) : null;
  return (flipAt && flipAt < week ? flipAt : week).toISOString();
}

/**
 * The POST /try/citizens handler.
 *
 * @param {{
 *   registry: {createCitizen(r: object): Promise<unknown>, countTryCitizens(): Promise<number>},
 *   issueOffer: (citizenId: string, format: string, opts: {expirationDate: string}) => Promise<{status: number, body: any}>,
 *   now?: () => Date,
 *   cap?: number,
 * }} deps
 */
export function createTryHandler({ registry, issueOffer, now = () => new Date(), cap = 1000 }) {
  return async (body) => {
    const at = now();
    const checked = validateTryRequest(body, at);
    if (!checked.ok) {
      return { status: 400, body: { error: 'invalid_request', field: checked.field, message: checked.error } };
    }
    const { name, dateOfBirth, wallet } = checked.value;

    if ((await registry.countTryCitizens()) >= cap) {
      return { status: 503, body: { error: 'demo_busy' } };
    }

    const citizenId = newTryCitizenId(at);
    await registry.createCitizen({ citizenId, name, dateOfBirth });

    const expirationDate = tryExpiration(dateOfBirth, at);
    const offer = await issueOffer(citizenId, TRY_WALLET_FORMATS[wallet], { expirationDate });
    if (offer.status !== 201) return offer;

    const claims = deriveAgeClaims({ citizenId, dateOfBirth }, at);
    return {
      status: 201,
      body: {
        citizenId,
        ageOver16: claims.ageOver16,
        ageOver18: claims.ageOver18,
        expirationDate,
        offerId: offer.body.offerId,
        qrData: offer.body.qrData,
      },
    };
  };
}

/**
 * Deletes TRY- citizens older than maxAgeMs (2 h by default). Keeps going past a failed delete:
 * one stuck record must not stop the rest from being cleaned up.
 *
 * @returns {Promise<number>} how many were deleted
 */
export async function cleanupTryCitizens({ registry, now = new Date(), maxAgeMs = RETENTION_MS }) {
  const records = await registry.listTryCitizens();
  let deleted = 0;
  for (const { osid, citizenId } of records) {
    const createdAt = tryCitizenCreatedAt(citizenId);
    if (!createdAt || now.getTime() - createdAt.getTime() <= maxAgeMs) continue;
    try {
      await registry.deleteCitizen(osid);
      deleted += 1;
    } catch (err) {
      console.error(`[age-issuer] could not delete test citizen ${citizenId}: ${err.message}`);
    }
  }
  return deleted;
}
