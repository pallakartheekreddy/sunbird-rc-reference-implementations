// Verifier front end.
//
// It talks ONLY to /api/verifier. It never calls oid4vc-service, and it never
// decides anything: APPROVED/DENIED arrives already decided from the verifier
// service, after cryptographic verification, the trust allowlist and the
// disclosure policy. A page that computed the decision from a claim it fetched
// itself would be a simulation of a verification, which is precisely what this
// iteration has to avoid.

const API = '/api/verifier';
const POLL_INTERVAL_MS = 1500;

const el = (id) => document.getElementById(id);
const state = { sessionId: null, timer: null, countdown: null, deadline: null, thresholds: [18], policy: null };

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

/** Claim chips: what was shared, and what was deliberately not. */
function claimsNode(disclosed) {
  const wrap = document.createElement('div');
  wrap.className = 'chips';
  for (const [name, value] of Object.entries(disclosed)) {
    const chip = document.createElement('span');
    chip.className = 'chip ask';
    chip.appendChild(text(`${name} = ${value}`));
    wrap.appendChild(chip);
  }
  // Everything the credential carries that this check did not ask for.
  const otherThresholds = state.thresholds
    .map((t) => `ageOver${t}`)
    .filter((claim) => !(claim in disclosed));
  for (const withheld of ['date of birth', 'name', ...otherThresholds]) {
    const chip = document.createElement('span');
    chip.className = 'chip withheld';
    chip.appendChild(text(withheld));
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

function showResult({ decision, reason, checks, issuer, disclosed, failedCheck, diagnostic, nothingShared }) {
  stopPolling();
  el('panel-request').hidden = true;
  el('panel-result').hidden = false;

  // Three outcomes, not two. A holder who declines, and a request nobody
  // answered, are NOT verification failures — showing them in red beside
  // "NOT VERIFIED" says the system broke when it did exactly what was asked.
  const verdict = nothingShared ? 'NO DATA SHARED' : decision || 'NOT VERIFIED';
  const tone = nothingShared
    ? 'neutral'
    : verdict === 'APPROVED'
      ? 'approved'
      : verdict === 'DENIED'
        ? 'denied'
        : 'failed';
  const node = el('decision');
  node.textContent = verdict;
  node.className = `decision ${tone}`;
  el('result-eyebrow').textContent = nothingShared ? 'No result' : decision ? 'Verified result' : 'Rejected';
  el('reason').textContent = reason || '';

  const detail = el('detail');
  detail.textContent = '';
  if (issuer) row(detail, 'Issuer', issuer);
  if (disclosed) {
    row(detail, 'Shared with us', claimsNode(disclosed));
  }
  if (checks && Object.keys(checks).length) row(detail, 'Verification', checksNode(checks));
  if (failedCheck) row(detail, 'Failed at', failedCheck);
  if (diagnostic) row(detail, 'Detail', diagnostic);
}

async function poll() {
  const { status, body } = await api(`/sessions/${state.sessionId}`);
  if (status === 404 || body.state === 'expired') {
    return showResult({
      nothingShared: true,
      reason: 'No presentation arrived before the request expired. Nothing was disclosed and no approval was produced.',
    });
  }
  if (body.state === 'waiting') return;
  if (body.state === 'cancelled') {
    return showResult({
      nothingShared: true,
      reason: 'The check was cancelled. Nothing was disclosed and no approval was produced.',
    });
  }
  if (body.state === 'declined') {
    return showResult({
      nothingShared: true,
      reason: 'The holder declined the request. Nothing was disclosed and no approval was produced.',
    });
  }
  if (body.state === 'rejected') return showResult(body);
  if (body.state === 'decided') return showResult(body);
}

// Module pitch, not layout, decides whether a phone can decode this. Toggling
// the class widens the symbol to the viewport and drops the surrounding chrome.
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
    reason: 'The check was cancelled. Nothing was disclosed and no approval was produced.',
  });
});

async function start() {
  el('start').disabled = true;
  el('threshold').disabled = true;
  const { status, body } = await api(`/sessions?threshold=${encodeURIComponent(el('threshold').value)}`, {
    method: 'POST',
  });
  if (status !== 201) {
    el('start').disabled = false;
    el('threshold').disabled = false;
    return showResult({ reason: body.error || 'Could not start an age check.' });
  }

  state.sessionId = body.sessionId;
  // Exposed in the DOM so the scripted wallet (and the demo capture) can answer
  // the session this page is actually showing. It is a transaction id, not
  // holder data, and it is single-use and short-lived.
  el('qr').dataset.sessionId = body.sessionId;
  el('qr').innerHTML = body.qrSvg;
  el('qr').hidden = false;
  // The same payload the QR encodes, as a tappable link: opening this page on
  // the phone and tapping it hands the request to the wallet through its
  // openid4vp:// handler, with no camera involved.
  el('open-wallet').href = body.qrData;
  el('open-wallet').hidden = false;
  el('enlarge').hidden = false;
  el('cancel').hidden = false;
  el('hint').hidden = false;
  el('start').hidden = true;
  el('threshold-wrap').hidden = true;
  el('request-eyebrow').textContent = 'Scan with your wallet';

  state.deadline = Date.now() + body.expiresInSeconds * 1000;
  state.timer = setInterval(poll, POLL_INTERVAL_MS);
  state.countdown = setInterval(() => {
    const left = Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
    el('countdown').textContent = `${left}s left`;
    if (left === 0) poll();
  }, 1000);
}

/** Shows what this verifier asks for, read from the service rather than hardcoded. */
async function showPolicy() {
  const { body } = await api('/policy');
  if (!body.requestedClaims) return;
  state.policy = body;
  setupThresholds(body);
  renderPolicy();
}

/**
 * Fills the minimum-age choice from the service's published thresholds and
 * preselects ?age= when it names one of them. An unsupported ?age= is ignored
 * rather than guessed at; the service would refuse it anyway.
 */
function setupThresholds({ thresholds = [18], defaultThreshold = 18 }) {
  state.thresholds = thresholds;
  const wanted = Number(new URLSearchParams(window.location.search).get('age'));
  const chosen = thresholds.includes(wanted) ? wanted : defaultThreshold;
  const select = el('threshold');
  select.textContent = '';
  for (const t of thresholds) {
    const option = document.createElement('option');
    option.value = String(t);
    option.textContent = `${t}+`;
    option.selected = t === chosen;
    select.appendChild(option);
  }
  showThreshold();
}

function showThreshold() {
  for (const node of document.querySelectorAll('.age-threshold')) node.textContent = el('threshold').value;
  document.title = `Age check ${el('threshold').value}+ — Sunbird RC showcase`;
  if (state.policy) renderPolicy();
}

/** Shows what this verifier asks for, read from the service rather than hardcoded. */
function renderPolicy() {
  const body = state.policy;
  const wrap = el('policy');
  wrap.textContent = '';
  wrap.appendChild(text('Requests'));
  const chip = document.createElement('span');
  chip.className = 'chip ask';
  chip.appendChild(text(`ageOver${el('threshold').value}`));
  wrap.appendChild(chip);
  wrap.appendChild(text('· accepts'));
  for (const issuer of body.trustedIssuers || []) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.appendChild(text(issuer));
    wrap.appendChild(chip);
  }
}

el('start').addEventListener('click', start);
el('threshold').addEventListener('change', showThreshold);
el('again').addEventListener('click', () => window.location.reload());
showPolicy();
