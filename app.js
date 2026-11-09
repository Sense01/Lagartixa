const $ = (id) => document.getElementById(id);

let crawler = null;
let results = [];
let items = [];
let kwFilter = null;

/* =========================================================
   Definições
   ========================================================= */
const FIELDS = ['sites', 'keywords', 'maxPages', 'maxDepth', 'concurrency', 'delay', 'proxy', 'customProxy',
  'minPrice', 'maxPrice', 'minDiscount', 'shotService', 'dealMode'];
const CHECKS = ['sameDomain', 'sameSection', 'respectRobots', 'stripQuery', 'wholeWord', 'caseSensitive', 'notify'];

function saveSettings() {
  const s = {};
  FIELDS.forEach((f) => (s[f] = $(f).value));
  CHECKS.forEach((c) => (s[c] = $(c).checked));
  try { localStorage.setItem('crawler-settings', JSON.stringify(s)); } catch {}
}

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem('crawler-settings') || '{}');
    // versões antigas guardavam o URL do proxy no seletor
    if (s.proxy && s.proxy.includes('://')) s.proxy = 'auto';
    FIELDS.forEach((f) => {
      const el = $(f);
      if (s[f] == null) return;
      if (f === 'customProxy' && !s[f].trim()) return; // campo vazio guardado não apaga o proxy pré-configurado
      if (el.tagName === 'SELECT' && ![...el.options].some((o) => o.value === s[f])) return;
      el.value = s[f];
    });
    CHECKS.forEach((c) => s[c] != null && ($(c).checked = s[c]));
  } catch {}
  // ?site=…&kw=…&min=…&max=…&desc=…
  const p = new URLSearchParams(location.search);
  if (p.get('site')) $('sites').value = p.getAll('site').join('\n');
  if (p.get('kw')) $('keywords').value = p.getAll('kw').join('\n');
  if (p.get('min')) $('minPrice').value = p.get('min');
  if (p.get('max')) $('maxPrice').value = p.get('max');
  if (p.get('desc')) $('minDiscount').value = p.get('desc');
}
loadSettings();

const splitList = (txt, re) => txt.split(re).map((s) => s.trim()).filter(Boolean);
const numOrNull = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);

function buildProxyList() {
  const mode = $('proxy').value;
  const custom = $('customProxy').value.trim();
  const mine = custom ? [{ name: 'o meu proxy', tpl: custom }] : [];
  if (mode === 'none') return [{ name: 'direto', tpl: '{url}' }];
  if (mode === 'custom') return mine;
  if (mode === 'auto') return [...mine, ...PUBLIC_PROXIES];
  return PUBLIC_PROXIES.filter((p) => p.name === mode);
}

/* =========================================================
   UI básica
   ========================================================= */
function log(msg) {
  const t = new Date().toLocaleTimeString();
  $('log').textContent += `[${t}] ${msg}\n`;
  $('log').scrollTop = $('log').scrollHeight;
}

function toast(msg, ms = 4000) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), ms);
}

function statusClass(s) {
  if (typeof s !== 'number') return 's-err';
  if (s < 300) return 's-ok';
  if (s < 400) return 's-redirect';
  return 's-err';
}

function esc(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

const fmtPrice = (v, cur = '€') =>
  v == null ? '' : `${v.toLocaleString('pt-PT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur}`;

/* =========================================================
   Tabela de páginas
   ========================================================= */
function keywordCell(r) {
  const hits = r.keywordHits || {};
  const kws = Object.keys(hits);
  let html = '';
  if (r.productsFound) {
    html += `<span class="tag tag-prod">${r.items?.length || 0}/${r.productsFound} produtos</span>`;
  }
  if (!kws.length) return html;
  const tags = kws.map((k) => `<span class="tag">${esc(k)} × ${hits[k]}</span>`).join('');
  const snips = kws
    .flatMap((k) => (r.keywordSnippets?.[k] || []).map(
      (s) => `<p class="snip">${esc(s.before)}<mark>${esc(s.match)}</mark>${esc(s.after)}</p>`
    ))
    .join('');
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
  applyFilter(tr);
  $('results').appendChild(tr);
}

function applyFilter(tr) {
  const q = $('filter').value.trim().toLowerCase();
  const kws = JSON.parse(tr.dataset.kws);
  const show =
    (!q || tr.dataset.search.includes(q)) &&
    (!$('onlyMatches').checked || kws.length > 0 || +tr.dataset.items > 0) &&
    (!kwFilter || kws.includes(kwFilter));
  tr.style.display = show ? '' : 'none';
}
const refilter = () => document.querySelectorAll('#results tr').forEach(applyFilter);
$('filter').addEventListener('input', refilter);
$('onlyMatches').addEventListener('change', refilter);

/* =========================================================
   Resumo de palavras-chave e estatísticas
   ========================================================= */
function renderKeywordSummary(s) {
  const kws = Object.keys(s.keywordTotals || {});
  $('kwPanel').classList.toggle('hidden', !kws.length);
  $('kwSummary').innerHTML = kws
    .map((k) => {
      const n = s.keywordTotals[k];
      const cls = ['kw-card', n ? '' : 'zero', kwFilter === k ? 'active' : ''].join(' ');
      return `<div class="${cls}" data-kw="${esc(k)}">
        <b>${esc(k)}</b><small>${n} ocorrências · ${s.keywordPages[k]} páginas</small></div>`;
    })
    .join('');
}

$('kwSummary').addEventListener('click', (e) => {
  const card = e.target.closest('.kw-card');
  if (!card) return;
  kwFilter = kwFilter === card.dataset.kw ? null : card.dataset.kw;
  if (crawler) renderKeywordSummary(crawler.stats());
  refilter();
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

/* =========================================================
   Produtos encontrados + screenshots
   ========================================================= */
function screenshotUrl(url) {
  switch ($('shotService').value) {
    case 'mshots': return `https://s.wordpress.com/mshots/v1/${encodeURIComponent(url)}?w=1200&h=900`;
    case 'thumio': return `https://image.thum.io/get/width/1200/crop/900/noanimate/${url}`;
    default: return '';
  }
}

// O mShots devolve uma imagem provisória (400×300) enquanto gera a captura: voltamos a pedir.
function watchShot(img) {
  const box = img.closest('.shot-thumb');
  img.addEventListener('load', () => {
    const tries = +(img.dataset.tries || 0);
    if ($('shotService').value === 'mshots' && img.naturalWidth === 400 && img.naturalHeight === 300 && tries < 8) {
      img.dataset.tries = tries + 1;
      box?.classList.add('loading');
      setTimeout(() => (img.src = img.dataset.src + `&r=${Date.now()}`), 3500);
    } else {
      box?.classList.remove('loading');
      box?.classList.add('ready');
    }
  });
  img.addEventListener('error', () => box?.classList.add('failed'));
}

function itemCard(it, idx) {
  const shot = screenshotUrl(it.url);
  const kws = Object.keys(it.keywordHits || {});
  const div = document.createElement('article');
  div.className = 'item';
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="media ${it.image ? '' : 'no-img'}">
      ${it.image
        ? `<img class="prod-img" src="${esc(it.image)}" alt="${esc(it.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
        : ''}
      ${it.discount != null ? `<span class="badge">-${it.discount}%</span>` : ''}
      ${shot ? `
        <button type="button" class="shot-thumb loading" aria-label="Ver captura da página">
          <img data-src="${esc(shot)}" src="${esc(shot)}" alt="" loading="lazy" decoding="async">
          <span class="shot-label">página</span>
        </button>` : ''}
    </div>
    <div class="item-body">
      ${it.brand ? `<div class="brand">${esc(it.brand)}</div>` : ''}
      <div class="name">${esc(it.name || 'Sem nome')}</div>
      <div class="prices">
        <span class="price">${fmtPrice(it.price, it.currency)}</span>
        ${it.oldPrice != null ? `<s>${fmtPrice(it.oldPrice, it.currency)}</s>` : ''}
      </div>
      ${kws.length ? `<div>${kws.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : ''}
      <div class="deal">${it.deal ? dealHtml(it.deal) : ''}</div>
      <div class="item-actions">
        <a class="btn" href="${esc(it.url)}" target="_blank" rel="noopener">Abrir ↗</a>
        <button type="button" class="save-card">📸 Guardar</button>
        ${$('dealMode').value !== 'off' && it.price != null ? `<button type="button" class="deal-btn">${it.deal && !it.deal.loading ? '🔄 Reavaliar' : '💡 Negócio?'}</button>` : ''}
      </div>
    </div>`;
  div.querySelectorAll('.shot-thumb img').forEach(watchShot);
  // se a foto do produto falhar, a captura da página passa a ocupar o espaço
  div.querySelector('.prod-img')?.addEventListener('error', (e) => {
    e.target.remove();
    div.querySelector('.media').classList.add('no-img');
  });
  return div;
}

/* ---------- "é bom negócio?" (Claude + pesquisa web, através do teu Worker) ---------- */
function dealEndpoint() {
  const tpl = $('customProxy').value.trim();
  if (!tpl) return null;
  try { return new URL(tpl.replace('{url}', 'x').replace('{rawurl}', 'x')).origin + '/deal'; } catch { return null; }
}

function countryOf(url) {
  try {
    const tld = new URL(url).hostname.split('.').pop().toUpperCase();
    return ['PT', 'FR', 'ES', 'DE', 'IT', 'BE', 'NL', 'IE', 'AT', 'LU'].includes(tld) ? tld : 'PT';
  } catch { return 'PT'; }
}

const VERDICTS = {
  bom: ['Bom negócio', 'v-bom'],
  razoavel: ['Preço normal', 'v-razoavel'],
  caro: ['Caro', 'v-caro'],
  incerto: ['Sem certeza', 'v-incerto'],
};

function dealHtml(d) {
  if (d.loading) return `<div class="deal-box loading">🔎 A pesquisar preços na web…</div>`;
  if (d.error) return `<div class="deal-box v-caro">⚠️ ${esc(d.error)}</div>`;
  const key = String(d.verdict || 'incerto').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const [label, cls] = VERDICTS[key] || VERDICTS.incerto;
  const nums = [
    d.typicalPrice != null && `típico <b>${fmtPrice(+d.typicalPrice)}</b>`,
    d.lowestPrice != null && `mais baixo <b>${fmtPrice(+d.lowestPrice)}</b>`,
    d.rrp != null && `PVP <b>${fmtPrice(+d.rrp)}</b>`,
  ].filter(Boolean).join(' · ');
  const src = (d.sources || []).slice(0, 3).map((s) => {
    let host = s.url; try { host = new URL(s.url).hostname.replace(/^www\./, ''); } catch {}
    return `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(host)}</a>`;
  }).join(' ');
  return `<div class="deal-box ${cls}">
      <div class="deal-head"><span class="verdict">${label}</span>${d.score != null ? `<span class="score">${Math.round(d.score)}/100</span>` : ''}</div>
      ${nums ? `<div class="deal-nums">${nums}</div>` : ''}
      ${d.summary ? `<div class="deal-sum">${esc(d.summary)}</div>` : ''}
      ${src ? `<div class="deal-src">${src}</div>` : ''}
    </div>`;
}

function refreshCard(it) {
  const idx = items.indexOf(it);
  const card = document.querySelector(`.item[data-idx="${idx}"]`);
  if (card) card.replaceWith(itemCard(it, idx));
}

const dealKey = (it) => `deal:${it.name}|${it.price}`.toLowerCase();

async function evaluateDeal(it, { force = false } = {}) {
  const endpoint = dealEndpoint();
  if (!endpoint) {
    it.deal = { error: 'Configura "O meu proxy" (o teu Worker) para usar esta função' };
    refreshCard(it);
    return it.deal;
  }
  if (!force) {
    try {
      const saved = JSON.parse(localStorage.getItem(dealKey(it)) || 'null');
      if (saved && Date.now() - Date.parse(saved.checkedAt) < 24 * 3600e3) { it.deal = saved; refreshCard(it); return saved; }
    } catch {}
  }
  it.deal = { loading: true };
  refreshCard(it);
  try {
    let store = ''; try { store = new URL(it.url).hostname.replace(/^www\./, ''); } catch {}
    const name = it.brand && !it.name.toLowerCase().includes(it.brand.toLowerCase()) ? `${it.brand} ${it.name}` : it.name;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, price: it.price, oldPrice: it.oldPrice, currency: 'EUR', store, country: countryOf(it.url) }),
    });
    const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    it.deal = data;
    try { localStorage.setItem(dealKey(it), JSON.stringify(data)); } catch {}
  } catch (e) {
    it.deal = { error: /Failed to fetch|Load failed|NetworkError/.test(e.message)
      ? 'O Worker não respondeu — confirma que tem a versão nova (com /deal)' : e.message };
  }
  refreshCard(it);
  return it.deal;
}

async function autoEvaluateDeals() {
  const top = items.filter((it) => it.price != null && !it.deal)
    .sort((a, b) => (b.discount ?? -1) - (a.discount ?? -1)).slice(0, 10);
  if (!top.length) return;
  toast(`💡 A avaliar ${top.length} produto(s)…`);
  let good = 0, done = 0;
  for (const it of top) {
    const d = await evaluateDeal(it);
    if (d?.error) { if (/proxy|Worker|API_KEY|autorizada/.test(d.error)) break; continue; }
    done++;
    if (String(d?.verdict || '').startsWith('bom')) good++;
  }
  if (done) notifyDone('Avaliação concluída', good ? `${good} bom(ns) negócio(s) entre ${done} produto(s)` : `Nenhum bom negócio claro entre ${done} produto(s)`);
}

/* ---------- visualizador da captura ---------- */
function openViewer(it, src) {
  $('viewerImg').src = src;
  $('viewerTitle').textContent = it.name || it.url;
  $('viewerOpen').href = it.url;
  $('viewer').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeViewer() {
  $('viewer').classList.add('hidden');
  document.body.style.overflow = '';
}
$('viewerClose').addEventListener('click', closeViewer);
$('viewer').addEventListener('click', (e) => { if (e.target.id === 'viewer') closeViewer(); });
addEventListener('keydown', (e) => { if (e.key === 'Escape') closeViewer(); });

function sortedItems() {
  const list = items.map((it, i) => ({ it, i }))
    .filter(({ it }) => !kwFilter || it.keywordHits?.[kwFilter]);
  const by = $('itemSort').value;
  const val = (v, d) => (v == null ? d : v);
  if (by === 'discount') list.sort((a, b) => val(b.it.discount, -1) - val(a.it.discount, -1));
  if (by === 'priceAsc') list.sort((a, b) => val(a.it.price, Infinity) - val(b.it.price, Infinity));
  if (by === 'priceDesc') list.sort((a, b) => val(b.it.price, -1) - val(a.it.price, -1));
  return list;
}

function renderItems() {
  $('itemsPanel').classList.toggle('hidden', !items.length);
  const box = $('items');
  box.innerHTML = '';
  sortedItems().forEach(({ it, i }) => box.appendChild(itemCard(it, i)));
}
$('itemSort').addEventListener('change', renderItems);

function appendItem(it, n) {
  $('itemsPanel').classList.remove('hidden');
  if ($('itemSort').value !== 'found' || kwFilter) return renderItemsThrottled();
  $('items').appendChild(itemCard(it, n - 1));
}
let rt = 0;
function renderItemsThrottled() {
  clearTimeout(rt);
  rt = setTimeout(renderItems, 400);
}

$('items').addEventListener('click', (e) => {
  const thumb = e.target.closest('.shot-thumb');
  if (thumb) {
    const it = items[+thumb.closest('.item').dataset.idx];
    return openViewer(it, thumb.querySelector('img').src);
  }
  const dealBtn = e.target.closest('.deal-btn');
  if (dealBtn) {
    const it = items[+dealBtn.closest('.item').dataset.idx];
    if (it.deal?.loading) return;
    return evaluateDeal(it, { force: !!it.deal });
  }
  const btn = e.target.closest('.save-card');
  if (!btn) return;
  const it = items[+btn.closest('.item').dataset.idx];
  btn.disabled = true;
  saveItemImage(it).finally(() => (btn.disabled = false));
});

/* ---------- imagem PNG de um produto (cartão gerado no próprio browser) ---------- */
function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = rej;
    img.src = src;
  });
}

async function loadProductImage(url) {
  if (!url) return null;
  try { return await loadImage(url); } catch {}
  // sem CORS direto → tenta via proxy
  for (const p of buildProxyList()) {
    try {
      const target = p.tpl === '{url}' ? url : p.tpl.replace('{url}', encodeURIComponent(url)).replace('{rawurl}', url);
      const blob = await (await fetch(target)).blob();
      if (!blob.type.startsWith('image/')) continue;
      return await loadImage(URL.createObjectURL(blob));
    } catch {}
  }
  return null;
}

function wrapText(ctx, text, maxW, maxLines) {
  const words = text.split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) {
      lines.push(line);
      line = w;
      if (lines.length === maxLines) break;
    } else line = t;
  }
  if (lines.length < maxLines && line) lines.push(line);
  if (lines.length === maxLines && words.join(' ').length > lines.join(' ').length) {
    lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  }
  return lines;
}

async function saveItemImage(it) {
  const W = 1080, H = 1350;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const css = getComputedStyle(document.documentElement);
  const a1 = css.getPropertyValue('--accent').trim() || '#f2f2f4';
  const a2 = css.getPropertyValue('--accent-2').trim() || '#9a9aa1';
  const onA = css.getPropertyValue('--on-accent').trim() || '#0b0b0c';

  // fundo: manchas de cor com a paleta atual (imitam o fundo fluido)
  const isDark = document.documentElement.dataset.theme !== 'light';
  const fg = (al) => (isDark ? `rgba(255,255,255,${al})` : `rgba(10,10,12,${al})`);
  ctx.fillStyle = isDark ? '#000' : '#f2f2f4';
  ctx.fillRect(0, 0, W, H);
  [[0.1, 0.05, 0.9], [0.95, 0.6, 0.7]].forEach(([fx, fy, r]) => {
    const g = ctx.createRadialGradient(fx * W, fy * H, 0, fx * W, fy * H, W * r);
    g.addColorStop(0, isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });

  // cartão de vidro
  const r = 48, x = 60, y = 60, w = W - 120, h = H - 120;
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fillStyle = isDark ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.75)';
  ctx.fill();
  ctx.strokeStyle = fg(isDark ? 0.22 : 0.1);
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();

  // imagem do produto
  const img = await loadProductImage(it.image);
  const imgBox = { x: x + 40, y: y + 40, w: w - 80, h: 620 };
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(imgBox.x, imgBox.y, imgBox.w, imgBox.h, 32);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.clip();
  if (img) {
    const s = Math.min(imgBox.w / img.width, imgBox.h / img.height) * 0.9;
    const iw = img.width * s, ih = img.height * s;
    ctx.drawImage(img, imgBox.x + (imgBox.w - iw) / 2, imgBox.y + (imgBox.h - ih) / 2, iw, ih);
  } else {
    ctx.fillStyle = '#9aa3b5';
    ctx.font = '600 36px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Imagem indisponível', imgBox.x + imgBox.w / 2, imgBox.y + imgBox.h / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  // selo de desconto
  if (it.discount != null) {
    ctx.fillStyle = a1;
    ctx.beginPath();
    ctx.roundRect(imgBox.x + 24, imgBox.y + 24, 230, 96, 48);
    ctx.fill();
    ctx.fillStyle = onA;
    ctx.font = '800 56px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`-${it.discount}%`, imgBox.x + 24 + 115, imgBox.y + 24 + 68);
    ctx.textAlign = 'left';
  }

  // textos
  let ty = imgBox.y + imgBox.h + 80;
  const tx = x + 50, tw = w - 100;
  if (it.brand) {
    ctx.fillStyle = fg(0.6);
    ctx.font = '600 34px -apple-system, system-ui, sans-serif';
    ctx.fillText(it.brand.toUpperCase(), tx, ty);
    ty += 60;
  }
  ctx.fillStyle = fg(0.95);
  ctx.font = '700 50px -apple-system, system-ui, sans-serif';
  for (const line of wrapText(ctx, it.name || 'Sem nome', tw, 3)) {
    ctx.fillText(line, tx, ty);
    ty += 64;
  }
  ty += 40;
  ctx.font = '800 96px -apple-system, system-ui, sans-serif';
  const priceTxt = fmtPrice(it.price, it.currency) || '—';
  ctx.fillText(priceTxt, tx, ty);
  if (it.oldPrice != null) {
    const pw = ctx.measureText(priceTxt).width;
    ctx.font = '500 48px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = fg(0.5);
    const old = fmtPrice(it.oldPrice, it.currency);
    const ox = tx + pw + 30;
    ctx.fillText(old, ox, ty);
    const ow = ctx.measureText(old).width;
    ctx.fillRect(ox, ty - 16, ow, 4);
  }

  // rodapé
  ctx.fillStyle = fg(0.45);
  ctx.font = '400 26px -apple-system, system-ui, sans-serif';
  let host = '';
  try { host = new URL(it.url).hostname.replace(/^www\./, ''); } catch {}
  ctx.fillText(`${host} · ${new Date(it.foundAt || Date.now()).toLocaleString('pt-PT')}`, tx, y + h - 50);

  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) return toast('Não foi possível gerar a imagem');
  const name = `produto-${(it.name || 'item').toLowerCase().replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  // no iPhone, a folha de partilha permite "Guardar imagem" nas Fotografias
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: it.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(name, blob);
}

/* =========================================================
   Notificações, som e badge
   ========================================================= */
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

async function notifyDone(title, body) {
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

/* =========================================================
   Iniciar / parar
   ========================================================= */
function setRunning(on) {
  $('startBtn').disabled = on;
  $('stopBtn').disabled = !on;
  $('exportJson').disabled = on || !results.length;
  $('exportCsv').disabled = on || !results.length;
  $('exportItems').disabled = on || !items.length;
  document.querySelectorAll('#config input, #config select, #config textarea').forEach((el) => (el.disabled = on));
}

$('config').addEventListener('submit', async (e) => {
  e.preventDefault();
  unlockAudio();              // o iOS só deixa tocar som depois de um toque
  const permission = askNotifyPermission(); // tem de ser pedido logo no toque
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
  });

  crawler.onResult = (r, i) => { results.push(r); addRow(r, i); };
  crawler.onItem = (it, n) => { items.push(it); appendItem(it, n); };
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

  if (state !== 'parado') {
    const body = items.length
      ? `${items.length} produto(s) encontrado(s) em ${s.crawled} página(s)`
      : s.errors && s.errors === s.crawled
        ? `Falhou: ${s.errors} erro(s) — vê o log`
        : `${s.crawled} página(s) analisada(s), ${s.matches} com palavras-chave`;
    await notifyDone(state === 'erro' ? 'Crawling com erro' : 'Crawling terminado', body);
    if ($('dealMode').value === 'auto' && items.length) autoEvaluateDeals();
  }
});

$('stopBtn').addEventListener('click', () => {
  crawler?.stop();
  updateStats(crawler.stats(), 'parado');
});

/* =========================================================
   Exportar
   ========================================================= */
function download(name, content, type) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

function stamp() {
  return new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
}

const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

$('exportJson').addEventListener('click', () => {
  download(`crawl-${stamp()}.json`, JSON.stringify({ pages: results, products: items }, null, 2), 'application/json');
});

$('exportCsv').addEventListener('click', () => {
  const kws = Object.keys(crawler?.keywordTotals || {});
  const cols = ['url', 'status', 'title', 'description', 'depth', 'from', 'ms', 'wordCount', 'images', 'canonical', 'error'];
  const header = [...cols, 'links', 'products', 'keywordTotal', ...kws.map((k) => `kw:${k}`)];
  const rows = results.map((r) =>
    [...cols.map((c) => r[c]), r.links?.length ?? 0, r.items?.length ?? 0, r.keywordTotal ?? 0, ...kws.map((k) => r.keywordHits?.[k] ?? 0)]
      .map(cell).join(',')
  );
  download(`paginas-${stamp()}.csv`, '﻿' + [header.map(cell).join(','), ...rows].join('\n'), 'text/csv');
});

$('exportItems').addEventListener('click', () => {
  const cols = ['name', 'brand', 'price', 'oldPrice', 'discount', 'currency', 'url', 'image', 'page', 'source', 'foundAt'];
  const rows = items.map((it) => [...cols.map((c) => it[c]), Object.keys(it.keywordHits || {}).join(' | '), screenshotUrl(it.url),
    it.deal?.verdict ?? '', it.deal?.score ?? '', it.deal?.typicalPrice ?? '', it.deal?.lowestPrice ?? '', it.deal?.rrp ?? '', it.deal?.summary ?? ''].map(cell).join(','));
  download(`produtos-${stamp()}.csv`, '﻿' + [[...cols, 'keywords', 'screenshot', 'negocio', 'pontuacao', 'preco_tipico', 'preco_mais_baixo', 'pvp', 'resumo'].map(cell).join(','), ...rows].join('\n'), 'text/csv');
});
