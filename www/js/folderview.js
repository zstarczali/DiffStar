// Folder comparison view: two folder trees side by side (Beyond Compare
// style), status filters, virtual list, copy left ↔ right, opens file pairs.

import { h, icon, esc, toast, contextMenu, invoke, basename, fmtDate } from './util.js';
import { t } from './i18n.js';
import { fmtSize } from './textview.js';
import { IMG_THUMB, wantThumb, lazyThumb } from './thumbs.js';

const VIEWS = [
  ['details', 'viewList', () => t('Részletek (fa)')],
  ['small', 'viewSmall', () => t('Kis ikonok')],
  ['large', 'viewLarge', () => t('Nagy ikonok (képek előnézetével)')],
];
const GLYPH = { same: '=', diff: '≠', left: '◀', right: '▶', error: '!' };

const ROW = 24;
const SEP = /[\\/]/.test(navigator.platform) || /Windows/i.test(navigator.userAgent) ? '\\' : '/';
const join = (base, rel) => (rel ? base.replace(/[\\/]+$/, '') + SEP + rel.split('/').join(SEP) : base);

export class FolderCompare {
  constructor(ctx, left, right) {
    this.ctx = ctx;
    this.kind = 'folder';
    this.left = left || '';
    this.right = right || '';
    this.res = null;
    this.running = false;
    this.expanded = new Set();
    this.show = { same: true, diff: true, left: true, right: true };
    this.q = '';
    this.sel = '';
    this.flat = [];
    this.view = ctx.uiGet('ds.fview') || 'details';
    this.cwd = ''; // the folder shown by the icon views
    this.el = h('div.fv');
    this.built = false;
  }

  get s() { return this.ctx.settings(); }
  pair() { return { kind: 'folder', left: this.left, right: this.right }; }
  title() { return `${basename(this.left) || '?'} ↔ ${basename(this.right) || '?'}`; }
  tooltip() { return `${this.left}\n${this.right}`; }
  isDirty() { return false; }

  build() {
    this.head = h('div.dv-head');
    this.optbar = h('div.diff-toolbar.fv-opts');
    this.cols = h('div.fv-row.fv-cols',
      h('div.c.nm', t('Név')), h('div.c.sz', t('Méret')), h('div.c.dt', t('Módosítva')),
      h('div.c.st'),
      h('div.c.nm', t('Név')), h('div.c.sz', t('Méret')), h('div.c.dt', t('Módosítva')));
    this.vrows = h('div.dv-rows');
    this.inner = h('div.dv-inner', this.vrows);
    this.scroll = h('div.fv-scroll', { tabindex: '0' }, this.inner);
    this.crumbs = h('div.fv-crumbs');
    this.tiles = h('div.fv-tiles', { tabindex: '0' });
    this.el.replaceChildren(this.head, this.optbar, this.cols, this.crumbs, this.scroll, this.tiles);
    const tileOf = (e) => { const el = e.target.closest('.ft[data-rel]'); return el ? this.byRel(el.dataset.rel) : null; };
    this.tiles.addEventListener('click', (e) => { const x = tileOf(e); if (x) this.selectTile(x.rel); else if (e.target.closest('.ft.up')) this.goUp(); });
    this.tiles.addEventListener('dblclick', (e) => { const x = tileOf(e); if (x) this.activate(x); });
    this.tiles.addEventListener('contextmenu', (e) => { const x = tileOf(e); if (!x) return; this.selectTile(x.rel); this.menu(e, x); });
    this.tiles.addEventListener('keydown', (e) => this.onTileKey(e));
    let raf = 0;
    this.scroll.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.paint(); }); }, { passive: true });
    this.scroll.addEventListener('click', (e) => {
      const r = e.target.closest('.fv-row[data-i]');
      if (!r) return;
      const it = this.flat[+r.dataset.i];
      if (e.target.closest('.tw') && it.e.is_dir) { this.toggle(it.e); return; }
      this.select(it.e.rel);
    });
    this.scroll.addEventListener('dblclick', (e) => {
      const r = e.target.closest('.fv-row[data-i]');
      if (r) this.activate(this.flat[+r.dataset.i].e);
    });
    this.scroll.addEventListener('contextmenu', (e) => {
      const r = e.target.closest('.fv-row[data-i]');
      if (!r) return;
      const it = this.flat[+r.dataset.i];
      this.select(it.e.rel);
      this.menu(e, it.e);
    });
    this.scroll.addEventListener('keydown', (e) => this.onKey(e));
    new ResizeObserver(() => { if (this.el.isConnected) this.paint(true); }).observe(this.scroll);
    this.built = true;
  }

  mount(container) {
    if (!this.built) this.build();
    container.replaceChildren(this.el);
    this.renderHead();
    this.renderOpts();
    if (!this.res && !this.running && this.left && this.right) this.run();
    else this.renderList();
  }

  renderHead() {
    const side = (k) => {
      const inp = h('input.inp.dv-path', {
        value: k === 'L' ? this.left : this.right, spellcheck: 'false', placeholder: t('Mappa útvonala – vagy húzd ide a mappát'),
        on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.setSide(k, inp.value.trim()); } } },
      });
      const c = this.res?.root?.counts;
      return h('div.dv-side.' + k,
        h('div.dv-side-row', inp,
          h('button.icon-btn', { title: t('Tallózás…'), on: { click: () => this.browse(k) } }, icon('open')),
          h('button.icon-btn', { title: t('Megnyitás a fájlkezelőben'), disabled: !(k === 'L' ? this.left : this.right) || null, on: { click: () => invoke('reveal_in_explorer', { path: k === 'L' ? this.left : this.right }).catch((e) => toast(String(e), 'err')) } }, icon('folder'))),
        h('div.dv-meta', c ? h('span', k === 'L' ? t('{0} fájl csak itt', c.left) : t('{0} fájl csak itt', c.right)) : h('span.dim', ' ')));
    };
    this.head.replaceChildren(side('L'),
      h('div.dv-mid', h('button.icon-btn', { title: t('Oldalak felcserélése'), on: { click: () => this.swap() } }, icon('swap'))),
      side('R'));
  }

  renderOpts() {
    const c = this.res?.root?.counts || { same: 0, diff: 0, left: 0, right: 0 };
    const s = this.s;
    const flt = (key, cls, label, n, title) => h('button.fv-flt.k-' + cls + (this.show[key] ? '.on' : ''), { title, on: { click: () => { this.show[key] = !this.show[key]; this.renderOpts(); this.renderList(); } } }, h('i'), label, h('b', String(n)));
    const mode = h('select.inp.dv-sel', { title: t('Összehasonlítás módja'), on: { change: (e) => { s.dir_mode = e.target.value; this.ctx.saveSettings(); this.run(); } } },
      h('option', { value: 'content' }, t('Tartalom szerint')), h('option', { value: 'quick' }, t('Méret és dátum szerint')));
    mode.value = s.dir_mode || 'content';
    const filter = h('input.inp.fv-q', { value: this.q, placeholder: t('Szűrés névre…'), spellcheck: 'false', on: { input: (e) => { this.q = e.target.value; this.renderList(); } } });
    this.optbar.replaceChildren(
      this.running
        ? h('button.btn.sm.danger', { on: { click: () => invoke('cancel_compare') } }, icon('stop'), t('Leállítás'))
        : h('button.btn.sm.primary', { disabled: !(this.left && this.right) || null, title: t('Összehasonlítás újra (F5)'), on: { click: () => this.run() } }, icon('refresh'), t('Összehasonlítás')),
      this.running ? h('span.dim.fv-prog', t('Folyamatban…')) : null,
      mode,
      h('span.tb-mini-sep'),
      flt('same', 'same', t('Azonos'), c.same, t('Azonos fájlok mutatása')),
      flt('diff', 'diff', t('Eltérő'), c.diff, t('Eltérő fájlok mutatása')),
      flt('left', 'left', t('Csak bal'), c.left, t('Csak a bal oldalon lévő fájlok mutatása')),
      flt('right', 'right', t('Csak jobb'), c.right, t('Csak a jobb oldalon lévő fájlok mutatása')),
      h('span.grow'),
      h('button.btn.sm.ai', { disabled: !this.res || this.running || !(c.diff + c.left + c.right) || null, title: t('A mappák eltéréseinek elemzése és tanácsok AI-jal'), on: { click: () => this.aiExplain() } }, icon('sparkle'), 'AI'),
      h('button.btn.sm', { disabled: !(this.left || this.right) || null, title: t('Azonos tartalmú fájlok keresése a két mappában (és mappán belül)'), on: { click: () => this.ctx.openDups([this.left, this.right].filter(Boolean)) } }, icon('dups'), t('Duplikátumok')),
      filter,
      this.view === 'details' ? h('button.icon-btn', { title: t('Mind kibontása'), on: { click: () => this.expandAll(true) } }, icon('expand')) : null,
      this.view === 'details' ? h('button.icon-btn', { title: t('Mind összecsukása'), on: { click: () => this.expandAll(false) } }, icon('fold')) : null,
      h('div.fv-views', VIEWS.map(([v, ic, label]) => h('button.icon-btn' + (this.view === v ? '.on' : ''), { title: label(), on: { click: () => this.setView(v) } }, icon(ic)))),
    );
  }

  async browse(k) {
    const p = await this.ctx.pickFolder(k === 'L' ? t('Bal oldali mappa') : t('Jobb oldali mappa'), (k === 'L' ? this.left : this.right) || undefined);
    if (p) this.setSide(k, p);
  }

  setSide(k, p) {
    if (!p) return;
    if (k === 'L') this.left = p; else this.right = p;
    this.res = null;
    this.ctx.remember();
    this.renderHead();
    if (this.left && this.right) this.run(); else this.renderOpts();
    this.ctx.changed();
  }

  drop(k, path) { this.setSide(k, path); }

  swap() {
    [this.left, this.right] = [this.right, this.left];
    this.ctx.remember();
    this.renderHead();
    this.run();
  }

  async run() {
    if (!this.left || !this.right) return;
    if (this.running) return;
    this.running = true;
    this.renderOpts();
    this.ctx.setBusy(true, t('Mappák összehasonlítása…'));
    const timer = setInterval(async () => {
      const n = await invoke('compare_progress').catch(() => 0);
      const p = this.optbar.querySelector('.fv-prog');
      if (p) p.textContent = t('{0} fájl összehasonlítva…', n);
    }, 250);
    const s = this.s;
    let res = null;
    try { res = await invoke('compare_dirs', { left: this.left, right: this.right, opts: { mode: s.dir_mode || 'content', ignore: s.dir_ignore || '' } }); }
    catch (e) { toast(String(e), 'err'); }
    clearInterval(timer);
    this.running = false;
    this.ctx.setBusy(false);
    if (res) {
      const first = !this.res;
      this.res = res;
      if (res.cancelled) toast(t('Az összehasonlítás leállítva – az eredmény hiányos.'), 'err');
      if (first && !this.expanded.size) this.autoExpand();
    }
    this.renderHead();
    this.renderOpts();
    this.renderList();
    this.ctx.changed();
  }

  /** First view: open the folders that hold differences (if not too many). */
  autoExpand() {
    let budget = 400;
    const walk = (e, depth) => {
      for (const c of e.children) {
        if (!c.is_dir || budget <= 0) continue;
        if (c.status !== 'same' && depth < 3) { this.expanded.add(c.rel); budget -= c.children.length; walk(c, depth + 1); }
      }
    };
    walk(this.res.root, 0);
  }

  expandAll(on) {
    if (!this.res) return;
    this.expanded.clear();
    if (on) {
      const walk = (e) => { for (const c of e.children) if (c.is_dir) { this.expanded.add(c.rel); walk(c); } };
      walk(this.res.root);
    }
    this.renderList();
  }

  toggle(e) {
    if (this.expanded.has(e.rel)) this.expanded.delete(e.rel); else this.expanded.add(e.rel);
    this.renderList();
  }

  visible(e, q) {
    if (e.is_dir) {
      const c = e.counts;
      const any = (this.show.same && c.same) || (this.show.diff && c.diff) || (this.show.left && c.left) || (this.show.right && c.right);
      const empty = !e.children.length && this.show[e.status === 'same' ? 'same' : e.status];
      if (!(any || empty)) return false;
      if (!q) return true;
      return e.name.toLowerCase().includes(q) || e.children.some((c) => this.visible(c, q));
    }
    const st = e.status === 'error' ? 'diff' : e.status;
    if (!this.show[st]) return false;
    return !q || e.name.toLowerCase().includes(q);
  }

  setView(v) {
    if (this.view === v) return;
    this.view = v;
    this.ctx.uiSet('ds.fview', v);
    // the icon views start in the folder of the selected row
    if (v !== 'details' && this.sel) { const e = this.byRel(this.sel); this.cwd = e ? (e.is_dir ? e.rel : e.rel.split('/').slice(0, -1).join('/')) : ''; }
    this.renderOpts();
    this.renderList();
  }

  byRel(rel) {
    if (!this.res) return null;
    if (!rel) return this.res.root;
    let e = this.res.root;
    let acc = '';
    for (const part of rel.split('/')) {
      acc = acc ? acc + '/' + part : part;
      e = e.children.find((c) => c.rel === acc);
      if (!e) return null;
    }
    return e;
  }

  renderList() {
    if (!this.built) return;
    const tiles = this.view !== 'details';
    this.el.classList.toggle('tiles', tiles && !!this.res);
    if (tiles && this.res) { this.renderTiles(); return; }
    this.crumbs.replaceChildren();
    const flat = [];
    const q = this.q.trim().toLowerCase();
    const walk = (e, depth) => {
      for (const c of e.children) {
        if (!this.visible(c, q)) continue;
        flat.push({ e: c, depth });
        if (c.is_dir && (this.expanded.has(c.rel) || q)) walk(c, depth + 1);
      }
    };
    if (this.res) walk(this.res.root, 0);
    this.flat = flat;
    this.inner.style.height = flat.length * ROW + 'px';
    this.pa = this.pb = -1;
    if (!this.res) {
      this.inner.style.height = '';
      this.vrows.style.transform = '';
      this.vrows.innerHTML = `<div class="diff-msg">${esc(this.running ? t('Összehasonlítás…') : !(this.left && this.right) ? t('Add meg mindkét mappát (tallózás, útvonal + Enter, vagy húzd ide).') : '')}</div>`;
      return;
    }
    if (!flat.length) {
      this.inner.style.height = '';
      this.vrows.style.transform = '';
      const c = this.res.root.counts;
      const same = !c.diff && !c.left && !c.right;
      this.vrows.innerHTML = `<div class="diff-msg">${esc(same ? t('A két mappa azonos ({0} fájl).', c.same) : t('A szűrésnek nem felel meg egy elem sem.'))}</div>`;
      return;
    }
    this.paint(true);
  }

  paint(force = false) {
    if (!this.flat.length) return;
    const n = this.flat.length;
    const top = this.scroll.scrollTop, hgt = this.scroll.clientHeight || 800;
    const a = Math.max(0, Math.floor(top / ROW) - 10), b = Math.min(n, Math.ceil((top + hgt) / ROW) + 10);
    if (!force && a >= this.pa && b <= this.pb) return;
    this.pa = Math.max(0, a - 30);
    this.pb = Math.min(n, b + 30);
    this.vrows.style.transform = `translateY(${this.pa * ROW}px)`;
    let html = '';
    for (let i = this.pa; i < this.pb; i++) html += this.rowHtml(i);
    this.vrows.innerHTML = html;
  }

  rowHtml(i) {
    const { e, depth } = this.flat[i];
    const pad = `style="padding-left:${6 + depth * 16}px"`;
    const open = this.expanded.has(e.rel) || !!this.q.trim();
    const tw = e.is_dir ? `<span class="tw${open ? ' open' : ''}">${icon('chev').outerHTML}</span>` : '<span class="tw"></span>';
    const ic = icon(e.is_dir ? 'folder' : 'file').outerHTML;
    const cell = (sd) => sd
      ? `<div class="c nm" ${pad}>${tw}${ic}<span class="t">${esc(e.name)}</span></div><div class="c sz">${e.is_dir ? '' : fmtSize(sd.size)}</div><div class="c dt">${sd.mtime ? fmtDate(sd.mtime, true) : ''}</div>`
      : `<div class="c nm emp" ${pad}>${tw}</div><div class="c sz emp"></div><div class="c dt emp"></div>`;
    const glyph = { same: '=', diff: '≠', left: '◀', right: '▶', error: '!' }[e.status] || '';
    const title = { same: t('Azonos'), diff: e.error || t('Eltérő'), left: t('Csak a bal oldalon'), right: t('Csak a jobb oldalon'), error: e.error }[e.status] || '';
    return `<div class="fv-row s-${e.status}${e.is_dir ? ' dir' : ''}${this.sel === e.rel ? ' sel' : ''}" data-i="${i}">${cell(e.left)}<div class="c st" title="${esc(title)}">${glyph}</div>${cell(e.right)}</div>`;
  }

  /** Icon views: one folder level at a time, left and right picture side by side. */
  renderTiles() {
    let node = this.byRel(this.cwd);
    if (!node || !node.is_dir) { this.cwd = ''; node = this.res.root; }
    const q = this.q.trim().toLowerCase();
    let items = [];
    if (q) {
      const walk = (e) => { for (const c of e.children) { if (!this.visible(c, q)) continue; if (!c.is_dir && c.name.toLowerCase().includes(q)) items.push(c); if (c.is_dir) walk(c); } };
      walk(node);
    } else items = node.children.filter((c) => this.visible(c, ''));
    const parts = this.cwd ? this.cwd.split('/') : [];
    this.crumbs.replaceChildren(
      h('button.icon-btn', { title: t('Fel (Backspace)'), disabled: !this.cwd || null, on: { click: () => this.goUp() } }, icon('up')),
      h('button.crumb', { on: { click: () => this.enter('') } }, icon('folders'), `${basename(this.left)} ↔ ${basename(this.right)}`),
      ...parts.flatMap((p, i) => [h('span.sep', '›'), h('button.crumb', { on: { click: () => this.enter(parts.slice(0, i + 1).join('/')) } }, p)]),
      h('span.grow'),
      h('span.dim', t('{0} elem', items.length)));
    const large = this.view === 'large';
    const px = large ? 160 : 64;
    const MAX = 3000;
    const frag = document.createDocumentFragment();
    if (this.cwd && !q) frag.append(h('div.ft.up', { title: t('Fel (Backspace)') }, h('div.ft-pics', h('div.ti', icon('up'))), h('div.tn', '..')));
    for (const e of items.slice(0, MAX)) {
      const pic = (k) => {
        const sd = k === 'L' ? e.left : e.right;
        if (!sd) return h('div.ti.emp.' + k, h('span.none', '—'));
        const isImg = !e.is_dir && IMG_THUMB.test(e.name);
        const img = isImg ? h('img', { alt: '', draggable: 'false' }) : null;
        const box = h('div.ti.' + k, icon(e.is_dir ? 'folder' : isImg ? 'image' : 'file'), img);
        if (img) {
          const path = join(k === 'L' ? this.left : this.right, e.rel);
          lazyThumb(box, () => wantThumb(path, sd.size, sd.mtime, px, img));
        }
        return box;
      };
      const sz = (sd) => (sd ? (e.is_dir ? '' : fmtSize(sd.size)) : '—');
      const st = { same: t('Azonos'), diff: e.error || t('Eltérő'), left: t('Csak a bal oldalon'), right: t('Csak a jobb oldalon'), error: e.error }[e.status] || '';
      const title = `${e.rel}\n${st}` + (e.is_dir ? '' : `\n${t('Bal')}: ${sz(e.left)}   ${t('Jobb')}: ${sz(e.right)}`);
      frag.append(h(`div.ft.s-${e.status}${e.is_dir ? '.dir' : ''}${this.sel === e.rel ? '.sel' : ''}`, { dataset: { rel: e.rel }, title },
        h('div.ft-pics', pic('L'), pic('R')),
        h('div.tn', q ? e.rel : e.name),
        large && !e.is_dir ? h('div.tm', e.status === 'same' ? sz(e.left) : `${sz(e.left)} ↔ ${sz(e.right)}`) : null,
        h('span.ft-badge', GLYPH[e.status] || '')));
    }
    if (items.length > MAX) frag.append(h('div.diff-msg.full', t('Csak az első {0} elem látszik; szűkíts a szűrővel.', MAX)));
    if (!items.length) frag.append(h('div.diff-msg.full', t('A szűrésnek nem felel meg egy elem sem.')));
    this.tiles.className = 'fv-tiles view-' + this.view;
    this.tiles.replaceChildren(frag);
    this.tiles.querySelector('.ft.sel')?.scrollIntoView({ block: 'nearest' });
  }

  enter(rel) {
    this.cwd = rel;
    this.renderTiles();
    this.tiles.scrollTop = 0;
    this.tiles.focus({ preventScroll: true });
  }

  goUp() {
    if (!this.cwd) return;
    const prev = this.cwd;
    this.cwd = this.cwd.split('/').slice(0, -1).join('/');
    this.sel = prev;
    this.renderTiles();
    this.tiles.focus({ preventScroll: true });
  }

  selectTile(rel) {
    this.sel = rel;
    for (const el of this.tiles.querySelectorAll('.ft.sel')) el.classList.remove('sel');
    this.tiles.querySelector(`.ft[data-rel="${CSS.escape(rel)}"]`)?.classList.add('sel');
    this.tiles.focus({ preventScroll: true });
  }

  onTileKey(e) {
    const all = [...this.tiles.querySelectorAll('.ft[data-rel]')];
    const i = all.findIndex((x) => x.dataset.rel === this.sel);
    const w = all[0]?.offsetWidth || 1;
    const cols = Math.max(1, Math.floor((this.tiles.clientWidth - 12) / (w + 6)));
    const go = (j) => { const el = all[Math.max(0, Math.min(all.length - 1, j))]; if (el) { this.selectTile(el.dataset.rel); el.scrollIntoView({ block: 'nearest' }); } };
    if (e.key === 'ArrowRight') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); go(i < 0 ? 0 : i + cols); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - cols); }
    else if (e.key === 'Enter' && i >= 0) { e.preventDefault(); this.activate(this.byRel(this.sel)); }
    else if (e.key === 'Backspace') { e.preventDefault(); this.goUp(); }
  }

  select(rel) {
    this.sel = rel;
    this.paint(true);
    this.scroll.focus({ preventScroll: true });
  }

  onKey(e) {
    const i = this.flat.findIndex((x) => x.e.rel === this.sel);
    const go = (j) => {
      j = Math.max(0, Math.min(this.flat.length - 1, j));
      if (!this.flat[j]) return;
      this.sel = this.flat[j].e.rel;
      const y = j * ROW;
      if (y < this.scroll.scrollTop) this.scroll.scrollTop = y;
      else if (y + ROW > this.scroll.scrollTop + this.scroll.clientHeight) this.scroll.scrollTop = y + ROW - this.scroll.clientHeight;
      this.paint(true);
    };
    const cur = this.flat[i]?.e;
    if (e.key === 'ArrowDown') { e.preventDefault(); go(i + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); go(i - 1); }
    else if (e.key === 'PageDown') { e.preventDefault(); go(i + Math.floor(this.scroll.clientHeight / ROW)); }
    else if (e.key === 'PageUp') { e.preventDefault(); go(i - Math.floor(this.scroll.clientHeight / ROW)); }
    else if (e.key === 'Enter' && cur) { e.preventDefault(); this.activate(cur); }
    else if (e.key === 'ArrowRight' && cur?.is_dir && !this.expanded.has(cur.rel)) { e.preventDefault(); this.toggle(cur); }
    else if (e.key === 'ArrowLeft' && cur?.is_dir && this.expanded.has(cur.rel)) { e.preventDefault(); this.toggle(cur); }
  }

  /** Double click / Enter: folders open, files are compared in a new tab. */
  activate(e) {
    if (e.is_dir) { if (this.view !== 'details') this.enter(e.rel); else this.toggle(e); return; }
    this.ctx.openFiles(e.left ? join(this.left, e.rel) : '', e.right ? join(this.right, e.rel) : '');
  }

  menu(ev, e) {
    const lp = join(this.left, e.rel), rp = join(this.right, e.rel);
    contextMenu(ev, [
      !e.is_dir ? { label: t('Összehasonlítás'), icon: 'files', key: 'Enter', action: () => this.activate(e) } : null,
      !e.is_dir ? '-' : null,
      { label: t('Másolás jobbra →'), icon: 'toRight', disabled: !e.left || e.status === 'same', action: () => this.copy(e, lp, rp, true) },
      { label: t('Másolás balra ←'), icon: 'toLeft', disabled: !e.right || e.status === 'same', action: () => this.copy(e, rp, lp, false) },
      '-',
      e.is_dir && e.left && e.right ? { label: t('Összehasonlítás külön fülön'), icon: 'folders', action: () => this.ctx.openFolders(lp, rp) } : null,
      !e.is_dir && e.left ? { label: t('Bal oldali megnyitása'), icon: 'open', action: () => invoke('open_file', { path: lp }).catch((x) => toast(String(x), 'err')) } : null,
      !e.is_dir && e.right ? { label: t('Jobb oldali megnyitása'), icon: 'open', action: () => invoke('open_file', { path: rp }).catch((x) => toast(String(x), 'err')) } : null,
      e.left ? { label: t('Bal oldali a fájlkezelőben'), icon: 'folder', action: () => invoke('reveal_in_explorer', { path: lp }) } : null,
      e.right ? { label: t('Jobb oldali a fájlkezelőben'), icon: 'folder', action: () => invoke('reveal_in_explorer', { path: rp }) } : null,
      '-',
      { label: t('Relatív útvonal másolása'), icon: 'copy', action: () => navigator.clipboard.writeText(e.rel).catch(() => {}) },
    ]);
  }

  async copy(e, from, to, toRight) {
    const exists = toRight ? !!e.right : !!e.left;
    const what = e.is_dir ? t('a(z) „{0}” mappát', e.rel) : t('a(z) „{0}” fájlt', e.rel);
    const ok = await this.ctx.confirm(toRight ? t('Másolás jobbra') : t('Másolás balra'),
      t('Átmásolod {0} a {1} oldalra?', what, toRight ? t('jobb') : t('bal')) + (exists ? '\n' + t('A meglévő fájlok felülíródnak.') : '') + `\n\n${from}\n→ ${to}`,
      t('Másolás'));
    if (!ok) return;
    try {
      await invoke('copy_entry', { from, to });
      toast(t('Átmásolva: {0}', e.rel), 'ok');
    } catch (x) { toast(String(x), 'err'); }
    this.run();
  }

  /** Text listing of the differences for the AI (and the changed files to diff). */
  aiExplain() {
    const lines = [];
    const changed = [];
    const sd = (x) => (x ? `${fmtSize(x.size)}, ${fmtDate(x.mtime, true)}` : '-');
    const walk = (e) => {
      for (const c of e.children) {
        if (lines.length > 4000) return;
        if (c.is_dir && c.status !== 'left' && c.status !== 'right') { walk(c); continue; }
        if (c.status === 'same') continue;
        const tag = { diff: 'DIFFERENT', left: 'ONLY LEFT', right: 'ONLY RIGHT', error: 'ERROR' }[c.status];
        lines.push(`${tag}${c.is_dir ? ' (folder, ' + (c.counts.left + c.counts.right) + ' files)' : ''}: ${c.rel}  [L: ${sd(c.left)} | R: ${sd(c.right)}]`);
        if (c.status === 'diff' && !c.is_dir) changed.push(c.rel);
      }
    };
    walk(this.res.root);
    const k = this.res.root.counts;
    const summary = `Identical files: ${k.same}\nDifferent: ${k.diff}\nOnly left: ${k.left}\nOnly right: ${k.right}\n\n` + lines.join('\n');
    this.ctx.ai(t('AI: mappák eltérései és tanácsok'),
      (question, history) => invoke('ai_folder', { left: this.left, right: this.right, summary, changed, question, history }),
      [t('Melyik irányba szinkronizáljak?'), t('Mely fájlokat kell kézzel összefésülni?')]);
  }

  reload() { this.run(); }

  status() {
    const c = this.res?.root?.counts;
    if (!c) return [];
    return [h('span', t('{0} azonos · {1} eltérő · {2} csak bal · {3} csak jobb', c.same, c.diff, c.left, c.right))];
  }
}
