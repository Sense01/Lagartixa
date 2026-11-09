/* =========================================================
   App: definições, pesquisas guardadas, execução, tabela,
   estatísticas, notificações locais e exportação
   (carregado por último)
   ========================================================= */

/* ---------- definições ---------- */
const FIELDS = ['sites', 'keywords', 'maxPages', 'maxDepth', 'concurrency', 'delay', 'proxy', 'customProxy',
  'minPrice', 'maxPrice', 'minDiscount', 'shotService', 'dealMode', 'itemSort'];
const CHECKS = ['sameDomain', 'sameSection', 'respectRobots', 'stripQuery', 'useSitemap', 'wholeWord', 'caseSensitive', 'notify',
  'onlyGood', 'hideOut', 'onlyDrops'];

function saveSettings() {
  const s = {};
  FIELDS.forEach((f) => (s[f] = $(f).value));
  CHECKS.forEach((c) => (s[c] = $(c).checked));
  try { localStorage.setItem('crawler-settings', JSON.stringify(s)); } catch {}
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('crawler-settings') || '{}');
    if (s.proxy && s.proxy.includes('://')) s.proxy = 'auto';     // versões antigas
    FIELDS.forEach((f) => {
      const el = $(f);
      if (s[f] == null) return;
      if (f === 'customProxy' && !s[f].trim()) return;             // vazio não apaga o proxy pré-configurado
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === s[f])) return;
      el.value = s[f];
    });
    CHECKS.forEach((c) => s[c] != null && ($(c).checked = s[c]));
  } catch {}
  const p = new URLSearchParams(location.search);                 // ?site=…&kw=…&min=…&max=…&desc=…
  if (p.get('site')) $('sites').value = p.getAll('site').join('\n');
  if (p.get('kw')) $('keywords').value = p.getAll('kw').join('\n');
  if (p.get('min')) $('minPrice').value = p.get('min');
  if (p.get('max')) $('maxPrice').value = p.get('max');
  if (p.get('desc')) $('minDiscount').value = p.get('desc');
}

function buildProxyList() {
  const mode = $('proxy').value;
  const custom = $('customProxy').value.trim();
  const mine = custom ? [{ name: 'o meu proxy', tpl: custom }] : [];
  if (mode === 'none') return [{ name: 'direto', tpl: '{url}' }];
  if (mode === 'custom') return mine;
  if (mode === 'auto') return [...mine, ...PUBLIC_PROXIES];
  return PUBLIC_PROXIES.filter((p) => p.name === mode);
}

/* ---------- pesquisas guardadas ---------- */
const SEARCH_FIELDS = ['sites', 'keywords', 'minPrice', 'maxPrice', 'minDiscount', 'maxPages', 'maxDepth'];
const SEARCH_CHECKS = ['wholeWord', 'caseSensitive', 'sameDomain', 'sameSection'];

function currentConfig() {
  const c = {};
  SEARCH_FIELDS.forEach((f) => (c[f] = $(f).value));
  SEARCH_CHECKS.forEach((f) => (c[f] = $(f).checked));
  return c;
}

function applyConfig(c) {
  SEARCH_FIELDS.forEach((f) => c[f] != null && ($(f).value = c[f]));
  SEARCH_CHECKS.forEach((f) => c[f] != null && ($(f).checked = c[f]));
}

function suggestName() {
  const host = hostOf(splitList($('sites').value, /[\n\s,]+/)[0] || '') || 'pesquisa';
  const kw = splitList($('keywords').value, /[\n,;]+/).slice(0, 2).join(', ');
  const max = $('maxPrice').value ? ` até ${$('maxPrice').value}€` : '';
  return `${kw || host}${kw ? ` · ${host}` : ''}${max}`.slice(0, 60);
}

function renderSearches() {
  const list = Store.searches();
  $('searchesBar').classList.toggle('hidden', !list.length);
  $('savedSearches').innerHTML = list.map((s) => `
    <div class="ss-chip ${s.monitor ? 'mon' : ''}" data-id="${esc(s.id)}">
      <button type="button" class="ss-load" title="Carregar esta pesquisa">${esc(s.name)}</button>
      <button type="button" class="ss-run" title="Executar agora" aria-label="Executar">▶</button>
      <button type="button" class="ss-mon" title="${s.monitor ? 'Alertas ativos: o Worker verifica de hora a hora' : 'Ativar alertas automáticos'}" aria-pressed="${!!s.monitor}">${s.monitor ? '🔔' : '🔕'}</button>
      <button type="button" class="ss-del" title="Apagar" aria-label="Apagar">✕</button>
    </div>`).join('');
}

$('saveSearch').addEventListener('click', () => {
  if (!$('sites').value.trim()) return toast('Indica pelo menos um site antes de guardar.');
  const name = prompt('Nome desta pesquisa:', suggestName());
  if (!name) return;
  Store.saveSearch(name.trim(), currentConfig());
  toast(`💾 Pesquisa "${name.trim()}" guardada`);
});

$('savedSearches').addEventListener('click', (e) => {
  const chip = e.target.closest('.ss-chip');
  if (!chip) return;
  const s = Store.searches().find((x) => x.id === chip.dataset.id);
  if (!s) return;
  if (e.target.closest('.ss-del')) {
    if (confirm(`Apagar a pesquisa "${s.name}"?`)) Store.removeSearch(s.id);
  } else if (e.target.closest('.ss-mon')) {
    Store.updateSearch(s.id, { monitor: !s.monitor });
    toast(!s.monitor ? `🔔 "${s.name}": o Worker vai avisar-te de produtos novos e descidas de preço` : `🔕 Alertas desligados para "${s.name}"`, 5000);
  } else {
    applyConfig(s.config);
    toast(`Pesquisa "${s.name}" carregada`, 2000);
    if (e.target.closest('.ss-run')) {
      Store.updateSearch(s.id, { lastRun: Date.now() });
      $('config').requestSubmit();
    }
  }
});

Store.on('searches', () => { renderSearches(); Monitor.scheduleSync(); });

/* ---------- tabela de páginas ---------- */
function statusClass(s) {
  if (typeof s !== 'number') return 's-err';
  if (s < 300) return 's-ok';
  if (s < 400) return 's-redirect';
  return 's-err';
}

function keywordCell(r) {
  const hits = r.keywordHits || {};
  const kws = Object.keys(hits);
  let html = r.productsFound ? `<span class="tag tag-prod">${r.items?.length || 0}/${r.productsFound} produtos</span>` : '';
  if (!kws.length) return html;
  const tags = kws.map((k) => `<span class="tag">${esc(k)} × ${hits[k]}</span>`).join('');
  const snips = kws.flatMap((k) => (r.keywordSnippets?.[k] || []).map(
    (s) => `<p class="snip">${esc(s.before)}<mark>${esc(s.match)}</mark>${esc(s.after)}</p>`)).join('');
  return html + `<details><summary>${tags}</summary>${snips}</details>`;
}

function addRow(r, i) {
  const tr = document.createElement('tr');
  tr.dataset.search = `${r.url} ${r.title} ${r.status} ${r.error}`.toLowerCase();
  tr.dataset.kws = JSON.stringify(Object.keys(r.keywordHits || {}));
  tr.dataset.items = r.items?.length || 0;
  tr.innerHTML = `
    <td class="num">${i}</td>
    <td class="url"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
    <td class="${statusClass(r.status)} status">${esc(r.status)}${r.error && typeof r.status !== 'number' ? ' — ' + esc(r.error) : ''}</td>
    <td>${esc(r.title)}</td>
    <td class="kw">${keywordCell(r)}</td>
    <td class="num">${r.depth}</td>
    <td class="num">${r.links?.length ?? 0}</td>
    <td class="num">${r.ms || ''}</td>`;
  applyRowFilter(tr);
  $('results').appendChild(tr);
}

function applyRowFilter(tr) {
  const q = $('filter').value.trim().toLowerCase();
  const kws = JSON.parse(tr.dataset.kws);
  tr.style.display =
    (!q || tr.dataset.search.includes(q)) &&
    (!$('onlyMatches').checked || kws.length > 0 || +tr.dataset.items > 0) &&
    (!kwFilter || kws.includes(kwFilter)) ? '' : 'none';
}
const refilterRows = () => document.querySelectorAll('#results tr').forEach(applyRowFilter);
$('filter').addEventListener('input', refilterRows);
$('onlyMatches').addEventListener('change', refilterRows);

/* ---------- palavras-chave e estatísticas ---------- */
function renderKeywordSummary(s) {
  const kws = Object.keys(s.keywordTotals || {});
  $('kwPanel').classList.toggle('hidden', !kws.length);
  $('kwSummary').innerHTML = kws.map((k) => {
    const n = s.keywordTotals[k];
    return `<div class="kw-card ${n ? '' : 'zero'} ${kwFilter === k ? 'active' : ''}" data-kw="${esc(k)}">
      <b>${esc(k)}</b><small>${n} ocorrências · ${s.keywordPages[k]} páginas</small></div>`;
  }).join('');
}

$('kwSummary').addEventListener('click', (e) => {
  const card = e.target.closest('.kw-card');
  if (!card) return;
  kwFilter = kwFilter === card.dataset.kw ? null : card.dataset.kw;
  if (crawler) renderKeywordSummary(crawler.stats());
  refilterRows();
  renderItems();
});

function updateStats(s, state) {
  $('statCrawled').textContent = s.crawled;
  $('statQueued').textContent = s.queued;
  $('statItems').textContent = s.items;
  $('statMatches').textContent = s.matches;
  $('statErrors').textContent = s.errors;
  $('statLinks').textContent = s.links;
  if (state) $('statStatus').textContent = state;
  renderKeywordSummary(s);
}

/* ---------- notificações locais, som e badge ---------- */
let audioCtx = null;
function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch {}
}

function chime() {
  if (!audioCtx) return;
  const t = audioCtx.currentTime;
  [660, 880, 1320].forEach((f, i) => {
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0, t + i * 0.12);
    g.gain.linearRampToValueAtTime(0.15, t + i * 0.12 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.12 + 0.6);
    o.connect(g).connect(audioCtx.destination);
    o.start(t + i * 0.12);
    o.stop(t + i * 0.12 + 0.65);
  });
}

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
}

async function askNotifyPermission() {
  if (!$('notify').checked || !('Notification' in window)) return;
  if (Notification.permission === 'default') {
    try { await Notification.requestPermission(); } catch {}
  }
}

async function notifyLocal(title, body) {
  chime();
  navigator.vibrate?.([120, 60, 120]);
  toast(`${title} — ${body}`, 7000);
  try { navigator.setAppBadge?.(items.length || undefined); } catch {}
  if (!$('notify').checked || !('Notification' in window) || Notification.permission !== 'granted') return;
  const opts = { body, icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', tag: 'crawl-done', renotify: true };
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    if (reg) return await reg.showNotification(title, opts);
  } catch {}
  try { new Notification(title, opts); } catch {}
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) try { navigator.clearAppBadge?.(); } catch {}
});

/* ---------- iniciar / parar ---------- */
function setRunning(on) {
  $('startBtn').disabled = on;
  $('stopBtn').disabled = !on;
  $('exportJson').disabled = on || !results.length;
  $('exportCsv').disabled = on || !results.length;
  $('exportItems').disabled = on || !items.length;
  document.querySelectorAll('#config input, #config select, #config textarea').forEach((el) => (el.disabled = on));
  document.querySelectorAll('#savedSearches button').forEach((el) => (el.disabled = on));
}

$('config').addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockAudio();                              // o iOS só deixa tocar som depois de um toque
  const permission = askNotifyPermission();   // tem de ser pedido logo no toque
  saveSettings();

  const proxies = buildProxyList();
  if (!proxies.length) return alert('Escreve o endereço do teu proxy ou escolhe outro modo.');
  if (proxies.some((p) => p.tpl !== '{url}' && !p.tpl.includes('{url}') && !p.tpl.includes('{rawurl}'))) {
    return alert('O proxy tem de conter o marcador {url}.');
  }

  results = [];
  items = [];
  kwFilter = null;
  $('results').innerHTML = '';
  $('items').innerHTML = '';
  $('itemsPanel').classList.add('hidden');
  $('comparePanel').classList.add('hidden');
  $('log').textContent = '';
  try { navigator.clearAppBadge?.(); } catch {}

  crawler = new Crawler({
    startUrls: splitList($('sites').value, /[\n\s,]+/),
    keywords: splitList($('keywords').value, /[\n,;]+/),
    wholeWord: $('wholeWord').checked,
    caseSensitive: $('caseSensitive').checked,
    minPrice: numOrNull($('minPrice').value),
    maxPrice: numOrNull($('maxPrice').value),
    minDiscount: numOrNull($('minDiscount').value),
    maxPages: +$('maxPages').value,
    maxDepth: +$('maxDepth').value,
    concurrency: +$('concurrency').value,
    delay: +$('delay').value,
    proxies,
    sameDomain: $('sameDomain').checked,
    sameSection: $('sameSection').checked,
    respectRobots: $('respectRobots').checked,
    stripQuery: $('stripQuery').checked,
    useSitemap: $('useSitemap').checked,
  });

  crawler.onResult = (r, i) => { results.push(r); addRow(r, i); };
  crawler.onItem = (it, n) => {
    it.trend = Store.recordPrice(it);         // histórico de preços (antes de desenhar o cartão)
    items.push(it);
    appendItem(it, n);
  };
  crawler.onLog = log;
  crawler.onProgress = (s) => updateStats(s, 'a correr');

  setRunning(true);
  updateStats(crawler.stats(), 'a correr');
  await permission;
  let state = 'concluído';
  try {
    const { stopped } = await crawler.start();
    if (stopped) state = 'parado';
  } catch (err) {
    log('Erro: ' + err.message);
    state = 'erro';
  }
  const s = crawler.stats();
  updateStats(s, state);
  setRunning(false);
  renderItems();
  renderCompare();
  renderWatch();

  if (state !== 'parado') {
    const drops = items.filter((it) => it.trend?.change < 0).length;
    const body = items.length
      ? `${items.length} produto(s) em ${s.crawled} página(s)${drops ? ` · ${drops} desceram de preço` : ''}`
      : s.errors && s.errors === s.crawled
        ? `Falhou: ${s.errors} erro(s) — vê o log`
        : `${s.crawled} página(s) analisada(s), ${s.matches} com palavras-chave`;
    await notifyLocal(state === 'erro' ? 'Crawling com erro' : 'Crawling terminado', body);
    if ($('dealMode').value === 'auto' && items.length) autoEvaluateDeals();
  }
});

$('stopBtn').addEventListener('click', () => {
  crawler?.stop();
  updateStats(crawler.stats(), 'parado');
});

/* ---------- exportar ---------- */
$('exportJson').addEventListener('click', () => {
  download(`crawl-${stamp()}.json`, JSON.stringify({ pages: results, products: items }, null, 2), 'application/json');
});

$('exportCsv').addEventListener('click', () => {
  const kws = Object.keys(crawler?.keywordTotals || {});
  const cols = ['url', 'status', 'title', 'description', 'depth', 'from', 'ms', 'wordCount', 'images', 'canonical', 'error'];
  const header = [...cols, 'links', 'products', 'keywordTotal', ...kws.map((k) => `kw:${k}`)];
  const rows = results.map((r) =>
    [...cols.map((c) => r[c]), r.links?.length ?? 0, r.items?.length ?? 0, r.keywordTotal ?? 0, ...kws.map((k) => r.keywordHits?.[k] ?? 0)]
      .map(csvCell).join(','));
  download(`paginas-${stamp()}.csv`, '﻿' + [header.map(csvCell).join(','), ...rows].join('\n'), 'text/csv');
});

$('exportItems').addEventListener('click', () => {
  const cols = ['name', 'brand', 'price', 'oldPrice', 'discount', 'availability', 'ean', 'url', 'image', 'page', 'source', 'foundAt'];
  const head = [...cols, 'identidade', 'preco_anterior', 'variacao', 'minimo_historico', 'keywords', 'screenshot',
    'negocio', 'pontuacao', 'preco_tipico', 'preco_mais_baixo', 'pvp', 'resumo'];
  const rows = items.map((it) => [
    ...cols.map((c) => it[c]), Store.productIdentity(it) || '', it.trend?.prev ?? '', it.trend?.change ?? '', it.trend?.min ?? '',
    Object.keys(it.keywordHits || {}).join(' | '), screenshotUrl(it.url),
    it.deal?.verdict ?? '', it.deal?.score ?? '', it.deal?.typicalPrice ?? '', it.deal?.lowestPrice ?? '', it.deal?.rrp ?? '', it.deal?.summary ?? '',
  ].map(csvCell).join(','));
  download(`produtos-${stamp()}.csv`, '﻿' + [head.map(csvCell).join(','), ...rows].join('\n'), 'text/csv');
});

/* ---------- arranque ---------- */
loadSettings();
['itemSort', 'onlyGood', 'hideOut', 'onlyDrops'].forEach((id) => $(id).addEventListener('change', saveSettings));
renderSearches();
renderWatch();
SiteDir.load();
if (Store.watchList().length || Store.searches().some((s) => s.monitor)) Monitor.refresh();
