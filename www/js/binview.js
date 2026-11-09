// Binary comparisons: hex view (byte by byte, aligned by offset) and image
// view (side by side, blend, swipe, pixel difference).

import { h, icon, esc, toast, invoke, basename, fmtDate } from './util.js';
import { t } from './i18n.js';
import { fmtSize } from './textview.js';

const HEX_MAX = 16 * 1024 * 1024;
const IMG_MAX = 64 * 1024 * 1024;
const ROW = 19;
export const IMG_EXT = /\.(png|jpe?g|gif|bmp|webp|ico|avif|svg)$/i;

const b64bytes = (b64) => { const s = atob(b64); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; };
const hex2 = (n) => n.toString(16).padStart(2, '0');
const mime = (p) => (/\.svg$/i.test(p) ? 'image/svg+xml' : /\.png$/i.test(p) ? 'image/png' : /\.gif$/i.test(p) ? 'image/gif' : /\.webp$/i.test(p) ? 'image/webp'
  : /\.ico$/i.test(p) ? 'image/x-icon' : /\.bmp$/i.test(p) ? 'image/bmp' : /\.avif$/i.test(p) ? 'image/avif' : 'image/jpeg');

/** Shared header with the two paths (browse / drop to replace a side). */
function pathHead(view, kind) {
  const side = (k) => {
    const p = k === 'L' ? view.left : view.right;
    const info = k === 'L' ? view.infoL : view.infoR;
    const inp = h('input.inp.dv-path', { value: p, spellcheck: 'false', placeholder: t('Fájl útvonala – vagy húzd ide a fájlt'),
      on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); view.drop(k, inp.value.trim()); } } } });
    return h('div.dv-side.' + k,
      h('div.dv-side-row', inp,
        h('button.icon-btn', { title: t('Tallózás…'), on: { click: async () => { const f = await view.ctx.pickFile(t('Fájl kiválasztása'), p); if (f) view.drop(k, f); } } }, icon('open'))),
      h('div.dv-meta', info ? [h('span', kind), h('span', fmtSize(info.size)), info.mtime ? h('span', fmtDate(info.mtime, true)) : null] : h('span.dim', ' ')));
  };
  return [side('L'), h('div.dv-mid', h('button.icon-btn', { title: t('Oldalak felcserélése'), on: { click: () => view.swap() } }, icon('swap'))), side('R')];
}

// ───────────────────────── hex ─────────────────────────

export class HexCompare {
  constructor(ctx, left, right) {
    this.ctx = ctx;
    this.kind = 'hex';
    this.left = left;
    this.right = right;
    this.a = null;
    this.b = null;
    this.el = h('div.dv.hx');
    this.built = false;
  }

  pair() { return { kind: 'text', left: this.left, right: this.right }; }
  title() { return `${basename(this.left) || '?'} ↔ ${basename(this.right) || '?'}`; }
  tooltip() { return `${this.left}\n${this.right}`; }
  isDirty() { return false; }

  build() {
    this.head = h('div.dv-head');
    this.optbar = h('div.diff-toolbar.dv-opts');
    this.vrows = h('div.dv-rows');
    this.inner = h('div.dv-inner', this.vrows);
    this.scroll = h('div.dv-scroll.hx-scroll', this.inner);
    this.mini = h('div.minimap');
    this.el.replaceChildren(this.head, this.optbar, h('div.dv-body', h('div.dv-main', this.scroll), this.mini));
    let raf = 0;
    this.scroll.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; this.paint(); this.updateVp(); }); }, { passive: true });
    new ResizeObserver(() => { if (this.el.isConnected) this.paint(true); }).observe(this.scroll);
    this.mini.addEventListener('mousedown', (e) => {
      const go = (ev) => { const r = this.mini.getBoundingClientRect(); this.scroll.scrollTop = ((ev.clientY - r.top) / r.height) * this.scroll.scrollHeight - this.scroll.clientHeight / 2; };
      go(e);
      const up = () => { removeEventListener('mousemove', go); removeEventListener('mouseup', up); };
      addEventListener('mousemove', go);
      addEventListener('mouseup', up);
    });
    this.built = true;
  }

  mount(container) {
    if (!this.built) this.build();
    container.replaceChildren(this.el);
    this.head.replaceChildren(...pathHead(this, t('bináris')));
    if (!this.a && !this.loading) this.load(); else this.render();
  }

  async load() {
    this.loading = true;
    this.renderOpts();
    try {
      const [a, b, sum] = await Promise.all([
        this.left ? invoke('read_bytes', { path: this.left, max: HEX_MAX }) : { data: '', size: 0 },
        this.right ? invoke('read_bytes', { path: this.right, max: HEX_MAX }) : { data: '', size: 0 },
        this.left && this.right ? invoke('binary_summary', { left: this.left, right: this.right }) : null,
      ]);
      this.a = b64bytes(a.data);
      this.b = b64bytes(b.data);
      this.sizeA = a.size;
      this.sizeB = b.size;
      this.sum = sum;
      this.infoL = this.left ? await invoke('path_stat', { path: this.left }) : null;
      this.infoR = this.right ? await invoke('path_stat', { path: this.right }) : null;
    } catch (e) { toast(String(e), 'err'); this.a = new Uint8Array(); this.b = new Uint8Array(); }
    this.loading = false;
    const n = Math.ceil(Math.max(this.a.length, this.b.length) / 16);
    this.diffRows = [];
    for (let r = 0; r < n; r++) {
      const o = r * 16;
      for (let i = o; i < o + 16; i++) {
        if (i >= this.a.length && i >= this.b.length) break;
        if (this.a[i] !== this.b[i]) { this.diffRows.push(r); break; }
      }
    }
    this.rowsN = n;
    this.cur = -1;
    this.head.replaceChildren(...pathHead(this, t('bináris')));
    this.render();
    this.ctx.changed();
  }

  renderOpts() {
    const s = this.sum;
    const n = this.diffRows?.length || 0;
    const cut = (this.sizeA > HEX_MAX || this.sizeB > HEX_MAX);
    this.optbar.replaceChildren(
      this.loading ? h('span.dim', t('Betöltés…'))
        : !s ? h('span.dim', t('Add meg mindkét fájlt.'))
        : s.identical ? h('span.dv-same', icon('check'), t('A két fájl bájtra azonos'))
        : h('span.dv-sum', h('b', t('{0} eltérő bájt', s.diff_bytes.toLocaleString())),
          s.left_size !== s.right_size ? h('span.warn', ' · ' + t('eltérő méret: {0} / {1}', fmtSize(s.left_size), fmtSize(s.right_size))) : null,
          s.first_diff >= 0 ? h('span', ' · ' + t('első eltérés: 0x{0}', s.first_diff.toString(16).toUpperCase())) : null),
      cut ? h('span.warn', ' · ' + t('csak az első {0} látszik', fmtSize(HEX_MAX))) : null,
      n ? h('span.dv-pos', this.cur >= 0 ? `${this.cur + 1} / ${n}` : `– / ${n}`) : null,
      h('button.icon-btn', { disabled: !n || null, title: t('Előző eltérés (Alt+↑)'), on: { click: () => this.go(-1) } }, icon('up')),
      h('button.icon-btn', { disabled: !n || null, title: t('Következő eltérés (Alt+↓)'), on: { click: () => this.go(1) } }, icon('down')),
      h('span.grow'),
      IMG_EXT.test(this.left) && IMG_EXT.test(this.right) ? h('button.btn.sm', { on: { click: () => this.ctx.replace(this, new ImageCompare(this.ctx, this.left, this.right)) } }, icon('image'), t('Kép nézet')) : null,
    );
  }

  render() {
    this.renderOpts();
    if (!this.a) return;
    this.inner.style.height = this.rowsN * ROW + 'px';
    this.pa = this.pb = -1;
    this.paint(true);
    const n = Math.max(1, this.rowsN);
    const marks = [];
    let prev = null;
    for (const r of this.diffRows) {
      if (prev && r - prev.end <= Math.max(1, n / 400)) { prev.end = r + 1; continue; }
      prev = { start: r, end: r + 1 };
      marks.push(prev);
    }
    this.vp = h('div.vp');
    this.mini.replaceChildren(...marks.map((m) => h('i.m', { style: { top: (m.start / n) * 100 + '%', height: `max(2px, ${((m.end - m.start) / n) * 100}%)` } })), this.vp);
    this.updateVp();
  }

  updateVp() {
    if (!this.vp) return;
    const sc = this.scroll, sh = Math.max(1, sc.scrollHeight);
    this.vp.style.top = (sc.scrollTop / sh) * 100 + '%';
    this.vp.style.height = Math.min(100, (sc.clientHeight / sh) * 100) + '%';
  }

  paint(force = false) {
    if (!this.rowsN) { this.vrows.innerHTML = this.a ? `<div class="diff-msg">${esc(t('Mindkét fájl üres.'))}</div>` : ''; return; }
    const top = this.scroll.scrollTop, hgt = this.scroll.clientHeight || 800;
    const a = Math.max(0, Math.floor(top / ROW) - 10), b = Math.min(this.rowsN, Math.ceil((top + hgt) / ROW) + 10);
    if (!force && a >= this.pa && b <= this.pb) return;
    this.pa = Math.max(0, a - 40);
    this.pb = Math.min(this.rowsN, b + 40);
    this.vrows.style.transform = `translateY(${this.pa * ROW}px)`;
    let html = '';
    const curRow = this.cur >= 0 ? this.diffRows[this.cur] : -1;
    for (let r = this.pa; r < this.pb; r++) html += this.rowHtml(r, r === curRow);
    this.vrows.innerHTML = html;
  }

  rowHtml(r, cur) {
    const o = r * 16;
    const side = (x, y) => {
      let hx = '', asc = '';
      for (let i = o; i < o + 16; i++) {
        if (i >= x.length) { hx += '<i class="no">  </i> '; asc += ' '; continue; }
        const v = x[i];
        const d = v !== y[i];
        const ch = v >= 32 && v < 127 ? esc(String.fromCharCode(v)) : '.';
        hx += d ? `<i class="d">${hex2(v)}</i> ` : hex2(v) + ' ';
        asc += d ? `<i class="d">${ch}</i>` : ch;
        if (i === o + 7) hx += ' ';
      }
      return `<div class="hx-h">${hx}</div><div class="hx-a">${asc}</div>`;
    };
    return `<div class="hx-row${cur ? ' cur' : ''}"><div class="hx-o">${o.toString(16).padStart(8, '0').toUpperCase()}</div>${side(this.a, this.b)}<div class="gt"></div>${side(this.b, this.a)}</div>`;
  }

  go(dir) {
    const n = this.diffRows.length;
    if (!n) return;
    this.cur = this.cur < 0 ? (dir > 0 ? 0 : n - 1) : Math.max(0, Math.min(n - 1, this.cur + dir));
    this.scroll.scrollTop = this.diffRows[this.cur] * ROW - this.scroll.clientHeight / 3;
    this.paint(true);
    this.renderOpts();
  }

  drop(k, path) { this.ctx.reopen(this, k === 'L' ? path : this.left, k === 'L' ? this.right : path); }
  swap() { [this.left, this.right] = [this.right, this.left]; this.a = null; this.ctx.remember(); this.load(); }
  reload() { this.a = null; this.load(); }

  status() {
    return [h('span', `${fmtSize(this.sizeA || 0)} ↔ ${fmtSize(this.sizeB || 0)}`)];
  }
}

// ───────────────────────── images ─────────────────────────

export class ImageCompare {
  constructor(ctx, left, right) {
    this.ctx = ctx;
    this.kind = 'image';
    this.left = left;
    this.right = right;
    this.mode = ctx.uiGet('ds.imgMode') || 'side';
    this.fit = true;
    this.tol = 16;
    this.el = h('div.dv.im');
    this.built = false;
  }

  pair() { return { kind: 'text', left: this.left, right: this.right }; }
  title() { return `${basename(this.left) || '?'} ↔ ${basename(this.right) || '?'}`; }
  tooltip() { return `${this.left}\n${this.right}`; }
  isDirty() { return false; }

  build() {
    this.head = h('div.dv-head');
    this.optbar = h('div.diff-toolbar.dv-opts');
    this.stage = h('div.im-stage');
    this.el.replaceChildren(this.head, this.optbar, this.stage);
    this.built = true;
  }

  mount(container) {
    if (!this.built) this.build();
    container.replaceChildren(this.el);
    this.head.replaceChildren(...pathHead(this, t('kép')));
    if (!this.srcA && !this.loading) this.load(); else this.render();
  }

  async load() {
    this.loading = true;
    this.renderOpts();
    const get = async (p) => {
      if (!p) return null;
      const r = await invoke('read_bytes', { path: p, max: IMG_MAX });
      return `data:${mime(p)};base64,${r.data}`;
    };
    try {
      [this.srcA, this.srcB] = await Promise.all([get(this.left), get(this.right)]);
      this.infoL = this.left ? await invoke('path_stat', { path: this.left }) : null;
      this.infoR = this.right ? await invoke('path_stat', { path: this.right }) : null;
      [this.imgA, this.imgB] = await Promise.all([this.srcA, this.srcB].map((s) => new Promise((res) => {
        if (!s) return res(null);
        const im = new Image();
        im.onload = () => res(im);
        im.onerror = () => res(null);
        im.src = s;
      })));
    } catch (e) { toast(String(e), 'err'); }
    this.loading = false;
    this.diffStats = null;
    this.head.replaceChildren(...pathHead(this, t('kép')));
    this.render();
    this.ctx.changed();
  }

  setMode(m) { this.mode = m; this.ctx.uiSet('ds.imgMode', m); this.render(); }

  renderOpts() {
    const a = this.imgA, b = this.imgB;
    const dim = (im) => (im ? `${im.naturalWidth}×${im.naturalHeight}` : '—');
    const both = !!(a && b);
    const ds = this.diffStats;
    this.optbar.replaceChildren(
      this.loading ? h('span.dim', t('Betöltés…')) : h('span.dv-sum', `${dim(a)}  ↔  ${dim(b)}`,
        both && (a.naturalWidth !== b.naturalWidth || a.naturalHeight !== b.naturalHeight) ? h('span.warn', ' · ' + t('eltérő méret')) : null,
        ds ? (ds.count ? h('span', ' · ' + t('{0} eltérő képpont ({1}%)', ds.count.toLocaleString(), ds.pct)) : h('span.dv-same', ' ', icon('check'), t('képpontra azonos'))) : null),
      h('span.grow'),
      this.mode === 'diff' ? h('label.chk', { title: t('Ennyi színeltérés alatt a képpont azonosnak számít') }, t('Tűrés'),
        h('input', { type: 'range', min: 0, max: 128, value: this.tol, on: { change: (e) => { this.tol = +e.target.value; this.render(); } } })) : null,
      h('span.seg',
        ...[['side', t('Egymás mellett')], ['onion', t('Átúsztatás')], ['swipe', t('Csúszka')], ['diff', t('Különbség')]].map(([m, l]) =>
          h('button' + (this.mode === m ? '.on' : ''), { disabled: (m !== 'side' && !both) || null, on: { click: () => this.setMode(m) } }, l))),
      h('button.icon-btn' + (this.fit ? '.on' : ''), { title: t('Illesztés az ablakhoz / eredeti méret'), on: { click: () => { this.fit = !this.fit; this.render(); } } }, icon('expand')),
      h('button.btn.sm', { on: { click: () => this.ctx.replace(this, new HexCompare(this.ctx, this.left, this.right)) } }, icon('hex'), t('Hex nézet')),
    );
  }

  render() {
    if (!this.built) return;
    const a = this.imgA, b = this.imgB;
    if (this.mode !== 'side' && !(a && b)) this.mode = 'side';
    this.stage.className = 'im-stage' + (this.fit ? ' fit' : '');
    const cap = (txt) => h('figcaption', txt);
    const img = (src) => (src ? h('img', { src }) : h('div.diff-msg', t('nincs kép')));
    if (this.loading) { this.stage.replaceChildren(h('div.diff-msg', t('Betöltés…'))); this.renderOpts(); return; }
    if (this.mode === 'side') {
      this.stage.replaceChildren(h('div.im-sides',
        h('figure.o', h('div.im-box', img(this.srcA)), cap(t('Bal'))),
        h('figure.n', h('div.im-box', img(this.srcB)), cap(t('Jobb')))));
    } else if (this.mode === 'onion') {
      const top = h('img', { src: this.srcB, style: { opacity: 0.5 } });
      this.stage.replaceChildren(h('div.im-col',
        h('div.modes', t('Bal'), h('input', { type: 'range', min: 0, max: 100, value: 50, on: { input: (e) => (top.style.opacity = e.target.value / 100) } }), t('Jobb')),
        h('div.im-box.im-stack', h('img', { src: this.srcA }), top)));
    } else if (this.mode === 'swipe') {
      const topWrap = h('div.im-clip', h('img', { src: this.srcB }));
      const bar = h('div.im-bar');
      const box = h('div.im-box.im-stack.im-swipe', h('img', { src: this.srcA }), topWrap, bar);
      const set = (x) => { const r = box.getBoundingClientRect(); const p = Math.max(0, Math.min(1, (x - r.left) / r.width)); topWrap.style.clipPath = `inset(0 0 0 ${p * 100}%)`; bar.style.left = p * 100 + '%'; };
      box.addEventListener('mousedown', (e) => {
        set(e.clientX);
        const mv = (ev) => set(ev.clientX);
        const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
        addEventListener('mousemove', mv);
        addEventListener('mouseup', up);
      });
      topWrap.style.clipPath = 'inset(0 0 0 50%)';
      bar.style.left = '50%';
      this.stage.replaceChildren(h('div.im-col', h('div.modes.dim', t('Húzd az egeret a képen: balra a bal, jobbra a jobb oldali kép.')), box));
    } else {
      const canvas = this.diffCanvas();
      this.stage.replaceChildren(h('div.im-col', h('div.modes.dim', t('Az eltérő képpontok kiemelve, a többi halványan.')), h('div.im-box', canvas)));
    }
    this.renderOpts();
  }

  diffCanvas() {
    const a = this.imgA, b = this.imgB;
    const w = Math.max(a.naturalWidth, b.naturalWidth), hgt = Math.max(a.naturalHeight, b.naturalHeight);
    const data = (im) => { const c = document.createElement('canvas'); c.width = w; c.height = hgt; const g = c.getContext('2d'); g.drawImage(im, 0, 0); return g.getImageData(0, 0, w, hgt).data; };
    const da = data(a), db = data(b);
    const out = document.createElement('canvas');
    out.width = w; out.height = hgt;
    const g = out.getContext('2d');
    const img = g.createImageData(w, hgt);
    const o = img.data;
    let count = 0;
    const tol = this.tol;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.max(Math.abs(da[i] - db[i]), Math.abs(da[i + 1] - db[i + 1]), Math.abs(da[i + 2] - db[i + 2]), Math.abs(da[i + 3] - db[i + 3]));
      if (d > tol) {
        count++;
        o[i] = 255; o[i + 1] = 0; o[i + 2] = 170; o[i + 3] = 255;
      } else {
        const y = (da[i] * 0.3 + da[i + 1] * 0.59 + da[i + 2] * 0.11) * 0.35 + 150;
        o[i] = o[i + 1] = o[i + 2] = y; o[i + 3] = Math.max(60, da[i + 3]);
      }
    }
    g.putImageData(img, 0, 0);
    this.diffStats = { count, pct: ((count / Math.max(1, w * hgt)) * 100).toFixed(2) };
    return out;
  }

  drop(k, path) { this.ctx.reopen(this, k === 'L' ? path : this.left, k === 'L' ? this.right : path); }
  swap() { [this.left, this.right] = [this.right, this.left]; this.srcA = null; this.ctx.remember(); this.load(); }
  reload() { this.srcA = null; this.load(); }
  go() {}

  status() { return [h('span', t('Kép-összehasonlítás'))]; }
}
