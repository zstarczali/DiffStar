// DiffStar – main UI shell: tabs, toolbar, welcome page, dialogs, settings,
// about, self-update. The comparison views live in textview / folderview / binview.

import {
  invoke, h, icon, toast, modal, confirmDlg, contextMenu, markdown, debounce, basename,
  initUiState, uiGet, uiSet, editMenu, combo,
} from './util.js';
import { t, setLang, getLang } from './i18n.js';
import { TextCompare, newSide, sideFromLoaded } from './textview.js';
import { FolderCompare } from './folderview.js';
import { HexCompare, ImageCompare, IMG_EXT } from './binview.js';
import { DupView } from './dupview.js';

// ───────────────────────── state ─────────────────────────

const S = {
  settings: null,
  tabs: [],        // views (TextCompare | FolderCompare | HexCompare | ImageCompare)
  active: -1,
  busy: 0,
  busyLabel: '',
  donationVisible: false,
  update: null,
};

const cur = () => S.tabs[S.active] || null;
const isDeepSeek = () => S.settings?.ai_provider === 'deepseek';
const isClaudeCli = () => S.settings?.ai_provider === 'claude-cli';
const aiKey = () => (isClaudeCli() ? 'cli' : (isDeepSeek() ? S.settings?.deepseek_api_key : S.settings?.anthropic_api_key) || '');
const aiProviderName = () => (isDeepSeek() ? 'DeepSeek' : isClaudeCli() ? 'Claude Code CLI' : 'Anthropic Claude');
const aiModel = () => (isDeepSeek() ? S.settings?.deepseek_model : S.settings?.ai_model) || '';

async function saveSettings() {
  try { await invoke('save_settings', { settings: S.settings }); } catch (e) { toast(String(e), 'err'); }
}
const saveLater = debounce(() => saveSettings(), 400);

// ───────────────────────── services for the views ─────────────────────────

const ctx = {
  settings: () => S.settings,
  saveSettings: () => saveLater(),
  changed: () => { renderTabs(); renderToolbar(); renderStatusbar(); },
  setBusy: (on, label) => setBusy(on, label),
  confirm: (title, text, ok) => confirmDlg(title, text, ok),
  ai: (title, run, presets) => aiPanel(title, run, presets),
  pickFile: (title, def) => pickFile(title, def),
  pickFolder: (title, def) => pickFolder(title, def),
  pickSave: (title, def, filters) => pickSave(title, def, filters),
  remember: () => { persistSession(); },
  openFiles: (l, r) => openFiles(l, r),
  openFolders: (l, r) => openFolders(l, r),
  openDups: (roots) => openDups(roots),
  uiGet, uiSet,
  /** The view's files changed type (e.g. a binary file loaded into a text tab). */
  reopen: async (view, l, r) => {
    const v = await makeFileView(l, r);
    if (v) ctx.replace(view, v);
  },
  replace: (view, nv) => {
    const i = S.tabs.indexOf(view);
    if (i < 0) return;
    S.tabs[i] = nv;
    persistSession();
    renderAll();
  },
};

// ───────────────────────── theme / zoom / language ─────────────────────────

function applyLang() {
  setLang(S.settings.ui_language || 'auto');
  invoke('set_ui_language', { lang: getLang() }).catch(() => {});
}

function applyTheme() {
  let th = S.settings.theme;
  if (th === 'system') th = matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  document.documentElement.dataset.theme = th;
  document.documentElement.style.setProperty('--font-size', (S.settings.font_size || 13) + 'px');
}

const ZOOMS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];
const zoomNow = () => S.settings?.zoom || 1;
function applyZoom() { invoke('set_zoom', { scale: zoomNow() }).catch(() => {}); }
function setZoom(z) {
  z = Math.max(ZOOMS[0], Math.min(ZOOMS[ZOOMS.length - 1], Math.round(z * 100) / 100));
  if (z === zoomNow()) return;
  S.settings.zoom = z;
  applyZoom();
  saveLater();
  toast(t('Nagyítás: {0}%', Math.round(z * 100)), 'info', 1200);
  renderStatusbar();
}
function zoomStep(dir) {
  const z = zoomNow();
  if (dir === 0) return setZoom(1);
  const next = dir > 0 ? ZOOMS.find((x) => x > z + 0.001) : [...ZOOMS].reverse().find((x) => x < z - 0.001);
  if (next) setZoom(next);
}

// The toolbar button flips between plain dark and light; the rest is in Settings.
const THEME_UI = { dark: ['Sötét', 'moon'], light: ['Világos', 'sun'] };
const LIGHT_THEMES = ['light', 'modern'];
const nextBasicTheme = () => (LIGHT_THEMES.includes(document.documentElement.dataset.theme) ? 'dark' : 'light');
function toggleTheme() {
  S.settings.theme = nextBasicTheme();
  applyTheme();
  saveSettings();
  renderAll();
}

let busyTimer = 0;
function setBusy(on, label = '') {
  S.busy = Math.max(0, S.busy + (on ? 1 : -1));
  S.busyLabel = on ? label : S.busy ? S.busyLabel : '';
  clearTimeout(busyTimer);
  const bar = document.getElementById('busybar');
  if (S.busy) busyTimer = setTimeout(() => bar.classList.add('on'), 150);
  else bar.classList.remove('on');
  renderStatusbar();
}

// ───────────────────────── session / recent ─────────────────────────

function persistSession() {
  S.settings.session = S.tabs.map((v) => v.pair()).filter((p) => p.left || p.right);
  S.settings.session_active = S.active;
  for (const p of S.tabs.map((v) => v.pair())) if ((p.left && p.right) || (p.kind === 'dups' && p.left)) addRecent(p);
  saveLater();
}

function addRecent(p) {
  const key = (x) => `${x.kind}|${x.left}|${x.right}`.toLowerCase();
  S.settings.recent = [p, ...(S.settings.recent || []).filter((x) => key(x) !== key(p))].slice(0, 25);
}

// ───────────────────────── opening comparisons ─────────────────────────

async function pickFile(title, defaultPath) {
  try {
    const p = await invoke('plugin:dialog|open', { options: { multiple: false, title, ...(defaultPath ? { defaultPath } : {}) } });
    return Array.isArray(p) ? p[0] : p;
  } catch (e) { toast(String(e), 'err'); return null; }
}
async function pickFolder(title, defaultPath) {
  try {
    const p = await invoke('plugin:dialog|open', { options: { directory: true, multiple: false, title, ...(defaultPath ? { defaultPath } : {}) } });
    return Array.isArray(p) ? p[0] : p;
  } catch (e) { toast(String(e), 'err'); return null; }
}
async function pickSave(title, defaultPath, filters) {
  try { return await invoke('plugin:dialog|save', { options: { title, ...(defaultPath ? { defaultPath } : {}), ...(filters ? { filters } : {}) } }); }
  catch (e) { toast(String(e), 'err'); return null; }
}

/** The right view for a pair of files: text, image or hex. */
async function makeFileView(l, r) {
  if (l && r && IMG_EXT.test(l) && IMG_EXT.test(r) && !/\.svg$/i.test(l + r)) return new ImageCompare(ctx, l, r);
  setBusy(true, t('Betöltés…'));
  try {
    const load = (p) => (p ? invoke('load_file', { path: p, encoding: null }) : null);
    const [a, b] = await Promise.all([load(l), load(r)]);
    if ((a && a.kind !== 'text') || (b && b.kind !== 'text')) {
      const imgs = (!l || IMG_EXT.test(l)) && (!r || IMG_EXT.test(r));
      return imgs ? new ImageCompare(ctx, l, r) : new HexCompare(ctx, l, r);
    }
    const v = new TextCompare(ctx, a ? sideFromLoaded(a) : newSide(), b ? sideFromLoaded(b) : newSide());
    v.autoFirst = !!(a && b);
    return v;
  } catch (e) {
    toast(String(e), 'err');
    return null;
  } finally { setBusy(false); }
}

function addTab(view, at) {
  const i = at == null ? S.tabs.length : at;
  S.tabs.splice(i, 0, view);
  S.active = i;
  persistSession();
  renderAll();
  if (view.autoFirst) { view.autoFirst = false; setTimeout(() => view.first?.(), 50); }
}

async function openFiles(l, r) {
  const v = await makeFileView(l, r);
  if (v) addTab(v, S.active >= 0 ? S.active + 1 : undefined);
}

function openFolders(l, r) { addTab(new FolderCompare(ctx, l, r), S.active >= 0 ? S.active + 1 : undefined); }

/** Duplicate finder for one or two folders; without folders it asks for one. */
async function openDups(roots) {
  roots = (roots || []).filter(Boolean);
  if (!roots.length) {
    const v = cur();
    if (v?.kind === 'folder') roots = [v.left, v.right].filter(Boolean);
  }
  if (!roots.length) {
    const p = await pickFolder(t('Mappa a duplikátumok kereséséhez'));
    if (!p) return;
    roots = [p];
  }
  addTab(new DupView(ctx, roots), S.active >= 0 ? S.active + 1 : undefined);
}

function openTextScratch() { addTab(new TextCompare(ctx, newSide(), newSide())); }

/** Two paths of any kind: folders or files. */
async function openPaths(l, r) {
  const [a, b] = await Promise.all([l, r].map((p) => (p ? invoke('path_stat', { path: p }) : { exists: false })));
  if ((l && !a.exists) || (r && !b.exists)) { toast(t('Nem található: {0}', !a.exists && l ? l : r), 'err'); return; }
  if (a.is_dir || b.is_dir) {
    if ((l && !a.is_dir) || (r && !b.is_dir)) { toast(t('Egy mappát csak mappával lehet összehasonlítani.'), 'err'); return; }
    openFolders(l, r);
  } else await openFiles(l, r);
}

async function openDlg(kind = 'files', left = '', right = '') {
  const recentPaths = [...new Set((S.settings.recent || []).flatMap((p) => [p.left, p.right]).filter(Boolean))];
  let mode = kind;
  const mk = (val) => combo({ value: val, options: recentPaths, placeholder: t('Útvonal…') });
  const lc = mk(left), rc = mk(right);
  const browse = async (c, side) => {
    const title = side === 'L' ? (mode === 'folders' ? t('Bal oldali mappa') : t('Bal oldali fájl')) : (mode === 'folders' ? t('Jobb oldali mappa') : t('Jobb oldali fájl'));
    const p = mode === 'folders' ? await pickFolder(title, c.input.value || undefined) : await pickFile(title, c.input.value || undefined);
    if (p) c.input.value = p;
  };
  const seg = h('span.seg');
  const drawSeg = () => seg.replaceChildren(
    h('button' + (mode === 'files' ? '.on' : ''), { type: 'button', on: { click: () => { mode = 'files'; drawSeg(); } } }, t('Fájlok')),
    h('button' + (mode === 'folders' ? '.on' : ''), { type: 'button', on: { click: () => { mode = 'folders'; drawSeg(); } } }, t('Mappák')));
  drawSeg();
  const row = (label, c, side) => h('label.field', h('span', label),
    h('div', { style: { display: 'flex', gap: '6px' } }, c, h('button.btn', { type: 'button', on: { click: () => browse(c, side) } }, t('Tallózás…'))));
  const body = h('div.open-dlg',
    h('div', seg),
    row(t('Bal oldal'), lc, 'L'),
    h('div.open-swap', h('button.btn.sm.ghost', { type: 'button', title: t('Oldalak felcserélése'), on: { click: () => { const x = lc.input.value; lc.input.value = rc.input.value; rc.input.value = x; } } }, icon('swap'), t('Csere'))),
    row(t('Jobb oldal'), rc, 'R'),
    h('div.desc', t('Tipp: két fájlt vagy mappát egyszerre is ráhúzhatsz az ablakra.')));
  const ok = await modal({ title: t('Új összehasonlítás'), body, wide: true, buttons: [{ label: t('Mégse'), value: false }, { label: t('Összehasonlítás'), value: true, primary: true }] });
  if (!ok) return;
  const l = lc.input.value.trim(), r = rc.input.value.trim();
  if (!l || !r) { toast(t('Add meg mindkét oldalt.'), 'err'); return; }
  if (mode === 'folders') openFolders(l, r); else await openPaths(l, r);
}

async function closeTab(i) {
  const v = S.tabs[i];
  if (!v) return;
  if (v.isDirty()) {
    const res = await modal({ title: t('Nem mentett módosítások'), body: h('div.desc', t('A(z) „{0}” fülön nem mentett módosítások vannak.', v.title())),
      buttons: [{ label: t('Mégse'), value: null }, { label: t('Elvetés'), value: 'drop', danger: true }, { label: t('Mentés'), value: 'save', primary: true }] });
    if (!res) return;
    if (res === 'save' && !(await v.saveAll())) return;
  }
  v.closed?.(); // a running search of the tab stops
  S.tabs.splice(i, 1);
  if (S.active >= S.tabs.length) S.active = S.tabs.length - 1;
  else if (i < S.active) S.active--;
  persistSession();
  renderAll();
}

/** Closing a tab from the UI asks first: the × is easy to hit by accident.
 *  A tab with unsaved changes skips this, closeTab() asks about saving anyway. */
async function askCloseTab(i) {
  const v = S.tabs[i];
  if (!v) return;
  if (!v.isDirty() && !(await confirmDlg(t('Fül bezárása'), t('Bezárod a(z) „{0}” fület?', v.title()), t('Bezárás')))) return;
  const idx = S.tabs.indexOf(v);
  if (idx >= 0) closeTab(idx);
}

async function askCloseOthers(v) {
  if (S.tabs.length < 2 || !(await confirmDlg(t('Fül bezárása'), t('Bezárod a többi fület ({0} db)?', S.tabs.length - 1), t('Bezárás')))) return;
  for (let k = S.tabs.length - 1; k >= 0; k--) if (S.tabs[k] !== v) await closeTab(k);
}

function switchTab(i) {
  if (i === S.active) return;
  S.active = i;
  persistSession();
  renderAll();
}

// ───────────────────────── rendering ─────────────────────────

function renderAll() {
  renderTabs();
  renderToolbar();
  renderContent();
  renderStatusbar();
}

const tabIcon = (v) => ({ text: 'files', folder: 'folders', hex: 'hex', image: 'image', dups: 'dups' }[v.kind] || 'file');

function renderTabs() {
  const el = document.getElementById('tabs');
  el.replaceChildren(
    ...S.tabs.map((v, i) => h('div.tab' + (i === S.active ? '.active' : ''), {
      title: v.tooltip(),
      on: {
        mousedown: (e) => { if (e.button === 1) { e.preventDefault(); askCloseTab(i); } },
        click: () => switchTab(i),
        contextmenu: (e) => contextMenu(e, [
          { label: t('Újratöltés'), icon: 'refresh', key: 'F5', action: () => { switchTab(i); v.reload(); } },
          { label: t('Oldalak felcserélése'), icon: 'swap', action: () => v.swap() },
          '-',
          { label: t('Bezárás'), icon: 'close', key: 'Ctrl+W', action: () => askCloseTab(i) },
          { label: t('A többi bezárása'), action: () => askCloseOthers(v) },
        ]),
      },
    }, icon(tabIcon(v)), h('span.name', v.title()), v.isDirty() ? h('span.tab-dirty', { title: t('Nem mentett módosítások') }, '●') : null,
    h('button.x', { title: t('Bezárás'), on: { click: (e) => { e.stopPropagation(); askCloseTab(i); } } }, icon('close')))),
    h('button.tab-add', { title: t('Új összehasonlítás'), on: { click: () => { S.active = -1; renderAll(); } } }, icon('plus')),
  );
}

function tb(label, ic, action, { disabled, title, menu } = {}) {
  const on = { click: action };
  if (menu) on.contextmenu = (e) => { e.preventDefault(); menu(e); };
  return h('button.tb', { disabled: disabled || null, title: title || label, on }, icon(ic), h('span', label));
}

function renderToolbar() {
  const el = document.getElementById('toolbar');
  const v = cur();
  const nextTheme = nextBasicTheme();
  const text = v?.kind === 'text';
  const nav = v && v.go && v.kind !== 'image';
  el.replaceChildren(
    h('div.repo-title', h('span.rn', v ? v.title() : 'DiffStar'),
      h('span.rb', icon(v ? tabIcon(v) : 'star'), v ? { text: t('Szöveg-összehasonlítás'), folder: t('Mappa-összehasonlítás'), hex: t('Bináris (hex) összehasonlítás'), image: t('Kép-összehasonlítás'), dups: t('Duplikátum-keresés') }[v.kind] : t('Fájl- és mappa-összehasonlító'))),
    h('div.tb-sep'),
    tb(t('Fájlok'), 'files', () => openDlg('files'), { title: t('Fájlok összehasonlítása (Ctrl+O)') }),
    tb(t('Mappák'), 'folders', () => openDlg('folders'), { title: t('Mappák összehasonlítása (Ctrl+Shift+O)') }),
    tb(t('Szöveg'), 'text', () => openTextScratch(), { title: t('Beillesztett szövegek összehasonlítása (Ctrl+N)') }),
    tb(t('Duplikátumok'), 'dups', () => openDups(), { title: t('Azonos tartalmú fájlok keresése egy vagy két mappában (Ctrl+Shift+D)') }),
    h('div.tb-sep'),
    tb(t('Előző'), 'up', () => v.go(-1), { disabled: !nav, title: t('Előző eltérés (Alt+↑)') }),
    tb(t('Következő'), 'down', () => v.go(1), { disabled: !nav, title: t('Következő eltérés (Alt+↓)') }),
    tb(t('Balra'), 'toLeft', () => v.copyCurrent('toL'), { disabled: !text || v.cur < 0, title: t('Az aktuális eltérés másolása balra (Alt+←)') }),
    tb(t('Jobbra'), 'toRight', () => v.copyCurrent('toR'), { disabled: !text || v.cur < 0, title: t('Az aktuális eltérés másolása jobbra (Alt+→)') }),
    tb(t('Mentés'), 'save', () => v.saveAll(), { disabled: !text || !v.canSave(), title: t('Módosított fájlok mentése (Ctrl+S)') }),
    h('div.tb-sep'),
    tb(t('Újratöltés'), 'refresh', () => v.reload(), { disabled: !v, title: t('Újratöltés / újra összehasonlítás (F5)') }),
    tb(t('Csere'), 'swap', () => v.swap(), { disabled: !v, title: t('Oldalak felcserélése') }),
    tb(t('Keresés'), 'find', () => v.openFind(), { disabled: !text, title: t('Keresés mindkét oldalon (Ctrl+F)') }),
    h('div.tb-spacer'),
    tb(t(THEME_UI[nextTheme][0]), THEME_UI[nextTheme][1], toggleTheme, { title: t('Váltás sötét és világos téma között (a többi téma a Beállításokban)') }),
    ...(S.donationVisible ? [h('span.tb-donate', tb(t('Adomány'), 'heart', () => openDonate(), { title: t('A DiffStar ingyenes. Ha hasznos neked, egy kis adománnyal támogathatod a fejlesztést.') }))] : []),
    tb(t('Beállítások'), 'settings', () => settingsDlg()),
    tb(t('Névjegy'), 'info', () => aboutDlg(), { title: t('A DiffStar névjegye (F1)') }),
  );
}

function renderStatusbar() {
  const el = document.getElementById('statusbar');
  const v = cur();
  el.replaceChildren(
    S.busy ? h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } }, icon('refresh', 'spin'), S.busyLabel || t('Folyamatban…'))
      : h('span', v ? v.tooltip().replace('\n', '  ↔  ') : t('Nincs megnyitott összehasonlítás')),
    h('span.grow'),
    ...(v ? v.status() : []),
    zoomNow() !== 1 ? h('span.zoom-status', { title: t('Nagyítás visszaállítása 100%-ra (Ctrl+0)'), on: { click: () => setZoom(1) } }, Math.round(zoomNow() * 100) + '%') : null,
    h('span', t('AI: {0}', aiKey() ? aiModel() : t('nincs beállítva'))),
    S.update?.updateAvailable ? h('span.update-status', { title: t('Kattints a telepítéshez'), on: { click: () => updateShowAvailable() } }, icon('fetch'), t('Frissítés elérhető: v{0}', S.update.latestVersion)) : null,
  );
}

function renderContent() {
  const el = document.getElementById('content');
  const v = cur();
  if (!v) { renderWelcome(el); return; }
  v.mount(el);
}

function renderWelcome(el) {
  const recent = S.settings.recent || [];
  const card = (ic, title, desc, key, action) => h('button.wl-card', { on: { click: action } }, icon(ic), h('b', title), h('span', desc), h('kbd', key));
  el.replaceChildren(h('div.welcome', h('div.welcome-box',
    h('h1', h('img', { src: 'img/icon.svg', alt: '' }), 'DiffStar'),
    h('div.lead', t('Fájlok, mappák, képek és bináris állományok összehasonlítása – vizuális diff, összefésülés, AI magyarázat.')),
    h('div.wl-cards',
      card('files', t('Fájlok'), t('Két fájl soronként, szavanként'), 'Ctrl+O', () => openDlg('files')),
      card('folders', t('Mappák'), t('Teljes mappaszerkezet, tartalom szerint'), 'Ctrl+Shift+O', () => openDlg('folders')),
      card('text', t('Szöveg'), t('Vágólapról beillesztett szövegek'), 'Ctrl+N', () => openTextScratch()),
      card('dups', t('Duplikátumok'), t('Azonos tartalmú fájlok, képek előnézettel'), 'Ctrl+Shift+D', () => openDups())),
    h('div.wl-drop', icon('open'), t('Húzz ide két fájlt vagy mappát az összehasonlításhoz.')),
    recent.length ? h('div.wl-h', t('Legutóbbi összehasonlítások')) : null,
    recent.length ? h('div.recent', recent.slice(0, 12).map((p, i) => h('div.recent-item', {
      title: `${p.left}\n${p.right}`,
      on: { click: () => (p.kind === 'folder' ? openFolders(p.left, p.right) : p.kind === 'dups' ? openDups([p.left, p.right]) : openPaths(p.left, p.right)) },
    }, icon(p.kind === 'folder' ? 'folders' : p.kind === 'dups' ? 'dups' : 'files'),
    h('div.ri', h('div', p.kind === 'dups' ? t('Duplikátumok: {0}', [p.left, p.right].filter(Boolean).map(basename).join(' + ')) : `${basename(p.left)}  ↔  ${basename(p.right)}`), h('div.p', [p.left, p.right].filter(Boolean).join('  ↔  '))),
    h('button.icon-btn.x', { title: t('Eltávolítás a listából'), on: { click: (e) => { e.stopPropagation(); S.settings.recent.splice(i, 1); saveLater(); renderWelcome(el); } } }, icon('close'))))) : null,
  )));
}

// ───────────────────────── AI panel ─────────────────────────

/** run(question, history) -> {text, truncated}; presets: quick follow-up questions */
function aiPanel(title, run, presets = []) {
  document.querySelector('.ai-panel')?.remove();
  if (!aiKey()) {
    toast(t('Az AI funkciókhoz add meg az API kulcsot (vagy válaszd a Claude Code CLI-t) a Beállításokban.'), 'err');
    settingsDlg('ai');
    return;
  }
  const history = [];
  const body = h('div.ai-body');
  const input = h('textarea.inp.ai-ask', { rows: 2, placeholder: t('Kérdezz az eltérésekről… (Enter: küldés, Shift+Enter: új sor)') });
  const send = h('button.btn.sm.ai', { on: { click: () => ask(input.value.trim()) } }, icon('sparkle'), t('Kérdés'));
  let busy = false;
  const ask = async (q) => {
    if (busy) return;
    busy = true;
    send.disabled = true;
    if (q) body.append(h('div.ai-q', q));
    input.value = '';
    const wait = h('div.ai-thinking', icon('sparkle', 'spin'), q ? t('Az AI válaszol…') : t('Az AI elemzi az eltéréseket…'));
    body.append(wait);
    wait.scrollIntoView({ block: 'end' });
    try {
      const res = await run(q || null, history.slice());
      wait.remove();
      history.push({ q: q || '', a: res.text });
      const out = h('div.ai-ans', { html: markdown(res.text) });
      body.append(out);
      if (res.truncated) body.append(h('div.ai-q', t('Megjegyzés: az anyag túl nagy volt, csak az eleje került elemzésre.')));
      out.scrollIntoView({ block: 'start' });
    } catch (e) {
      wait.replaceWith(h('div', { style: { color: 'var(--danger)' } }, String(e)));
    } finally { busy = false; send.disabled = false; input.focus(); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ask(input.value.trim()); } });
  const panel = h('div.ai-panel',
    h('div.pane-h', h('span.spark', icon('sparkle')), title, h('span.sub', ` · ${aiModel() || aiProviderName()}`), h('span.grow'),
      h('button.icon-btn', { title: t('Szöveg másolása'), on: { click: () => navigator.clipboard.writeText(body.innerText).then(() => toast(t('Vágólapra másolva'), 'ok', 1500)) } }, icon('copy')),
      h('button.icon-btn', { title: t('Bezárás'), on: { click: () => panel.remove() } }, icon('close'))),
    body,
    h('div.ai-foot',
      presets.length ? h('div.ai-presets', presets.map((p) => h('button.btn.sm', { on: { click: () => ask(p) } }, p))) : null,
      h('div.ai-askrow', input, send)));
  document.body.append(panel);
  ask('');
}

// ───────────────────────── about / donation ─────────────────────────

const DONATE_URL = 'https://www.c64va.pro/register/donate.php';
const SITE_URL = 'https://www.c64va.pro/diffstar.html';
function startDonationTimer() {
  let remaining = 10 * 60 * 1000;
  let started = null;
  let timer;
  const update = () => {
    clearTimeout(timer);
    if (started !== null) remaining -= performance.now() - started;
    started = null;
    if (remaining <= 0) {
      S.donationVisible = true;
      window.removeEventListener('focus', update);
      window.removeEventListener('blur', update);
      document.removeEventListener('visibilitychange', update);
      renderToolbar();
    } else if (!document.hidden && document.hasFocus()) {
      started = performance.now();
      timer = setTimeout(update, remaining);
    }
  };
  window.addEventListener('focus', update);
  window.addEventListener('blur', update);
  document.addEventListener('visibilitychange', update);
  update();
}

function openDonate() {
  invoke('open_url', { url: `${DONATE_URL}?lang=${getLang() === 'hu' ? 'hu' : 'en'}` }).catch((e) => toast(String(e), 'err'));
}

async function aboutDlg() {
  let info = {};
  try { info = await invoke('app_info'); } catch (e) { info = {}; }
  const ai = aiKey() ? `${aiProviderName()} · ${aiModel()}` : t('nincs beállítva');
  const rows = [
    [t('Verzió'), info.version || '?'],
    ['Tauri', info.tauri || '?'],
    [t('Rendszer'), info.os || '?'],
    ['AI', ai],
    [t('Beállítások fájl'), info.settings_path || '?'],
  ];
  const text = 'DiffStar ' + rows.map(([k, v]) => `${k}: ${v}`).join('\n');
  const features = [
    ['split', t('Egymás melletti diff')], ['files', t('Szó szintű kiemelés')], ['toRight', t('Összefésülés, szerkesztés')],
    ['folders', t('Mappa-összehasonlítás')], ['image', t('Kép és hex')], ['sparkle', t('AI magyarázat és tanács')], ['globe', t('Magyar / English')],
  ];
  const body = h('div.about',
    h('div.about-hero',
      h('div.about-logo', h('img', { src: 'img/icon.svg', alt: 'DiffStar' })),
      h('div.about-name', 'DiffStar'),
      h('div.about-ver', `v${info.version || '?'}`),
      h('div.about-tag', t('Fájl- és mappa-összehasonlító vizuális diff-fel, összefésüléssel és AI tanácsadóval.'))),
    h('div.about-feats', features.map(([ic, l]) => h('span.about-feat', icon(ic), l))),
    h('div.about-info', rows.map(([k, v]) => [h('span.k', k), h('span.v', { title: v }, v)]),
      h('span.k', t('Weboldal')), h('span.v', h('a.about-link', { title: SITE_URL, on: { click: () => invoke('open_url', { url: SITE_URL }).catch((e) => toast(String(e), 'err')) } }, SITE_URL.replace(/^https:\/\//, '')))),
    h('div.about-foot', t('Rust + Tauri 2. A GitStar testvérprogramja. AI: Anthropic Claude (API vagy Claude Code CLI) vagy DeepSeek.')),
    h('div.about-free', t('A DiffStar ingyenes (freeware). Ha hasznos neked, egy kis adománnyal támogathatod a fejlesztést. Köszönöm!')),
    h('div.about-copy', '© 2026 Zsolt Tarczali'));
  const res = await modal({ title: t('Névjegy'), body, buttons: [
    { label: t('Adomány'), value: 'donate' },
    { label: t('Frissítések keresése'), value: 'update' },
    { label: t('Beállítások mappa'), value: 'folder' },
    { label: t('Másolás'), value: 'copy' },
    { label: t('Bezárás'), value: false, primary: true },
  ] });
  if (res === 'update') checkForAppUpdate();
  if (res === 'donate') openDonate();
  if (res === 'copy') { await navigator.clipboard.writeText(text).catch(() => {}); toast(t('Vágólapra másolva')); }
  if (res === 'folder' && info.settings_path) invoke('reveal_in_explorer', { path: info.settings_path }).catch((e) => toast(String(e), 'err'));
}

// ───────────────────────── settings ─────────────────────────

async function settingsDlg(startTab) {
  const s = S.settings;
  const els = {};
  const fld = (name, label, el, note, full) => { els[name] = el; return h('label.field' + (full ? '.full' : ''), h('span', label), el, note ? h('span.note', note) : null); };
  const sel = (opts, val) => { const e = h('select.inp', opts.map(([v, l]) => h('option', { value: v }, l))); e.value = String(val); return e; };
  const chk = (name, label, val) => { const e = h('input', { type: 'checkbox', checked: !!val }); els[name] = e; return h('label.chk.full', e, label); };

  // ── AI (same as GitStar) ──
  const models = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'];
  const modelSel = sel([...models.map((m) => [m, m]), ['custom', t('Egyéb…')]], models.includes(s.ai_model) ? s.ai_model : 'custom');
  const customModel = h('input.inp', { value: models.includes(s.ai_model) ? '' : s.ai_model, placeholder: 'model id', style: { display: models.includes(s.ai_model) ? 'none' : '' } });
  modelSel.addEventListener('change', () => (customModel.style.display = modelSel.value === 'custom' ? '' : 'none'));
  const key = h('input.inp', { type: 'password', value: s.anthropic_api_key, placeholder: 'sk-ant-…', spellcheck: 'false' });
  const dsModels = ['deepseek-flash', 'deepseek-v4-pro'];
  const dsModel = s.deepseek_model || 'deepseek-flash';
  const dsKey = h('input.inp', { type: 'password', value: s.deepseek_api_key || '', placeholder: 'sk-…', spellcheck: 'false' });
  const dsModelSel = sel([...dsModels.map((m) => [m, m]), ['custom', t('Egyéb…')]], dsModels.includes(dsModel) ? dsModel : 'custom');
  const dsCustom = h('input.inp', { value: dsModels.includes(dsModel) ? '' : dsModel, placeholder: 'model id', style: { display: dsModels.includes(dsModel) ? 'none' : '' } });
  dsModelSel.addEventListener('change', () => (dsCustom.style.display = dsModelSel.value === 'custom' ? '' : 'none'));
  const providerSel = sel([['anthropic', 'Anthropic Claude (API key)'], ['claude-cli', t('Claude Code CLI (saját bejelentkezés)')], ['deepseek', 'DeepSeek']], s.ai_provider || 'anthropic');
  const cliPath = h('input.inp', { value: s.claude_cli_path || '', placeholder: t('üres = megkeresi (PATH, ~/.local/bin, Homebrew, npm)'), spellcheck: 'false' });
  const cliField = h('label.field.full', h('span', t('Claude CLI útvonala')), cliPath,
    h('span.note', t('A telepített Claude Code CLI-t (claude) futtatja a saját bejelentkezéseddel, így itt nem kell API kulcs. Bejelentkezés: futtasd egyszer a „claude” parancsot egy terminálban.')));
  const keyField = h('label.field.full', h('span', t('Anthropic API kulcs')), key, h('span.note', t('A kulcs a DiffStar beállításfájljában tárolódik ezen a gépen. Kulcs: console.anthropic.com')));
  const claudeBox = h('div.settings-sub.full', keyField, cliField,
    h('label.field', h('span', t('Modell')), modelSel, customModel, h('span.note', t('Alapértelmezés: claude-opus-5-5. Gyorsabb/olcsóbb: claude-haiku-5-5.'))));
  const dsBox = h('div.settings-sub.full',
    h('label.field.full', h('span', t('DeepSeek API kulcs')), dsKey, h('span.note', t('A kulcs a DiffStar beállításfájljában tárolódik ezen a gépen. Kulcs: platform.deepseek.com'))),
    h('label.field', h('span', t('Modell')), dsModelSel, dsCustom, h('span.note', t('Alapértelmezés: deepseek-flash. Erősebb: deepseek-v4-pro.'))));
  const syncProvider = () => {
    const ds = providerSel.value === 'deepseek', cli = providerSel.value === 'claude-cli';
    claudeBox.style.display = ds ? 'none' : ''; dsBox.style.display = ds ? '' : 'none';
    keyField.style.display = cli ? 'none' : ''; cliField.style.display = cli ? '' : 'none';
  };
  providerSel.addEventListener('change', syncProvider);
  syncProvider();
  const aiTestOut = h('span.note', '');
  const aiTestBtn = h('button.btn', { on: { click: async () => {
    const ds = providerSel.value === 'deepseek', cli = providerSel.value === 'claude-cli';
    const apiKey = (ds ? dsKey.value : cli ? cliPath.value : key.value).trim();
    const model = ds ? (dsModelSel.value === 'custom' ? dsCustom.value.trim() || 'deepseek-flash' : dsModelSel.value)
      : (modelSel.value === 'custom' ? customModel.value.trim() || 'claude-opus-5-5' : modelSel.value);
    if (!apiKey && !cli) { aiTestOut.className = 'note err'; aiTestOut.textContent = '✗ ' + t('Nincs megadva API kulcs.'); return; }
    aiTestBtn.disabled = true;
    aiTestOut.className = 'note';
    aiTestOut.textContent = t('Tesztelés…');
    try { aiTestOut.textContent = '✓ ' + (await invoke('ai_test', { provider: providerSel.value, apiKey, model })); aiTestOut.className = 'note ok'; }
    catch (e) { aiTestOut.textContent = '✗ ' + e; aiTestOut.className = 'note err'; }
    finally { aiTestBtn.disabled = false; }
  } } }, t('Teszt'));

  // ── update ──
  const updCheck = h('input', { type: 'checkbox', checked: s.update_check !== false });
  const updServer = h('input.inp', { value: s.update_server || '', placeholder: 'https://www.c64va.pro/', spellcheck: 'false' });
  const saveUpdServer = async () => {
    try { await invoke('update_server_check', { url: updServer.value }); } catch (e) { toast(String(e), 'err'); return; }
    S.settings.update_server = updServer.value.trim();
    await saveSettings();
    checkForAppUpdate();
  };

  // ── git difftool ──
  const exe = await invoke('exe_path').catch(() => '');
  const gitOut = h('span.note', '');
  const gitCmd = `git config --global diff.tool diffstar\ngit config --global difftool.diffstar.cmd "\\"${exe.replace(/\\/g, '/')}\\" \\"$LOCAL\\" \\"$REMOTE\\""\ngit config --global difftool.prompt false`;

  const tabs = [
    ['compare', t('Összehasonlítás'), h('div.settings-grid',
      fld('algorithm', t('Algoritmus'), sel([['patience', t('Patience (kódhoz ajánlott)')], ['myers', 'Myers'], ['lcs', 'LCS']], s.algorithm || 'patience'),
        t('A Patience a mozgatott/átrendezett kódot olvashatóbban párosítja.')),
      fld('inline_mode', t('Soron belüli kiemelés'), sel([['word', t('Szavanként')], ['char', t('Karakterenként')]], s.inline_mode || 'word')),
      fld('ignore_ws', t('Whitespace'), sel([['none', t('Számít')], ['change', t('A mennyisége nem számít')], ['all', t('Figyelmen kívül')]], s.ignore_ws || 'none')),
      fld('context', t('Kontextus sorok („Csak eltérések” módban)'), h('input.inp', { type: 'number', min: 0, max: 100, value: s.context ?? 3 })),
      chk('ignore_case', t('Kis- és nagybetűk egyformák'), s.ignore_case),
      chk('only_changes', t('Alapból csak az eltérések (azonos részek összecsukva)'), s.only_changes),
      fld('fallback_encoding', t('Kódolás nem UTF-8 fájlokhoz'), sel([['windows-1250', t('Windows-1250 (közép-európai)')], ['iso-8859-2', 'ISO-8859-2'], ['windows-1252', t('Windows-1252 (nyugat-európai)')], ['iso-8859-1', 'ISO-8859-1'], ['windows-1251', 'Windows-1251'], ['shift_jis', 'Shift_JIS'], ['gbk', 'GBK']], s.fallback_encoding || 'windows-1250'),
        t('BOM nélküli, nem érvényes UTF-8 fájlok így olvasódnak be.'), true),
      h('div.settings-sec', t('Mappák')),
      fld('dir_mode', t('Fájlok összehasonlítása'), sel([['content', t('Tartalom szerint (bájtonként)')], ['quick', t('Méret és dátum szerint (gyors)')]], s.dir_mode || 'content')),
      h('div'),
      fld('dir_ignore', t('Kihagyott nevek'), h('input.inp', { value: s.dir_ignore || '', spellcheck: 'false' }), t('Pontosvesszővel elválasztva, * és ? helyettesítő karakterrel. Pl.: .git;node_modules;*.tmp'), true),
      h('div.settings-sec', t('Munkamenet')),
      chk('restore_session', t('Induláskor a legutóbbi fülek visszaállítása'), s.restore_session !== false))],
    ['look', t('Megjelenés'), h('div.settings-grid',
      fld('ui_language', t('Felület nyelve'), sel([['auto', t('Automatikus (rendszer)')], ['hu', 'Magyar'], ['en', 'English']], s.ui_language || 'auto')),
      h('div'),
      fld('theme', t('Téma'), sel([['dark', t('Sötét')], ['light', t('Világos')], ['ai', 'AI (neon)'], ['retro', t('Retró (8 bites)')], ['modern', t('Modern (üveg)')], ['modern-dark', t('Modern sötét (üveg)')], ['system', t('Rendszer szerint')]], s.theme)),
      fld('font_size', t('Betűméret'), h('input.inp', { type: 'number', min: 10, max: 20, value: s.font_size })),
      fld('zoom', t('Nagyítás'), sel(ZOOMS.map((z) => [String(z), Math.round(z * 100) + '%']), String(ZOOMS.includes(zoomNow()) ? zoomNow() : 1)),
        t('Gyorsan: Ctrl + / Ctrl − / Ctrl 0, vagy Ctrl + egérgörgő.')))],
    ['ai', 'AI', h('div.settings-grid',
      h('label.field.full', h('span', t('AI szolgáltató')), h('div', { style: { display: 'flex', gap: '6px' } }, providerSel, aiTestBtn), aiTestOut),
      claudeBox, dsBox,
      fld('ai_language', t('AI válaszok nyelve'), sel([['hu', t('Magyar')], ['en', 'English']], s.ai_language)),
      h('div.note.full', t('Az AI gomb (szöveg- és mappa-összehasonlításnál) elmagyarázza az eltéréseket és tanácsot ad az összefésüléshez; utána kérdezhetsz is tőle. Csak az eltérések (diff) kerülnek elküldésre a választott szolgáltatónak.')))],
    ['git', 'Git', h('div.settings-grid',
      h('div.field.full', h('span', t('DiffStar mint git difftool')),
        h('span.note', t('Ezután a „git difftool” (és a GitStar külső diff-je) a DiffStarban nyitja meg a fájlpárokat; egy már futó DiffStar új fülön kapja meg őket.')),
        h('pre.cmd-box', gitCmd),
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('button.btn', { on: { click: async () => {
            try { await invoke('setup_git_difftool'); gitOut.className = 'note ok'; gitOut.textContent = '✓ ' + t('Beállítva a globális git konfigurációban.'); }
            catch (e) { gitOut.className = 'note err'; gitOut.textContent = '✗ ' + e; }
          } } }, t('Beállítás most')),
          h('button.btn', { on: { click: () => navigator.clipboard.writeText(gitCmd).then(() => toast(t('Vágólapra másolva'), 'ok', 1500)) } }, icon('copy'), t('Parancsok másolása'))),
        gitOut),
      h('div.field.full', h('span', t('Parancssor')), h('pre.cmd-box', `"${exe}" <bal> <jobb>\n"${exe}" <bal mappa> <jobb mappa>`)))],
    ['update', t('Frissítés'), h('div.settings-grid',
      h('label.chk.full', updCheck, t('Új verzió keresése induláskor')),
      h('label.field.full', h('span', t('Frissítési szerver')), h('div', { style: { display: 'flex', gap: '6px' } }, updServer,
        h('button.btn', { on: { click: () => saveUpdServer() } }, t('Keresés most'))),
        h('span.note', t('Elég a szerver címe (pl. https://www.c64va.pro/), a DiffStar a downloads/DiffStar/ mappában keresi a telepítőket. Más mappához add meg a teljes címét. Üres = alapértelmezett.'))))],
  ];
  const tabBtns = tabs.map(([id, label]) => h('button.stab', { type: 'button', 'data-label': label, on: { click: () => showTab(id) } }, label));
  const panes = h('div.settings-panes', ...tabs.map(([, , el]) => el));
  const showTab = (id) => {
    if (!tabs.some((x) => x[0] === id)) id = 'compare';
    tabs.forEach(([tid, , el], i) => { el.classList.toggle('on', tid === id); tabBtns[i].classList.toggle('on', tid === id); });
    uiSet('ds.settingsTab', id);
  };
  showTab(startTab || uiGet('ds.settingsTab') || 'compare');
  const body = h('div.settings', h('div.settings-tabs', ...tabBtns), panes);
  const ok = await modal({ title: t('Beállítások'), body, wide: true, buttons: [{ label: t('Mégse'), value: false }, { label: t('Mentés'), value: true, primary: true }] });
  if (!ok) return;
  Object.assign(S.settings, {
    algorithm: els.algorithm.value,
    inline_mode: els.inline_mode.value,
    ignore_ws: els.ignore_ws.value,
    context: Math.max(0, Math.min(100, +els.context.value || 0)),
    ignore_case: els.ignore_case.checked,
    only_changes: els.only_changes.checked,
    fallback_encoding: els.fallback_encoding.value,
    dir_mode: els.dir_mode.value,
    dir_ignore: els.dir_ignore.value.trim(),
    restore_session: els.restore_session.checked,
    theme: els.theme.value,
    ui_language: els.ui_language.value,
    font_size: Math.max(10, Math.min(20, +els.font_size.value || 13)),
    zoom: +els.zoom.value || 1,
    ai_provider: providerSel.value,
    anthropic_api_key: key.value.trim(),
    claude_cli_path: cliPath.value.trim(),
    deepseek_api_key: dsKey.value.trim(),
    deepseek_model: dsModelSel.value === 'custom' ? dsCustom.value.trim() || 'deepseek-flash' : dsModelSel.value,
    ai_model: modelSel.value === 'custom' ? customModel.value.trim() || 'claude-opus-5-5' : modelSel.value,
    ai_language: els.ai_language.value,
    update_check: updCheck.checked,
  });
  applyZoom();
  try { await invoke('update_server_check', { url: updServer.value }); S.settings.update_server = updServer.value.trim(); }
  catch (e) { toast(String(e), 'err'); }
  await saveSettings();
  applyLang();
  applyTheme();
  renderAll();
}

// ───────────────────────── self-update ─────────────────────────

let updBusy = false;

function updateDlgEls() {
  let ov = document.getElementById('update-ov');
  if (ov) return ov.els;
  const els = {
    title: h('div.modal-h'), msg: h('div.desc.update-msg'),
    bar: h('div.update-bar-fill'), text: h('div.update-progress-text'),
    skip: h('button.btn', t('Kihagyom ezt a verziót')),
    close: h('button.btn', t('Bezárás')),
    install: h('button.btn.primary', icon('fetch'), t('Telepítés most')),
  };
  els.prog = h('div.update-progress', h('div.update-bar', els.bar), els.text);
  ov = h('div.overlay#update-ov', h('div.modal.update-dlg', els.title, h('div.modal-b', els.msg, els.prog), h('div.modal-f', els.skip, els.close, els.install)));
  ov.els = els;
  const shut = () => { if (!updBusy) { ov.remove(); document.removeEventListener('keydown', onKey, true); } };
  function onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); } }
  els.close.addEventListener('click', shut);
  els.skip.addEventListener('click', () => { S.settings.update_skip = S.update?.latestVersion || ''; saveSettings(); shut(); });
  els.install.addEventListener('click', () => installUpdate());
  document.addEventListener('keydown', onKey, true);
  document.body.append(ov);
  return els;
}

function updateProgress(state, label = '') {
  const els = updateDlgEls();
  els.prog.style.display = state === null ? 'none' : '';
  els.bar.classList.toggle('indet', state === -1);
  els.bar.style.width = state >= 0 ? state + '%' : '';
  els.text.textContent = label;
}

function updateShow({ title, msg, install = false, skip = false, closeLabel = t('Bezárás') }) {
  const els = updateDlgEls();
  els.title.textContent = title;
  els.msg.textContent = msg;
  els.install.style.display = install ? '' : 'none';
  els.skip.style.display = skip ? '' : 'none';
  els.close.textContent = closeLabel;
  els.close.disabled = false;
  if (!install) updateProgress(null);
}

function updateShowAvailable() {
  const u = S.update;
  if (!u?.updateAvailable) return;
  updateShow({ title: t('Új verzió érhető el'),
    msg: t('Elérhető a DiffStar {0} (most: {1}). Letöltöm és telepítem? A DiffStar a telepítés után újraindul.', u.latestVersion, u.currentVersion),
    install: true, skip: true, closeLabel: t('Később') });
  updateProgress(null);
}

async function checkForAppUpdate({ silent = false } = {}) {
  if (updBusy) return;
  if (!silent) { updateShow({ title: t('Frissítések keresése'), msg: t('Új verzió keresése…') }); updateProgress(-1); }
  updBusy = true;
  let info;
  try { info = await invoke('check_for_update'); }
  catch (e) {
    updBusy = false;
    if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('A frissítés ellenőrzése nem sikerült: {0}', String(e)) });
    return;
  }
  updBusy = false;
  S.update = info;
  renderStatusbar();
  if (!info?.supported) { if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('Ezen a platformon nincs automatikus frissítés.') }); return; }
  if (!info.updateAvailable) { if (!silent) updateShow({ title: t('Frissítések keresése'), msg: t('A DiffStar naprakész (v{0}).', info.currentVersion) }); return; }
  if (silent && (S.settings.update_skip === info.latestVersion || document.querySelector('.overlay'))) return;
  updateShowAvailable();
}

async function installUpdate() {
  const u = S.update;
  if (updBusy || !u?.updateAvailable) return;
  if (S.tabs.some((v) => v.isDirty()) && !(await confirmDlg(t('Frissítés'), t('Nem mentett módosítások vannak. Biztosan frissítesz most?'), t('Frissítés')))) return;
  const els = updateDlgEls();
  updBusy = true;
  els.install.style.display = 'none';
  els.skip.style.display = 'none';
  els.close.disabled = true;
  els.msg.textContent = t('A DiffStar {0} letöltése…', u.latestVersion);
  updateProgress(-1);
  let unlisten = null;
  try {
    const mb = (n) => (n / 1048576).toFixed(1);
    unlisten = await window.__TAURI__.event.listen('update-download-progress', ({ payload: { received, total } }) => {
      if (total > 0) updateProgress(Math.min(100, Math.round((received * 100) / total)), `${mb(received)} / ${mb(total)} MB`);
      else updateProgress(-1, `${mb(received)} MB`);
    });
    const res = await invoke('download_and_install_update', { version: u.latestVersion });
    updateProgress(100);
    if (res.restarting) els.msg.textContent = t('A telepítő elindult, a DiffStar most bezárul és újraindul.');
    else {
      updBusy = false;
      updateShow({ title: t('Új verzió érhető el'), msg: t('A telepítő megnyílt ({0}). Fejezd be a telepítést, majd indítsd újra a DiffStart.', res.path) });
    }
  } catch (e) {
    updBusy = false;
    updateShow({ title: t('Új verzió érhető el'), msg: t('A frissítés nem sikerült: {0}', String(e)), install: true });
    updateProgress(null);
  } finally { unlisten?.(); }
}

// ───────────────────────── drag & drop ─────────────────────────

let dropHint = null;
function showDropHint(x) {
  if (!dropHint) {
    dropHint = h('div.drop-hint', h('div.dh.L', icon('open'), h('span', t('Bal oldal'))), h('div.dh.R', icon('open'), h('span', t('Jobb oldal'))));
    document.body.append(dropHint);
  }
  const left = x < innerWidth / 2;
  dropHint.classList.toggle('single', !cur());
  dropHint.querySelector('.L').classList.toggle('on', left);
  dropHint.querySelector('.R').classList.toggle('on', !left);
}
function hideDropHint() { dropHint?.remove(); dropHint = null; }

async function onDrop(paths, x) {
  hideDropHint();
  if (!paths?.length) return;
  if (paths.length >= 2) { await openPaths(paths[0], paths[1]); return; }
  const p = paths[0];
  const v = cur();
  const k = x < innerWidth / 2 ? 'L' : 'R';
  const st = await invoke('path_stat', { path: p }).catch(() => ({}));
  if (v && v.drop && ((v.kind === 'folder' || v.kind === 'dups') === !!st.is_dir)) { v.drop(k, p); return; }
  // nothing to drop into: a new tab with this one side filled
  if (st.is_dir) openFolders(k === 'L' ? p : '', k === 'L' ? '' : p);
  else await openFiles(k === 'L' ? p : '', k === 'L' ? '' : p);
}

async function setupDragDrop() {
  const wv = window.__TAURI__?.webview?.getCurrentWebview?.();
  if (!wv?.onDragDropEvent) return;
  await wv.onDragDropEvent((e) => {
    const p = e.payload;
    const x = p.position ? p.position.x / devicePixelRatio : innerWidth / 2;
    if (p.type === 'over' || p.type === 'enter') showDropHint(x);
    else if (p.type === 'drop') onDrop(p.paths, x);
    else hideDropHint();
  });
}

// ───────────────────────── launch arguments ─────────────────────────

async function handleLaunch() {
  const reqs = await invoke('take_launch_args').catch(() => []);
  for (const paths of reqs) {
    if (paths.length >= 2) await openPaths(paths[0], paths[1]);
    else if (paths.length === 1) await openPaths(paths[0], '');
  }
}

// ───────────────────────── boot ─────────────────────────

async function boot() {
  try { S.settings = await invoke('get_settings'); }
  catch (e) { S.settings = { theme: 'dark', diff_mode: 'split', context: 3, recent: [], session: [] }; toast(String(e), 'err'); }
  S.settings.ui_state ||= {};
  initUiState(S.settings.ui_state, debounce(() => saveSettings(), 300));
  applyLang();
  applyTheme();
  if (zoomNow() !== 1) applyZoom();
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (S.settings.theme === 'system') { applyTheme(); renderAll(); } });
  renderAll();
  startDonationTimer();

  // previous session, then whatever the command line asks for
  if (S.settings.restore_session !== false && S.settings.session?.length) {
    const want = S.settings.session_active;
    for (const p of S.settings.session) {
      if (p.kind === 'folder') S.tabs.push(new FolderCompare(ctx, p.left, p.right));
      else if (p.kind === 'dups') S.tabs.push(new DupView(ctx, [p.left, p.right]));
      else {
        const v = await makeFileView(p.left, p.right).catch(() => null);
        if (v) S.tabs.push(v);
      }
    }
    S.active = S.tabs.length ? Math.max(0, Math.min(S.tabs.length - 1, want ?? 0)) : -1;
    renderAll();
  }
  await handleLaunch();
  window.__TAURI__?.event?.listen('launch-args', () => handleLaunch());
  setupDragDrop().catch(() => {});

  // files changed by other programs: reload when the window gets focus
  let lastFocus = 0;
  window.addEventListener('focus', () => {
    if (Date.now() - lastFocus < 1000) return;
    lastFocus = Date.now();
    cur()?.checkExternal?.();
  });

  // unsaved edits: ask before the window closes
  const win = window.__TAURI__?.window?.getCurrentWindow?.();
  win?.onCloseRequested(async (e) => {
    const dirty = S.tabs.filter((v) => v.isDirty());
    if (!dirty.length) return;
    e.preventDefault();
    const res = await modal({ title: t('Nem mentett módosítások'), body: h('div.desc', t('{0} fülön nem mentett módosítások vannak:\n{1}', dirty.length, dirty.map((v) => '• ' + v.title()).join('\n'))),
      buttons: [{ label: t('Mégse'), value: null }, { label: t('Kilépés mentés nélkül'), value: 'quit', danger: true }, { label: t('Mentés és kilépés'), value: 'save', primary: true }] });
    if (!res) return;
    if (res === 'save') for (const v of dirty) if (!(await v.saveAll())) return;
    await saveSettings();
    win.destroy();
  });

  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = e.key, c = e.code;
      const dir = (k === '+' || k === '=' || c === 'NumpadAdd') ? 1 : (k === '-' || c === 'NumpadSubtract') ? -1 : (k === '0' || c === 'Numpad0') ? 0 : null;
      if (dir !== null) { e.preventDefault(); zoomStep(dir); return; }
    }
    if (document.querySelector('.overlay')) return;
    const v = cur();
    const inField = e.target.closest?.('input, textarea, [contenteditable="true"], [contenteditable="plaintext-only"]');
    const key = e.key.toLowerCase();
    if (e.key === 'F1') { e.preventDefault(); aboutDlg(); }
    else if (e.key === 'F5') { e.preventDefault(); v?.reload(); }
    else if (mod && key === 'o') { e.preventDefault(); openDlg(e.shiftKey ? 'folders' : 'files'); }
    else if (mod && e.shiftKey && key === 'd') { e.preventDefault(); openDups(); }
    else if (mod && key === 'n') { e.preventDefault(); openTextScratch(); }
    else if (mod && key === 'w') { e.preventDefault(); if (S.active >= 0) askCloseTab(S.active); }
    else if (mod && e.key === 'Tab' && S.tabs.length > 1) { e.preventDefault(); switchTab((S.active + (e.shiftKey ? S.tabs.length - 1 : 1)) % S.tabs.length); }
    else if (mod && key === ',') { e.preventDefault(); settingsDlg(); }
    else if (mod && key === 's' && v?.kind === 'text') { e.preventDefault(); v.saveAll(); }
    else if (mod && key === 'f' && v?.openFind) { e.preventDefault(); v.openFind(); }
    else if (mod && key === 'g' && v?.gotoDlg) { e.preventDefault(); v.gotoDlg(); }
    else if (inField) { /* typing: leave the keys alone */ }
    else if (mod && key === 'z' && !e.shiftKey && v?.undo) { e.preventDefault(); v.undo(); }
    else if (mod && (key === 'y' || (key === 'z' && e.shiftKey)) && v?.redo) { e.preventDefault(); v.redo(); }
    else if ((e.altKey && e.key === 'ArrowDown') || (e.key === 'F8' && !e.shiftKey)) { e.preventDefault(); v?.go?.(1); }
    else if ((e.altKey && e.key === 'ArrowUp') || (e.key === 'F8' && e.shiftKey)) { e.preventDefault(); v?.go?.(-1); }
    else if (e.altKey && e.key === 'ArrowRight' && v?.copyCurrent) { e.preventDefault(); v.copyCurrent('toR'); }
    else if (e.altKey && e.key === 'ArrowLeft' && v?.copyCurrent) { e.preventDefault(); v.copyCurrent('toL'); }
    else if (e.key === 'Escape') { const ai = document.querySelector('.ai-panel'); if (ai) ai.remove(); else if (v?.running && !document.querySelector('.overlay')) v.stop?.(); }
  });
  let wheelSum = 0, wheelLast = 0, wheelAt = 0;
  addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLast > 400) wheelSum = 0;
    wheelLast = now;
    wheelSum += e.deltaY;
    if (Math.abs(wheelSum) < 40 || now - wheelAt < 120) return;
    wheelAt = now;
    zoomStep(wheelSum < 0 ? 1 : -1);
    wheelSum = 0;
  }, { passive: false });
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    e.preventDefault();
    editMenu(e);
  });
  document.addEventListener('dragstart', (e) => { if (!e.target.closest?.('[draggable="true"]')) e.preventDefault(); });

  if (S.settings.update_check !== false) setTimeout(() => checkForAppUpdate({ silent: true }), 4000);
}

boot();
