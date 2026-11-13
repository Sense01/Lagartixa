/* =========================================================
   Diretório de lojas + verificador de compatibilidade
   ========================================================= */

const SiteCheck = (() => {
  const PLATFORMS = [
    [/cdn\.shopify\.com|Shopify\.theme/i, 'Shopify'],
    [/wp-content\/plugins\/woocommerce|woocommerce-/i, 'WooCommerce'],
    [/demandware\.(?:store|static)/i, 'Salesforce Commerce Cloud'],
    [/prestashop|\/modules\/ps_/i, 'PrestaShop'],
    [/Magento|mage\/cookies/i, 'Magento'],
  ];

  /** Analisa a resposta de uma página (função pura — testável sem rede). */
  function classify(r, url, { robotsAllowed = true } = {}) {
    const res = { url, status: 'error', method: '', products: 0, priced: 0, sample: [], links: 0, platform: '', notes: [], checkedAt: new Date().toISOString() };
    if (!robotsAllowed) { res.status = 'robots'; res.notes.push('O robots.txt desta loja não permite ler esta página — experimenta uma página de categoria.'); return res; }
    if (!r) { res.notes.push('Sem resposta da loja.'); return res; }
    const block = Crawler.detectBlock(r);
    if (block) { res.status = 'blocked'; res.notes.push(block); return res; }
    if (!r.ok) { res.status = r.status === 404 ? 'error' : 'blocked'; res.notes.push(`A loja respondeu HTTP ${r.status}.`); return res; }

    const html = r.text || '';
    res.platform = (PLATFORMS.find(([re]) => re.test(html.slice(0, 300000))) || [, ''])[1];
    const c = new Crawler({ keywords: [] });
    let items = [];
    if (Crawler.isPrestaShopJson(r)) {
      res.method = 'PrestaShop (JSON)';
      try { items = (JSON.parse(html).products || []).map((p) => c.prestaShopItem(p, url)).filter(Boolean); } catch {}
    } else {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const ld = c.extractJsonLd(doc, url);
      const heur = c.extractHeuristic(doc, url);
      const ldPriced = ld.filter((p) => p.price != null).length;
      const hPriced = heur.filter((p) => p.price != null).length;
      if (ldPriced >= hPriced && ld.length) { items = ld; res.method = 'JSON-LD (schema.org)'; }
      else { items = heur; res.method = 'HTML (deteção automática)'; }
      const host = hostOf(url);
      res.links = new Set([...doc.querySelectorAll('a[href]')].map((a) => { try { return new URL(a.getAttribute('href'), url); } catch { return null; } })
        .filter((u) => u && u.hostname.replace(/^www\./, '') === host).map((u) => u.pathname)).size;
      doc.querySelectorAll('script, style, noscript, template').forEach((n) => n.remove());
      const text = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 400 || /enable javascript|javascript (?:n'est pas activ|is disabled|est d[ée]sactiv)|ativ[ae] o javascript|activa javascript/i.test(text.slice(0, 2000))) {
        if (!items.length) { res.status = 'js'; res.notes.push('A página só mostra conteúdo com JavaScript (ou é uma verificação anti-bot) — o crawler não a consegue ler.'); return res; }
      }
    }
    res.products = items.length;
    res.priced = items.filter((p) => p.price != null).length;
    res.sample = items.filter((p) => p.price != null).slice(0, 3).map((p) => ({ name: p.name, price: p.price, oldPrice: p.oldPrice, availability: p.availability }));
    if (res.priced >= 3) res.status = 'ok';
    else if (res.products || res.priced) { res.status = 'partial'; res.notes.push('Encontrou poucos produtos com preço — pode ser que os preços sejam carregados por JavaScript.'); }
    else {
      res.status = 'none';
      res.notes.push(res.links > 20
        ? 'A página abriu, mas não tem produtos com preço. Experimenta o link de uma categoria ou de promoções.'
        : 'A página abriu, mas não tem produtos nem links suficientes para navegar.');
    }
    if (res.status === 'ok' && res.links < 5) res.notes.push('Poucos links na página: cola diretamente as categorias que queres.');
    if (/Shopify|WooCommerce/.test(res.platform)) res.notes.push(`Loja feita em ${res.platform}.`);
    return res;
  }

  /** Testa uma loja através do proxy (o teu Worker), como uma pesquisa real faria. */
  async function run(rawUrl) {
    let url = String(rawUrl || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    try { url = new URL(url).href; } catch { return { url: rawUrl, status: 'error', notes: ['Endereço inválido.'], checkedAt: new Date().toISOString() }; }
    const c = new Crawler({ proxies: buildProxyList(), timeout: 20000 });
    c.running = true;
    // 1) robots.txt
    let robotsAllowed = true;
    try {
      const rr = await c.fetchText(new URL(url).origin + '/robots.txt', { timeout: 10000 });
      if (rr.ok && !/<html/i.test(rr.text.slice(0, 500))) robotsAllowed = c.robotsAllows(url, c.parseRobots(rr.text));
    } catch {}
    // 2) Lidl: API de pesquisa
    const lidl = LiteX.lidlApiUrl(url, 0, 24);
    if (lidl && robotsAllowed) {
      try {
        const r = await c.fetchText(lidl);
        const items = LiteX.lidlItems(JSON.parse(r.text), url);
        return { url, status: items.length ? 'ok' : 'none', method: 'API do Lidl', products: items.length, priced: items.filter((p) => p.price != null).length,
          sample: items.slice(0, 3).map((p) => ({ name: p.name, price: p.price, oldPrice: p.oldPrice })), notes: [], platform: 'Lidl', checkedAt: new Date().toISOString() };
      } catch (e) {
        return { url, status: 'blocked', notes: [e.message], checkedAt: new Date().toISOString() };
      }
    }
    // 3) a página em si
    let r = null;
    try { r = await c.fetchText(url); } catch (e) {
      const res = classify(null, url, { robotsAllowed });
      res.status = e.siteBlocked || e.proxyFailure ? 'blocked' : 'error';
      res.notes = [e.siteBlocked ? 'Esta loja bloqueia acesso automático (o teu proxy recebeu "acesso recusado").' : e.message];
      return res;
    }
    return classify(r, url, { robotsAllowed });
  }

  return { classify, run };
})();

const SiteDir = (() => {
  if (!document.getElementById('sdList')) return { load() {}, render() {}, allSites: () => [], showResale() {}, collectionStarts: () => [], countryFor: () => null, collections: () => [] };   // página de testes
  const K_MINE = (window.STORE_PREFIX || '') + 'crawler-mysites';
  const K_CHECKS = (window.STORE_PREFIX || '') + 'crawler-sitechecks';
  const STATUS = {
    ok: ['✅ Funciona', 'ok'], partial: ['⚠️ Parcial', 'partial'], blocked: ['⛔ Bloqueia', 'blocked'],
    robots: ['🚫 robots.txt não permite', 'blocked'], js: ['⛔ Só com JavaScript', 'blocked'],
    none: ['🔍 Sem produtos nesta página', 'partial'], error: ['⚠️ Erro', 'partial'],
  };
  const FLAG = { PT: '🇵🇹', FR: '🇫🇷', ES: '🇪🇸', DE: '🇩🇪', IT: '🇮🇹', BE: '🇧🇪' };
  let data = { sites: [], categories: {} };

  const read = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };
  const write = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} };
  const mine = () => read(K_MINE, []);
  const checks = () => read(K_CHECKS, {});

  async function load() {
    try {
      const r = await fetch('data/sites.json', { cache: 'no-cache' });
      data = await r.json();
    } catch (e) { console.warn('sites.json:', e); }
    fillFilters();
    render();
    renderCollections();
  }

  /* ---------- pesquisar por categoria: varias lojas de uma vez ---------- */
  const COL_KEY = (window.STORE_PREFIX || '') + 'crawler-colcountry';

  /** paginas de partida de uma colecao (so lojas que funcionam e do pais escolhido) */
  function collectionStarts(col, country) {
    const byId = new Map(allSites().map((s) => [s.id, s]));
    const out = [];
    for (const [id, labels] of Object.entries(col.stores || {})) {
      const s = byId.get(id);
      if (!s || (country && !country.split(',').includes(s.country))) continue;
      const st = effectiveStatus(s);
      if (!['ok', 'partial'].includes(st)) continue;
      for (const l of labels) { const x = (s.starts || []).find((y) => y.label === l); if (x) out.push({ site: s, url: x.url, label: l }); }
    }
    return out;
  }

  function renderCollections() {
    const box = $('colChips');
    if (!box || !data.collections) return;
    try { $('colCountry').value = localStorage.getItem(COL_KEY) || ''; } catch {}
    const country = $('colCountry').value;
    box.innerHTML = data.collections.map((c) => {
      const st = collectionStarts(c, country);
      const stores = new Set(st.map((x) => x.site.id)).size;
      return `<button type="button" class="col-chip" data-col="${esc(c.id)}" ${stores ? '' : 'disabled'}>
        <span>${c.icon} ${esc(c.name)}</span><small>${stores} loja${stores === 1 ? '' : 's'}</small></button>`;
    }).join('');
  }

  function useCollection(id) {
    const col = data.collections.find((c) => c.id === id);
    if (!col) return;
    const st = collectionStarts(col, $('colCountry').value);
    if (!st.length) return toast('Nenhuma loja desta categoria no país escolhido', 3000);
    $('sites').value = st.map((x) => x.url).join('\n');
    if (col.keyword && !$('keywords').value.trim()) { $('keywords').value = col.keyword; $('keywords').dispatchEvent(new Event('input')); }
    const needSitemap = st.some((x) => x.site.sitemap);
    if (needSitemap && $('useSitemap')) $('useSitemap').checked = true;
    const stores = [...new Set(st.map((x) => x.site.name))];
    // paginas suficientes para todas as lojas (pelo menos ~25 por loja)
    if (+$('maxPages').value < stores.length * 25) $('maxPages').value = Math.min(500, stores.length * 25);
    document.querySelectorAll('.col-chip').forEach((b) => b.classList.toggle('on', b.dataset.col === id));
    $('colInfo').textContent = `${col.icon} ${col.name}: ${stores.length} lojas, ${st.length} páginas de partida — ${stores.join(', ')}.` +
      (needSitemap ? ' Inclui o sitemap da Rádio Popular.' : '') + ' Escreve as palavras-chave (ou deixa vazio para ver tudo) e carrega em ▶ Iniciar.';
    $('sites').dispatchEvent(new Event('input', { bubbles: true }));
  }

  if ($('colChips')) {
    $('colChips').addEventListener('click', (e) => { const b = e.target.closest('.col-chip'); if (b) useCollection(b.dataset.col); });
    $('colCountry').addEventListener('change', () => { try { localStorage.setItem(COL_KEY, $('colCountry').value); } catch {} renderCollections(); });
  }

  function allSites() {
    const own = mine().map((s) => ({ ...s, user: true }));
    const ownDomains = new Set(own.map((s) => s.domain));
    return [...own, ...data.sites.filter((s) => !ownDomains.has(s.domain))];
  }

  function fillFilters() {
    const cats = Object.entries(data.categories || {});
    $('sdCat').innerHTML = `<option value="">Todas as categorias</option>` + cats.map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join('');
    $('sdFoot').textContent = data.verifiedAt
      ? `Lista verificada em ${new Date(data.verifiedAt).toLocaleDateString('pt-PT')} através do teu Worker. As lojas mudam — usa 🔍 Testar para confirmar.`
      : '';
  }

  const ORDER = { ok: 0, partial: 1, none: 2, error: 3, robots: 4, js: 5, blocked: 6 };
  function effectiveStatus(s) { return checks()[s.domain]?.status || s.status; }

  function checkHtml(chk) {
    if (!chk) return '';
    const [label] = STATUS[chk.status] || STATUS.error;
    const sample = (chk.sample || []).map((p) => `<li>${esc(p.name).slice(0, 60)} — <b>${fmtPrice(p.price)}</b>${p.oldPrice ? ` <s>${fmtPrice(p.oldPrice)}</s>` : ''}</li>`).join('');
    return `<div class="sd-check">
      <div><b>${label}</b> · testado ${fmtDateTime(chk.checkedAt)}${chk.method ? ` · ${esc(chk.method)}` : ''}${chk.priced ? ` · ${chk.priced} produtos com preço` : ''}${chk.platform ? ` · ${esc(chk.platform)}` : ''}</div>
      ${(chk.notes || []).map((n) => `<div class="sd-note">${esc(n)}</div>`).join('')}
      ${sample ? `<ul>${sample}</ul>` : ''}
    </div>`;
  }

  function cardHtml(s) {
    const st = effectiveStatus(s);
    const [label, cls] = STATUS[st] || STATUS.error;
    const cats = (s.categories || []).map((c) => data.categories?.[c] || c).join(' · ');
    const starts = (s.starts || []).map((x, i) => `
      <div class="sd-start">
        <span title="${esc(x.url)}">${esc(x.label || x.url)}</span>
        <button type="button" class="sd-use" data-i="${i}" ${st === 'blocked' || st === 'js' || st === 'robots' ? 'disabled' : ''}>Usar</button>
        <button type="button" class="sd-add-one" data-i="${i}" title="Juntar aos sites já escritos (para comparar lojas)" ${st === 'blocked' || st === 'js' || st === 'robots' ? 'disabled' : ''}>＋</button>
      </div>`).join('');
    return `<div class="sd-card st-${cls}" data-domain="${esc(s.domain)}">
      <div class="sd-head"><span class="flag">${FLAG[s.country] || '🌐'}</span><b>${esc(s.name)}</b>${s.user ? '<span class="sd-mine">a minha</span>' : ''}<span class="sd-badge">${label}</span>${s.resale ? '<span class="sd-badge sd-rs" title="Mostra o preço antigo/PVPR: o simulador de revenda tem uma referência">📈</span>' : ''}</div>
      <small class="sd-meta">${esc(s.domain)}${cats ? ` · ${esc(cats)}` : ''}${s.method ? ` · ${esc(s.method)}` : ''}</small>
      ${s.notes ? `<p class="sd-notes">${esc(s.notes)}</p>` : ''}
      ${starts ? `<div class="sd-starts">${starts}</div>` : ''}
      ${checkHtml(checks()[s.domain])}
      <div class="sd-actions">
        <button type="button" class="sd-test">🔍 Testar agora</button>
        ${s.user ? '<button type="button" class="sd-del">Remover</button>' : ''}
      </div>
    </div>`;
  }

  function render() {
    const q = $('sdSearch').value.trim().toLowerCase();
    const cat = $('sdCat').value, country = $('sdCountry').value, status = $('sdStatus').value;
    const list = allSites().filter((s) => {
      const st = effectiveStatus(s);
      return (!q || `${s.name} ${s.domain} ${s.notes || ''}`.toLowerCase().includes(q)) &&
        (!cat || (s.categories || []).includes(cat)) &&
        (!country || s.country === country) &&
        (!status || (status === 'usable' ? !['blocked', 'js', 'robots'].includes(st) : status === 'resale' ? s.resale && st === 'ok' : status === 'blocked' ? ['blocked', 'js', 'robots'].includes(st) : st === status));
    }).sort((a, b) => (ORDER[effectiveStatus(a)] ?? 9) - (ORDER[effectiveStatus(b)] ?? 9) || a.name.localeCompare(b.name));
    const okN = allSites().filter((s) => effectiveStatus(s) === 'ok').length;
    $('sdCount').textContent = `${okN} funcionam`;
    $('sdList').innerHTML = list.map(cardHtml).join('') || '<p class="empty">Nenhuma loja com estes filtros.</p>';
    // lojas bloqueadas: escondidas por omissao, mas guardadas (evita voltar a testa-las e mostra se alguma volta a funcionar)
    const hidden = allSites().filter((s) => ['blocked', 'js', 'robots'].includes(effectiveStatus(s))).length;
    const base = data.verifiedAt ? `Lista verificada em ${new Date(data.verifiedAt).toLocaleDateString('pt-PT')} através do teu Worker. As lojas mudam — usa 🔍 Testar para confirmar.` : '';
    $('sdFoot').innerHTML = esc(base) + (status === 'usable' && hidden
      ? ` <button type="button" class="link" id="sdShowBlocked">⛔ ${hidden} lojas que bloqueiam estão escondidas — ver</button>` : '');
  }

  function useUrl(url, append, site) {
    const cur = splitList($('sites').value, /[\n\s,]+/);
    $('sites').value = append ? [...new Set([...cur, url])].join('\n') : url;
    // lojas cujas listas só mostram os primeiros produtos: ligar a pesquisa no sitemap
    if (site?.sitemap && $('useSitemap')) $('useSitemap').checked = true;
    $('config').scrollIntoView({ behavior: 'smooth', block: 'start' });
    toast(append ? 'Loja juntada à lista de sites' : 'Loja escolhida — escreve as palavras-chave e carrega em ▶ Iniciar', 4000);
  }

  async function test(s, btn) {
    const url = s.starts?.[0]?.url || `https://${s.domain}/`;
    if (btn) { btn.disabled = true; btn.textContent = '⏳ A testar…'; }
    const res = await SiteCheck.run(url);
    const all = checks();
    all[s.domain] = res;
    write(K_CHECKS, all);
    if (s.user) {
      const list = mine();
      const m = list.find((x) => x.domain === s.domain);
      if (m) { m.status = res.status; m.method = res.method || m.method; write(K_MINE, list); }
    }
    render();
    toast(`${s.name}: ${(STATUS[res.status] || STATUS.error)[0]}`, 4000);
  }

  async function addFromUrl() {
    const raw = $('sdAddUrl').value.trim();
    if (!raw) return toast('Cola o endereço de uma loja (de preferência uma página de categoria ou de promoções).');
    const btn = $('sdAddBtn');
    btn.disabled = true; btn.textContent = '⏳ A testar…';
    $('sdAddResult').innerHTML = '<div class="sd-check">🔎 A testar através do teu proxy: robots.txt, bloqueios e produtos…</div>';
    const res = await SiteCheck.run(raw);
    btn.disabled = false; btn.textContent = '🔍 Testar e adicionar';
    $('sdAddResult').innerHTML = checkHtml(res);
    if (res.status === 'error' && !res.products) return;
    const domain = hostOf(res.url);
    const list = mine().filter((x) => x.domain !== domain);
    const known = data.sites.find((x) => x.domain === domain);
    list.unshift({
      id: 'u-' + domain, name: known?.name || domain.split('.')[0].replace(/^\w/, (ch) => ch.toUpperCase()), domain,
      country: countryOf(res.url), categories: known?.categories || [], status: res.status, method: res.method,
      starts: [{ label: new URL(res.url).pathname === '/' ? 'Página inicial' : decodeURIComponent(new URL(res.url).pathname).slice(0, 50), url: res.url },
        ...(known?.starts || []).filter((x) => x.url !== res.url)],
      notes: known?.notes || '', addedAt: Date.now(),
    });
    write(K_MINE, list);
    const all = checks(); all[domain] = res; write(K_CHECKS, all);
    $('sdAddUrl').value = '';
    render();
  }

  $('sdList').addEventListener('click', (e) => {
    const card = e.target.closest('.sd-card');
    if (!card) return;
    const s = allSites().find((x) => x.domain === card.dataset.domain);
    if (!s) return;
    const use = e.target.closest('.sd-use, .sd-add-one');
    if (use) return useUrl(s.starts[+use.dataset.i].url, use.classList.contains('sd-add-one'), s);
    if (e.target.closest('.sd-test')) return test(s, e.target.closest('.sd-test'));
    if (e.target.closest('.sd-del')) {
      write(K_MINE, mine().filter((x) => x.domain !== s.domain));
      render();
    }
  });
  $('sdFoot').addEventListener('click', (e) => { if (e.target.id === 'sdShowBlocked') { $('sdStatus').value = 'blocked'; render(); } });
  ['sdSearch', 'sdCat', 'sdCountry', 'sdStatus'].forEach((id) => $(id).addEventListener(id === 'sdSearch' ? 'input' : 'change', render));
  $('sdAddBtn').addEventListener('click', addFromUrl);
  $('sdAddUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addFromUrl(); } });

  function showResale() {
    $('sitesPanel').open = true;
    $('sdStatus').value = 'resale';
    $('sdCat').value = ''; $('sdCountry').value = ''; $('sdSearch').value = '';
    render();
    $('sitesPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /** pais de uma loja conhecida (para a IA comparar no mercado certo: coolmod.com -> ES) */
  function countryFor(url) {
    const h = hostOf(url);
    const s = allSites().find((x) => h === x.domain || h.endsWith('.' + x.domain));
    return s?.country || null;
  }

  return { load, render, allSites, showResale, collectionStarts, countryFor, collections: () => data.collections || [] };
})();
