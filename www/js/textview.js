// Text comparison view: side-by-side / unified, virtual scrolling, word-level
// highlights, folding of identical parts, merge (copy blocks between the
// sides), in-place line editing, undo / redo, find, go to line, export.

import { h, icon, esc, toast, contextMenu, modal, formDlg, invoke, basename, fmtDate } from './util.js';
import { t } from './i18n.js';

export const RH = 19;               // row height (px) when not wrapping
const WRAP_MAX_ROWS = 30000;        // wrapping renders every row: only up to this many
const isWin = /Windows/i.test(navigator.userAgent);

export const ENCODINGS = [
  ['utf-8', 'UTF-8'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE'],
  ['windows-1250', 'Windows-1250'], ['iso-8859-2', 'ISO-8859-2'], ['windows-1252', 'Windows-1252'],
  ['iso-8859-1', 'ISO-8859-1'], ['windows-1251', 'Windows-1251'], ['koi8-r', 'KOI8-R'],
  ['shift_jis', 'Shift_JIS'], ['gbk', 'GBK'], ['euc-kr', 'EUC-KR'],
];

export const fmtSize = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export function newSide(path = '') {
  return { path, name: path ? basename(path) : '', lines: [], finalNewline: true, encoding: 'utf-8', bom: false,
    eol: 'none', eolSave: isWin ? 'CRLF' : 'LF', size: 0, mtime: 0, dirty: false, lossy: false };
}

export function sideFromLoaded(f) {
  return { path: f.path, name: f.name, lines: f.lines, finalNewline: f.final_newline, encoding: f.encoding, bom: f.bom,
    eol: f.eol, eolSave: f.eol_save, size: f.size, mtime: f.mtime, dirty: false, lossy: f.lossy };
}

const encLabel = (sd) => (ENCODINGS.find((e) => e[0] === sd.encoding)?.[1] || sd.encoding.toUpperCase()) + (sd.bom && sd.encoding === 'utf-8' ? ' BOM' : '');
const SVG = {};
const svg = (name) => (SVG[name] ||= icon(name).outerHTML);

export class TextCompare {
  /** ctx: services of the app shell (settings, saveSettings, changed, ai, pickSave, pickFile, reopen) */
  constructor(ctx, left, right) {
    this.ctx = ctx;
    this.kind = 'text';
    this.L = left;
    this.R = right;
    this.res = null;
    this.rows = [];
    this.changes = [];     // [{bi, start, end}] row ranges of the change blocks
    this.cur = -1;         // current change (index into this.changes)
    this.expanded = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.find = null;
    this.editing = null;
    this.sx = 0;
    this.optKey = '';
    this.el = h('div.dv');
    this.built = false;
  }

  get s() { return this.ctx.settings(); }
  side(k) { return k === 'L' ? this.L : this.R; }
  pair() { return { kind: 'text', left: this.L.path, right: this.R.path }; }
  title() { return `${this.L.name || t('Névtelen')} ↔ ${this.R.name || t('Névtelen')}`; }
  tooltip() { return `${this.L.path || t('Névtelen')}\n${this.R.path || t('Névtelen')}`; }
  /** unsaved edits in a real file (untitled scratch sides never ask) */
  isDirty() { return (this.L.dirty && !!this.L.path) || (this.R.dirty && !!this.R.path); }
  opts() { const s = this.s; return { ignore_ws: s.ignore_ws, ignore_case: s.ignore_case, algorithm: s.algorithm, inline: s.inline_mode }; }

  // ───────────────────────── diff & rows ─────────────────────────

  async rediff() {
    const o = this.opts();
    this.optKey = JSON.stringify(o);
    const tok = (this.tok = Symbol());
    let res;
    try { res = await invoke('diff_text', { left: this.L.lines, right: this.R.lines, opts: o }); }
    catch (e) { toast(String(e), 'err'); return; }
    if (tok !== this.tok) return;
    this.res = res;
    const a = this.L.lines, b = this.R.lines;
    this.identical = a.length === b.length && this.L.finalNewline === this.R.finalNewline && a.every((x, i) => x === b[i]);
    this.measure();
    this.buildRows();
    if (this.cur >= this.changes.length) this.cur = this.changes.length - 1;
    if (this.built) { this.renderHead(); this.renderOpts(); this.renderBody(); }
    this.ctx.changed();
  }

  measure() {
    let m = 0;
    for (const ls of [this.L.lines, this.R.lines]) {
      for (const x of ls) {
        if (x.length * 4 <= m) continue;
        let n = x.length;
        for (let i = 0; i < x.length; i++) if (x.charCodeAt(i) === 9) n += 3;
        if (n > m) m = n;
      }
    }
    this.maxChars = m;
  }

  buildRows() {
    const s = this.s;
    const split = s.diff_mode !== 'unified';
    const only = !!s.only_changes;
    const ctxN = Math.max(0, s.context ?? 3);
    const rows = [], changes = [];
    const blocks = this.res?.blocks || [];
    blocks.forEach((b, bi) => {
      if (b.kind === 'eq') {
        const n = b.l1 - b.l0;
        const head = bi === 0 ? 0 : ctxN;
        const tail = bi === blocks.length - 1 ? 0 : ctxN;
        const eq = (k) => rows.push({ t: 'e', l: b.l0 + k, r: b.r0 + k });
        if (!only || n <= head + tail + 1 || this.expanded.has(bi)) { for (let k = 0; k < n; k++) eq(k); return; }
        for (let k = 0; k < head; k++) eq(k);
        rows.push({ t: 'f', bi, n: n - head - tail });
        for (let k = n - tail; k < n; k++) eq(k);
        return;
      }
      const start = rows.length;
      if (split) {
        b.rows.forEach(([x, y], k) => rows.push({ t: 'c', b: bi, k, l: x < 0 ? -1 : b.l0 + x, r: y < 0 ? -1 : b.r0 + y }));
      } else {
        b.rows.forEach(([x], k) => { if (x >= 0) rows.push({ t: 'd', b: bi, k, l: b.l0 + x, r: -1 }); });
        b.rows.forEach(([, y], k) => { if (y >= 0) rows.push({ t: 'a', b: bi, k, l: -1, r: b.r0 + y }); });
      }
      changes.push({ bi, start, end: rows.length });
    });
    this.rows = rows;
    this.changes = changes;
    if (this.find?.q) this.runFind(this.find.q, false);
  }

  curBlock() { return this.cur >= 0 && this.changes[this.cur] ? this.changes[this.cur].bi : -1; }

  // ───────────────────────── DOM ─────────────────────────

  build() {
    this.head = h('div.dv-head');
    this.optbar = h('div.diff-toolbar.dv-opts');
    this.vrows = h('div.dv-rows');
    this.inner = h('div.dv-inner', this.vrows);
    this.scroll = h('div.dv-scroll', this.inner);
    this.hbarIn = h('div');
    this.hbar = h('div.dv-hbar', this.hbarIn);
    this.mini = h('div.minimap');
    this.main = h('div.dv-main', this.scroll, this.hbar);
    this.body = h('div.dv-body', this.main, this.mini);
    this.el.replaceChildren(this.head, this.optbar, this.body);

    let raf = 0;
    this.scroll.addEventListener('scroll', () => {
      if (this.editing && !this.editing.x.isConnected) this.commitEdit(true);
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.paint(); this.updateViewport(); });
    }, { passive: true });
    this.hbar.addEventListener('scroll', () => {
      this.sx = this.hbar.scrollLeft;
      this.scroll.style.setProperty('--sx', this.sx + 'px');
    }, { passive: true });
    this.scroll.addEventListener('wheel', (e) => {
      if (this.wrap) return;
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      if (!dx || (!e.shiftKey && Math.abs(e.deltaX) < Math.abs(e.deltaY))) return;
      e.preventDefault();
      this.hbar.scrollLeft += dx;
    }, { passive: false });
    this.scroll.addEventListener('click', (e) => this.onClick(e));
    this.scroll.addEventListener('dblclick', (e) => {
      const cell = e.target.closest('.cd');
      if (cell) { e.preventDefault(); this.startEdit(cell, e); }
    });
    this.scroll.addEventListener('contextmenu', (e) => {
      const row = e.target.closest('.dr');
      if (!row || row.classList.contains('fold') || getSelection().toString()) return;
      this.rowMenu(e, +row.dataset.i, this.sideOfTarget(e.target, row));
    });
    new ResizeObserver(() => { if (this.el.isConnected) { this.paint(true); this.updateHbar(); this.updateViewport(); } }).observe(this.scroll);
    this.built = true;
  }

  /** Puts the view into the content area (the DOM is kept between tab switches). */
  mount(container) {
    if (!this.built) this.build();
    container.replaceChildren(this.el);
    this.renderHead();
    this.renderOpts();
    if (!this.res || this.optKey !== JSON.stringify(this.opts())) this.rediff();
    else { this.buildRows(); this.renderBody(); }
  }

  sideOfTarget(target, row) {
    const cell = target.closest('.cd, .ln');
    if (cell?.classList.contains('L')) return 'L';
    if (cell?.classList.contains('R')) return 'R';
    const r = this.rows[+row.dataset.i];
    return r?.t === 'a' ? 'R' : r?.t === 'd' ? 'L' : 'R';
  }

  // ───────────────────────── headers ─────────────────────────

  renderHead() {
    if (!this.built) return;
    this.head.replaceChildren(this.sideHead('L'),
      h('div.dv-mid', h('button.icon-btn', { title: t('Oldalak felcserélése'), on: { click: () => this.swap() } }, icon('swap'))),
      this.sideHead('R'));
  }

  sideHead(k) {
    const sd = this.side(k);
    const inp = h('input.inp.dv-path', {
      value: sd.path, spellcheck: 'false', placeholder: t('Fájl útvonala – vagy húzd ide a fájlt'),
      on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.loadSide(k, inp.value.trim()); } } },
    });
    const empty = !sd.path && !sd.lines.length;
    const meta = empty
      ? [h('span.dim', t('Üres oldal: illessz be szöveget, tallózz egy fájlt, vagy húzd ide.'))]
      : [
        h('a.dv-enc', { title: t('Kódolás – kattints a módosításhoz'), on: { click: (e) => this.encMenu(e, k) } }, encLabel(sd)),
        h('a.dv-enc', { title: t('Sorvége – kattints a módosításhoz'), on: { click: (e) => this.eolMenu(e, k) } }, sd.eol === 'mixed' ? t('vegyes ({0})', sd.eolSave) : sd.eol === 'none' ? sd.eolSave : sd.eol),
        h('span', t('{0} sor', sd.lines.length)),
        sd.path ? h('span', fmtSize(sd.size)) : null,
        sd.path && sd.mtime ? h('span', fmtDate(sd.mtime, true)) : null,
        sd.lossy ? h('span.warn', { title: t('A fájl nem érvényes ebben a kódolásban; a hibás bájtok helyén � áll.') }, '⚠ ' + t('hibás karakterek')) : null,
        sd.dirty ? h('span.dirty', '● ' + t('módosítva')) : null,
      ];
    return h('div.dv-side.' + k + (sd.dirty ? '.dirty' : ''),
      h('div.dv-side-row', inp,
        h('button.icon-btn', { title: t('Tallózás…'), on: { click: () => this.browse(k) } }, icon('open')),
        !sd.path ? h('button.icon-btn', { title: t('Beillesztés a vágólapról'), on: { click: () => this.pasteSide(k) } }, icon('copy')) : null,
        h('button.icon-btn', { title: t('Szerkesztés szövegként…'), on: { click: () => this.editAll(k) } }, icon('edit')),
        h('button.icon-btn' + (sd.dirty ? '.on' : ''), { title: t('Mentés (Ctrl+S)'), disabled: !(sd.dirty || (!sd.path && sd.lines.length)) || null, on: { click: () => this.save(k) } }, icon('save'))),
      h('div.dv-meta', meta));
  }

  encMenu(e, k) {
    const sd = this.side(k);
    const saveEnc = [['utf-8', false, 'UTF-8'], ['utf-8', true, 'UTF-8 BOM'], ['utf-16le', true, 'UTF-16 LE'], ['utf-16be', true, 'UTF-16 BE'],
      ['windows-1250', false, 'Windows-1250'], ['iso-8859-2', false, 'ISO-8859-2'], ['windows-1252', false, 'Windows-1252']];
    contextMenu(e, [
      sd.path ? { header: t('Újratöltés ezzel a kódolással') } : null,
      ...(sd.path ? ENCODINGS.map(([v, l]) => ({ label: l, icon: v === sd.encoding ? 'check' : null, action: () => this.loadSide(k, sd.path, v) })) : []),
      sd.path ? '-' : null,
      { header: t('Mentés ezzel a kódolással') },
      ...saveEnc.map(([v, bom, l]) => ({ label: l, icon: v === sd.encoding && bom === sd.bom ? 'check' : null, action: () => {
        if (sd.encoding === v && sd.bom === bom) return;
        Object.assign(sd, { encoding: v, bom, dirty: true });
        this.renderHead(); this.ctx.changed();
      } })),
    ]);
  }

  eolMenu(e, k) {
    const sd = this.side(k);
    contextMenu(e, [{ header: t('Sorvége mentéskor') }, ...['CRLF', 'LF', 'CR'].map((v) => ({
      label: { CRLF: 'CRLF (Windows)', LF: 'LF (Unix, macOS)', CR: 'CR (klasszikus Mac)' }[v], icon: sd.eolSave === v ? 'check' : null,
      action: () => { if (sd.eolSave !== v) { sd.eolSave = v; sd.dirty = true; this.renderHead(); this.ctx.changed(); } },
    }))]);
  }

  // ───────────────────────── options bar ─────────────────────────

  renderOpts() {
    if (!this.built) return;
    const s = this.s;
    const st = this.res?.stats;
    const n = this.changes.length;
    const sel = (opts, val, title, key, cast = String) => {
      const e = h('select.inp.dv-sel', { title, on: { change: (ev) => this.setPref(key, cast(ev.target.value)) } }, opts.map(([v, l]) => h('option', { value: v }, l)));
      e.value = String(val);
      return e;
    };
    const tog = (key, ic, title, label) => h('button.icon-btn' + (s[key] ? '.on' : ''), { title, on: { click: () => this.setPref(key, !s[key]) } }, ic ? icon(ic) : null, label ? h('b.tg', label) : null);
    const summary = !this.res ? h('span.dim', t('Összehasonlítás…'))
      : n === 0 ? h('span.dv-same', icon('check'), this.identical ? t('A két oldal azonos') : t('Nincs eltérés (a figyelmen kívül hagyott különbségeken kívül)'))
      : h('span.dv-sum', h('b', t('{0} eltérés', n)), ' ',
        h('span.stat-d', { title: t('Csak a bal oldalon') }, `−${st.deleted}`), ' ',
        h('span.stat-m', { title: t('Módosított sorok') }, `~${st.modified}`), ' ',
        h('span.stat-a', { title: t('Csak a jobb oldalon') }, `+${st.added}`),
        this.res.approximate ? h('span.warn', { title: t('Az összehasonlítás időkorlátba ütközött; az eredmény helyes, de nem feltétlenül a legrövidebb.') }, ' ≈') : null);
    this.optbar.replaceChildren(
      summary,
      n ? h('span.dv-pos', this.cur >= 0 ? `${this.cur + 1} / ${n}` : `– / ${n}`) : null,
      h('button.icon-btn', { disabled: !n || null, title: t('Előző eltérés (Alt+↑, Shift+F8)'), on: { click: () => this.go(-1) } }, icon('up')),
      h('button.icon-btn', { disabled: !n || null, title: t('Következő eltérés (Alt+↓, F8)'), on: { click: () => this.go(1) } }, icon('down')),
      h('span.tb-mini-sep'),
      h('button.icon-btn', { disabled: this.cur < 0 || null, title: t('Az aktuális eltérés másolása balra (Alt+←)'), on: { click: () => this.copyCurrent('toL') } }, icon('toLeft')),
      h('button.icon-btn', { disabled: this.cur < 0 || null, title: t('Az aktuális eltérés másolása jobbra (Alt+→)'), on: { click: () => this.copyCurrent('toR') } }, icon('toRight')),
      h('button.icon-btn', { disabled: !this.undoStack.length || null, title: t('Visszavonás (Ctrl+Z)'), on: { click: () => this.undo() } }, icon('undo')),
      h('button.icon-btn', { disabled: !this.redoStack.length || null, title: t('Újra (Ctrl+Y)'), on: { click: () => this.redo() } }, icon('redo')),
      h('span.grow'),
      tog('only_changes', 'fold', t('Csak az eltérések (az azonos részek összecsukva)')),
      s.only_changes ? sel([[0, t('0 sor')], [1, t('1 sor')], [3, t('3 sor')], [5, t('5 sor')], [10, t('10 sor')], [25, t('25 sor')]], s.context, t('Kontextus sorok az eltérések körül'), 'context', Number) : null,
      sel([['none', t('Szóköz: számít')], ['change', t('Szóköz: mennyiség nem számít')], ['all', t('Szóköz: figyelmen kívül')]], s.ignore_ws, t('Whitespace kezelése'), 'ignore_ws'),
      tog('ignore_case', null, t('Kis- és nagybetűk egyformák'), 'Aa'),
      tog('show_ws', 'pilcrow', t('Szóközök és tabulátorok megjelenítése')),
      tog('wrap', 'wrap', t('Sortörés')),
      h('span.seg',
        h('button' + (s.diff_mode !== 'unified' ? '.on' : ''), { title: t('Egymás melletti nézet'), on: { click: () => this.setPref('diff_mode', 'split') } }, t('Osztott')),
        h('button' + (s.diff_mode === 'unified' ? '.on' : ''), { title: t('Egyesített nézet'), on: { click: () => this.setPref('diff_mode', 'unified') } }, t('Egyesített'))),
      h('button.btn.sm.ai', { disabled: !n || null, title: t('Az eltérések magyarázata AI-jal'), on: { click: () => this.aiExplain() } }, icon('sparkle'), 'AI'),
      h('button.icon-btn', { title: t('Exportálás…'), on: { click: (e) => this.exportMenu(e) } }, icon('export')),
    );
  }

  setPref(key, v) {
    const s = this.s;
    s[key] = v;
    this.ctx.saveSettings();
    if (['ignore_ws', 'ignore_case', 'algorithm', 'inline_mode'].includes(key)) { this.renderOpts(); this.rediff(); return; }
    if (['only_changes', 'context', 'diff_mode'].includes(key)) {
      const anchor = this.topLine();
      this.buildRows();
      this.renderBody();
      this.scrollToLine(anchor);
    } else this.renderBody();
    this.renderOpts();
  }

  /** The line at the top of the view, to keep the place when the rows change. */
  topLine() {
    const i = this.rowAt(this.scroll?.scrollTop || 0);
    const r = this.rows[i];
    return r ? (r.l >= 0 ? { k: 'L', n: r.l } : r.r >= 0 ? { k: 'R', n: r.r } : null) : null;
  }

  scrollToLine(a, center = false) {
    if (!a) return;
    const key = a.k === 'L' ? 'l' : 'r';
    let best = -1;
    for (let i = 0; i < this.rows.length; i++) { const v = this.rows[i][key]; if (v >= 0 && v <= a.n) best = i; if (v > a.n) break; }
    if (best >= 0) this.scrollToRow(best, center);
  }

  // ───────────────────────── body ─────────────────────────

  renderBody() {
    if (!this.built) return;
    const s = this.s;
    const split = s.diff_mode !== 'unified';
    if (s.wrap && this.rows.length > WRAP_MAX_ROWS && !this.wrapWarned) { this.wrapWarned = true; toast(t('Túl sok sor a sortöréshez ({0}); a sortörés ki van kapcsolva ennél az összehasonlításnál.', this.rows.length)); }
    this.wrap = !!s.wrap && this.rows.length <= WRAP_MAX_ROWS;
    this.scroll.className = 'dv-scroll ' + (split ? 'split' : 'unified') + (this.wrap ? ' wrap' : '') + (s.show_ws ? ' showws' : '');
    const digits = String(Math.max(this.L.lines.length, this.R.lines.length, 1)).length;
    this.scroll.style.setProperty('--lnw', Math.max(3, digits) * 7.5 + 14 + 'px');
    if (!this.res) { this.inner.style.height = ''; this.vrows.style.transform = ''; this.vrows.innerHTML = `<div class="diff-msg">${esc(t('Összehasonlítás…'))}</div>`; return; }
    if (!this.rows.length) {
      this.inner.style.height = ''; this.vrows.style.transform = '';
      this.vrows.innerHTML = `<div class="diff-msg">${esc(t('Mindkét oldal üres.'))}</div>`;
      this.mini.replaceChildren();
      this.updateHbar();
      return;
    }
    this.inner.style.height = this.wrap ? '' : this.rows.length * RH + 'px';
    this.pa = this.pb = -1;
    this.paint(true);
    this.renderMinimap();
    this.updateHbar();
  }

  rowAt(y) {
    if (!this.wrap) return Math.max(0, Math.min(this.rows.length - 1, Math.floor(y / RH)));
    for (const el of this.vrows.children) if (el.offsetTop + el.offsetHeight > y) return +el.dataset.i || 0;
    return 0;
  }

  paint(force = false) {
    if (!this.built || !this.res || !this.rows.length) return;
    if (this.editing) return;
    const n = this.rows.length;
    if (this.wrap) {
      if (force) { this.vrows.style.transform = ''; this.vrows.innerHTML = this.rowsHtml(0, n); }
      return;
    }
    const top = this.scroll.scrollTop, hgt = this.scroll.clientHeight || 800;
    const a = Math.max(0, Math.floor(top / RH) - 10), b = Math.min(n, Math.ceil((top + hgt) / RH) + 10);
    if (!force && a >= this.pa && b <= this.pb) return;
    this.pa = Math.max(0, a - 40);
    this.pb = Math.min(n, b + 40);
    this.vrows.style.transform = `translateY(${this.pa * RH}px)`;
    this.vrows.innerHTML = this.rowsHtml(this.pa, this.pb);
  }

  rowsHtml(a, b) {
    let out = '';
    for (let i = a; i < b; i++) out += this.rowHtml(i);
    return out;
  }

  fmt(s) {
    const e = esc(s);
    return this.s.show_ws ? e.replace(/ /g, '<i class="ws">·</i>').replace(/\t/g, '<i class="ws">→</i>\t') : e;
  }

  segs(list) {
    let out = '';
    for (const [txt, ch] of list) out += ch ? `<span class="hl">${this.fmt(txt)}</span>` : this.fmt(txt);
    return out;
  }

  rowHtml(i) {
    const r = this.rows[i];
    const L = this.L.lines, R = this.R.lines;
    const hit = this.find?.set?.has(i) ? (this.find.hits[this.find.i] === i ? ' hit hitcur' : ' hit') : '';
    if (r.t === 'f') {
      return `<div class="dr fold" data-i="${i}">${svg('fold')}<span>${esc(t('{0} azonos sor – kattints a kibontáshoz', r.n))}</span></div>`;
    }
    const cur = r.b != null && r.b === this.curBlock() ? ' cur' : '';
    if (this.s.diff_mode !== 'unified') {
      if (r.t === 'e') {
        const soft = L[r.l] !== R[r.r] ? ' soft' : '';
        return `<div class="dr${soft}${hit}" data-i="${i}"><div class="ln L">${r.l + 1}</div><div class="cd L"><span class="x">${this.fmt(L[r.l])}</span></div><div class="gt"></div><div class="ln R">${r.r + 1}</div><div class="cd R"><span class="x">${this.fmt(R[r.r])}</span></div></div>`;
      }
      const blk = this.res.blocks[r.b];
      const inl = blk.inline[r.k];
      const kind = r.l >= 0 && r.r >= 0 ? 'm' : r.l >= 0 ? 'd' : 'a';
      const lc = r.l >= 0 ? `<div class="ln L del">${r.l + 1}</div><div class="cd L del"><span class="x">${inl ? this.segs(inl[0]) : this.fmt(L[r.l])}</span></div>` : '<div class="ln L emp"></div><div class="cd L emp"><span class="x"></span></div>';
      const rc = r.r >= 0 ? `<div class="ln R add">${r.r + 1}</div><div class="cd R add"><span class="x">${inl ? this.segs(inl[1]) : this.fmt(R[r.r])}</span></div>` : '<div class="ln R emp"></div><div class="cd R emp"><span class="x"></span></div>';
      const gt = r.k === 0
        ? `<div class="gt"><button class="mg" data-act="toR" data-b="${r.b}" title="${esc(t('Másolás jobbra (Alt+→)'))}">${svg('toRight')}</button><button class="mg" data-act="toL" data-b="${r.b}" title="${esc(t('Másolás balra (Alt+←)'))}">${svg('toLeft')}</button></div>`
        : '<div class="gt"></div>';
      const first = r.k === 0 ? ' first' : '';
      const last = i + 1 >= this.rows.length || this.rows[i + 1].b !== r.b ? ' last' : '';
      return `<div class="dr chg ${kind}${cur}${first}${last}${hit}" data-i="${i}">${lc}${gt}${rc}</div>`;
    }
    // unified
    if (r.t === 'e') {
      return `<div class="dr u${hit}" data-i="${i}"><div class="ln L">${r.l + 1}</div><div class="ln R">${r.r + 1}</div><div class="mk"></div><div class="cd U"><span class="x">${this.fmt(R[r.r])}</span></div></div>`;
    }
    const blk = this.res.blocks[r.b];
    const inl = blk.inline[r.k];
    const del = r.t === 'd';
    const code = inl ? this.segs(inl[del ? 0 : 1]) : this.fmt(del ? L[r.l] : R[r.r]);
    const first = i === 0 || this.rows[i - 1].b !== r.b ? ' first' : '';
    const last = i + 1 >= this.rows.length || this.rows[i + 1].b !== r.b ? ' last' : '';
    return `<div class="dr u chg ${del ? 'd' : 'a'}${cur}${first}${last}${hit}" data-i="${i}"><div class="ln L ${del ? 'del' : ''}">${del ? r.l + 1 : ''}</div><div class="ln R ${del ? '' : 'add'}">${del ? '' : r.r + 1}</div><div class="mk">${del ? '−' : '+'}</div><div class="cd U ${del ? 'del' : 'add'}"><span class="x">${code}</span></div></div>`;
  }

  charW() {
    const probe = h('span.dv-probe', '0'.repeat(100));
    this.scroll.append(probe);
    const w = probe.getBoundingClientRect().width / 100 || 7.2;
    probe.remove();
    return w;
  }

  updateHbar() {
    if (this.wrap || !this.rows.length) { this.hbar.style.display = 'none'; this.scroll.style.setProperty('--sx', '0px'); return; }
    const cell = this.vrows.querySelector('.cd');
    const codeW = cell ? cell.clientWidth : this.scroll.clientWidth / 2;
    const range = Math.max(0, Math.ceil(this.maxChars * this.charW() + 28 - codeW));
    this.hbar.style.display = range > 0 ? '' : 'none';
    this.hbarIn.style.width = this.hbar.clientWidth + range + 'px';
    if (this.hbar.scrollLeft > range) this.hbar.scrollLeft = range;
    this.sx = range > 0 ? this.hbar.scrollLeft : 0;
    this.scroll.style.setProperty('--sx', this.sx + 'px');
  }

  renderMinimap() {
    const mini = this.mini;
    const n = this.rows.length;
    const kids = [];
    let prev = null;
    for (const c of this.changes) {
      for (let i = c.start; i < c.end; i++) {
        const r = this.rows[i];
        const k = r.t === 'a' ? 'a' : r.t === 'd' ? 'd' : r.l >= 0 && r.r >= 0 ? 'm' : r.l >= 0 ? 'd' : 'a';
        if (prev && prev.k === k && prev.end === i) { prev.end = i + 1; continue; }
        prev = { k, start: i, end: i + 1 };
        kids.push(prev);
      }
    }
    this.vp = h('div.vp');
    mini.replaceChildren(...kids.map((m) => h('i.' + m.k, { style: { top: (m.start / n) * 100 + '%', height: `max(2px, ${((m.end - m.start) / n) * 100}%)` } })), this.vp);
    if (!mini._bound) {
      mini._bound = true;
      const go = (e) => {
        const rect = mini.getBoundingClientRect();
        this.scroll.scrollTop = ((e.clientY - rect.top) / rect.height) * this.scroll.scrollHeight - this.scroll.clientHeight / 2;
      };
      mini.addEventListener('mousedown', (e) => {
        go(e);
        const mv = (ev) => go(ev);
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
        addEventListener('mousemove', mv);
        addEventListener('mouseup', up);
      });
    }
    this.updateViewport();
  }

  updateViewport() {
    if (!this.vp) return;
    const sc = this.scroll;
    const sh = Math.max(1, sc.scrollHeight);
    this.vp.style.top = (sc.scrollTop / sh) * 100 + '%';
    this.vp.style.height = Math.min(100, (sc.clientHeight / sh) * 100) + '%';
  }

  scrollToRow(i, center = true) {
    const sc = this.scroll;
    let y;
    if (this.wrap) { const el = this.vrows.querySelector(`[data-i="${i}"]`); y = el ? el.offsetTop : 0; }
    else y = i * RH;
    sc.scrollTop = center ? y - sc.clientHeight / 3 : y;
    this.paint(true);
  }

  // ───────────────────────── navigation ─────────────────────────

  go(dir) {
    const n = this.changes.length;
    if (!n) return;
    if (this.cur < 0) {
      const top = this.rowAt(this.scroll.scrollTop);
      if (dir > 0) { const k = this.changes.findIndex((c) => c.start >= top); this.cur = k < 0 ? n - 1 : k; }
      else { let k = -1; this.changes.forEach((c, i) => { if (c.start < top) k = i; }); this.cur = k < 0 ? 0 : k; }
    } else this.cur = Math.max(0, Math.min(n - 1, this.cur + dir));
    this.scrollToRow(this.changes[this.cur].start);
    this.renderOpts();
    this.ctx.changed();
  }

  first() { if (this.changes.length) { this.cur = 0; this.scrollToRow(this.changes[0].start); this.renderOpts(); } }

  onClick(e) {
    const mg = e.target.closest('button.mg');
    if (mg) { e.stopPropagation(); this.copyBlock(+mg.dataset.b, mg.dataset.act); return; }
    const row = e.target.closest('.dr');
    if (!row) return;
    const r = this.rows[+row.dataset.i];
    if (r?.t === 'f') { this.expanded.add(r.bi); const a = this.topLine(); this.buildRows(); this.renderBody(); this.scrollToLine(a); return; }
    if (r?.b != null && !getSelection().toString()) {
      const k = this.changes.findIndex((c) => c.bi === r.b);
      if (k >= 0 && k !== this.cur) { this.cur = k; this.paint(true); this.renderOpts(); this.ctx.changed(); }
    }
  }

  // ───────────────────────── editing ─────────────────────────

  edit(k, fn) {
    const sd = this.side(k);
    this.undoStack.push({ k, lines: sd.lines.slice(), dirty: sd.dirty, fnl: sd.finalNewline });
    if (this.undoStack.length > 300) this.undoStack.shift();
    this.redoStack = [];
    fn(sd.lines, sd);
    sd.dirty = true;
    this.rediff();
  }

  undo() { this.swapState(this.undoStack, this.redoStack); }
  redo() { this.swapState(this.redoStack, this.undoStack); }
  swapState(from, to) {
    const u = from.pop();
    if (!u) return;
    const sd = this.side(u.k);
    to.push({ k: u.k, lines: sd.lines, dirty: sd.dirty, fnl: sd.finalNewline });
    Object.assign(sd, { lines: u.lines, dirty: u.dirty, finalNewline: u.fnl });
    this.rediff();
  }

  copyBlock(bi, dir) {
    const b = this.res?.blocks[bi];
    if (!b || b.kind !== 'chg') return;
    if (dir === 'toR') this.edit('R', (ls) => ls.splice(b.r0, b.r1 - b.r0, ...this.L.lines.slice(b.l0, b.l1)));
    else this.edit('L', (ls) => ls.splice(b.l0, b.l1 - b.l0, ...this.R.lines.slice(b.r0, b.r1)));
  }

  copyCurrent(dir) { const bi = this.curBlock(); if (bi >= 0) this.copyBlock(bi, dir); }

  copyAll(dir) {
    const [src, k] = dir === 'toR' ? [this.L, 'R'] : [this.R, 'L'];
    this.edit(k, (ls, sd) => { ls.splice(0, ls.length, ...src.lines); sd.finalNewline = src.finalNewline; });
  }

  /** Where a new line goes when typing into the empty (padding) cell of a change row. */
  insertPos(r, k) {
    const b = this.res.blocks[r.b];
    const col = k === 'L' ? 0 : 1;
    for (let j = r.k + 1; j < b.rows.length; j++) if (b.rows[j][col] >= 0) return (k === 'L' ? b.l0 : b.r0) + b.rows[j][col];
    return k === 'L' ? b.l1 : b.r1;
  }

  startEdit(cell, ev) {
    if (this.editing) this.commitEdit();
    const rowEl = cell.closest('.dr');
    const r = this.rows[+rowEl.dataset.i];
    if (!r || r.t === 'f') return;
    let k = cell.classList.contains('L') ? 'L' : cell.classList.contains('R') ? 'R' : r.t === 'd' ? 'L' : 'R';
    const idx = k === 'L' ? r.l : r.r;
    const sd = this.side(k);
    let insert = null;
    if (idx < 0) { if (r.t !== 'c') return; insert = this.insertPos(r, k); }
    const x = cell.querySelector('.x');
    const orig = idx >= 0 ? sd.lines[idx] : '';
    x.textContent = orig;
    try { x.contentEditable = 'plaintext-only'; } catch { x.contentEditable = 'true'; }
    cell.classList.add('editing');
    this.editing = { k, idx, insert, x, orig };
    x.focus();
    // caret where the user clicked
    try {
      const rg = document.caretRangeFromPoint?.(ev.clientX, ev.clientY);
      if (rg && x.contains(rg.startContainer)) { const sel = getSelection(); sel.removeAllRanges(); sel.addRange(rg); }
    } catch { /* caret at the start */ }
    x.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); this.commitEdit(); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.commitEdit(true); }
      else if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '\t'); }
      e.stopPropagation();
    });
    x.addEventListener('blur', () => this.commitEdit(), { once: true });
  }

  commitEdit(cancel = false) {
    const e = this.editing;
    if (!e) return;
    this.editing = null;
    const txt = e.x.innerText.replace(/\r\n?/g, '\n').replace(/\n$/, '');
    e.x.contentEditable = 'false';
    e.x.closest('.cd')?.classList.remove('editing');
    if (cancel || (e.insert == null && txt === e.orig) || (e.insert != null && txt === '')) { this.paint(true); return; }
    const parts = txt.split('\n');
    if (e.insert != null) this.edit(e.k, (ls) => ls.splice(e.insert, 0, ...parts));
    else this.edit(e.k, (ls) => ls.splice(e.idx, 1, ...parts));
  }

  rowMenu(e, i, k) {
    const r = this.rows[i];
    const sd = this.side(k);
    const idx = k === 'L' ? r.l : r.r;
    const inChg = r.b != null;
    const sideName = k === 'L' ? t('bal') : t('jobb');
    contextMenu(e, [
      { header: t('{0} oldal', sideName) },
      idx >= 0 ? { label: t('Sor szerkesztése'), icon: 'edit', key: t('Dupla katt.'), action: () => {
        const cell = this.vrows.querySelector(`.dr[data-i="${i}"] .cd${this.s.diff_mode === 'unified' ? '' : '.' + k}`);
        if (cell) this.startEdit(cell, e);
      } } : null,
      idx >= 0 ? { label: t('Üres sor beszúrása alá'), icon: 'plus', action: () => this.edit(k, (ls) => ls.splice(idx + 1, 0, '')) } : null,
      idx >= 0 ? { label: t('Sor törlése'), icon: 'minus', danger: true, action: () => this.edit(k, (ls) => ls.splice(idx, 1)) } : null,
      idx >= 0 ? { label: t('Sor másolása'), icon: 'copy', action: () => navigator.clipboard.writeText(sd.lines[idx]).catch(() => {}) } : null,
      inChg ? '-' : null,
      inChg ? { label: t('Eltérés másolása jobbra'), icon: 'toRight', key: 'Alt+→', action: () => this.copyBlock(r.b, 'toR') } : null,
      inChg ? { label: t('Eltérés másolása balra'), icon: 'toLeft', key: 'Alt+←', action: () => this.copyBlock(r.b, 'toL') } : null,
      '-',
      { label: t('Minden eltérés másolása jobbra'), icon: 'toRight', action: () => this.copyAll('toR') },
      { label: t('Minden eltérés másolása balra'), icon: 'toLeft', action: () => this.copyAll('toL') },
      '-',
      { label: t('Szerkesztés szövegként…'), icon: 'edit', action: () => this.editAll(k) },
      { label: t('Ugrás sorra… (Ctrl+G)'), icon: 'goto', action: () => this.gotoDlg() },
    ]);
  }

  async editAll(k) {
    const sd = this.side(k);
    const ta = h('textarea.inp.dv-edit-all', { spellcheck: 'false', wrap: 'off' });
    ta.value = sd.lines.join('\n');
    const ok = await modal({
      title: t('{0} oldal szerkesztése', k === 'L' ? t('Bal') : t('Jobb')) + (sd.name ? ` – ${sd.name}` : ''),
      body: ta, wide: true,
      buttons: [{ label: t('Mégse'), value: false }, { label: t('Alkalmaz'), value: true, primary: true }],
    });
    if (!ok) return;
    const lines = ta.value.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length === 1 && lines[0] === '' && !sd.lines.length) return;
    this.edit(k, (ls) => ls.splice(0, ls.length, ...lines));
  }

  async pasteSide(k) {
    let txt = '';
    try { txt = await invoke('clipboard_text'); } catch (e) { toast(t('A vágólap üres vagy nem szöveg.'), 'err'); return; }
    if (!txt) { toast(t('A vágólap üres vagy nem szöveg.'), 'err'); return; }
    const lines = txt.replace(/\r\n?/g, '\n').split('\n');
    if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    this.edit(k, (ls) => ls.splice(0, ls.length, ...lines));
  }

  // ───────────────────────── files ─────────────────────────

  async browse(k) {
    const p = await this.ctx.pickFile(k === 'L' ? t('Bal oldali fájl') : t('Jobb oldali fájl'), this.side(k).path || this.side(k === 'L' ? 'R' : 'L').path);
    if (p) this.loadSide(k, p);
  }

  async loadSide(k, path, encoding) {
    const sd = this.side(k);
    if (!path) return;
    if (sd.dirty && sd.path && !(await this.ctx.confirm(t('Nem mentett módosítások'), t('A(z) „{0}” módosításai elvesznek. Folytatod?', sd.name), t('Elvetés')))) return;
    let f;
    try { f = await invoke('load_file', { path, encoding: encoding || null }); }
    catch (e) { toast(String(e), 'err'); return; }
    if (f.kind !== 'text') {
      // binary / image: the app reopens the pair in the right view
      const other = this.side(k === 'L' ? 'R' : 'L').path;
      this.ctx.reopen(this, k === 'L' ? path : other, k === 'L' ? other : path);
      return;
    }
    const ns = sideFromLoaded(f);
    if (k === 'L') this.L = ns; else this.R = ns;
    this.undoStack = this.undoStack.filter((u) => u.k !== k);
    this.redoStack = this.redoStack.filter((u) => u.k !== k);
    this.expanded.clear();
    this.cur = -1;
    this.ctx.remember();
    await this.rediff();
    if (this.L.path && this.R.path) this.first();
  }

  async reload(force = false) {
    if (!force && this.isDirty() && !(await this.ctx.confirm(t('Újratöltés'), t('A nem mentett módosítások elvesznek. Újratöltöd a fájlokat?'), t('Újratöltés')))) return;
    for (const k of ['L', 'R']) {
      const sd = this.side(k);
      if (!sd.path) continue;
      try {
        const f = await invoke('load_file', { path: sd.path, encoding: null });
        if (f.kind === 'text') { const ns = sideFromLoaded(f); if (k === 'L') this.L = ns; else this.R = ns; }
      } catch (e) { toast(String(e), 'err'); }
    }
    this.undoStack = [];
    this.redoStack = [];
    await this.rediff();
  }

  /** Window got focus: reload sides changed on disk (unless edited here). */
  async checkExternal() {
    for (const k of ['L', 'R']) {
      const sd = this.side(k);
      if (!sd.path) continue;
      const st = await invoke('path_stat', { path: sd.path }).catch(() => null);
      if (!st?.exists || Math.abs(st.mtime - sd.mtime) < 0.001) continue;
      if (sd.dirty) {
        if (sd.warnedMtime !== st.mtime) { sd.warnedMtime = st.mtime; toast(t('A(z) „{0}” megváltozott a lemezen, de itt is módosítottad. Mentés felülírja.', sd.name), 'err'); }
        continue;
      }
      try {
        const f = await invoke('load_file', { path: sd.path, encoding: null });
        if (f.kind !== 'text') continue;
        const ns = sideFromLoaded(f);
        if (k === 'L') this.L = ns; else this.R = ns;
        toast(t('Újratöltve (megváltozott a lemezen): {0}', sd.name), 'ok');
        await this.rediff();
      } catch { /* deleted or locked: keep what we have */ }
    }
  }

  async save(k, as = false) {
    const sd = this.side(k);
    let path = sd.path;
    if (!path || as) {
      path = await this.ctx.pickSave(t('Mentés másként'), sd.path || 'untitled.txt');
      if (!path) return false;
    }
    const req = { path, lines: sd.lines, final_newline: sd.finalNewline, encoding: sd.encoding, bom: sd.bom, eol: sd.eolSave };
    let st;
    try { st = await invoke('save_file', { req }); }
    catch (e) {
      if (sd.encoding !== 'utf-8' && !sd.encoding.startsWith('utf-16')
        && await this.ctx.confirm(t('Mentés'), String(e) + '\n\n' + t('Mented UTF-8 kódolással?'), t('Mentés UTF-8-ként'))) {
        sd.encoding = 'utf-8';
        sd.bom = false;
        return this.save(k, as);
      }
      toast(String(e), 'err');
      return false;
    }
    Object.assign(sd, { path, name: basename(path), size: st.size, mtime: st.mtime, dirty: false });
    toast(t('Mentve: {0}', sd.name), 'ok', 1800);
    this.renderHead();
    this.ctx.remember();
    this.ctx.changed();
    return true;
  }

  async saveAll() {
    for (const k of ['L', 'R']) {
      const sd = this.side(k);
      if (sd.dirty && sd.path && !(await this.save(k))) return false;
    }
    return true;
  }

  canSave() { return (this.L.dirty && this.L.path) || (this.R.dirty && this.R.path); }

  swap() {
    [this.L, this.R] = [this.R, this.L];
    this.undoStack = this.undoStack.map((u) => ({ ...u, k: u.k === 'L' ? 'R' : 'L' }));
    this.redoStack = this.redoStack.map((u) => ({ ...u, k: u.k === 'L' ? 'R' : 'L' }));
    this.ctx.remember();
    this.rediff();
  }

  /** A file dropped on the left or right half of the view. */
  drop(k, path) { this.loadSide(k, path); }

  // ───────────────────────── find / go to ─────────────────────────

  openFind() {
    if (!this.findBar) {
      const inp = h('input.inp', { placeholder: t('Keresés mindkét oldalon…'), spellcheck: 'false' });
      const cnt = h('span.cnt');
      inp.addEventListener('input', () => this.runFind(inp.value, true));
      inp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.nextHit(e.shiftKey ? -1 : 1); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.closeFind(); }
      });
      this.findBar = h('div.dv-find', icon('find'), inp, cnt,
        h('button.icon-btn', { title: t('Előző (Shift+Enter)'), on: { click: () => this.nextHit(-1) } }, icon('up')),
        h('button.icon-btn', { title: t('Következő (Enter)'), on: { click: () => this.nextHit(1) } }, icon('down')),
        h('button.icon-btn', { title: t('Bezárás (Esc)'), on: { click: () => this.closeFind() } }, icon('close')));
      this.findBar.inp = inp;
      this.findBar.cnt = cnt;
    }
    this.body.append(this.findBar);
    this.findBar.inp.focus();
    this.findBar.inp.select();
  }

  closeFind() { this.findBar?.remove(); this.find = null; this.paint(true); }

  runFind(q, jump) {
    const hits = [];
    const ql = q.toLowerCase();
    if (ql) {
      const L = this.L.lines, R = this.R.lines;
      this.rows.forEach((r, i) => {
        if (r.t === 'f') return;
        if ((r.l >= 0 && L[r.l].toLowerCase().includes(ql)) || (r.r >= 0 && R[r.r].toLowerCase().includes(ql))) hits.push(i);
      });
    }
    this.find = { q, hits, set: new Set(hits), i: -1 };
    if (jump && hits.length) {
      const top = this.rowAt(this.scroll.scrollTop);
      const k = hits.findIndex((x) => x >= top);
      this.find.i = k < 0 ? 0 : k;
      this.scrollToRow(hits[this.find.i]);
    } else this.paint(true);
    this.updateFindCount();
  }

  nextHit(dir) {
    const f = this.find;
    if (!f?.hits.length) return;
    f.i = (f.i + dir + f.hits.length) % f.hits.length;
    this.scrollToRow(f.hits[f.i]);
    this.updateFindCount();
  }

  updateFindCount() {
    if (!this.findBar) return;
    const f = this.find;
    this.findBar.cnt.textContent = !f?.q ? '' : f.hits.length ? `${f.i + 1 || '–'} / ${f.hits.length}` : t('nincs találat');
    this.findBar.classList.toggle('none', !!f?.q && !f.hits.length);
  }

  async gotoDlg() {
    const v = await formDlg(t('Ugrás sorra'), [
      { name: 'line', label: t('Sor száma'), type: 'number', value: '' },
      { name: 'side', label: t('Oldal'), type: 'select', options: [{ value: 'L', label: t('Bal') }, { value: 'R', label: t('Jobb') }] },
    ], t('Ugrás'));
    const n = parseInt(v?.line, 10);
    if (!n) return;
    const k = v.side;
    const key = k === 'L' ? 'l' : 'r';
    const target = Math.min(Math.max(1, n), this.side(k).lines.length) - 1;
    if (!this.res) return;
    // inside a folded part: unfold it first
    this.res.blocks.forEach((b, bi) => {
      const [a0, a1] = k === 'L' ? [b.l0, b.l1] : [b.r0, b.r1];
      if (b.kind === 'eq' && target >= a0 && target < a1) this.expanded.add(bi);
    });
    this.buildRows();
    this.renderBody();
    const i = this.rows.findIndex((r) => r[key] === target);
    if (i >= 0) {
      this.scrollToRow(i);
      requestAnimationFrame(() => this.vrows.querySelector(`.dr[data-i="${i}"]`)?.classList.add('flash'));
    }
  }

  // ───────────────────────── AI / export ─────────────────────────

  names() {
    return [this.L.path || t('bal (névtelen)'), this.R.path || t('jobb (névtelen)')];
  }

  aiExplain() {
    const [ln, rn] = this.names();
    this.ctx.ai(t('AI: eltérések és tanácsok'), (question, history) => invoke('ai_explain', { left: this.L.lines, right: this.R.lines, leftName: ln, rightName: rn, question, history }),
      [t('Melyik oldalt tartsam meg?'), t('Van benne hiba vagy kockázat?'), t('Hogyan fésüljem össze?')]);
  }

  exportMenu(e) {
    contextMenu(e, [
      { label: t('HTML jelentés mentése…'), icon: 'export', action: () => this.exportHtml() },
      { label: t('Unified diff mentése (.patch)…'), icon: 'file', action: () => this.exportPatch() },
      { label: t('Unified diff másolása'), icon: 'copy', action: () => this.copyPatch() },
    ]);
  }

  async patch() {
    const [ln, rn] = this.names();
    return invoke('unified_patch', { left: this.L.lines, right: this.R.lines, leftName: ln, rightName: rn, context: 3 });
  }

  async copyPatch() {
    try { await navigator.clipboard.writeText(await this.patch()); toast(t('Vágólapra másolva'), 'ok', 1500); } catch (e) { toast(String(e), 'err'); }
  }

  async exportPatch() {
    const path = await this.ctx.pickSave(t('Unified diff mentése'), (this.R.name || 'diff') + '.patch', [{ name: 'Patch', extensions: ['patch', 'diff'] }]);
    if (!path) return;
    try { await invoke('write_text_file', { path, text: await this.patch() }); toast(t('Mentve: {0}', basename(path)), 'ok'); } catch (e) { toast(String(e), 'err'); }
  }

  async exportHtml() {
    const path = await this.ctx.pickSave(t('HTML jelentés mentése'), 'diffstar-report.html', [{ name: 'HTML', extensions: ['html', 'htm'] }]);
    if (!path) return;
    try { await invoke('write_text_file', { path, text: this.reportHtml() }); toast(t('Mentve: {0}', basename(path)), 'ok'); } catch (e) { toast(String(e), 'err'); }
  }

  reportHtml() {
    const L = this.L.lines, R = this.R.lines;
    const st = this.res?.stats || {};
    const seg = (list, fallback) => (list ? list.map(([s, c]) => (c ? `<span class="hl">${esc(s)}</span>` : esc(s))).join('') : esc(fallback));
    const body = [];
    const max = 200000;
    // always the side-by-side layout, with the folding the view uses
    const rows = [];
    (this.res?.blocks || []).forEach((b, bi) => {
      if (b.kind === 'eq') {
        const n = b.l1 - b.l0, c = this.s.only_changes ? this.s.context : Infinity;
        if (n > 2 * c + 1) {
          const head = bi === 0 ? 0 : c, tail = bi === this.res.blocks.length - 1 ? 0 : c;
          for (let k = 0; k < head; k++) rows.push(['e', b.l0 + k, b.r0 + k]);
          rows.push(['f', n - head - tail]);
          for (let k = n - tail; k < n; k++) rows.push(['e', b.l0 + k, b.r0 + k]);
        } else for (let k = 0; k < n; k++) rows.push(['e', b.l0 + k, b.r0 + k]);
      } else b.rows.forEach(([x, y], k) => rows.push(['c', x < 0 ? -1 : b.l0 + x, y < 0 ? -1 : b.r0 + y, b.inline[k]]));
    });
    for (const r of rows.slice(0, max)) {
      if (r[0] === 'f') { body.push(`<tr class="f"><td colspan="4">… ${esc(t('{0} azonos sor', r[1]))} …</td></tr>`); continue; }
      if (r[0] === 'e') { body.push(`<tr><td class="n">${r[1] + 1}</td><td>${esc(L[r[1]])}</td><td class="n">${r[2] + 1}</td><td>${esc(R[r[2]])}</td></tr>`); continue; }
      const [, l, rr, inl] = r;
      body.push(`<tr class="c"><td class="n">${l >= 0 ? l + 1 : ''}</td><td class="${l >= 0 ? 'd' : 'x'}">${l >= 0 ? seg(inl?.[0], L[l]) : ''}</td><td class="n">${rr >= 0 ? rr + 1 : ''}</td><td class="${rr >= 0 ? 'a' : 'x'}">${rr >= 0 ? seg(inl?.[1], R[rr]) : ''}</td></tr>`);
    }
    const [ln, rn] = this.names();
    const now = new Date().toLocaleString();
    return `<!doctype html><html><head><meta charset="utf-8"><title>DiffStar – ${esc(this.title())}</title><style>
body{font:13px/1.45 "Segoe UI",system-ui,sans-serif;margin:24px;color:#1f2328;background:#fff}
h1{font-size:18px;margin:0 0 6px}.meta{color:#5d6672;margin-bottom:14px}.meta b{color:#1f2328}
table{border-collapse:collapse;width:100%;table-layout:fixed;font:12px/18px Consolas,"Cascadia Mono",monospace}
td{padding:0 6px;white-space:pre-wrap;word-break:break-all;vertical-align:top;border-bottom:1px solid #f0f1f3}
td.n{width:48px;text-align:right;color:#8b939e;background:#f6f8fa;user-select:none}
td.d{background:#ffebe9}td.a{background:#e6ffec}td.x{background:repeating-linear-gradient(45deg,#fff 0 6px,#f3f4f6 6px 12px)}
td.d .hl{background:#ffc1bc;border-radius:2px}td.a .hl{background:#abf2bc;border-radius:2px}
tr.f td{text-align:center;color:#4a6fb5;background:#eef4ff;font-family:"Segoe UI",sans-serif}
.s-d{color:#d33a3a}.s-a{color:#1f9d55}.s-m{color:#b7791f}
</style></head><body><h1>DiffStar – ${esc(this.title())}</h1>
<div class="meta"><b>${esc(t('Bal'))}:</b> ${esc(ln)}<br><b>${esc(t('Jobb'))}:</b> ${esc(rn)}<br>
${esc(t('{0} eltérés', this.changes.length))} · <span class="s-d">−${st.deleted ?? 0}</span> <span class="s-m">~${st.modified ?? 0}</span> <span class="s-a">+${st.added ?? 0}</span> · ${esc(now)}</div>
<table><colgroup><col style="width:48px"><col><col style="width:48px"><col></colgroup>${body.join('')}</table>
${rows.length > max ? `<p>${esc(t('A jelentés az első {0} sornál véget ér.', max))}</p>` : ''}
</body></html>`;
  }

  // ───────────────────────── statusbar ─────────────────────────

  status() {
    const st = this.res?.stats;
    return [
      h('span', t('Bal: {0} sor', this.L.lines.length) + ' · ' + t('Jobb: {0} sor', this.R.lines.length)),
      st ? h('span', this.changes.length ? t('{0} eltérés', this.changes.length) : t('azonos')) : null,
    ];
  }
}
