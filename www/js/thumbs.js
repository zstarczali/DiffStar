// Image thumbnails for the icon views: made in Rust (local_thumb), cached here,
// loaded only when the tile scrolls into view (taken over from FtpStar).

import { invoke } from './util.js';

export const IMG_THUMB = /\.(jpe?g|png|gif|webp|bmp|ico|svg)$/i;

const cache = new Map();
const queue = [];
let busy = 0;
const PARALLEL = 4;

function show(img, url) {
  img.src = url;
  img.closest('.ti')?.classList.add('has-thumb');
}

async function pump() {
  while (busy < PARALLEL && queue.length) {
    const job = queue.pop(); // the newest first: what is on screen now
    if (!job.img.isConnected) continue;
    if (cache.has(job.key)) { const v = cache.get(job.key); if (v) show(job.img, v); continue; }
    busy++;
    (async () => {
      let url = null;
      try { url = await invoke('local_thumb', { path: job.path, size: job.px }); } catch { url = null; }
      cache.set(job.key, url);
      if (url && job.img.isConnected) show(job.img, url);
      busy--;
      pump();
    })();
  }
}

/** Asks for the thumbnail of `path` into `img` (key: path + size + date). */
export function wantThumb(path, size, mtime, px, img) {
  const key = `${path}|${size}|${mtime}|${px}`;
  if (cache.has(key)) { const v = cache.get(key); if (v) show(img, v); return; }
  queue.push({ path, px, img, key });
  pump();
}

const observer = new IntersectionObserver((list) => {
  for (const it of list) {
    if (!it.isIntersecting) continue;
    observer.unobserve(it.target);
    it.target._want?.();
  }
}, { rootMargin: '200px' });

/** Loads the thumbnail when `el` becomes visible. */
export function lazyThumb(el, want) {
  el._want = want;
  observer.observe(el);
}
