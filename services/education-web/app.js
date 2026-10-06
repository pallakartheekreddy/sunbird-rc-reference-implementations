// The two Education front ends, from one file.
//
// ONE implementation for both portals, chosen deliberately. The iteration's claim
// is that a university and an employer asking about the same three credentials
// get different requests and different answers because the POLICY differs — not
// because two front ends were written differently. Two copies of this file could
// diverge in a way that made the demo look right for the wrong reason; one file
// reading `data-policy` off the page cannot.
//
// It talks ONLY to /api/verifier/education/<policy>. It never calls
// oid4vc-service, never verifies anything, and never applies a threshold: the
// verdict, its wording and the reason all arrive already decided from the
// verifier service — after cryptographic verification, the approved-algorithm
// check, a per-role issuer trust check on all three credentials, and the
// Learner ID correlation check.
//
// Deliberately the same shape as services/bank-web and services/verifier-web:
// same API surface, same polling, same three no-result states.

const POLICY = document.body.dataset.policy;
if (POLICY !== 'masters' && POLICY !== 'job') {
  throw new Error(`page must declare data-policy="masters" or "job", got ${POLICY}`);
}
const API = `/api/verifier/education/${POLICY}`;
const POLL_INTERVAL_MS = 1500;

const el = (id) => document.getElementById(id);
const state = { sessionId: null, timer: null, countdown: null, deadline: null };

/** Everything from the server is rendered as text, never as markup. */
const text = (value) => document.createTextNode(String(value));

async function api(path, init) {
  const res = await fetch(`${API}${path}`, init);
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  if (state.countdown) clearInterval(state.countdown);
  state.timer = null;
  state.countdown = null;
}

/** Verification checks as pass/fail pills. */
function checksNode(checks) {
  const wrap = document.createElement('div');
  wrap.className = 'checks';
  for (const [name, value] of Object.entries(checks)) {
    const pill = document.createElement('span');
    pill.className = value === 'OK' ? 'check' : 'check bad';
    pill.appendChild(text(name));
    wrap.appendChild(pill);
  }
  return wrap;
}

/**
 * What was shared, grouped by the credential it came from.
 *
 * Grouped rather than merged, because `learnerId` arriving three times IS the
 * correlation the verifier checked. Flattening the three sets into one list would
 * hide the single most important fact on the screen — that three independent
 * institutions named the same learner.
 */
function claimsNode(disclosed) {
  const wrap = document.createElement('div');
  // One row per credential, same shape as the request screen. The old flat run
  // put the next institution's label inline among the previous one's chips, so
  // where one card ended and the next began was a matter of reading carefully.
  wrap.className = 'policy';
  for (const [role, claims] of Object.entries(disclosed)) {
    if (!claims) continue;
    const line = document.createElement('div');
    line.className = 'policy-row';
    const label = document.createElement('span');
    label.className = 'policy-role';
    label.appendChild(text(role));
    line.appendChild(label);
    const chips = document.createElement('div');
    chips.className = 'policy-chips';
    for (const [name, value] of Object.entries(claims)) {
      const chip = document.createElement('span');
      chip.className = 'chip ask';
      chip.appendChild(text(`${name} = ${value}`));
      chips.appendChild(chip);
    }
    line.appendChild(chips);
    wrap.appendChild(line);
  }
  return wrap;
}

/** The withheld list, from the service. Never written into this page. */
function withheldNode(neverRequested, notRequested) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const [role, claims] of Object.entries(notRequested || {})) {
    for (const claim of claims) {
      const chip = document.createElement('span');
      chip.className = 'chip withheld';
      chip.appendChild(text(`${role}: ${claim}`));
      wrap.appendChild(chip);
    }
  }
  for (const claim of neverRequested || []) {
    const chip = document.createElement('span');
    chip.className = 'chip withheld';
    chip.appendChild(text(claim));
    wrap.appendChild(chip);
  }
  return wrap;
}

function row(list, term, valueNode) {
  const dt = document.createElement('dt');
  dt.appendChild(text(term));
  const dd = document.createElement('dd');
  dd.appendChild(typeof valueNode === 'string' ? text(valueNode) : valueNode);
  list.appendChild(dt);
  list.appendChild(dd);
}

/**
 * The rule, shown rather than asserted.
 *
 * Every threshold this policy declared, each against what the learner actually
 * presented, so an ELIGIBLE verdict has visible arithmetic behind it and a
 * NOT ELIGIBLE one names the single number that fell short. A verdict with no
 * derivation on screen is indistinguishable from a hardcoded one.
 */
function showRule({ thresholds, verified, shortfall }) {
  const wrap = el('calculation');
  wrap.textContent = '';
  if (!thresholds) {
    wrap.hidden = true;
    return;
  }
  for (const [role, required] of Object.entries(thresholds)) {
    const line = document.createElement('div');
    line.className = 'calc-line';
    const k = document.createElement('span');
    k.appendChild(text(`${role} — requires ${required}%`));
    const v = document.createElement('strong');
    // Both strings arrive ALREADY FORMATTED, '%' included, from the module that
    // owns the arithmetic. This page must not be able to render a percentage
    // differently from the service that decided on it.
    if (shortfall && shortfall.role === role) {
      v.appendChild(text(`${shortfall.actual} — short`));
      line.classList.add('short');
    } else if (verified && verified[role] && verified[role].percentage !== undefined) {
      v.appendChild(text(`${verified[role].percentage} — met`));
    } else {
      // A threshold the decision never reached, because an earlier one failed.
      v.appendChild(text('not reached'));
    }
    line.append(k, v);
    wrap.appendChild(line);
  }
  wrap.hidden = false;
}

function showResult(body) {
  const {
    decision,
    reason,
    checks,
    issuer,
    disclosed,
    headline,
    detail: detailLine,
    learnerId,
    thresholds,
    shortfall,
    failedCheck,
    diagnostic,
    nothingShared,
  } = body;
  stopPolling();
  el('panel-request').hidden = true;
  el('panel-result').hidden = false;

  // Four outcomes, and the distinction between them is a Product requirement.
  // A holder who declined, and a request nobody answered, are NOT verification
  // failures. Nor is REJECTED the same as NOT ELIGIBLE: one means we could not
  // trust what we were shown, the other means we trusted it and the answer was
  // no.
  //
  // The ELIGIBLE wording comes from the SERVICE, never from here. PRODUCT
  // forbids ever saying ADMITTED or implying a job offer, and the safest place
  // for wording under that constraint is the module the tests assert against.
  const verdict = nothingShared
    ? 'NO DATA SHARED'
    : decision === 'ELIGIBLE'
      ? headline || 'ELIGIBLE'
      : decision === 'NOT_ELIGIBLE'
        ? 'NOT ELIGIBLE'
        : 'REJECTED / UNABLE TO VERIFY';
  const tone = nothingShared
    ? 'neutral'
    : decision === 'ELIGIBLE'
      ? 'approved'
      : decision === 'NOT_ELIGIBLE'
        ? 'denied'
        : 'failed';
  const node = el('decision');
  node.textContent = verdict;
  node.className = `decision ${tone}`;
  el('result-eyebrow').textContent = nothingShared
    ? 'No result'
    : decision
      ? 'Verified result'
      : 'Unable to verify';
  el('reason').textContent = decision === 'ELIGIBLE' ? detailLine || '' : reason || '';

  showRule({ thresholds, verified: body.verified, shortfall });

  const detail = el('detail');
  detail.textContent = '';
  if (learnerId) row(detail, 'Learner (correlated across all three)', learnerId);
  if (issuer) row(detail, 'Issuers', Array.isArray(issuer) ? issuer.join(' · ') : issuer);
  if (disclosed) row(detail, 'Shared with us', claimsNode(disclosed));
  if (state.withheld) row(detail, 'Not shared', state.withheld);
  if (checks && Object.keys(checks).length) row(detail, 'Verification', checksNode(checks));
  if (failedCheck) row(detail, 'Failed at', failedCheck);
  if (diagnostic) row(detail, 'Detail', diagnostic);
}

async function poll() {
  const { status, body } = await api(`/sessions/${state.sessionId}`);
  if (status === 404 || body.state === 'expired') {
    return showResult({
      nothingShared: true,
      reason:
        'No presentation arrived before the request expired. Nothing was disclosed and no decision was produced.',
    });
  }
  if (body.state === 'waiting') return;
  if (body.state === 'cancelled') {
    return showResult({
      nothingShared: true,
      reason: 'The check was cancelled. Nothing was disclosed and no decision was produced.',
    });
  }
  if (body.state === 'declined') {
    return showResult({
      nothingShared: true,
      reason: 'The learner declined the request. Nothing was disclosed and no decision was produced.',
    });
  }
  if (body.state === 'rejected') return showResult(body);
  if (body.state === 'decided') return showResult(body);
}

// Module pitch, not layout, decides whether a phone can decode this. The
// Education request pins THREE credential types, so its payload is the longest
// in the showcase and this matters more here than anywhere else.
el('enlarge').addEventListener('click', () => {
  const large = document.body.classList.toggle('qr-large');
  el('enlarge').textContent = large ? 'Back to normal size' : 'Enlarge for scanning';
});

el('cancel').addEventListener('click', async () => {
  const id = state.sessionId;
  stopPolling();
  if (id) await api(`/sessions/${id}/cancel`, { method: 'POST' });
  showResult({
    nothingShared: true,
    reason: 'The check was cancelled. Nothing was disclosed and no decision was produced.',
  });
});

async function start() {
  el('start').disabled = true;
  const { status, body } = await api('/sessions', { method: 'POST' });
  if (status !== 201) {
    el('start').disabled = false;
    return showResult({ reason: body.error || 'Could not start the check.' });
  }

  state.sessionId = body.sessionId;
  // Exposed in the DOM so the scripted wallet (and the demo capture) can answer
  // the session this page is actually showing. It is a transaction id, not
  // holder data, and it is single-use and short-lived.
  el('qr').dataset.sessionId = body.sessionId;
  el('qr').innerHTML = body.qrSvg;
  el('qr').hidden = false;
  el('open-wallet').href = body.qrData;
  el('open-wallet').hidden = false;
  el('enlarge').hidden = false;
  el('cancel').hidden = false;
  el('hint').hidden = false;
  // The three steps are read once, before pressing the button. After it, the
  // code is the whole task — and the column had scrolled far enough that the
  // thing you are meant to scan was above the viewport.
  el('request-eyebrow').textContent = 'Scan this with your wallet';
  document.querySelector('.steps')?.setAttribute('hidden', '');
  document.querySelector('.stage')?.scrollTo({ top: 0, behavior: 'smooth' });
  el('start').hidden = true;
  el('request-eyebrow').textContent = 'Scan with your wallet';

  state.deadline = Date.now() + body.expiresInSeconds * 1000;
  state.timer = setInterval(poll, POLL_INTERVAL_MS);
  state.countdown = setInterval(() => {
    const left = Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
    el('countdown').textContent = `${left}s left`;
    if (left === 0) poll();
  }, 1000);
}

/**
 * What this portal asks for and requires, read from the service rather than
 * hardcoded — so the page cannot claim a policy or a privacy guarantee the
 * verifier does not hold. The withheld list is kept for the result screen.
 */
async function showPolicy() {
  const { body } = await api('/policy');
  if (!body.requestedClaims) return;
  state.withheld = withheldNode(body.neverRequested, body.notRequested);
  const wrap = el('policy');
  wrap.textContent = '';
  wrap.className = 'policy';

  /** A labelled block: a heading, then whatever rows the caller adds. */
  const block = (label) => {
    const section = document.createElement('section');
    section.className = 'policy-block';
    const h = document.createElement('h3');
    h.className = 'policy-label';
    h.appendChild(text(label));
    section.appendChild(h);
    wrap.appendChild(section);
    return section;
  };
  // Returns the CHIP container, not the row: the row is a two-column grid whose
  // first column is the label, so chips appended straight to it would each land
  // on their own grid line instead of flowing.
  const row = (parent, role) => {
    const r = document.createElement('div');
    r.className = 'policy-row';
    const name = document.createElement('span');
    name.className = 'policy-role';
    if (role) name.appendChild(text(role));
    r.appendChild(name);
    const chips = document.createElement('div');
    chips.className = 'policy-chips';
    r.appendChild(chips);
    parent.appendChild(r);
    return chips;
  };
  // camelCase keys are what the protocol calls these. A person reading the page
  // is not the protocol.
  const human = (k) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\bId\b/, 'ID').toLowerCase()
    .replace(/\bid\b/, 'ID');
  const chip = (parent, label, kind) => {
    const c = document.createElement('span');
    c.className = kind ? `chip ${kind}` : 'chip';
    c.appendChild(text(label));
    parent.appendChild(c);
  };

  // One row per credential: learnerId arriving three times IS the correlation
  // the verifier checks, and merging them into one run hides that.
  const asks = block('What this portal will ask for');
  for (const [role, claims] of Object.entries(body.requestedClaims)) {
    const r = row(asks, role);
    for (const claim of claims) chip(r, human(claim), 'ask');
  }

  // Only the issuers that can satisfy a role in THIS request. The Age and
  // Agriculture issuers are on the same allowlist and are not among them.
  const accepted = (body.trustedIssuers || []).filter(
    (i) => i.roles && i.roles.some((role) => role in body.requestedClaims),
  );
  if (accepted.length) {
    const r = row(block('Issuers it accepts'));
    for (const issuer of accepted) chip(r, issuer.name, 'issuer');
  }

  const thresholds = Object.entries(body.thresholds || {});
  const fields = body.acceptedFieldsOfStudy || [];
  if (thresholds.length || fields.length) {
    const rule = block('The published rule');
    if (thresholds.length) {
      const r = row(rule);
      for (const [role, required] of thresholds) chip(r, `${role} \u2265 ${required}%`, 'rule');
    }
    if (fields.length) {
      const r = row(rule, 'fields');
      for (const field of fields) chip(r, field.replace(/_/g, ' ').toLowerCase(), 'rule');
    }
  }
}

el('start').addEventListener('click', start);
el('again').addEventListener('click', () => window.location.reload());
showPolicy();
