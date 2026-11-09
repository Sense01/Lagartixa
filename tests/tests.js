/* Testes no browser: abre tests/index.html (localmente ou no GitHub Pages em /tests/) */
(async () => {
  const out = document.getElementById('out');
  let pass = 0, fail = 0, section = null;
  const group = (name) => { section = document.createElement('ul'); out.insertAdjacentHTML('beforeend', `<h2>${name}</h2>`); out.appendChild(section); };
  const ok = (cond, name, detail) => {
    cond ? pass++ : fail++;
    section.insertAdjacentHTML('beforeend', `<li class="${cond ? 'pass' : 'fail'}">${cond ? '✓' : '✗'} ${name}${!cond && detail !== undefined ? ` <code>${String(JSON.stringify(detail)).replace(/</g, '&lt;')}</code>` : ''}</li>`);
  };
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  /* ---------- páginas de exemplo ---------- */
  const specs = Array.from({ length: 12 }, (_, i) => `<li>Especificação ${i}: valor detalhado com bastante texto descritivo</li>`).join('');
  const sfccTile = (pid, name, price, old, stock = '3–5 dias úteis') => `
    <div class="product" data-pid="${pid}"><div class="product-tile">
      <div class="image-container"><a href="/${pid}.html"><img class="tile-image" src="/img/${pid}.jpg" alt="${name}"></a></div>
      <div class="tile-body"><div class="pdp-link"><a class="link" href="/${pid}.html">${name}</a></div><ul class="specs">${specs}</ul>
      <div class="price"><span>${old ? `<span class="strike-through list"><span class="value" content="${old}">${old.replace('.', ',')} €</span></span>` : ''}
      <span class="sales"><span class="value" content="${price}">${price.replace('.', ',')} €</span></span></span> Incl. IVA</div>
      <div class="stock">${stock}</div><button>Adicionar ao Carrinho</button></div></div></div>`;
  const GLOBALDATA = `<html><head><title>Ventoinhas | Globaldata</title></head><body>
    <header><nav><a href="/componentes/cooling/ventoinhas">Ventoinhas</a><div class="minicart">Carrinho 0,00 €</div></nav></header>
    <div class="row product-grid">${sfccTile('RC21', 'Ventoinha Razer Kunai 140mm aRGB', '52.90')}${sfccTile('LL01', 'Ventoinha Lian Li UNI FAN (Pack 3)', '39.90', '54.90')}${sfccTile('AR14', 'Ventoinha Arctic P14 PRO', '5.90', '15.90', 'Esgotado')}</div>
    <footer>Portes grátis acima de 50,00 €</footer></body></html>`;
  const JSONLD = `<html><head><title>Loja</title><script type="application/ld+json">{"@type":"Product","name":"LEGO Botanicals Rosas (40460)","gtin13":"5702017151861","brand":{"@type":"Brand","name":"LEGO"},"image":"https://loja.pt/rosas.jpg","offers":{"price":"8.91","priceCurrency":"EUR","availability":"https://schema.org/OutOfStock"}}</script></head><body></body></html>`;
  const PRESTA = { label: 'Componentes', rendered_products: '', products: [
    { name: 'Ventoinha Noctua NF-A12x25', price_amount: 24.9, has_discount: true, regular_price_amount: 29.9, discount_type: 'percentage', discount_percentage_absolute: '17%', url: 'https://www.coolmatica.pt/p/3.html', ean13: '9010018100004', reference: 'NF-A12x25', availability: 'available', cover: { medium: { url: 'https://www.coolmatica.pt/3.jpg' } } },
    { name: 'Pasta térmica', price_amount: 3.22, has_discount: false, url: 'https://www.coolmatica.pt/p/1.html', availability: 'unavailable', cover: {} },
  ] };
  const LIDL = { numFound: 1, items: [{ gridbox: { data: { fullTitle: 'Visseuse à chocs 20 V', brand: { name: 'Parkside Performance' }, price: { price: 119.99, oldPrice: 129.97, discount: { percentageDiscount: 7 } }, image: 'https://www.lidl.fr/a.jpg', canonicalUrl: '/p/visseuse/p1' } } }] };

  const c = new Crawler({ keywords: [] });
  const doc = (html) => new DOMParser().parseFromString(html, 'text/html');

  group('Preços');
  const cases = { '12,99 €': 12.99, '1.299,99': 1299.99, '1,299.99': 1299.99, '€12.99': 12.99, '1.299': 1299, '0,99': 0.99, '119.99': 119.99 };
  for (const [k, v] of Object.entries(cases)) ok(Crawler.parsePrice(k) === v && LiteX.parsePrice(k) === v, `"${k}" → ${v}`, [Crawler.parsePrice(k), LiteX.parsePrice(k)]);

  group('Globaldata (HTML, blocos grandes, preço riscado)');
  const gd = c.extractHeuristic(doc(GLOBALDATA), 'https://www.globaldata.pt/componentes/cooling/ventoinhas');
  ok(gd.length === 3, '3 produtos detetados', gd.length);
  const lian = gd.find((p) => /Lian/.test(p.name));
  ok(lian && lian.price === 39.9 && lian.oldPrice === 54.9 && lian.discount === 27, 'preço com desconto correto (39,90, antes 54,90, -27%)', lian);
  const arctic = gd.find((p) => /Arctic/.test(p.name));
  ok(arctic && arctic.price === 5.9 && arctic.availability === 'out', 'esgotado detetado e rodapé ignorado', arctic);
  ok(gd.every((p) => p.url.startsWith('https://www.globaldata.pt/') && p.image), 'links e imagens absolutos');
  const lite = LiteX.listingFromHtml(GLOBALDATA, 'https://www.globaldata.pt/componentes/cooling/ventoinhas');
  ok(eq(lite.map((p) => [p.name, p.price, p.oldPrice]), gd.map((p) => [p.name, p.price, p.oldPrice])), 'extrator leve (Worker) dá o mesmo resultado que o da app', lite.map((p) => [p.name, p.price]));

  group('JSON-LD / PrestaShop / Lidl');
  const ld = c.extractJsonLd(doc(JSONLD), 'https://loja.pt/rosas');
  ok(ld[0]?.price === 8.91 && ld[0].ean === '5702017151861' && ld[0].availability === 'out', 'JSON-LD: preço, EAN e stock', ld[0]);
  const ps = PRESTA.products.map((p) => c.prestaShopItem(p, 'https://www.coolmatica.pt/store/1'));
  ok(ps[0].price === 24.9 && ps[0].oldPrice === 29.9 && ps[0].discount === 17 && ps[0].ean === '9010018100004' && ps[0].availability === 'in', 'PrestaShop: desconto, EAN e stock', ps[0]);
  ok(ps[1].availability === 'out', 'PrestaShop: indisponível = esgotado');
  ok(Crawler.isPrestaShopJson({ type: 'application/json', text: JSON.stringify({ rendered_products: '' }) }), 'resposta JSON do PrestaShop reconhecida');
  ok(/\/q\/api\/search\?.*locale=pt_PT/.test(c.lidlApiUrl('https://www.lidl.pt/q/search?q=parkside', 0, 100)), 'Lidl: URL da API (pt_PT)');
  const li = LiteX.lidlItems(LIDL, 'https://www.lidl.fr/q/query/promotions');
  ok(li[0].price === 119.99 && li[0].discount === 7 && li[0].url === 'https://www.lidl.fr/p/visseuse/p1', 'Lidl: produto da API', li[0]);

  group('Bloqueios e stock');
  ok(!!Crawler.detectBlock({ status: 200, text: '<form action="/errors/validateCaptcha">' }), 'captcha da Amazon detetado');
  ok(!!Crawler.detectBlock({ status: 203, text: 'ok' }), 'HTTP 203 tratado como bloqueio');
  ok(!Crawler.detectBlock({ status: 200, text: '<html>loja normal</html>' }), 'página normal não é bloqueio');
  ok(Crawler.detectAvailability('Brevemente/Encomenda') === 'preorder' && Crawler.detectAvailability('Últimos artigos em stock') === 'in' && Crawler.detectAvailability('Esgotado') === 'out', 'textos de stock (encomenda / disponível / esgotado)');

  group('Histórico, identidade e comparação (dados de teste isolados)');
  ['test-crawler-history', 'test-crawler-watch', 'test-crawler-searches'].forEach((k) => localStorage.removeItem(k));
  Store._reset();
  ok(Store.itemKey('https://www.loja.pt/p/1/?utm_source=x&srsltid=abc&id=7') === 'loja.pt/p/1?id=7', 'chave do produto ignora parâmetros de tracking');
  ok(Store.productIdentity({ name: 'LEGO Botanicals: Rosas, 120 Peças (40460)' }) === 'lego:40460', 'identidade LEGO pelo nº do set');
  ok(Store.productIdentity({ name: 'Qualquer', ean: '05702017151861' }) === 'ean:5702017151861', 'identidade pelo EAN (zeros à esquerda)');
  const h = JSON.parse(localStorage.getItem('test-crawler-history') || '{}');
  h['loja-a.pt/p/rosas'] = { pts: [['2026-11-01', 12.49], ['2026-11-05', 10.99]], n: 'LEGO Rosas (40460)', u: 'https://loja-a.pt/p/rosas', s: 'loja-a.pt', id: 'lego:40460' };
  h['loja-b.pt/lego-rosas'] = { pts: [['2026-11-07', 9.99]], n: 'LEGO Botanicals Rosas 40460', u: 'https://loja-b.pt/lego-rosas', s: 'loja-b.pt', id: 'lego:40460' };
  localStorage.setItem('test-crawler-history', JSON.stringify(h));
  Store._reset();
  const t = Store.recordPrice({ name: 'LEGO Rosas (40460)', url: 'https://loja-a.pt/p/rosas', price: 8.91 });
  ok(t && t.prev === 10.99 && t.change === -2.08 && t.changePct === -19 && t.isLowest, 'descida face à última vez + mínimo histórico', t);
  const others = Store.otherStores({ name: 'LEGO Rosas (40460)', url: 'https://loja-a.pt/p/rosas' });
  ok(others.length === 1 && others[0].store === 'loja-b.pt' && others[0].price === 9.99, 'mesmo produto noutra loja encontrado', others);
  const stats = Store.historyStats('https://loja-a.pt/p/rosas');
  ok(stats.min === 8.91 && stats.max === 12.49 && stats.points === 3, 'estatísticas do histórico', stats);
  ok(Store.toggleWatch({ name: 'X', url: 'https://loja-a.pt/p/rosas', price: 8.91 }) === true && Store.isWatched({ url: 'https://loja-a.pt/p/rosas?utm_source=z' }), 'seguir produto (mesmo com tracking no link)');
  Store.saveSearch('Rosas', { sites: 'https://loja-a.pt/lego' });
  ok(Store.searches()[0]?.name === 'Rosas', 'pesquisa guardada');
  ['test-crawler-history', 'test-crawler-watch', 'test-crawler-searches'].forEach((k) => localStorage.removeItem(k));

  group('Verificador de lojas');
  const R = (text, status = 200, type = 'text/html') => ({ status, ok: status < 300, type, text });
  const u = 'https://www.globaldata.pt/componentes/cooling/ventoinhas';
  const g = SiteCheck.classify(R(GLOBALDATA), u);
  ok(g.status === 'ok' && g.priced === 3 && /HTML/.test(g.method) && g.sample[0].price, 'loja normal: funciona, 3 produtos com preço', g);
  ok(SiteCheck.classify(R('<html><title>Robot Check</title><form action="/errors/validateCaptcha"></form></html>'), u).status === 'blocked', 'captcha → bloqueia');
  ok(SiteCheck.classify(R('', 403), u).status === 'blocked', 'HTTP 403 → bloqueia');
  ok(SiteCheck.classify(R('<html><body><noscript>Le JavaScript n\'est pas activé sur votre navigateur.</noscript><div id="app"></div></body></html>'), u).status === 'js', 'página só com JavaScript → não legível');
  const psr = SiteCheck.classify(R(JSON.stringify({ ...PRESTA, rendered_products_top: '' }), 200, 'application/json'), 'https://www.coolmatica.pt/store/1');
  ok(psr.method === 'PrestaShop (JSON)' && psr.products === 2, 'PrestaShop reconhecido', psr);
  const links = Array.from({ length: 30 }, (_, i) => `<a href="/cat/${i}">Categoria ${i}</a>`).join('');
  const home = SiteCheck.classify(R(`<html><body><nav>${links}</nav><p>${'Bem-vindo à nossa loja de informática. '.repeat(20)}</p></body></html>`), 'https://loja.pt/');
  ok(home.status === 'none' && /categoria/.test(home.notes.join(' ')), 'página inicial sem produtos → sugere usar uma categoria', home);
  ok(SiteCheck.classify(R(GLOBALDATA), u, { robotsAllowed: false }).status === 'robots', 'robots.txt proibido → não lê');
  const shop = SiteCheck.classify(R(GLOBALDATA.replace('</head>', '<script src="https://cdn.shopify.com/s/x.js"></script></head>')), u);
  ok(shop.platform === 'Shopify' && /Shopify/.test(shop.notes.join(' ')), 'plataforma Shopify identificada');

  group('Formato de preço francês');
  ok(LiteX.parsePrice('279€98') === 279.98 && Crawler.parsePrice('1 299€99') === 1299.99, '"279€98" e "1 299€99" lidos corretamente');
  ok(JSON.stringify(Crawler.pricesIn('Lave-linge 279€98 ou 119€')) === '[279.98,119]', 'vários preços no formato francês');

  group('Base de dados de lojas (data/sites.json)');
  try {
    const d = await (await fetch('../data/sites.json')).json();
    const ids = new Set(), bad = [];
    for (const s of d.sites) {
      if (ids.has(s.id)) bad.push('id repetido ' + s.id); ids.add(s.id);
      if (!['ok', 'partial', 'blocked'].includes(s.status)) bad.push(s.id + ': estado');
      if (s.status !== 'blocked' && !(s.starts || []).length) bad.push(s.id + ': sem endereços');
      for (const x of s.starts || []) { try { if (hostOf(x.url) !== s.domain && !hostOf(x.url).endsWith('.' + s.domain)) bad.push(s.id + ': domínio ' + x.url); } catch { bad.push(s.id + ': url ' + x.url); } }
      (s.categories || []).forEach((c) => { if (!d.categories[c]) bad.push(s.id + ': categoria ' + c); });
    }
    ok(!bad.length, `${d.sites.length} lojas válidas (ids, estados, endereços, categorias)`, bad);
    ok(d.sites.filter((s) => s.status === 'ok').length >= 10, 'pelo menos 10 lojas que funcionam');
    // nenhum endereço de partida usa caminhos proibidos que já conhecemos
    const forbidden = [/globaldata\.pt\/search/, /auchan\.pt\/.*(prefn|srule|pmin|pmax)/, /king-jouet\.com\/jeux-jouets\/(recherche|page[2-9])/, /materiel\.net\/(recherche|search)/, /topachat\.com\/pages\/recherche/, /ludum\.fr\/.*\?/, /almedina\.net\/.*\?/, /misterpc\.pt\/.*[?&](sort|limit|page|filter)=/, /philibertnet\.com\/.*(recherche|[?&]n=|orderby)/, /kultgames\.pt\/.*(search|orderby|[?&]n=)/, /rueducommerce\.fr\/(.*\/produits\/page|recherche)/, /chiptec\.net\/.*[?&]p=/, /espritjeu\.com\/.*filtres/, /leyaonline\.com\/(pt\/)?(loja|livrosescolares)\//, /electrodepot\.fr\/(catalog|product)\//];
    const hits = d.sites.flatMap((s) => (s.starts || []).map((x) => x.url)).filter((x) => forbidden.some((re) => re.test(x)));
    ok(!hits.length, 'endereços de partida respeitam os robots.txt verificados', hits);
  } catch (e) { ok(false, 'carregar data/sites.json', e.message); }

  const sum = document.getElementById('summary');
  sum.textContent = `${pass} passaram, ${fail} falharam`;
  sum.className = fail ? 'fail' : 'pass';
  window.__TEST_RESULT = { pass, fail };
})();
