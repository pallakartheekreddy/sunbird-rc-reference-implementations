// Age check page: DOM wiring only.
//
// It talks ONLY to /api/verifier and never decides anything: APPROVED/DENIED
// arrives decided by the verifier service, after cryptographic verification,
// the trust allowlist and the disclosure policy. The "Behind the scenes" panel
// draws a tick only for what the service reported (steps.js).
//
// Everything from the server is rendered as text, never markup, except the QR
// SVG, which the service itself generates.

import { LANGS, t, pickLang } from './i18n.js';
import { stepStatuses, extraChecks } from './steps.js';
import { copyText } from './copy.js';
import { request, pollStillCurrent, startFailure } from './flow.js';

const API = '/api/verifier';
const POLL_INTERVAL_MS = 1500;
const params = new URLSearchParams(window.location.search);
const el = (id) => document.getElementById(id);

const state = {
  lang: pickLang({ query: params.get('lang'), stored: safeStored(), browser: navigator.languages || [] }),
  policy: { thresholds: [18], defaultThreshold: 18, wallets: [], trustedIssuers: [], approvedAlgorithms: [] },
  threshold: 18,
  wallet: 'openid',
  view: 'idle', // idle | waiting | result
  result: null, // the service's body (or a synthesised one for declined/cancelled/expired)
  sessionId: null,
  qrData: '',
  deadline: 0,
  timer: null,
  countdown: null,
};

function safeStored() {
  try {
    return localStorage.getItem('age-check-lang');
  } catch {
    return null;
  }
}

const tr = (key, p) => t(state.lang, key, p);
const node = (tag, className, textValue) => {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (textValue !== undefined) n.textContent = String(textValue);
  return n;
};

// Never rejects: a network error comes back as status 0 (flow.js).
const api = (path, init) => request(fetch, `${API}${path}`, init);

// ---------------------------------------------------------------- controls

function segmented(container, options, selected, onPick) {
  container.textContent = '';
  for (const { value, label } of options) {
    const b = node('button', '', label);
    b.type = 'button';
    b.setAttribute('aria-pressed', String(value === selected));
    b.addEventListener('click', () => onPick(value));
    container.appendChild(b);
  }
}

function renderControls() {
  const locked = state.view !== 'idle';
  segmented(el('lang'), LANGS.map((l) => ({ value: l, label: l.toUpperCase() })), state.lang, setLang);
  el('lang').setAttribute('aria-label', tr('lang.label'));
  segmented(
    el('rule'),
    state.policy.thresholds.map((n) => ({ value: n, label: `${n}+` })),
    state.threshold,
    (n) => { state.threshold = n; render(); },
  );
  const injiOffered = (state.policy.wallets || []).includes('inji');
  el('wallet-field').hidden = !injiOffered;
  segmented(
    el('wallet'),
    [{ value: 'openid', label: tr('wallet.openid') }, { value: 'inji', label: tr('wallet.inji') }],
    state.wallet,
    (w) => { state.wallet = w; render(); },
  );
  for (const b of document.querySelectorAll('#rule button, #wallet button')) b.disabled = locked;
  el('controls').hidden = locked;
}

function setLang(lang) {
  state.lang = lang;
  try { localStorage.setItem('age-check-lang', lang); } catch { /* private mode */ }
  render();
}

// ---------------------------------------------------------------- render

function threshold() {
  return state.result?.threshold ?? state.threshold;
}

function render() {
  document.documentElement.lang = state.lang;
  for (const n of document.querySelectorAll('[data-i18n]')) n.textContent = tr(n.dataset.i18n);
  document.title = `${tr('app.title')} ${threshold()}+`;
  el('headline').textContent = tr('headline', { t: threshold() });
  el('lede').textContent = tr('lede', { t: threshold() });
  el('enlarge').textContent = tr(document.body.classList.contains('qr-large') ? 'shrink' : 'enlarge');
  renderControls();
  el('present').hidden = state.view !== 'waiting';
  el('result').hidden = state.view !== 'result';
  if (state.view === 'result') renderVerdict();
  renderBehind();
}

const OUTCOME = {
  APPROVED: { tone: 'ok', icon: '✓', title: 'result.approved', reason: 'reason.approved' },
  DENIED: { tone: 'warn', icon: '✕', title: 'result.denied', reason: 'reason.denied' },
  rejected: { tone: 'bad', icon: '!', title: 'result.rejected', reason: 'reason.failed' },
  declined: { tone: 'neutral', icon: '–', title: 'result.declined', reason: 'reason.declined' },
  cancelled: { tone: 'neutral', icon: '–', title: 'result.cancelled', reason: 'reason.cancelled' },
  expired: { tone: 'neutral', icon: '–', title: 'result.expired', reason: 'reason.expired' },
  // The check never started: no session, no wallet, so not a failed presentation.
  unavailable: { tone: 'neutral', icon: '!', title: 'result.unavailable', reason: 'reason.unavailable' },
};

function outcomeOf(result) {
  if (result.state === 'decided') return OUTCOME[result.decision] || OUTCOME.rejected;
  return OUTCOME[result.state] || OUTCOME.rejected;
}

function renderVerdict() {
  const r = state.result;
  const o = outcomeOf(r);
  el('verdict').className = `verdict ${o.tone}`;
  el('verdict-icon').textContent = o.icon;
  el('verdict-title').textContent = tr(o.title, { t: threshold() });
  const failed = stepStatuses(r).find((s) => s.status === 'fail');
  // "failed at: Decision. No decision was made." would contradict itself.
  const reasonKey =
    o.reason !== 'reason.failed'
      ? o.reason
      : failed?.id === 'decision'
        ? 'reason.failedDecision'
        : failed?.id === 'expiry'
          ? 'reason.credentialExpired'
          : o.reason;
  el('verdict-reason').textContent = tr(reasonKey, { t: threshold(), step: failed ? tr(`step.${failed.id}`) : '' });
  // The service's own wording, in English, for anyone who wants the exact cause.
  const technical = [r.reason, r.diagnostic].filter(Boolean).join(' — ');
  el('technical').hidden = !technical || r.state === 'decided';
  el('technical-text').textContent = technical;
}

const PILL = {
  idle: ['', 'state.idle'],
  waiting: ['waiting', 'waiting'],
  ok: ['ok'],
  warn: ['warn'],
  bad: ['bad'],
  neutral: [''],
};

function renderBehind() {
  const n = threshold();
  const asked = `ageOver${n}`;

  // State pill
  const pill = el('state-pill');
  if (state.view === 'result') {
    const o = outcomeOf(state.result);
    pill.className = `pill ${PILL[o.tone][0]}`;
    pill.textContent = tr(o.title, { t: n });
  } else {
    const [cls, key] = PILL[state.view];
    pill.className = `pill ${cls}`;
    pill.textContent = tr(key);
  }

  // What we ask
  el('asked').replaceChildren(node('span', 'chip ask', asked));
  const others = state.policy.thresholds.filter((x) => x !== n).map((x) => `ageOver${x}`);
  el('not-asked').replaceChildren(
    ...[tr('ask.dob'), tr('ask.name'), ...others].map((c) => node('span', 'chip muted', c)),
  );

  // Accepted issuer
  el('issuers').replaceChildren(...(state.policy.trustedIssuers || []).map((name) => node('li', '', name)));

  // Verification steps
  const result = state.view === 'result' ? state.result : { state: state.view };
  const steps = stepStatuses(result);
  const items = steps.map(({ id, status }) => {
    const li = node('li', status);
    li.append(
      node('span', 'icon', status === 'ok' ? '✓' : status === 'fail' ? '✕' : ''),
      node('span', 'name', tr(`step.${id}`)),
      node('span', 'state', tr(`status.${status}`)),
    );
    return li;
  });
  for (const key of extraChecks(result.checks)) {
    const ok = result.checks[key] === 'OK';
    const li = node('li', `raw ${ok ? 'ok' : 'fail'}`);
    li.append(node('span', 'icon', ok ? '✓' : '✕'), node('span', 'name', key), node('span', 'state', tr(ok ? 'status.ok' : 'status.fail')));
    items.push(li);
  }
  el('steps').replaceChildren(...items);
  el('algs').textContent = (state.policy.approvedAlgorithms || []).join(' · ');

  // What was shared
  const disclosed = state.view === 'result' && state.result.state === 'decided' ? state.result.disclosed || {} : null;
  if (disclosed && Object.keys(disclosed).length) {
    el('shared').replaceChildren(
      ...Object.entries(disclosed).map(([k, v]) => node('span', 'chip value', `${k} = ${v}`)),
    );
    el('withheld-row').hidden = false;
    el('withheld').replaceChildren(
      ...[tr('ask.dob'), tr('ask.name'), ...others].map((c) => node('span', 'chip muted', c)),
    );
  } else {
    el('shared').replaceChildren(node('span', 'chip empty', state.view === 'result' ? tr('shared.nothing') : '—'));
    el('withheld-row').hidden = true;
  }
}

// ---------------------------------------------------------------- flow

function stopPolling() {
  clearInterval(state.timer);
  clearInterval(state.countdown);
  state.timer = null;
  state.countdown = null;
}

function finish(result) {
  stopPolling();
  document.body.classList.remove('qr-large');
  state.view = 'result';
  state.result = { threshold: state.threshold, ...result };
  render();
}

async function start() {
  el('start').disabled = true;
  const query = new URLSearchParams({ threshold: String(state.threshold) });
  if (!el('wallet-field').hidden) query.set('wallet', state.wallet);
  const { status, body } = await api(`/sessions?${query}`, { method: 'POST' });
  el('start').disabled = false;
  if (status !== 201) return finish(startFailure(status, body));

  state.sessionId = body.sessionId;
  state.qrData = body.qrData;
  el('qr').dataset.sessionId = body.sessionId; // read by the scripted wallet and demo capture
  el('qr').innerHTML = body.qrSvg; // generated by the verifier service
  el('open-wallet').href = body.qrData;
  el('copied').hidden = true;
  el('link-field-wrap').hidden = true;
  state.view = 'waiting';
  state.deadline = Date.now() + body.expiresInSeconds * 1000;
  state.timer = setInterval(poll, POLL_INTERVAL_MS);
  state.countdown = setInterval(tick, 1000);
  tick();
  render();
}

function tick() {
  const left = Math.max(0, Math.round((state.deadline - Date.now()) / 1000));
  el('countdown').textContent = tr('secondsLeft', { s: left });
  // The server's own expiry normally arrives as a 404 here; if it cannot be
  // reached at all, the page still stops waiting shortly after the deadline.
  if (Date.now() > state.deadline + 10000) return finish({ state: 'expired' });
  if (left === 0) poll();
}

async function poll() {
  const id = state.sessionId;
  const { status, body } = await api(`/sessions/${id}`);
  // A late answer after Cancel, or for an older session, must not overwrite the page.
  if (!pollStillCurrent(state, id)) return;
  if (status === 0 || status >= 500) return; // transient; the deadline still ends it
  if (status === 404 || body.state === 'expired') return finish({ state: 'expired' });
  if (body.state === 'waiting') return;
  if (['cancelled', 'declined', 'rejected', 'decided'].includes(body.state)) return finish(body);
}

el('start').addEventListener('click', start);

el('copy-link').addEventListener('click', async () => {
  const outcome = await copyText(state.qrData, {
    clipboard: navigator.clipboard,
    fallback: (text) => {
      el('link-field').value = text;
      el('link-field-wrap').hidden = false;
      el('link-field').focus();
      el('link-field').select();
    },
  });
  el('copied').hidden = outcome !== 'copied';
  el('copied').textContent = tr('copied');
});

// Module pitch, not layout, decides whether a phone can decode the QR.
el('enlarge').addEventListener('click', () => {
  document.body.classList.toggle('qr-large');
  render();
});

el('cancel').addEventListener('click', async () => {
  const id = state.sessionId;
  stopPolling();
  if (id) await api(`/sessions/${id}/cancel`, { method: 'POST' });
  finish({ state: 'cancelled' });
});

el('again').addEventListener('click', () => {
  state.view = 'idle';
  state.result = null;
  state.sessionId = null;
  render();
});

// ---------------------------------------------------------------- boot

(async () => {
  render();
  const { body } = await api('/policy');
  if (Array.isArray(body.thresholds)) {
    state.policy = body;
    const wanted = Number(params.get('age'));
    state.threshold = body.thresholds.includes(wanted) ? wanted : body.defaultThreshold;
    if (params.get('wallet') === 'inji') state.wallet = 'inji';
  }
  render();
})();
