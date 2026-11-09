/* =========================================================
   Produtos encontrados: cartões, filtros, ordenação,
   comparação entre lojas, visualizador e cartão PNG
   ========================================================= */

/* ---------- screenshots ---------- */
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

/* ---------- partes do cartão ---------- */
const STOCK_LABEL = { out: ['Esgotado', 'st-out'], preorder: ['Por encomenda', 'st-pre'] };

function trendHtml(it) {
  const t = it.trend;
  const h = Store.getHistory(it);
  const spark = h && h.pts.length >= 2 ? sparkline(h.pts) : '';
  const parts = [];
  if (t && t.change) {
    const down = t.change < 0;
    parts.push(`<span class="chg ${down ? 'down' : 'up'}" title="Visto por ${fmtPrice(t.prev)} em ${fmtDate(t.prevDate)}">
      ${down ? '↓' : '↑'} ${fmtPrice(Math.abs(t.change))} (${t.changePct > 0 ? '+' : ''}${t.changePct}%) <small>desde ${fmtDate(t.prevDate)}</small></span>`);
  } else if (t && t.points > 1) {
    parts.push(`<span class="chg flat">= igual <small>desde ${fmtDate(t.prevDate)}</small></span>`);
  }
  if (t?.isLowest) parts.push(`<span class="low">🏆 mínimo que já vi</span>`);
  if (!parts.length && !spark) return '';
  return `<div class="trend">${spark}<div>${parts.join('')}</div></div>`;
}

function othersHtml(it) {
  const others = Store.otherStores(it);
  if (!others.length || it.price == null) return '';
  const best = others[0];
  const cheaperHere = it.price <= best.price;
  return `<div class="others ${cheaperHere ? 'best' : 'worse'}">
    ${cheaperHere ? '✅ Mais barato aqui' : '🏷️ Mais barato noutra loja'} ·
    <a href="${esc(best.url)}" target="_blank" rel="noopener">${esc(best.store)} ${fmtPrice(best.price)}</a>
    <small>(${fmtDate(best.date)}${others.length > 1 ? ` · +${others.length - 1} loja${others.length > 2 ? 's' : ''}` : ''})</small>
  </div>`;
}

function itemCard(it, idx) {
  const shot = screenshotUrl(it.url);
  const kws = Object.keys(it.keywordHits || {});
  const watched = Store.isWatched(it);
  const stock = STOCK_LABEL[it.availability];
  const div = document.createElement('article');
  div.className = 'item' + (it.availability === 'out' ? ' is-out' : '');
  div.dataset.idx = idx;
  div.innerHTML = `
    <div class="media ${it.image ? '' : 'no-img'}">
      ${it.image
        ? `<img class="prod-img" src="${esc(it.image)}" alt="${esc(it.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">`
        : ''}
      ${it.discount != null ? `<span class="badge">-${it.discount}%</span>` : ''}
      ${stock ? `<span class="stock-badge ${stock[1]}">${stock[0]}</span>` : ''}
      ${shot ? `
        <button type="button" class="shot-thumb loading" aria-label="Ver captura da página">
          <img data-src="${esc(shot)}" src="${esc(shot)}" alt="" loading="lazy" decoding="async">
          <span class="shot-label">página</span>
        </button>` : ''}
    </div>
    <div class="item-body">
      <div class="brand">${esc(it.brand) || '&nbsp;'}</div>
      <div class="name" title="${esc(it.name)}">${esc(it.name || 'Sem nome')}</div>
      <div class="prices">
        <span class="price">${fmtPrice(it.price, it.currency) || '—'}</span>
        ${it.oldPrice != null ? `<s>${fmtPrice(it.oldPrice, it.currency)}</s>` : ''}
      </div>
      ${trendHtml(it)}
      ${othersHtml(it)}
      ${kws.length ? `<div>${kws.map((k) => `<span class="tag">${esc(k)}</span>`).join('')}</div>` : ''}
      <div class="deal">${it.deal ? dealHtml(it.deal) : ''}</div>
      <div class="item-actions">
        <a class="btn" href="${esc(it.url)}" target="_blank" rel="noopener">Abrir ↗</a>
        <button type="button" class="watch-btn ${watched ? 'on' : ''}" aria-pressed="${watched}">${watched ? '★ A seguir' : '☆ Seguir'}</button>
        <button type="button" class="save-card" title="Guardar imagem do produto">📸</button>
        ${$('dealMode').value !== 'off' && it.price != null
          ? `<button type="button" class="deal-btn">${it.deal && !it.deal.loading ? '🔄 Reavaliar' : '💡 Negócio?'}</button>` : ''}
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

function refreshCard(it) {
  const idx = items.indexOf(it);
  const card = document.querySelector(`.item[data-idx="${idx}"]`);
  if (card) card.replaceWith(itemCard(it, idx));
}

/* ---------- filtros e ordenação ---------- */
const dealScore = (it) => (it.deal && !it.deal.error && !it.deal.loading && it.deal.score != null ? +it.deal.score : -1);
const isGoodDeal = (it) => /^bom/i.test(String(it.deal?.verdict || '')) || dealScore(it) >= 70;

function visibleItems() {
  const onlyGood = $('onlyGood').checked;
  const hideOut = $('hideOut').checked;
  const onlyDrops = $('onlyDrops').checked;
  const list = items.map((it, i) => ({ it, i })).filter(({ it }) =>
    (!kwFilter || it.keywordHits?.[kwFilter]) &&
    (!onlyGood || isGoodDeal(it)) &&
    (!hideOut || it.availability !== 'out') &&
    (!onlyDrops || (it.trend?.change < 0) || it.trend?.isLowest)
  );
  const by = $('itemSort').value;
  const val = (v, d) => (v == null ? d : v);
  if (by === 'deal') list.sort((a, b) => dealScore(b.it) - dealScore(a.it) || val(b.it.discount, -1) - val(a.it.discount, -1));
  if (by === 'discount') list.sort((a, b) => val(b.it.discount, -1) - val(a.it.discount, -1));
  if (by === 'priceAsc') list.sort((a, b) => val(a.it.price, Infinity) - val(b.it.price, Infinity));
  if (by === 'priceDesc') list.sort((a, b) => val(b.it.price, -1) - val(a.it.price, -1));
  if (by === 'drop') list.sort((a, b) => val(a.it.trend?.changePct, 0) - val(b.it.trend?.changePct, 0));
  return list;
}

function renderItems() {
  $('itemsPanel').classList.toggle('hidden', !items.length);
  const box = $('items');
  const list = visibleItems();
  box.innerHTML = '';
  const frag = document.createDocumentFragment();
  list.forEach(({ it, i }) => frag.appendChild(itemCard(it, i)));
  box.appendChild(frag);
  $('itemsCount').textContent = list.length === items.length ? `${items.length}` : `${list.length} de ${items.length}`;
  $('itemsEmpty').classList.toggle('hidden', !!list.length || !items.length);
}
const renderItemsThrottled = debounce(renderItems, 350);

function appendItem(it, n) {
  $('itemsPanel').classList.remove('hidden');
  const filtersOn = $('itemSort').value !== 'found' || kwFilter || $('onlyGood').checked || $('hideOut').checked || $('onlyDrops').checked;
  if (filtersOn) return renderItemsThrottled();
  $('items').appendChild(itemCard(it, n - 1));
  $('itemsCount').textContent = `${items.length}`;
}

['itemSort', 'onlyGood', 'hideOut', 'onlyDrops'].forEach((id) => $(id).addEventListener('change', renderItems));

/* ---------- comparação entre lojas ---------- */
function compareGroups() {
  const groups = new Map();
  const add = (id, row) => {
    if (!groups.has(id)) groups.set(id, new Map());
    const g = groups.get(id);
    const prev = g.get(row.store);
    if (!prev || row.fresh || (!prev.fresh && row.price < prev.price)) g.set(row.store, row);
  };
  for (const it of items) {
    const id = Store.productIdentity(it);
    if (!id || it.price == null) continue;
    add(id, { store: hostOf(it.url), price: it.price, url: it.url, name: it.name, date: today(), fresh: true, av: it.availability });
    for (const o of Store.otherStores(it)) add(id, { store: o.store, price: o.price, url: o.url, name: o.name, date: o.date, fresh: false, av: o.av });
  }
  return [...groups.entries()]
    .map(([id, g]) => ({ id, rows: [...g.values()].sort((a, b) => a.price - b.price) }))
    .filter((g) => g.rows.length >= 2)
    .sort((a, b) => (b.rows[b.rows.length - 1].price - b.rows[0].price) - (a.rows[a.rows.length - 1].price - a.rows[0].price));
}

function renderCompare() {
  const groups = compareGroups();
  $('comparePanel').classList.toggle('hidden', !groups.length);
  $('compareList').innerHTML = groups.slice(0, 60).map((g) => {
    const best = g.rows[0], worst = g.rows[g.rows.length - 1];
    const save = worst.price - best.price;
    const label = g.id.startsWith('lego:') ? `LEGO ${g.id.slice(5)}` : g.id.startsWith('ean:') ? `EAN ${g.id.slice(4)}` : 'Ref. ' + g.id.split(':').pop();
    return `<div class="cmp">
      <div class="cmp-head"><b>${esc(best.name)}</b><small>${esc(label)}${save > 0 ? ` · poupas até ${fmtPrice(save)}` : ''}</small></div>
      <div class="cmp-rows">${g.rows.map((r, i) => `
        <a class="cmp-row ${i === 0 ? 'best' : ''} ${r.av === 'out' ? 'out' : ''}" href="${esc(r.url)}" target="_blank" rel="noopener">
          <span class="st">${i === 0 ? '✅ ' : ''}${esc(r.store)}</span>
          <span class="pr">${fmtPrice(r.price)}</span>
          <small>${r.fresh ? 'agora' : fmtDate(r.date)}${r.av === 'out' ? ' · esgotado' : ''}</small>
        </a>`).join('')}
      </div>
    </div>`;
  }).join('');
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

/* ---------- cliques nos cartões ---------- */
$('items').addEventListener('click', (e) => {
  const card = e.target.closest('.item');
  if (!card) return;
  const it = items[+card.dataset.idx];
  const thumb = e.target.closest('.shot-thumb');
  if (thumb) return openViewer(it, thumb.querySelector('img').src);
  if (e.target.closest('.watch-btn')) {
    const on = Store.toggleWatch(it);
    toast(on ? '★ A seguir — vais ver a evolução do preço' : 'Deixaste de seguir este produto', 2500);
    return refreshCard(it);
  }
  if (e.target.closest('.deal-btn')) {
    if (it.deal?.loading) return;
    return evaluateDeal(it, { force: !!it.deal });
  }
  const btn = e.target.closest('.save-card');
  if (btn) {
    btn.disabled = true;
    saveItemImage(it).finally(() => (btn.disabled = false));
  }
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
  for (const p of buildProxyList()) {   // sem CORS direto → tenta via proxy
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
  const onA = css.getPropertyValue('--on-accent').trim() || '#0b0b0c';
  const isDark = document.documentElement.dataset.theme !== 'light';
  const fg = (al) => (isDark ? `rgba(255,255,255,${al})` : `rgba(10,10,12,${al})`);
  const FONT = '-apple-system, system-ui, sans-serif';

  ctx.fillStyle = isDark ? '#000' : '#f2f2f4';
  ctx.fillRect(0, 0, W, H);
  [[0.1, 0.05, 0.9], [0.95, 0.6, 0.7]].forEach(([fx, fy, r]) => {
    const g = ctx.createRadialGradient(fx * W, fy * H, 0, fx * W, fy * H, W * r);
    g.addColorStop(0, isDark ? 'rgba(255,255,255,0.18)' : 'rgba(0,0,0,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  });

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
    ctx.font = `600 36px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText('Imagem indisponível', imgBox.x + imgBox.w / 2, imgBox.y + imgBox.h / 2);
    ctx.textAlign = 'left';
  }
  ctx.restore();

  if (it.discount != null) {
    ctx.fillStyle = a1;
    ctx.beginPath();
    ctx.roundRect(imgBox.x + 24, imgBox.y + 24, 230, 96, 48);
    ctx.fill();
    ctx.fillStyle = onA;
    ctx.font = `800 56px ${FONT}`;
    ctx.textAlign = 'center';
    ctx.fillText(`-${it.discount}%`, imgBox.x + 24 + 115, imgBox.y + 24 + 68);
    ctx.textAlign = 'left';
  }

  let ty = imgBox.y + imgBox.h + 80;
  const tx = x + 50, tw = w - 100;
  if (it.brand) {
    ctx.fillStyle = fg(0.6);
    ctx.font = `600 34px ${FONT}`;
    ctx.fillText(it.brand.toUpperCase(), tx, ty);
    ty += 60;
  }
  ctx.fillStyle = fg(0.95);
  ctx.font = `700 50px ${FONT}`;
  for (const line of wrapText(ctx, it.name || 'Sem nome', tw, 3)) {
    ctx.fillText(line, tx, ty);
    ty += 64;
  }
  ty += 40;
  ctx.font = `800 96px ${FONT}`;
  const priceTxt = fmtPrice(it.price, it.currency) || '—';
  ctx.fillText(priceTxt, tx, ty);
  if (it.oldPrice != null) {
    const pw = ctx.measureText(priceTxt).width;
    ctx.font = `500 48px ${FONT}`;
    ctx.fillStyle = fg(0.5);
    const old = fmtPrice(it.oldPrice, it.currency);
    const ox = tx + pw + 30;
    ctx.fillText(old, ox, ty);
    ctx.fillRect(ox, ty - 16, ctx.measureText(old).width, 4);
  }
  if (it.deal?.verdict && !it.deal.error) {
    ty += 70;
    ctx.font = `700 40px ${FONT}`;
    ctx.fillStyle = fg(0.85);
    const v = { bom: 'Bom negócio', razoavel: 'Preço normal', caro: 'Caro', incerto: 'Sem certeza' }[String(it.deal.verdict).normalize('NFD').replace(/[̀-ͯ]/g, '')] || it.deal.verdict;
    ctx.fillText(`💡 ${v}${it.deal.score != null ? ` · ${Math.round(it.deal.score)}/100` : ''}`, tx, ty);
  }

  ctx.fillStyle = fg(0.45);
  ctx.font = `400 26px ${FONT}`;
  ctx.fillText(`${hostOf(it.url)} · ${new Date(it.foundAt || Date.now()).toLocaleString('pt-PT')}`, tx, y + h - 50);

  const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
  if (!blob) return toast('Não foi possível gerar a imagem');
  const name = `produto-${(it.name || 'item').toLowerCase().replace(/[^a-z0-9]+/gi, '-').slice(0, 50)}.png`;
  const file = new File([blob], name, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {   // no iPhone: "Guardar imagem" nas Fotografias
    try { await navigator.share({ files: [file], title: it.name }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  download(name, blob);
}
