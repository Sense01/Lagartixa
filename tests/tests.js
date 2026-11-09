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

  group('Palavras-chave no plural e páginas de categoria');
  {
    const re = (k) => LiteX.keywordRegexes([k])[0].re;
    ok(re('Monitores').test('MONITOR LED LG') && re('monitor').test('Monitores gaming'), '"Monitores" encontra "monitor" (e vice-versa)');
    ok(!re('Monitores').test('monitorização') && re('placa gráfica').test('placas gráficas'), 'continua a respeitar a palavra inteira; frases no plural');
    const c = new Crawler({ startUrls: ['https://www.radiopopular.pt/'], keywords: ['Monitores'] });
    ok(c.filterItem({ name: 'MONITOR LED LG 27U411B-B', brand: '', url: 'https://www.radiopopular.pt/produto/monitor-led-lg', price: 79.99 }) !== null, 'o crawler aceita o produto "MONITOR …" com a palavra "Monitores"');
    ok(Crawler.LISTING_PATH.test('/categoria/monitores-3') && Crawler.LISTING_PATH.test('/marca/lg') && !Crawler.LISTING_PATH.test('/produto/monitor-led-lg'), 'sitemap: categorias e marcas não contam como produtos');
    ok(c.normalize('https://www.radiopopular.pt/?srsltid=AYCX9v&utm_source=x&p=2') === 'https://www.radiopopular.pt/?p=2', 'parâmetros de seguimento (srsltid, utm_) removidos');
  }

  group('Falsos produtos e preços impossíveis');
  {
    const c = new Crawler({ startUrls: ['https://www.radiopopular.pt/'] });
    const a = c.makeItem({ name: 'Cartão RP ON', price: '8.99', oldPrice: '1500', url: '/pagina/cartao' }, 'html', 'https://www.radiopopular.pt/');
    ok(a.oldPrice == null && a.discount == null, '"preço antigo" 1500 € para 8,99 € é descartado (nada de -99%)');
    ok(!Crawler.looksLikeProduct(a), 'bloco que leva a /pagina/… não é um produto');
    const b = c.makeItem({ name: '24"', price: '20', url: '/categoria/monitores-24' }, 'html', 'https://www.radiopopular.pt/');
    ok(!Crawler.looksLikeProduct(b), 'filtro "24\\"" que leva a uma categoria não é um produto');
    const g = c.makeItem({ name: 'MONITOR LED LG 27U411B-B', price: '79.99', oldPrice: '109.99', url: '/produto/monitor-led-lg' }, 'html', 'https://www.radiopopular.pt/');
    ok(Crawler.looksLikeProduct(g) && g.discount === 27, 'produto verdadeiro continua (-27%)');
  }

  group('Melhores negócios = abaixo da média');
  {
    const mk = (name, url, price, extra = {}) => ({ name, url, price, ...extra });
    const lego1 = mk('LEGO Orquídea 10311', 'https://a.pt/l1', 30, { id: 'lego:10311' });
    const lego2 = mk('LEGO Orquídea 10311', 'https://b.pt/l1', 45, { id: 'lego:10311' });
    const lego3 = mk('LEGO Orquídea 10311', 'https://c.pt/l1', 47, { id: 'lego:10311' });
    const mons = [129, 139, 149, 159, 89].map((p, i) => mk(`MONITOR LED Marca${i} 27" X${i}`, `https://d.pt/m${i}`, p));
    const mons24 = [99, 109].map((p, i) => mk(`MONITOR LED Outra${i} 24" Y${i}`, `https://d.pt/n${i}`, p));
    const pv = mk('Cabo HDMI 2m', 'https://e.pt/c', 9, { oldPrice: 20 });
    const ai = mk('Robot aspirador Z', 'https://f.pt/r', 150, { deal: { typicalPrice: 200, verdict: 'bom' } });
    const all = [lego1, lego2, lego3, ...mons, ...mons24, pv, ai];
    const V = Value.analyze(all, { identity: (it) => it.id || '', otherStores: () => [], history: () => [] });
    const l = V.get(lego1);
    ok(l.basis === 'lojas' && l.n === 2 && l.ref === 46 && l.pct === 35 && l.good, 'LEGO 30 € vs média de 2 lojas (46 €) → 35% abaixo, bom negócio', l);
    ok(V.get(lego3).pct < 0 && !V.get(lego3).good, 'a loja mais cara fica acima da média');
    const m = V.get(mons[4]);
    ok(m.basis === 'semelhantes' && m.ref === 144 && !m.good && m.weak, 'monitor 27" 89 € vs mediana de 4 monitores 27" (144 €): só estimativa, não conta como bom negócio', m);
    ok(V.get(mons24[0]) === null, 'monitores 24" não são comparados com os de 27" (grupo pequeno demais → sem referência)');
    ok(Value.sizeKey('MONITOR LED LG 27" FHD') === '27in' && Value.sizeKey('SSD Samsung 1TB') === '1tb' && Value.sizeKey('MONITOR LED AOC 27B36X') === '', 'tamanho lido do nome (27", 1TB)');
    const need = Value.needsAi(all.map((x) => ({ ...x, availability: 'in' })), 12).map((x) => x.url);
    ok(!need.includes('https://a.pt/l1') && need.includes('https://e.pt/c'), 'a IA é chamada sozinha só para os que não têm referência fiável', need);
    ok(V.get(pv).basis === 'pvpr' && V.get(ai).basis === 'ia' && V.get(ai).pct === 25, 'sem outras lojas: PVPR da loja; com IA: preço típico');
    const order = all.slice().sort((a, b) => (V.get(b)?.score ?? -1e9) - (V.get(a)?.score ?? -1e9)).map((x) => x.url);
    ok(order[0] === 'https://a.pt/l1', 'ordenação: o mais abaixo da média (com a referência mais fiável) primeiro', order.slice(0, 3));
    ok(Value.typeKey('MONITOR LED GAMING AOC') === 'monitor led' && Value.typeKey('SUPORTE MONITOR NAPOFIX') === 'suporte monitor', 'tipo do produto pelas primeiras palavras');
  }

  group('Simulador de revenda');
  {
    const P = { ...Resale.DEFAULTS, feePct: 10, feeFixed: 0.5, shipIn: 0, shipOut: 5, packaging: 1, returnPct: 0, quickSalePct: 0, vat: 'none' };
    const a = Resale.profit(50, 100, P);
    // 100 - (10 + 0,5) - 5 - 1 - 50 = 33,5
    ok(a.net === 33.5 && a.roi === 67, 'lucro: 100 € de venda, 50 € de compra → 33,50 € (67%)', [a.net, a.roi]);
    const m = Resale.profit(50, 100, { ...P, vat: 'margin' });
    ok(Math.abs(m.vat - 50 * 0.23 / 1.23) < 0.01, 'regime da margem: IVA só sobre os 50 € de margem', m.vat);
    const n = Resale.profit(50, 100, { ...P, vat: 'normal' });
    ok(Math.abs(n.vat - (100 - 100 / 1.23 - (50 - 50 / 1.23))) < 0.01, 'IVA normal: liquidado − dedutível', n.vat);
    const q = Resale.profit(50, 100, { ...P, quickSalePct: 10, returnPct: 10 });
    ok(q.sale === 90 && q.returns === 1.1, 'venda 10% abaixo do mercado e custo esperado das devoluções', [q.sale, q.returns]);
    ok(Resale.profit(0, 100, P) === null && Resale.profit(10, null, P) === null, 'sem preço de compra ou de revenda → sem cálculo');
    const it = { name: 'X', url: 'https://loja.pt/p/x', price: 40, oldPrice: 60 };
    ok(Resale.marketPrice(it, { manual: {}, deal: { lowestPrice: 55, typicalPrice: 65 }, others: [], history: null }).value === 55, 'revenda: usa o mais baixo da concorrência (IA)');
    ok(Resale.marketPrice(it, { manual: {}, deal: null, others: [], history: null }).source === 'antigo', 'sem IA: usa o preço antigo');
    const SP = { ...P, budget: 300, months: 6, sellProb: 70, priceVol: 10, dealsAgain: 50, minRoi: 10 };
    const good = Resale.simulate([{ buy: 50, market: 100 }, { buy: 30, market: 55 }], SP, { runs: 500, seed: 7 });
    const good2 = Resale.simulate([{ buy: 50, market: 100 }, { buy: 30, market: 55 }], SP, { runs: 500, seed: 7 });
    ok(good.profit.p50 > 0 && good.probLoss < 10 && good.bands.length === 7, 'simulação rentável dá lucro provável positivo', good.profit);
    ok(JSON.stringify(good) === JSON.stringify(good2), 'mesma semente → mesmo resultado (repetível)');
    const bad = Resale.simulate([{ buy: 50, market: 58 }], { ...SP, minRoi: -100 }, { runs: 300, seed: 3 });
    ok(bad.profit.p50 < 0 && bad.probLoss > 50, 'margem pequena + custos → prejuízo provável', bad.profit);
    ok(Resale.simulate([{ buy: 50, market: 58 }], SP, { runs: 50 }).pool === 0, 'retorno abaixo do mínimo → não compra');
  }

  group('Rádio Popular (microdata) e sitemap');
  {
    const tile = (name, price, old, slug, img) => `<article class="product-grid-module module product link ECI " itemprop="itemListElement" itemscope itemtype="http://schema.org/Product"> <div class="mobile"> <meta itemprop="name" content="${name}" /> <meta itemprop="sku" content="1351121" /> <meta itemprop="gtin13" content="8806096833339" /> <div itemprop="brand" itemscope itemtype="http://schema.org/Brand"> <meta itemprop="name" content="LG"> </div> <div class="flags"><div class="flags-item standard">Até 10x Sem Juros</div></div> <div class="designation px-2" itemprop="name" content="${name}"> <a href="https://www.radiopopular.pt/produto/${slug}" target="_top"> ${name} </a> </div> <div class="image wrapper"> <a href="https://www.radiopopular.pt/produto/${slug}" itemprop="url"> <img src="https://www.radiopopular.pt/includes/imgs/1x1.png" loading="lazy" style="background-image:url('https://x.pt/${img}.jpg');" alt="${name}" itemprop="image" content="https://x.pt/${img}.jpg"> </a> </div> <div class="data cb" itemprop="offers" itemscope="" itemtype="http://schema.org/Offer"> <a href="/entrega" class="message-stock">Entrega em 1 a 2 dias úteis </a> <meta itemprop="priceCurrency" content="EUR"> <div class="promotion promotion-pvpr"><p class="promotion-number">-27%</p><p class="promotion-text">sobre PVPR</p></div> <div class="data-bottom">${old ? `<div class="old-price notranslate fl"><p class="rp-body-3 old-price__pvpr">PVPR*</p><span class="no-strike rp-body-3">€${old}</span><sup class="no-strike rp-sup">,99</sup></div>` : ''} <div class="product-footer"> <div class="price notranslate fl" itemprop="price" content="${price}">${Math.floor(price)}<sup>,99</sup></div> </div> <meta itemprop="availability" content="http://schema.org/InStock" /> </div> </div> </div> </article>`;
    const cat = `<html><body><div class="viewport">${tile('MONITOR LED LG 27U411B-B', 79.99, 109, 'monitor-led-lg-27u411b-b', 'a')}${tile('MONITOR LED GAMING AOC CQ32G4VE', 159.99, 229, 'monitor-led-gam-aoc', 'b')}${tile('MONITOR LED GAMING LG 25G523B-B', 99.99, null, 'monitor-lg-25g', 'c')}</div></body></html>`;
    const L = LiteX.listingFromHtml(cat, 'https://www.radiopopular.pt/categoria/monitores-3');
    ok(L.length === 3, 'lista: 3 produtos', L.length);
    ok(L[0].price === 79.99 && L[0].oldPrice === 109.99 && L[0].discount === 27, 'preço 79,99 e PVPR 109,99 ("€109</span><sup>,99")', [L[0].price, L[0].oldPrice]);
    ok(L[0].image === 'https://x.pt/a.jpg', 'imagem real em vez do 1x1.png', L[0].image);
    ok(L[0].availability === 'in' && L[2].oldPrice == null, 'stock por microdata; sem PVPR fica sem preço antigo');
    const c = new Crawler({ startUrls: ['https://www.radiopopular.pt/categoria/monitores-3'] });
    const parsed = c.parse(cat, 'https://www.radiopopular.pt/categoria/monitores-3');
    ok(parsed.products.filter((p) => p.price != null).length === 3 && parsed.products.some((p) => p.price === 159.99 && p.oldPrice === 229.99), 'crawler no browser lê os mesmos 3 produtos', parsed.products.map((p) => [p.price, p.oldPrice]));
    // pagina de produto com outro produto (vistos recentemente) antes do principal
    const prod = `<html><head><meta property="og:title" content="MONITOR LED LG 27U411B-B | Ao melhor preço radiopopular.pt"></head><body><nav>${tile('MONITOR LED PHILIPS 27E1N1100A', 89.99, null, 'philips', 'p')}</nav><h1>MONITOR LED LG 27U411B-B</h1><div itemscope itemtype="http://schema.org/Product"><meta itemprop="name" content="MONITOR LED LG 27U411B-B" /><div class="old-price notranslate fl"><p>PVPR*</p><span class="no-strike">€109</span><sup>,99</sup></div><div class="price" itemprop="price" content="79.99">79<sup>,99</sup></div></div></body></html>`;
    const P = LiteX.productFromHtml(prod, 'https://www.radiopopular.pt/produto/monitor-led-lg-27u411b-b');
    ok(P.name === 'MONITOR LED LG 27U411B-B' && P.price === 79.99 && P.oldPrice === 109.99, 'página de produto: escolhe o produto principal, não o relacionado', [P.name, P.price, P.oldPrice]);
    const idx = LiteX.parseSitemap('<sitemapindex><sitemap><loc>https://s3/sitemap-paginas.xml</loc></sitemap><sitemap><loc>https://s3/sitemap-produtos-00.xml</loc></sitemap></sitemapindex>');
    ok(LiteX.rankSitemaps(idx.sitemaps)[0].endsWith('produtos-00.xml'), 'sitemap: os de produtos primeiro');
    const us = LiteX.parseSitemap('<urlset><url><loc>https://www.radiopopular.pt/produto/monitor-led-lg</loc><image:image><image:title><![CDATA[MONITOR LED LG]]></image:title></image:image></url><url><loc>https://www.radiopopular.pt/produto/frigorifico</loc></url></urlset>');
    ok(us.urls.length === 2 && us.urls[0].title === 'MONITOR LED LG', 'sitemap: endereços e títulos das imagens');
    ok(JSON.stringify(LiteX.robotsSitemaps('User-agent: *\nAllow: /files/sitemaps/\n\nSitemap: https://s3/sitemap.xml')) === '["https://s3/sitemap.xml"]', 'robots.txt: linhas Sitemap');
  }

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
