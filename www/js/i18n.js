// UI language. Hungarian text is the key; EN holds the English translation.
// t('Szöveg {0}', x) fills {0}, {1} ... placeholders.

import { EN } from './i18n-en.js';

let lang = 'hu';

export function setLang(l) {
  lang = l === 'en' || l === 'hu' ? l : (navigator.language || '').toLowerCase().startsWith('hu') ? 'hu' : 'en';
  document.documentElement.lang = lang;
}
export const getLang = () => lang;

export function t(s, ...args) {
  let r = lang === 'en' ? EN[s] ?? s : s;
  if (args.length) r = r.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? ''));
  return r;
}
