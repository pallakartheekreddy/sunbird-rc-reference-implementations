// /try/: become a test citizen, receive the credential, then go to a demo site.
// Talks only to POST /api/try/citizens, GET /qr and GET /api/verifier/recent.

import { t } from '/verifier/i18n.js';
import { request } from '/verifier/flow.js';
import { randomPersona, PERSONA_KINDS, completedYears } from './personas.js';
import { tryErrorKey } from './site.js';
import { setupLang, el, node, todayUtc } from './common.js';

let kindIndex = 0;
let lastError = null; // i18n key, re-rendered on a language change
let offer = null; // { citizenId, expirationDate, qrData, name }
let lastRecent = []; // declared before setupLang(render) runs render()

const wallet = () => document.querySelector('input[name="wallet"]:checked')?.value || 'paradym';
const lang = setupLang(render);

function fillPersona() {
  const p = randomPersona(PERSONA_KINDS[kindIndex % PERSONA_KINDS.length], todayUtc());
  kindIndex += 1;
  el('name').value = p.name;
  el('dob').value = p.dateOfBirth;
  render();
}

function renderPreview() {
  const box = el('preview');
  box.replaceChildren();
  const years = completedYears(el('dob').value, todayUtc());
  if (years === null) return;
  for (const threshold of [16, 18]) {
    const yes = years >= threshold;
    box.append(
      node('span', `pill ${yes ? 'ok' : 'warn'}`, t(lang(), 'try.preview', {
        t: threshold,
        answer: t(lang(), yes ? 'try.yes' : 'try.no'),
      })),
    );
  }
}

function renderSiteLinks() {
  const w = wallet();
  const l = lang();
  el('go-social').href = `/try/social/?wallet=${w}&lang=${l}`;
  el('go-shop').href = `/try/shop/?wallet=${w}&lang=${l}`;
}

function renderOffer() {
  el('live-idle').hidden = !!offer;
  el('live-offer').hidden = !offer;
  if (!offer) return;
  el('live-name').textContent = offer.name;
  el('offer-qr').src = `/qr?data=${encodeURIComponent(offer.qrData)}`;
  el('offer-open').href = offer.qrData;
  const date = new Date(offer.expirationDate).toLocaleDateString(lang(), { dateStyle: 'medium' });
  el('offer-expires').textContent = t(lang(), 'try.expires', { date });
}

function render() {
  renderPreview();
  renderSiteLinks();
  renderOffer();
  el('error').hidden = !lastError;
  el('error').textContent = lastError ? t(lang(), lastError) : '';
  renderRecent(lastRecent);
}

async function getCredential(event) {
  event.preventDefault();
  const button = el('get');
  button.disabled = true;
  button.textContent = t(lang(), 'try.creating');
  lastError = null;
  const name = el('name').value;
  const { status, body } = await request(fetch, '/api/try/citizens', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, dateOfBirth: el('dob').value, wallet: wallet() }),
  });
  button.disabled = false;
  button.textContent = t(lang(), 'try.get');
  if (status === 201 && body?.qrData) {
    offer = { ...body, name: name.trim() };
  } else {
    offer = null;
    lastError = tryErrorKey(status, body);
  }
  render();
  if (offer && window.matchMedia('(max-width: 860px)').matches) el('live-offer').scrollIntoView({ behavior: 'smooth' });
}

// --- recent checks ----------------------------------------------------------

function renderRecent(checks) {
  const rows = el('recent-rows');
  rows.replaceChildren();
  el('recent-empty').hidden = checks.length > 0;
  const l = lang();
  for (const c of checks) {
    const tr = document.createElement('tr');
    const outcomeKey = `try.outcome.${c.outcome}`;
    const outcome = t(l, outcomeKey) === outcomeKey ? String(c.outcome) : t(l, outcomeKey);
    const site = { social: 'SocialApp', shop: 'ShopNow' }[c.site] || t(l, 'app.service');
    const walletName = c.wallet === 'inji' ? t(l, 'wallet.inji') : t(l, 'wallet.openid');
    tr.append(
      node('td', '', new Date(c.at).toLocaleTimeString(l, { hour: '2-digit', minute: '2-digit' })),
      node('td', '', site),
      node('td', '', `${c.threshold}+`),
      node('td', '', walletName),
      node('td', `outcome-${c.outcome}`, outcome),
      node('td', '', c.checksTotal ? t(l, 'try.checksPassed', { p: c.checksPassed, n: c.checksTotal }) : '—'),
    );
    rows.append(tr);
  }
}

async function pollRecent() {
  const { status, body } = await request(fetch, '/api/verifier/recent');
  if (status === 200 && Array.isArray(body?.checks)) {
    lastRecent = body.checks;
    renderRecent(lastRecent);
  }
}

el('new-citizen').addEventListener('click', fillPersona);
el('dob').addEventListener('input', renderPreview);
el('dob').max = todayUtc();
for (const r of document.querySelectorAll('input[name="wallet"]')) r.addEventListener('change', renderSiteLinks);
el('citizen-form').addEventListener('submit', getCredential);
el('offer-continue').addEventListener('click', (e) => {
  e.preventDefault();
  el('go-social').scrollIntoView({ behavior: 'smooth', block: 'center' });
  el('go-social').focus();
});

fillPersona();
pollRecent();
setInterval(pollRecent, 10_000);
