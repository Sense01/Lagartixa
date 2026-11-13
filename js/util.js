/* =========================================================
   Utilitários partilhados (carregado primeiro)
   ========================================================= */

const $ = (id) => document.getElementById(id);

// estado global da sessão (partilhado entre os módulos)
let crawler = null;
let results = [];   // páginas visitadas
let items = [];     // produtos encontrados nesta pesquisa
let kwFilter = null;

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const fmtPrice = (v, cur = '€') => {
  if (v == null || !isFinite(v)) return '';
  const sym = !cur || /^eur$/i.test(cur) ? '€' : cur;
  return `${(+v).toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${sym}`;
};

const fmtDate = (t) => new Date(t).toLocaleDateString('pt-PT', { day: '2-digit', month: '2-digit' });
const fmtDateTime = (t) => new Date(t).toLocaleString('pt-PT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const today = () => new Date().toISOString().slice(0, 10);

const splitList = (txt, re) => String(txt || '').split(re).map((s) => s.trim()).filter(Boolean);
const numOrNull = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function countryOf(url) {
  const tld = hostOf(url).split('.').pop().toUpperCase();
  return ['PT', 'FR', 'ES', 'DE', 'IT', 'BE', 'NL', 'IE', 'AT', 'LU'].includes(tld) ? tld : 'PT';
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent += `[${t}] ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}

/* ---------- folhas da barra inferior (Simular revenda, Histórico, Registo) ---------- */
const Sheets = (() => {
  const all = () => [...document.querySelectorAll('.sheet')];
  const current = () => all().find((el) => !el.classList.contains('hidden'))?.dataset.sheet || null;
  let opener = null;

  function show(name) {
    for (const el of all()) el.classList.toggle('hidden', el.dataset.sheet !== name);
    document.querySelectorAll('[data-sheet-open]').forEach((b) => b.setAttribute('aria-expanded', String(b.dataset.sheetOpen === name)));
    $('sheetBackdrop')?.classList.toggle('hidden', !name);
    document.body.classList.toggle('sheet-open', !!name);
  }
  function open(name) {
    if (!current()) opener = document.activeElement;
    show(name);
    const el = all().find((x) => x.dataset.sheet === name);
    if (name === 'log') { const b = el.querySelector('.sheet-body'); b.scrollTop = b.scrollHeight; }   // o registo abre no fim (o mais recente)
    el?.querySelector('.sheet-close')?.focus({ preventScroll: true });
    document.dispatchEvent(new CustomEvent('sheet', { detail: name }));
  }
  function close() {
    if (!current()) return;
    show(null);
    opener?.focus?.({ preventScroll: true });
  }
  const toggle = (name) => (current() === name ? close() : open(name));

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (e) => {
      const o = e.target.closest('[data-sheet-open]');
      if (o) return toggle(o.dataset.sheetOpen);
      if (e.target.closest('[data-sheet-close]') || e.target.id === 'sheetBackdrop') close();
    });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  }
  return { open, close, toggle, current };
})();

function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

/** mini-gráfico SVG de uma série de preços [[t, preço], …] */
function sparkline(points, w = 84, h = 26) {
  if (!points || points.length < 2) return '';
  const ps = points.map((p) => p[1]);
  const min = Math.min(...ps), max = Math.max(...ps);
  const span = max - min || 1;
  const step = w / (points.length - 1);
  const xy = ps.map((p, i) => `${(i * step).toFixed(1)},${(h - 3 - ((p - min) / span) * (h - 6)).toFixed(1)}`);
  const last = ps[ps.length - 1], first = ps[0];
  const cls = last < first ? 'down' : last > first ? 'up' : 'flat';
  return `<svg class="spark ${cls}" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" aria-hidden="true">
    <polyline points="${xy.join(' ')}" fill="none" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${xy[xy.length - 1].split(',')[0]}" cy="${xy[xy.length - 1].split(',')[1]}" r="2.4"/>
  </svg>`;
}
