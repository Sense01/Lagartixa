/* =========================================================
   Produtos seguidos: painel, preço-alvo e atualização de preços
   ========================================================= */

function watchRowHtml(w) {
  const h = Store.getHistory(w.url);
  const pts = h?.pts || [];
  const cur = pts.length ? pts[pts.length - 1][1] : w.price;
  const first = pts.length ? pts[0][1] : w.price;
  const diff = cur != null && first != null ? Math.round((cur - first) * 100) / 100 : 0;
  const hit = w.target != null && cur != null && cur <= w.target;
  const av = h?.av === 'out' ? '<span class="stock-badge st-out inline">Esgotado</span>' : '';
  return `<div class="w-row ${hit ? 'hit' : ''}" data-key="${esc(w.key)}">
    <a class="w-img" href="${esc(w.url)}" target="_blank" rel="noopener">${w.image ? `<img src="${esc(w.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}</a>
    <div class="w-info">
      <a class="w-name" href="${esc(w.url)}" target="_blank" rel="noopener">${esc(w.name)}</a>
      <small>${esc(w.store)}${w.lastChecked ? ` · verificado ${fmtDateTime(w.lastChecked)}` : ''} ${av}</small>
      <label class="w-target">Avisar abaixo de
        <input type="number" min="0" step="0.01" inputmode="decimal" value="${w.target ?? ''}" placeholder="—"> €
      </label>
    </div>
    <div class="w-price">
      <b>${fmtPrice(cur) || '—'}</b>
      ${diff ? `<span class="chg ${diff < 0 ? 'down' : 'up'}">${diff < 0 ? '↓' : '↑'} ${fmtPrice(Math.abs(diff))}</span>` : ''}
      ${sparkline(pts, 90, 26)}
      ${hit ? '<span class="low">🎯 abaixo do alvo</span>' : ''}
    </div>
    <button type="button" class="w-del" aria-label="Deixar de seguir" title="Deixar de seguir">✕</button>
  </div>`;
}

function renderWatch() {
  const list = Store.watchList();
  $('watchCount').textContent = list.length;
  $('watchPanel').classList.toggle('hidden', !list.length);
  $('watchList').innerHTML = list.map(watchRowHtml).join('');
}

$('watchList').addEventListener('change', (e) => {
  const inp = e.target.closest('.w-target input');
  if (!inp) return;
  const key = e.target.closest('.w-row').dataset.key;
  Store.updateWatch(key, { target: numOrNull(inp.value) });
  toast(inp.value ? `🎯 Vais ser avisado abaixo de ${fmtPrice(+inp.value)}` : 'Preço-alvo removido', 2500);
});

$('watchList').addEventListener('click', (e) => {
  const del = e.target.closest('.w-del');
  if (!del) return;
  Store.removeWatch(del.closest('.w-row').dataset.key);
  renderItemsThrottled();   // atualiza o botão "Seguir" nos cartões
});

/** vai à página de cada produto seguido e regista o preço atual */
async function refreshWatchPrices() {
  const list = Store.watchList();
  if (!list.length) return;
  const btn = $('watchRefresh');
  btn.disabled = true;
  const fetcher = new Crawler({ proxies: buildProxyList(), timeout: 20000 });
  fetcher.running = true;
  const changes = [];
  let done = 0;
  const queue = [...list];
  async function worker() {
    while (queue.length) {
      const w = queue.shift();
      btn.textContent = `🔄 ${++done}/${list.length}…`;
      try {
        const r = await fetcher.fetchText(w.url);
        const p = Crawler.detectBlock(r) ? null : LiteX.productFromHtml(r.text, w.url);
        if (p?.price != null) {
          const t = Store.recordPrice({ ...w, ...p, name: w.name, url: w.url, image: w.image || p.image });
          Store.updateWatch(w.key, { price: p.price, lastChecked: Date.now(), error: null });
          if (t?.change) changes.push({ w, t, price: p.price });
          else if (w.target != null && p.price <= w.target) changes.push({ w, t: { change: 0 }, price: p.price, target: true });
        } else {
          Store.updateWatch(w.key, { lastChecked: Date.now(), error: 'preço não encontrado' });
        }
      } catch (e) {
        Store.updateWatch(w.key, { lastChecked: Date.now(), error: e.message });
      }
    }
  }
  await Promise.all([worker(), worker()]);
  btn.disabled = false;
  btn.textContent = '🔄 Atualizar preços';
  renderWatch();
  const drops = changes.filter((c) => c.t.change < 0 || c.target);
  if (drops.length) {
    const first = drops[0];
    notifyLocal(
      drops.length === 1 ? `↓ ${first.w.name}` : `${drops.length} produtos seguidos desceram`,
      drops.length === 1 ? `Agora ${fmtPrice(first.price)} em ${first.w.store}` : drops.map((d) => `${d.w.name.slice(0, 30)}: ${fmtPrice(d.price)}`).join(' · ')
    );
  } else {
    toast(`Preços atualizados: ${changes.length ? `${changes.length} subida(s)` : 'sem descidas'}`);
  }
}

$('watchRefresh').addEventListener('click', refreshWatchPrices);
Store.on('watch', () => { renderWatch(); Monitor.scheduleSync(); });

/* ---------- Páginas visitadas: os produtos que abriste a partir da app ---------- */
const Visited = (() => {
  const KEY = ((typeof window !== 'undefined' && window.STORE_PREFIX) || '') + 'crawler-visited';
  const MAX = 100;
  const list = () => { try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; } };
  const save = (l) => { try { localStorage.setItem(KEY, JSON.stringify(l.slice(0, MAX))); } catch {} };

  /** guarda um link aberto (o mais recente fica em cima; o mesmo endereço não se repete) */
  function add(v) {
    if (!/^https?:\/\//i.test(v.url || '')) return;
    save([{ ...v, t: Date.now() }, ...list().filter((x) => x.url !== v.url)]);
    if (Sheets.current() === 'visited') render();
  }

  const ago = (t) => {
    const m = Math.round((Date.now() - t) / 60000);
    return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : fmtDate(t);
  };

  function render() {
    const l = list();
    $('visitedList').innerHTML = l.length
      ? l.map((v) => `<a class="visited-row" href="${esc(v.url)}" target="_blank" rel="noopener" data-visited="1">
          ${v.image ? `<img src="${esc(v.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '<span class="visited-ph">🔗</span>'}
          <span class="visited-txt"><b>${esc(v.name || hostOf(v.url))}</b><small>${esc(hostOf(v.url))} · ${ago(v.t)}</small></span>
          ${v.price != null ? `<b class="visited-price">${fmtPrice(v.price)}</b>` : ''}
        </a>`).join('')
      : '<p class="empty">Ainda não abriste nenhum produto. Quando tocares em "Abrir ↗" num produto, ele fica guardado aqui.</p>';
    $('visitedClear').classList.toggle('hidden', !l.length);
  }

  function init() {
    if (!$('visitedPanel')) return;
    // qualquer link para uma loja aberto a partir da app (cartões, comparação, leitor, seguidos, preços da IA)
    document.addEventListener('click', (e) => {
      const a = e.target.closest('a[href^="http"][target="_blank"]');
      if (!a || a.dataset.visited || a.closest('#visitedPanel')) return;
      const card = a.closest('.item');
      const it = card ? items[+card.dataset.idx] : null;
      const url = it && a.classList.contains('btn') ? it.url : a.href;
      if (it && url === it.url) add({ url, name: it.name, price: it.price, image: it.image || '' });
      else if (it) add({ url, name: it.name, image: it.image || '' });          // o mesmo produto, noutra loja
      else add({ url, name: (a.querySelector('.w-name, .rs-name')?.textContent || a.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120) });
    }, true);
    $('visitedClear').addEventListener('click', () => { save([]); render(); });
    document.addEventListener('sheet', (e) => { if (e.detail === 'visited') render(); });
  }

  return { add, list, render, init };
})();
