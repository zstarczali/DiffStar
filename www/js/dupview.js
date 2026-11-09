// Duplicate finder view: files with the same content in one or two folders
// (also inside one folder). Groups with previews, quick selection, recycle bin.

import { h, icon, toast, contextMenu, invoke, basename, fmtDate } from './util.js';
import { t } from './i18n.js';
import { fmtSize } from './textview.js';
import { IMG_THUMB, wantThumb, lazyThumb } from './thumbs.js';

const MIN_SIZES = [[1, () => t('Bármekkora')], [1024, () => '≥ 1 KB'], [102400, () => '≥ 100 KB'], [1048576, () => '≥ 1 MB'], [10485760, () => '≥ 10 MB']];
const MAX_GROUPS = 2000;
let lastJob = Date.now(); // every search gets its own id: its stop and counter are its own

export class DupView {
  constructor(ctx, roots) {
    this.ctx = ctx;
    this.kind = 'dups';
    this.roots = [roots[0] || '', roots[1] || ''];
    this.res = null;
    this.running = false;
    this.stopping = false;
    this.job = 0;
    this.marked = new Set(); // paths selected for the recycle bin
    this.q = '';
    this.cross = false; // only groups that have copies on both sides
    this.minSize = +(ctx.uiGet('ds.dupMin') || 1);
    this.large = ctx.uiGet('ds.dupLarge') === '1';
    this.el = h('div.fv.dup');
    this.built = false;
  }

  get s() { return this.ctx.settings(); }
  pair() { return { kind: 'dups', left: this.roots[0], right: this.roots[1] }; }
  title() { return t('Duplikátumok: {0}', this.roots.filter(Boolean).map(basename).join(' + ') || '?'); }
  tooltip() { return this.roots.filter(Boolean).join('\n'); }
  isDirty() { return false; }

  build() {
    this.head = h('div.dv-head');
    this.optbar = h('div.diff-toolbar.fv-opts');
    this.list = h('div.dup-list', { tabindex: '0' });
    this.el.replaceChildren(this.head, this.optbar, this.list);
    this.list.addEventListener('change', (e) => {
      const cb = e.target.closest('input[data-path]');
      if (!cb) return;
      if (cb.checked) this.marked.add(cb.dataset.path); else this.marked.delete(cb.dataset.path);
      cb.closest('.dup-f')?.classList.toggle('marked', cb.checked);
      this.renderOpts();
    });
    this.list.addEventListener('dblclick', (e) => {
      const f = e.target.closest('.dup-f[data-path]');
      if (f && !e.target.closest('input,button')) invoke('open_file', { path: f.dataset.path }).catch((x) => toast(String(x), 'err'));
    });
    this.list.addEventListener('contextmenu', (e) => {
      const f = e.target.closest('.dup-f[data-path]');
      if (!f) return;
      const p = f.dataset.path;
      const g = this.res.groups[+f.dataset.g];
      contextMenu(e, [
        { label: t('Megnyitás'), icon: 'open', action: () => invoke('open_file', { path: p }).catch((x) => toast(String(x), 'err')) },
        { label: t('Megnyitás a fájlkezelőben'), icon: 'folder', action: () => invoke('reveal_in_explorer', { path: p }) },
        { label: t('Útvonal másolása'), icon: 'copy', action: () => navigator.clipboard.writeText(p).catch(() => {}) },
        '-',
        { label: t('Ezt tartsd meg, a többit jelöld ki'), icon: 'check', action: () => { for (const x of g.files) this.mark(x.path, x.path !== p); this.renderList(); } },
        { label: t('Lomtárba'), icon: 'trash', action: () => this.trash([p]) },
      ]);
    });
    this.built = true;
  }

  mount(container) {
    if (!this.built) this.build();
    container.replaceChildren(this.el);
    this.renderHead();
    this.renderOpts();
    if (!this.res && !this.running && this.roots[0]) this.run();
    else this.renderList();
  }

  renderHead() {
    const side = (i) => {
      const inp = h('input.inp.dv-path', {
        value: this.roots[i], spellcheck: 'false', placeholder: i ? t('Második mappa (nem kötelező)') : t('Mappa útvonala – vagy húzd ide a mappát'),
        on: { keydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); this.setRoot(i, inp.value.trim()); } } },
      });
      return h('div.dv-side.' + (i ? 'R' : 'L'),
        h('div.dv-side-row', inp,
          h('button.icon-btn', { title: t('Tallózás…'), on: { click: async () => { const p = await this.ctx.pickFolder(t('Mappa'), this.roots[i] || undefined); if (p) this.setRoot(i, p); } } }, icon('open')),
          i && this.roots[1] ? h('button.icon-btn', { title: t('Eltávolítás'), on: { click: () => this.setRoot(1, '') } }, icon('close')) : null),
        h('div.dv-meta', h('span.dim', i ? t('Jobb oldal') : t('Bal oldal'))));
    };
    this.head.replaceChildren(side(0), h('div.dv-mid', icon('dups')), side(1));
  }

  setRoot(i, p) {
    this.roots[i] = p;
    this.res = null;
    this.marked.clear();
    this.ctx.remember();
    this.renderHead();
    this.ctx.changed();
    if (this.roots[0] || this.roots[1]) this.run();
  }

  drop(k, p) { this.setRoot(k === 'L' ? 0 : 1, p); }
  swap() { this.roots.reverse(); this.renderHead(); this.renderList(); this.ctx.remember(); }
  reload() { this.run(); }

  shown() {
    if (!this.res) return [];
    const q = this.q.trim().toLowerCase();
    return this.res.groups.filter((g) => (!this.cross || (g.files.some((f) => f.root === 0) && g.files.some((f) => f.root === 1)))
      && (!q || g.files.some((f) => f.rel.toLowerCase().includes(q))));
  }

  renderOpts() {
    const r = this.res;
    const two = !!(this.roots[0] && this.roots[1]);
    const min = h('select.inp.dv-sel', { title: t('Ennél kisebb fájlok kimaradnak'), on: { change: (e) => { this.minSize = +e.target.value; this.ctx.uiSet('ds.dupMin', String(this.minSize)); this.run(); } } },
      MIN_SIZES.map(([v, l]) => h('option', { value: String(v) }, l())));
    min.value = String(this.minSize);
    const markedSize = r ? r.groups.reduce((a, g) => a + g.files.filter((f) => this.marked.has(f.path)).length * g.size, 0) : 0;
    const sel = (label, fn) => ({ label, action: () => { this.autoMark(fn); } });
    this.optbar.replaceChildren(
      this.running
        ? h('button.btn.sm.danger', { disabled: this.stopping || null, title: 'Esc', on: { click: () => this.stop() } }, icon('stop'), this.stopping ? t('Leállítás…') : t('Leállítás'))
        : h('button.btn.sm.primary', { disabled: !(this.roots[0] || this.roots[1]) || null, title: t('Keresés újra (F5)'), on: { click: () => this.run() } }, icon('refresh'), t('Keresés')),
      this.running ? h('span.dim.fv-prog', t('Folyamatban…')) : null,
      min,
      two ? h('button.fv-flt' + (this.cross ? '.on' : ''), { title: t('Csak azok a csoportok, amelyeknek mindkét mappában van példánya'), on: { click: () => { this.cross = !this.cross; this.renderOpts(); this.renderList(); } } }, h('i'), t('Csak a két mappa között')) : null,
      h('span.tb-mini-sep'),
      r ? h('span.dup-sum', t('{0} csoport · {1} felesleges példány · {2} visszanyerhető', r.groups.length, r.groups.reduce((a, g) => a + g.files.length - 1, 0), fmtSize(r.wasted))) : null,
      h('span.grow'),
      h('button.btn.sm', { disabled: !r?.groups.length || null, on: { click: (e) => contextMenu(e, [
        sel(t('Minden csoportban a legrégebbi marad'), (g) => [...g.files].sort((a, b) => a.mtime - b.mtime)[0]),
        sel(t('Minden csoportban a legújabb marad'), (g) => [...g.files].sort((a, b) => b.mtime - a.mtime)[0]),
        sel(t('Minden csoportban az első (rövidebb útvonal) marad'), (g) => [...g.files].sort((a, b) => a.rel.length - b.rel.length)[0]),
        two ? '-' : null,
        two ? { label: t('Jobb oldali példányok kijelölése (ahol a bal oldalon is van)'), action: () => this.markSide(1) } : null,
        two ? { label: t('Bal oldali példányok kijelölése (ahol a jobb oldalon is van)'), action: () => this.markSide(0) } : null,
        '-',
        { label: t('Kijelölés törlése'), action: () => { this.marked.clear(); this.renderOpts(); this.renderList(); } },
      ]) } }, icon('check'), t('Kijelölés'), icon('chev')),
      h('button.btn.sm.danger', { disabled: !this.marked.size || null, title: t('A kijelölt fájlok áthelyezése a Lomtárba'), on: { click: () => this.trash([...this.marked]) } },
        icon('trash'), this.marked.size ? t('Lomtárba ({0}, {1})', this.marked.size, fmtSize(markedSize)) : t('Lomtárba')),
      h('input.inp.fv-q', { value: this.q, placeholder: t('Szűrés névre…'), spellcheck: 'false', on: { input: (e) => { this.q = e.target.value; this.renderList(); } } }),
      h('div.fv-views',
        h('button.icon-btn' + (!this.large ? '.on' : ''), { title: t('Lista'), on: { click: () => this.setLarge(false) } }, icon('viewList')),
        h('button.icon-btn' + (this.large ? '.on' : ''), { title: t('Nagy előnézetek'), on: { click: () => this.setLarge(true) } }, icon('viewLarge'))),
    );
  }

  setLarge(on) {
    this.large = on;
    this.ctx.uiSet('ds.dupLarge', on ? '1' : '0');
    this.renderOpts();
    this.renderList();
  }

  mark(path, on) { if (on) this.marked.add(path); else this.marked.delete(path); }

  /** Every group: keep the file `keep(g)` returns, select the rest. */
  autoMark(keep) {
    for (const g of this.shown()) { const k = keep(g); for (const f of g.files) this.mark(f.path, f !== k); }
    this.renderOpts();
    this.renderList();
  }

  /** Selects the copies on one side where the other side has one too. */
  markSide(root) {
    for (const g of this.shown()) {
      if (!g.files.some((f) => f.root !== root)) continue;
      for (const f of g.files) this.mark(f.path, f.root === root);
    }
    this.renderOpts();
    this.renderList();
  }

  /** Stops the running search; the partial result stays. */
  stop() {
    if (!this.running || this.stopping) return;
    this.stopping = true;
    invoke('cancel_dups', { job: this.job }).catch(() => {});
    this.renderOpts();
  }

  /** The tab is closed: a running search is not needed any more. */
  closed() { if (this.running) invoke('cancel_dups', { job: this.job }).catch(() => {}); }

  async run() {
    const roots = this.roots.filter(Boolean);
    if (!roots.length || this.running) return;
    this.running = true;
    this.stopping = false;
    const job = this.job = ++lastJob;
    this.marked.clear();
    this.renderOpts();
    this.renderList();
    this.ctx.setBusy(true, t('Duplikátumok keresése…'));
    const timer = setInterval(async () => {
      const n = await invoke('dups_progress', { job }).catch(() => 0);
      const p = this.optbar.querySelector('.fv-prog');
      if (p) p.textContent = t('{0} fájl átnézve…', n);
    }, 250);
    let res = null;
    try { res = await invoke('find_duplicates', { roots, opts: { ignore: this.s.dir_ignore || '', min_size: this.minSize }, job }); }
    catch (e) { toast(String(e), 'err'); }
    clearInterval(timer);
    this.running = false;
    this.stopping = false;
    this.ctx.setBusy(false);
    if (res) {
      // root indexes refer to the non-empty folders: map them back to left / right
      const idx = this.roots.map((r, i) => (r ? i : -1)).filter((i) => i >= 0);
      for (const g of res.groups) for (const f of g.files) f.root = idx[f.root];
      this.res = res;
      if (res.cancelled) toast(t('A keresés leállítva – az eredmény hiányos.'), 'err');
    }
    this.renderOpts();
    this.renderList();
    this.ctx.changed();
  }

  renderList() {
    if (!this.built) return;
    if (!this.res) {
      this.list.replaceChildren(h('div.diff-msg', this.running ? t('Duplikátumok keresése…') : t('Adj meg egy vagy két mappát (tallózás, útvonal + Enter, vagy húzd ide).')));
      return;
    }
    const groups = this.shown();
    if (!groups.length) {
      this.list.replaceChildren(h('div.diff-msg', this.res.groups.length ? t('A szűrésnek nem felel meg egy elem sem.') : t('Nincs duplikátum ({0} fájl átnézve).', this.res.scanned)));
      return;
    }
    const px = this.large ? 160 : 48;
    const two = !!(this.roots[0] && this.roots[1]);
    const frag = document.createDocumentFragment();
    groups.slice(0, MAX_GROUPS).forEach((g) => {
      const gi = this.res.groups.indexOf(g);
      const img = IMG_THUMB.test(g.files[0].rel);
      const allMarked = g.files.every((f) => this.marked.has(f.path));
      frag.append(h('div.dup-g' + (this.large ? '.large' : '') + (allMarked ? '.danger' : ''),
        h('div.dup-gh', icon(img ? 'image' : 'file'), h('b', basename(g.files[0].rel)),
          h('span.dim', t('{0} példány · {1} / db', g.files.length, fmtSize(g.size))),
          h('span.grow'),
          allMarked ? h('span.dup-warn', t('Minden példány ki van jelölve!')) : null,
          h('span.dim', t('felesleges: {0}', fmtSize(g.size * (g.files.length - 1))))),
        h('div.dup-fs', g.files.map((f) => {
          const on = this.marked.has(f.path);
          const pic = img ? h('div.ti', icon('image'), h('img', { alt: '', draggable: 'false' })) : null;
          if (pic) lazyThumb(pic, () => wantThumb(f.path, g.size, f.mtime, px, pic.querySelector('img')));
          return h('label.dup-f' + (on ? '.marked' : ''), { dataset: { path: f.path, g: String(gi) }, title: f.path },
            h('input', { type: 'checkbox', checked: on, dataset: { path: f.path } }),
            pic,
            two ? h('span.dup-side.' + (f.root ? 'R' : 'L'), f.root ? t('Jobb') : t('Bal')) : null,
            h('span.dup-p', f.rel),
            h('span.dup-d', f.mtime ? fmtDate(f.mtime, true) : ''),
            h('button.icon-btn', { title: t('Megnyitás a fájlkezelőben'), on: { click: (e) => { e.preventDefault(); invoke('reveal_in_explorer', { path: f.path }); } } }, icon('folder')));
        }))));
    });
    if (groups.length > MAX_GROUPS) frag.append(h('div.diff-msg', t('Csak az első {0} csoport látszik; szűkíts a szűrővel vagy a minimális mérettel.', MAX_GROUPS)));
    this.list.replaceChildren(frag);
  }

  async trash(paths) {
    if (!paths.length) return;
    // never let every copy of a file go
    const set = new Set(paths);
    const wipe = this.res.groups.filter((g) => g.files.every((f) => set.has(f.path)));
    if (wipe.length) {
      toast(t('{0} csoportban minden példány ki van jelölve – legalább egyet meg kell tartani.', wipe.length), 'err', 6000);
      return;
    }
    const size = this.res.groups.reduce((a, g) => a + g.files.filter((f) => set.has(f.path)).length * g.size, 0);
    const list = paths.slice(0, 12).map((p) => '• ' + p).join('\n') + (paths.length > 12 ? '\n' + t('… és még {0}', paths.length - 12) : '');
    if (!(await this.ctx.confirm(t('Lomtárba'), t('{0} fájl ({1}) kerül a Lomtárba. Onnan visszaállítható.', paths.length, fmtSize(size)) + '\n\n' + list, t('Lomtárba')))) return;
    this.ctx.setBusy(true, t('Áthelyezés a Lomtárba…'));
    try {
      await invoke('move_to_trash', { paths });
      toast(t('{0} fájl a Lomtárba került.', paths.length), 'ok');
      for (const g of this.res.groups) g.files = g.files.filter((f) => !set.has(f.path));
      this.res.groups = this.res.groups.filter((g) => g.files.length > 1);
      this.res.wasted = this.res.groups.reduce((a, g) => a + g.size * (g.files.length - 1), 0);
      for (const p of paths) this.marked.delete(p);
    } catch (e) { toast(String(e), 'err'); }
    this.ctx.setBusy(false);
    this.renderOpts();
    this.renderList();
  }

  status() {
    const r = this.res;
    if (!r) return [];
    return [h('span', t('{0} fájl átnézve · {1} csoport · {2} visszanyerhető', r.scanned, r.groups.length, fmtSize(r.wasted)))];
  }
}
