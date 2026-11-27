// Shared by /try/ and its two demo sites: language choice and static text.
// Every string goes through textContent: a test citizen's name is typed by a
// stranger, and nothing on these pages is ever rendered as HTML from input.

import { LANGS, t, pickLang } from '/verifier/i18n.js';

const STORE = 'age-demo-lang';

export function currentLang() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORE);
  } catch {}
  return pickLang({
    query: new URLSearchParams(location.search).get('lang'),
    stored,
    browser: navigator.languages || [],
  });
}

/** Fills [data-i18n] elements and builds the language switch; calls onChange(lang). */
export function setupLang(onChange) {
  let lang = currentLang();
  const box = document.getElementById('lang');
  const apply = () => {
    document.documentElement.lang = lang;
    for (const node of document.querySelectorAll('[data-i18n]')) node.textContent = t(lang, node.dataset.i18n);
    for (const b of box.children) b.setAttribute('aria-pressed', String(b.dataset.lang === lang));
    onChange(lang);
  };
  for (const code of LANGS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.dataset.lang = code;
    b.textContent = code.toUpperCase();
    b.addEventListener('click', () => {
      lang = code;
      try {
        localStorage.setItem(STORE, code);
      } catch {}
      apply();
    });
    box.append(b);
  }
  // After the caller has the getter: its onChange usually reads it.
  queueMicrotask(apply);
  return () => lang;
}

export const el = (id) => document.getElementById(id);

export function node(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;
  return n;
}

export const todayUtc = () => new Date().toISOString().slice(0, 10);
