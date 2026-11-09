/**
 * Crawler BFS que corre no browser.
 * - GitHub Pages é estático → pedidos passam por proxies CORS (com troca automática se um falhar).
 * - Extrai produtos (nome, preço, preço antigo, desconto) de: API do Lidl, JSON-LD (schema.org) e heurística no HTML.
 * - Filtra produtos por palavras-chave, preço mín./máx. e desconto mínimo.
 */

const PUBLIC_PROXIES = [
  { name: 'allorigins', tpl: 'https://api.allorigins.win/raw?url={url}' },
  { name: 'codetabs', tpl: 'https://api.codetabs.com/v1/proxy?quest={url}' },
  { name: 'corsproxy.io', tpl: 'https://corsproxy.io/?url={url}' },
];

class Crawler {
  constructor(opts) {
    this.opts = {
      startUrls: [],
      keywords: [],
      caseSensitive: false,
      wholeWord: true,
      snippetsPerKeyword: 3,
      minPrice: null,
      maxPrice: null,
      minDiscount: null,
      maxPages: 50,
      maxDepth: 2,
      concurrency: 3,
      delay: 300,
      proxies: PUBLIC_PROXIES,   // [{name, tpl}] — tentados por ordem
      sameDomain: true,
      sameSection: true,     // só segue links dentro do caminho indicado (ex.: /componentes/…)
      respectRobots: true,
      stripQuery: false,
      timeout: 20000,
      maxApiProducts: 1000,
      useSitemap: false,     // procura produtos no sitemap da loja (para listas que só mostram 12 e carregam o resto por JavaScript)
      maxSitemapFiles: 8,
      ...opts,
    };
    this.proxies = [...this.opts.proxies];
    this.queue = [];
    this.seen = new Set();
    this.results = [];
    this.items = [];              // produtos que passam os filtros
    this.itemKeys = new Set();
    this.productsSeen = 0;        // todos os produtos detetados (antes dos filtros)
    this.errors = 0;
    this.running = false;
    this.active = 0;
    this.robotsRules = new Map();
    this.hostCount = new Map();       // paginas em fila/visitadas por loja
    this.controllers = new Set();
    this.keywordTotals = {};
    this.keywordPages = {};
    this.pagesWithMatches = 0;
    this.matchers = this.buildMatchers();

    this.onResult = () => {};
    this.onItem = () => {};
    this.onLog = () => {};
    this.onProgress = () => {};
  }

  get hasItemFilters() {
    const o = this.opts;
    return this.matchers.length > 0 || o.minPrice != null || o.maxPrice != null || o.minDiscount != null;
  }

  /* ---------- utilitários ---------- */

  normalize(raw, base) {
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return null;
      u.hash = '';
      if (this.opts.stripQuery) u.search = '';
      // parametros de seguimento (Google, Facebook, campanhas) nao mudam a pagina
      for (const k of [...u.searchParams.keys()]) if (/^(srsltid|gclid|gbraid|wbraid|fbclid|msclkid|mc_[a-z]+|utm_[a-z]+)$/i.test(k)) u.searchParams.delete(k);
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
      return u.href;
    } catch {
      return null;
    }
  }

  inSection(url) {
    const u = new URL(url);
    const host = this.hostKey(url);
    const path = u.pathname.toLowerCase();
    return (this.sections || []).some(
      (s) => s.host === host && (!s.path || path === s.path || path.startsWith(s.path + '/') || path.startsWith(s.path + '.') || path.startsWith(s.path + '?'))
    );
  }

  hostKey(url) {
    return new URL(url).hostname.replace(/^www\./, '');
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  proxied(url, tpl) {
    if (!tpl || tpl === '{url}') return url;
    return tpl.replace('{url}', encodeURIComponent(url)).replace('{rawurl}', url);
  }

  async fetchOnce(url, tpl, timeout) {
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort('timeout'), timeout);
    const t0 = performance.now();
    try {
      const res = await fetch(this.proxied(url, tpl), { signal: ctrl.signal, redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      return { status: res.status, ok: res.ok, type, text, ms: Math.round(performance.now() - t0) };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ctrl);
    }
  }

  /**
   * Tenta cada proxy por ordem. Erro de rede, timeout, 429 ou 5xx → passa ao seguinte.
   * O proxy que funcionar passa para a frente da lista.
   */
  async fetchText(url, { timeout = this.opts.timeout, maxTries = this.proxies.length } = {}) {
    const failures = [];
    let lastResponse = null;
    const list = this.proxies.slice(0, Math.max(1, maxTries));
    for (const p of list) {
      if (!this.running) throw new DOMException('Cancelado', 'AbortError');
      try {
        const r = await this.fetchOnce(url, p.tpl, timeout);
        r.proxy = p.name;
        // 401/403/407: proxy a pedir chave ou site a bloquear o IP do proxy → tenta o seguinte
        if ([0, 401, 403, 407, 408, 429].includes(r.status) || r.status >= 500) {
          failures.push(`${p.name}: HTTP ${r.status}`);
          this.onLog(`Proxy ${p.name} respondeu HTTP ${r.status} — a tentar o seguinte`);
          lastResponse = r;
          continue;
        }
        // sucesso: este proxy passa a ser o primeiro
        const i = this.proxies.indexOf(p);
        if (i > 0) {
          this.proxies.splice(i, 1);
          this.proxies.unshift(p);
          this.onLog(`A usar o proxy ${p.name}`);
        }
        r.proxy = p.name;
        return r;
      } catch (e) {
        if (!this.running) throw e;
        failures.push(`${p.name}: ${e.name === 'AbortError' || e === 'timeout' ? 'sem resposta' : e.message}`);
      }
    }
    if (lastResponse && list.length === 1) return lastResponse;
    // se o proxy próprio chegou ao site e levou 401/403, é o site que bloqueia — não o proxy
    const ownBlocked = failures.some((f) => /^o meu proxy: HTTP 40[13]/.test(f));
    const err = new Error(
      ownBlocked
        ? 'Este site bloqueia acesso automático (o teu proxy chegou ao site e recebeu "acesso recusado")'
        : `Todos os proxies falharam (${failures.join('; ')})`
    );
    err.proxyFailure = !ownBlocked;
    err.siteBlocked = ownBlocked;
    err.details = failures.join('; ');
    throw err;
  }

  /** Deteta páginas de captcha / anti-bot que chegam em vez do conteúdo real. */
  static detectBlock(r) {
    const head = (r.text || '').slice(0, 20000);
    const patterns = [
      /Robot Check|validateCaptcha|api-services-support@amazon|opfcaptcha/i,
      /cf-chl-|challenge-platform|Just a moment\.\.\.|Attention Required! \| Cloudflare/i,
      /Access Denied[\s\S]{0,400}(Reference|errors\.edgesuite)/i,
      /Pardon Our Interruption|px-captcha|_Incapsula_Resource|datadome|geo\.captcha-delivery/i,
      /are you a (human|robot)|confirm you are human|verify you are human/i,
    ];
    if (patterns.some((re) => re.test(head))) {
      return `O site mostrou uma verificação anti-robô (captcha) em vez da página — este site bloqueia acesso automático`;
    }
    if (r.status === 403 || r.status === 401) {
      return `Acesso recusado (HTTP ${r.status}) — este site bloqueia acesso automático a partir de servidores`;
    }
    if (r.status === 203) {
      return `HTTP 203: a resposta foi substituída a caminho (normalmente uma página anti-robô) — este site bloqueia acesso automático`;
    }
    return null;
  }

  /* ---------- palavras-chave ---------- */

  buildMatchers() {
    const flags = 'gu' + (this.opts.caseSensitive ? '' : 'i');
    const kws = [...new Set(this.opts.keywords.map((k) => k.trim()).filter(Boolean))];
    return kws.map((kw) => {
      let src = LiteX.keywordSource(kw);
      if (this.opts.wholeWord) src = `(?<![\\p{L}\\p{N}])${src}(?![\\p{L}\\p{N}])`;
      this.keywordTotals[kw] = 0;
      this.keywordPages[kw] = 0;
      return { kw, re: new RegExp(src, flags) };
    });
  }

  findKeywords(text) {
    const hits = {};
    const snippets = {};
    let total = 0;
    for (const { kw, re } of this.matchers) {
      re.lastIndex = 0;
      let count = 0;
      const snips = [];
      let m;
      while ((m = re.exec(text))) {
        count++;
        if (snips.length < this.opts.snippetsPerKeyword) {
          const a = Math.max(0, m.index - 70);
          const b = Math.min(text.length, m.index + m[0].length + 70);
          snips.push({
            before: (a > 0 ? '…' : '') + text.slice(a, m.index),
            match: m[0],
            after: text.slice(m.index + m[0].length, b) + (b < text.length ? '…' : ''),
          });
        }
        if (m[0].length === 0) re.lastIndex++;
      }
      if (count) {
        hits[kw] = count;
        snippets[kw] = snips;
        total += count;
      }
    }
    return { hits, snippets, total };
  }

  /* ---------- preços ---------- */

  // um so parser de precos, partilhado com o Worker (js/extract-lite.js)
  static parsePrice(raw) { return LiteX.parsePrice(raw); }

  static pricesIn(text) { return LiteX.pricesIn(text); }


  /** 'out' | 'preorder' | 'in' | null a partir de texto ou de URL schema.org */
  static detectAvailability(text) {
    const t = String(text || '');
    if (/OutOfStock|SoldOut|Discontinued|esgotad|indispon[ií]vel|sem stock|fora de stock|out of stock|sold out|rupture|[ée]puis[ée]|agotad|ausverkauft|nicht verf[üu]gbar/i.test(t)) return 'out';
    if (/PreOrder|BackOrder|brevemente|pr[ée]-?reserva|por encomenda|sob encomenda|pre-?order|pr[ée]commande/i.test(t)) return 'preorder';
    if (/InStock|LimitedAvailability|em stock|dispon[ií]vel|in stock|en stock|[úu]ltimos artigos|entrega em|envio em/i.test(t)) return 'in';
    return null;
  }

  static LISTING_PATH = /\/(categorias?|category|categories|categorie|c|cat|collections?|marcas?|brands?|marques?|pesquisa|search|recherche|tag|tags|blog|pagina|paginas|page|pages|lojas|stores|promo[a-z]*)(\/|$)/i;

  /** descarta "falsos produtos": blocos que levam a uma categoria/campanha ou sem nome a serio (ex. '24"') */
  static looksLikeProduct(it) {
    if (it.source === 'html' || it.source === 'sitemap') {
      try { if (Crawler.LISTING_PATH.test(new URL(it.url).pathname)) return false; } catch {}
      if (!/\p{L}{3,}/u.test(it.name || '')) return false;
    }
    return true;
  }

  makeItem(raw, source, pageUrl) {
    const price = Crawler.parsePrice(raw.price);
    let oldPrice = Crawler.parsePrice(raw.oldPrice);
    if (oldPrice != null && price != null && oldPrice <= price) oldPrice = null;
    // "preco antigo" 5x maior que o atual quase sempre e outro numero da pagina (filtro de precos, outro produto)
    if (oldPrice != null && price != null && oldPrice > price * 5) oldPrice = null;
    let discount = raw.discount != null ? Math.abs(parseFloat(raw.discount)) : null;
    if (discount != null && (discount >= 90 || discount <= 0)) discount = null;
    if ((discount == null || !isFinite(discount)) && price != null && oldPrice != null) {
      discount = Math.round(((oldPrice - price) / oldPrice) * 100);
    }
    if (!isFinite(discount)) discount = null;
    const url = raw.url ? this.normalize(raw.url, pageUrl) || pageUrl : pageUrl;
    return {
      name: (raw.name || '').replace(/\s+/g, ' ').trim().replace(/^\d{5,}\s*[-\u2013|]\s*/, ''),   // "1352201 - MONITOR…" -> "MONITOR…"
      brand: String(raw.brand || '').trim(),
      ean: String(raw.ean || '').replace(/\D/g, '') || '',
      mpn: String(raw.mpn || '').trim(),
      sku: String(raw.sku || '').trim(),
      availability: raw.availability || null,   // 'in' | 'out' | 'preorder' | null
      price,
      oldPrice,
      discount,
      currency: raw.currency || '€',
      url,
      image: raw.image ? this.normalize(raw.image, pageUrl) || '' : '',
      source,
      page: pageUrl,
    };
  }

  /** Aplica filtros; devolve as palavras encontradas ou null se não passar. */
  filterItem(it) {
    const o = this.opts;
    if (o.minPrice != null && (it.price == null || it.price < o.minPrice)) return null;
    if (o.maxPrice != null && (it.price == null || it.price > o.maxPrice)) return null;
    if (o.minDiscount != null && (it.discount == null || it.discount < o.minDiscount)) return null;
    let hits = {};
    if (this.matchers.length) {
      let slug = '';
      try { slug = decodeURIComponent(new URL(it.url).pathname).replace(/[-_/]+/g, ' '); } catch {}
      hits = this.findKeywords(`${it.brand} ${it.name} ${slug}`).hits;
      if (!Object.keys(hits).length) return null;
    }
    return hits;
  }

  addItems(items, row) {
    row.productsFound = items.length;
    row.items = [];
    for (const it of items) {
      if (!it.name && it.price == null) continue;
      if (!Crawler.looksLikeProduct(it)) continue;
      this.productsSeen++;
      const hits = this.filterItem(it);
      if (!hits) continue;
      const key = `${it.url}|${it.name}`;
      if (this.itemKeys.has(key)) continue;
      this.itemKeys.add(key);
      it.keywordHits = hits;
      it.foundAt = new Date().toISOString();
      this.items.push(it);
      row.items.push(it);
      this.onItem(it, this.items.length);
    }
  }

  /* ---------- extração de produtos ---------- */

  extractJsonLd(doc, pageUrl) {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      const type = [].concat(node['@type'] || []).join(' ');
      if (/Product/i.test(type)) {
        const offers = [].concat(node.offers || []);
        const offer = offers[0] || {};
        const inner = [].concat(offer.offers || [])[0] || offer;
        const price = inner.price ?? inner.lowPrice ?? offer.lowPrice;
        const spec = [].concat(inner.priceSpecification || []);
        const listPrice = spec.find((s) => /ListPrice|StrikethroughPrice/i.test(s.priceType || ''))?.price;
        out.push(
          this.makeItem(
            {
              name: node.name,
              brand: typeof node.brand === 'object' ? node.brand?.name : node.brand,
              price,
              oldPrice: listPrice ?? inner.highPrice,
              currency: inner.priceCurrency,
              url: node.url || offer.url,
              image: [].concat(node.image || [])[0]?.url || [].concat(node.image || [])[0],
              ean: node.gtin13 || node.gtin || node.gtin12 || node.gtin14 || node.gtin8 || '',
              mpn: node.mpn || '',
              sku: node.sku || '',
              availability: Crawler.detectAvailability(inner.availability || offer.availability || ''),
            },
            'json-ld',
            pageUrl
          )
        );
      }
      if (node['@graph']) visit(node['@graph']);
      if (node.itemListElement) visit([].concat(node.itemListElement).map((e) => e.item || e));
    };
    doc.querySelectorAll('script[type="application/ld+json"]').forEach((s) => {
      try { visit(JSON.parse(s.textContent)); } catch {}
    });
    return out;
  }

  extractHeuristic(doc, pageUrl) {
    const sel = 'article, li, [itemtype*="Product"], [class*="product" i], [class*="tile" i], [class*="card" i], [class*="item" i], [data-pid], [data-product-id]';
    const info = new Map();
    let cands = [...doc.querySelectorAll(sel)].filter((el) => {
      const t = el.textContent;
      if (t.length > 5000 || !el.querySelector('a[href]')) return false;
      const prices = [...new Set(Crawler.pricesIn(t.replace(/\s+/g, ' ')))];
      // um produto tem 1 a 4 preços (atual, antigo, por unidade…); mais do que isso é uma grelha
      if (!prices.length || prices.length > 4) return false;
      info.set(el, prices);
      return true;
    });
    // fica com os contentores mais interiores que ainda têm link + preço
    cands = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    // mas se o mais interior não tiver imagem nem título, sobe até ao bloco que os tem
    cands = cands.map((el) => {
      let cur = el;
      for (let i = 0; i < 4 && cur.parentElement; i++) {
        if (cur.querySelector('img') && cur.querySelector('h2, h3, h4, [class*="name" i], [class*="title" i], a[href]')) break;
        const up = cur.parentElement;
        const upPrices = [...new Set(Crawler.pricesIn(up.textContent.replace(/\s+/g, ' ')))];
        if (upPrices.length > 4 || up.textContent.length > 5000) break;
        cur = up;
      }
      return cur;
    });
    cands = [...new Set(cands)];

    return cands.slice(0, 300).map((el) => {
      const text = el.textContent.replace(/\s+/g, ' ');
      const prices = [...new Set(Crawler.pricesIn(text))];
      // preço "oficial" em atributos (schema.org, Salesforce Commerce, etc.)
      const STRUCK = 's, del, strike, [class*="old" i], [class*="strike" i], [class*="regular" i], [class*="was" i], [class*="before" i]';
      const notInStruck = (n) => n && !n.closest(STRUCK);
      const attrEl =
        [...el.querySelectorAll('[itemprop="price"], .sales [content], [class*="price" i] [content], [class*="price" i][content], [data-price]')]
          .find(notInStruck);
      const attrPrice = attrEl ? attrEl.getAttribute('content') || attrEl.getAttribute('data-price') : null;
      const struck = [...el.querySelectorAll(STRUCK)].find((n) => Crawler.pricesIn(n.textContent.replace(/\s+/g, ' ')).length || n.getAttribute('content'));
      const struckPrice = struck
        ? Crawler.pricesIn(struck.textContent.replace(/\s+/g, ' '))[0] ??
          Crawler.parsePrice(struck.querySelector('[content]')?.getAttribute('content') || struck.getAttribute('content'))
        : null;
      let priceN = Crawler.parsePrice(attrPrice);
      if (priceN == null) {
        const notStruck = prices.filter((p) => p !== struckPrice);
        priceN = notStruck.length ? Math.min(...notStruck) : prices.length ? Math.min(...prices) : null;
      }
      const bigger = prices.filter((p) => priceN != null && p > priceN);
      const oldPrice = struckPrice != null && struckPrice > (priceN ?? 0) ? struckPrice : bigger.length ? Math.max(...bigger) : null;
      const dm = text.match(Crawler.DISCOUNT_RE);
      const nameEl = el.querySelector('[itemprop="name"], .pdp-link a, [class*="product-name" i], [class*="product-title" i], h2, h3, h4, [class*="title" i], [class*="name" i]');
      const img = el.querySelector('img');
      const link = el.querySelector('.pdp-link a[href], h2 a[href], h3 a[href], [class*="name" i] a[href], [class*="title" i] a[href]') || el.querySelector('a[href]');
      const imgSrc = img?.getAttribute('data-src') || img?.getAttribute('data-lazy') ||
        (img?.getAttribute('srcset') || img?.getAttribute('data-srcset') || '').split(/\s+/)[0] || img?.getAttribute('src') || '';
      return this.makeItem(
        {
          name: nameEl?.textContent || img?.alt || link?.getAttribute('title') || link?.textContent || '',
          price: priceN,
          oldPrice,
          discount: dm ? dm[1] || dm[2] : null,
          url: link?.getAttribute('href'),
          image: imgSrc.startsWith('data:') ? '' : imgSrc,
          availability: Crawler.detectAvailability(text),
        },
        'html',
        pageUrl
      );
    });
  }

  /* ---------- Lidl: as páginas de pesquisa carregam os produtos por JS, usamos a API ---------- */

  static LIDL_LOCALES = {
    fr: 'fr_FR', pt: 'pt_PT', es: 'es_ES', de: 'de_DE', it: 'it_IT', nl: 'nl_NL', be: 'nl_BE',
    pl: 'pl_PL', 'co.uk': 'en_GB', ie: 'en_IE', at: 'de_AT', ch: 'de_CH', cz: 'cs_CZ', sk: 'sk_SK',
    hu: 'hu_HU', ro: 'ro_RO', bg: 'bg_BG', hr: 'hr_HR', si: 'sl_SI', dk: 'da_DK', se: 'sv_SE',
    fi: 'fi_FI', lt: 'lt_LT', lv: 'lv_LV', ee: 'et_EE', gr: 'el_GR', cy: 'el_CY', mt: 'en_MT', rs: 'sr_RS',
  };

  lidlApiUrl(pageUrl, offset, size) {
    const u = new URL(pageUrl);
    const m = u.hostname.match(/(?:^|\.)lidl\.([a-z.]+)$/);
    if (!m || !/^\/q\/(query|search)/.test(u.pathname)) return null;
    const tld = m[1];
    const locale = Crawler.LIDL_LOCALES[tld] || 'en_GB';
    const api = new URL(`${u.origin}/q/api/search`);
    u.searchParams.forEach((v, k) => api.searchParams.append(k, v));
    const seg = u.pathname.match(/^\/q\/query\/([^/]+)/);
    if (seg && seg[1] !== 'promotions' && !api.searchParams.has('q')) api.searchParams.set('q', decodeURIComponent(seg[1]));
    api.searchParams.set('assortment', locale.split('_')[1]);
    api.searchParams.set('locale', locale);
    api.searchParams.set('version', 'v2.0.0');
    api.searchParams.set('offset', offset);
    api.searchParams.set('fetchsize', size);
    return api.href;
  }

  async visitLidl(row) {
    const products = [];
    const size = 100;
    let offset = 0;
    let total = Infinity;
    let ms = 0;
    while (offset < total && offset < this.opts.maxApiProducts && this.running) {
      const r = await this.fetchText(this.lidlApiUrl(row.url, offset, size));
      ms += r.ms;
      row.status = r.status;
      if (!r.ok) throw new Error(`API do Lidl respondeu HTTP ${r.status} (via ${r.proxy})`);
      let json;
      try { json = JSON.parse(r.text); } catch { throw new Error('A API do Lidl não devolveu JSON (o proxy pode ter sido bloqueado)'); }
      total = json.numFound ?? 0;
      const items = json.items || [];
      for (const it of items) {
        const d = it.gridbox?.data || {};
        const pr = d.price || {};
        products.push(
          this.makeItem(
            {
              name: d.fullTitle || it.gridbox?.title || d.title,
              brand: d.brand?.name || '',
              price: pr.price,
              oldPrice: pr.oldPrice,
              discount: pr.discount?.percentageDiscount,
              currency: pr.currencySymbol || '€',
              url: d.canonicalUrl || it.url,
              image: d.image,
            },
            'lidl-api',
            row.url
          )
        );
      }
      this.onLog(`Lidl: ${Math.min(offset + items.length, total)}/${total} produtos`);
      if (!items.length) break;
      offset += items.length;
    }
    row.ms = ms;
    row.title = `Lidl — ${products.length} produtos`;
    const kw = this.findKeywords(products.map((p) => `${p.brand} ${p.name}`).join(' · '));
    Object.assign(row, { keywordHits: kw.hits, keywordSnippets: kw.snippets, keywordTotal: kw.total, links: [] });
    this.addItems(products, row);
  }

  /* ---------- PrestaShop (resposta JSON da listagem) ---------- */

  static isPrestaShopJson(r) {
    if (!/json/i.test(r.type || '') && !/^\s*\{/.test(r.text || '')) return false;
    return /"rendered_products"|"rendered_products_top"/.test((r.text || '').slice(0, 5000));
  }

  prestaShopItem(p, pageUrl) {
    if (!p || typeof p !== 'object') return null;
    const cover = p.cover || p.default_image || {};
    const image =
      cover.bySize?.home_default?.url || cover.medium?.url || cover.large?.url || cover.small?.url || '';
    const pct = String(p.discount_percentage_absolute || p.discount_percentage || '').replace(/[^\d.,]/g, '');
    return this.makeItem(
      {
        name: p.name,
        brand: p.manufacturer_name || '',
        price: p.price_amount ?? p.price,
        oldPrice: p.has_discount ? p.regular_price_amount ?? p.regular_price : null,
        discount: p.has_discount && pct && /percent/i.test(p.discount_type || 'percentage') ? pct : null,
        url: p.url || p.link,
        image,
        ean: p.ean13 || p.upc || '',
        mpn: p.mpn || '',
        sku: p.reference || '',
        availability:
          p.availability === 'unavailable' || (p.quantity != null && +p.quantity <= 0 && !p.allow_oosp) ? 'out'
          : p.availability === 'available' || p.availability === 'last_remaining_items' ? 'in'
          : Crawler.detectAvailability(p.availability_message || ''),
      },
      'prestashop',
      pageUrl
    );
  }

  /* ---------- robots.txt ---------- */

  // guarda a promessa: pedidos em paralelo para o mesmo site esperam pelo mesmo robots.txt
  loadRobots(origin) {
    if (!this.robotsRules.has(origin)) this.robotsRules.set(origin, this.fetchRobots(origin));
    return this.robotsRules.get(origin);
  }

  async fetchRobots(origin) {
    let rules = [];
    try {
      const r = await this.fetchText(origin + '/robots.txt', { timeout: 10000, maxTries: 1 });
      if (r.ok && !/<html/i.test(r.text.slice(0, 500))) {
        rules = this.parseRobots(r.text);
        rules.sitemaps = LiteX.robotsSitemaps(r.text);
      }
      this.onLog(`robots.txt de ${origin}: ${rules.length} regras`);
    } catch {
      this.onLog(`robots.txt de ${origin} indisponível — a continuar sem regras`);
    }
    return rules;
  }

  parseRobots(txt) {
    const rules = [];
    let applies = false;
    let lastWasAgent = false;
    for (let line of txt.split(/\r?\n/)) {
      line = line.replace(/#.*/, '').trim();
      if (!line) continue;
      const idx = line.indexOf(':');
      if (idx < 0) continue;
      const key = line.slice(0, idx).trim().toLowerCase();
      const val = line.slice(idx + 1).trim();
      if (key === 'user-agent') {
        if (!lastWasAgent) applies = false;
        if (val === '*') applies = true;
        lastWasAgent = true;
        continue;
      }
      lastWasAgent = false;
      if (!applies) continue;
      if ((key === 'allow' || key === 'disallow') && val) rules.push({ allow: key === 'allow', path: val });
    }
    return rules;
  }

  robotsAllows(url, rules) {
    const u = new URL(url);
    const path = u.pathname + u.search;
    let best = null;
    for (const r of rules) {
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
    }
    return !best || best.allow;
  }

  /* ---------- parsing de páginas ---------- */

  parse(html, baseUrl) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const baseEl = doc.querySelector('base[href]');
    const base = baseEl ? this.normalize(baseEl.getAttribute('href'), baseUrl) || baseUrl : baseUrl;

    const links = new Set();
    doc.querySelectorAll('a[href]').forEach((a) => {
      const rel = (a.getAttribute('rel') || '').toLowerCase();
      if (rel.includes('nofollow')) return;
      const n = this.normalize(a.getAttribute('href'), base);
      if (n) links.add(n);
    });

    const meta = (name) => doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';
    const title = doc.querySelector('title')?.textContent.trim() || '';
    const description = meta('description');

    // produtos: JSON-LD primeiro; se não houver, heurística no HTML
    let products = this.extractJsonLd(doc, base);
    if (!products.length) products = this.extractHeuristic(doc, base);
    // segunda opiniao: o extrator partilhado com o Worker (microdata, precos "79<sup>,99</sup>", imagens em background)
    const priced = (list) => list.filter((p) => p.price != null).length;
    if (priced(products) < 12) {
      try {
        const lite = LiteX.listingFromHtml(html, base).map((p) => this.makeItem(p, 'html', base));
        if (priced(lite) >= priced(products) && priced(lite)) products = lite;
      } catch {}
    }

    doc.querySelectorAll('script, style, noscript, template, svg, iframe').forEach((n) => n.remove());
    const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const kw = this.findKeywords([title, description, bodyText].filter(Boolean).join(' · '));

    return {
      title,
      description,
      keywordHits: kw.hits,
      keywordSnippets: kw.snippets,
      keywordTotal: kw.total,
      h1: [...doc.querySelectorAll('h1')].map((h) => h.textContent.trim()).filter(Boolean),
      canonical: doc.querySelector('link[rel="canonical"]')?.getAttribute('href') || '',
      robotsMeta: meta('robots'),
      images: doc.querySelectorAll('img').length,
      wordCount: bodyText ? bodyText.split(' ').length : 0,
      links: [...links],
      products,
    };
  }

  /* ---------- ciclo principal ---------- */

  enqueue(url, depth, from, extra) {
    if (this.seen.has(url)) return false;
    if (this.seen.size >= this.opts.maxPages) return false;
    // varias lojas: cada uma tem a sua parte das paginas (uma loja grande nao gasta tudo e deixa as outras a espera)
    const host = this.hostKey(url);
    if (this.startHosts && this.startHosts.size > 1) {
      const cap = Math.ceil(this.opts.maxPages / this.startHosts.size);
      if ((this.hostCount.get(host) || 0) >= cap) return false;
    }
    if (!extra?.product) {
      if (depth > this.opts.maxDepth) return false;
      if (this.opts.sameDomain && !this.startHosts.has(this.hostKey(url))) return false;
      if (this.opts.sameSection && !this.inSection(url)) return false;
    }
    this.seen.add(url);
    this.hostCount.set(host, (this.hostCount.get(host) || 0) + 1);
    // fila intercalada por loja: a proxima pagina e sempre da loja com menos paginas pedidas
    this.queue.push({ url, depth, from, ...extra });
    return true;
  }

  /* ---------- sitemap ---------- */

  /** junta ao inicio da fila as paginas de produto do sitemap cujo endereco/titulo tem as palavras-chave */
  async seedFromSitemaps(starts) {
    if (!this.matchers.length) {
      this.onLog('Sitemap: indica palavras-chave para escolher os produtos (o sitemap tem milhares de páginas)');
      return;
    }
    for (const origin of [...new Set(starts.map((u) => new URL(u).origin))]) {
      const rules = this.opts.respectRobots ? await this.loadRobots(origin) : [];
      let pending = LiteX.rankSitemaps(rules.sitemaps?.length ? rules.sitemaps : [origin + '/sitemap.xml']);
      const done = new Set();
      let files = 0, found = 0, added = 0;
      while (pending.length && files < this.opts.maxSitemapFiles && this.running) {
        const sm = pending.shift();
        if (done.has(sm)) continue;
        done.add(sm);
        if (/\.gz($|\?)/i.test(sm)) { this.onLog(`Sitemap comprimido ignorado: ${sm}`); continue; }
        let r;
        try { r = await this.fetchText(sm, { timeout: 45000, maxTries: 2 }); } catch (e) { this.onLog(`Sitemap indisponível: ${sm} (${e.message})`); continue; }
        if (!r.ok) { this.onLog(`Sitemap ${sm}: HTTP ${r.status}`); continue; }
        files++;
        const { sitemaps, urls } = LiteX.parseSitemap(r.text);
        // indice: so os sub-sitemaps que parecem de produtos (paginas, categorias, blog... ficam para o fim)
        pending = LiteX.rankSitemaps([...pending, ...sitemaps.filter((x) => !done.has(x))]);
        // se o indice tem sitemaps de produtos, os de paginas/categorias/marcas ficam de fora
        if (pending.some((x) => /prod|item|artic/i.test(x.split('/').pop().replace(/sitemaps?/gi, '')))) {
          pending = pending.filter((x) => !/pagin|page|categor|blog|news|post|marca|brand|video|image/i.test(x.split('/').pop().replace(/sitemaps?/gi, '')));
        }
        // ja ha produtos: os sitemaps de paginas, categorias, blog... nao trazem mais
        if (found) pending = pending.filter((x) => !/pagin|page|categor|blog|news|post|marca|brand|video/i.test(x.split('/').pop().replace(/sitemaps?/gi, '')));
        for (const { loc, title } of urls) {
          let slug = '';
          try { slug = decodeURIComponent(new URL(loc).pathname).replace(/[-_/]+/g, ' '); } catch { continue; }
          // paginas de lista (categorias, marcas, pesquisas) nao sao produtos: ja sao percorridas pelos links
          if (Crawler.LISTING_PATH.test(new URL(loc).pathname)) continue;
          if (!Object.keys(this.findKeywords(`${title} ${slug}`).hits).length) continue;
          found++;
          if (this.opts.respectRobots && !this.robotsAllows(loc, rules)) continue;
          const n = this.normalize(loc);
          if (n && this.enqueue(n, this.opts.maxDepth, sm, { product: true, title })) added++;
        }
        this.onLog(`Sitemap ${sm.split('/').pop()}: ${urls.length} endereços, ${found} com as palavras-chave até agora`);
      }
      if (files) {
        this.onLog(`Sitemap de ${new URL(origin).hostname}: ${added} páginas de produto em fila` +
          (found > added ? ` (${found - added} ficaram de fora — aumenta "Máx. páginas" para ver todas)` : ''));
      } else {
        this.onLog(`Sitemap de ${new URL(origin).hostname}: não encontrado`);
      }
    }
  }

  async start() {
    const starts = this.opts.startUrls
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => this.normalize(/^https?:\/\//i.test(u) ? u : 'https://' + u))
      .filter(Boolean);
    if (!starts.length) throw new Error('Indique pelo menos um site válido');

    this.startHosts = new Set(starts.map((u) => this.hostKey(u)));
    // secções: o caminho de cada site de partida (sem o último "/" e sem extensão .html)
    this.sections = starts.map((u) => {
      const x = new URL(u);
      const path = x.pathname.replace(/\.(html?|php|aspx?)$/i, '').replace(/\/+$/, '').toLowerCase();
      return { host: this.hostKey(u), path };
    });
    this.running = true;
    this.onLog(`A iniciar em: ${starts.join(', ')}`);
    this.onLog(`Proxies: ${this.proxies.map((p) => p.name).join(' → ')}`);
    if (this.matchers.length) this.onLog(`Palavras-chave: ${this.matchers.map((m) => m.kw).join(', ')}`);
    const o = this.opts;
    if (o.minPrice != null || o.maxPrice != null || o.minDiscount != null) {
      this.onLog(`Filtros: preço ${o.minPrice ?? '–'} a ${o.maxPrice ?? '–'}, desconto ≥ ${o.minDiscount ?? 0}%`);
    }
    for (const s of starts) {
      if (!this.seen.has(s)) {
        this.seen.add(s);
        this.hostCount.set(this.hostKey(s), (this.hostCount.get(this.hostKey(s)) || 0) + 1);
        this.queue.push({ url: s, depth: 0, from: null });
      }
    }
    if (this.opts.useSitemap) await this.seedFromSitemaps(starts);

    await Promise.all(Array.from({ length: this.opts.concurrency }, () => this.worker()));

    const stopped = !this.running;
    this.running = false;
    this.onLog(`Terminado: ${this.results.length} páginas, ${this.items.length} produtos encontrados, ${this.errors} erros`);
    return { stopped };
  }

  /** proximo pedido: intercala as lojas (a que tem menos paginas ja visitadas primeiro) */
  nextJob() {
    if (this.queue.length < 2 || !this.startHosts || this.startHosts.size < 2) return this.queue.shift();
    this.visitedBy ||= new Map();
    let bi = 0, best = Infinity;
    for (let i = 0; i < this.queue.length; i++) {
      const n = this.visitedBy.get(this.hostKey(this.queue[i].url)) || 0;
      if (n < best) { best = n; bi = i; if (n === 0) break; }
    }
    const [job] = this.queue.splice(bi, 1);
    const h = this.hostKey(job.url);
    this.visitedBy.set(h, (this.visitedBy.get(h) || 0) + 1);
    return job;
  }

  async worker() {
    while (this.running) {
      const job = this.nextJob();
      if (!job) {
        if (this.active === 0) return;
        await this.sleep(100);
        continue;
      }
      this.active++;
      try {
        await this.visit(job);
      } finally {
        this.active--;
        this.onProgress(this.stats());
      }
      if (this.opts.delay) await this.sleep(this.opts.delay);
    }
  }

  async visit({ url, depth, from, product }) {
    const row = { url, depth, from, status: null, title: '', links: [], ms: 0, error: '' };

    try {
      if (this.opts.respectRobots) {
        const rules = await this.loadRobots(new URL(url).origin);
        if (!this.robotsAllows(url, rules)) {
          row.status = 'robots';
          row.error = depth === 0
            ? 'Bloqueado por robots.txt — o site não permite crawlers nesta secção (ex.: pesquisa). Usa o link da categoria.'
            : 'Bloqueado por robots.txt';
          this.push(row);
          return;
        }
      }

      if (this.lidlApiUrl(url, 0, 1)) {
        this.onLog(`Página de pesquisa do Lidl detetada — a usar a API de produtos`);
        await this.visitLidl(row);
      } else {
        const r = await this.fetchText(url);
        row.status = r.status;
        row.ms = r.ms;
        row.contentType = r.type;

        const block = Crawler.detectBlock(r);
        if (block) {
          row.error = block;
          row.status = `bloqueado (${r.status})`;
          this.errors++;
        } else if (!r.ok) {
          row.error = `HTTP ${r.status}`;
          this.errors++;
        } else if (Crawler.isPrestaShopJson(r)) {
          // lojas PrestaShop respondem em JSON quando o pedido aceita JSON: lista de produtos já estruturada
          const j = JSON.parse(r.text);
          const html = ['rendered_products_top', 'rendered_products', 'rendered_products_bottom', 'rendered_facets']
            .map((k) => j[k] || '').join('\n');
          const parsed = this.parse(
            `<html><head><title>${String(j.label || '').replace(/</g, '')}</title></head><body>${html}</body></html>`, url);
          const fromJson = (j.products || []).map((p) => this.prestaShopItem(p, url)).filter(Boolean);
          const products = fromJson.length ? fromJson : parsed.products;
          delete parsed.products;
          Object.assign(row, parsed);
          if (!row.title) row.title = `PrestaShop — ${products.length} produtos`;
          this.addItems(products, row);
          for (const link of row.links) this.enqueue(link, depth + 1, url);
        } else if (product && (!r.type || r.type.includes('html'))) {
          // pagina de produto vinda do sitemap: so o produto principal (nao os relacionados)
          const parsed = this.parse(r.text, url);
          delete parsed.products;
          Object.assign(row, parsed, { links: [] });
          // pagina de produto: so o produto principal. Os "relacionados", filtros e campanhas da pagina ficam de fora.
          const p = LiteX.productFromHtml(r.text, url);
          if (p && p.price != null && p.name) {
            this.addItems([this.makeItem(p, 'sitemap', url)], row);
          } else {
            // afinal e uma pagina de lista: so com o extrator rigoroso (cartoes completos com nome, link e preco)
            const lite = LiteX.listingFromHtml(r.text, url).map((x) => this.makeItem(x, 'html', url)).filter((x) => x.url !== url);
            this.addItems(lite.length >= 3 ? lite : [], row);
          }
        } else if (!r.type || r.type.includes('html')) {
          const parsed = this.parse(r.text, url);
          const products = parsed.products;
          delete parsed.products;
          Object.assign(row, parsed);
          this.addItems(products, row);
          if (!/nofollow/i.test(row.robotsMeta || '')) {
            for (const link of row.links) this.enqueue(link, depth + 1, url);
          }
        }
      }
    } catch (e) {
      row.status = 'erro';
      row.error = e.name === 'AbortError' ? (this.running ? 'Timeout' : 'Cancelado') : e.message;
      if (e.siteBlocked) {
        row.status = 'bloqueado';
        this.onLog(`Detalhe: ${e.details}`);
      } else if (e.proxyFailure) {
        row.error += ' — o site pode estar a bloquear proxies públicos; experimenta o teu próprio proxy (ver worker/README.md)';
      }
      this.errors++;
    }
    this.push(row);
  }

  push(row) {
    if (row.keywordTotal) {
      this.pagesWithMatches++;
      for (const [kw, n] of Object.entries(row.keywordHits)) {
        this.keywordTotals[kw] += n;
        this.keywordPages[kw]++;
      }
    }
    this.results.push(row);
    this.onResult(row, this.results.length);
    if (row.error) this.onLog(`✗ ${row.url} — ${row.error}`);
  }

  stop() {
    this.running = false;
    this.queue = [];
    this.controllers.forEach((c) => c.abort());
    this.onLog('Parado pelo utilizador');
  }

  stats() {
    const allLinks = new Set();
    this.results.forEach((r) => r.links?.forEach((l) => allLinks.add(l)));
    return {
      crawled: this.results.length,
      queued: this.queue.length,
      errors: this.errors,
      links: allLinks.size,
      matches: this.pagesWithMatches,
      items: this.items.length,
      productsSeen: this.productsSeen,
      keywordTotals: this.keywordTotals,
      keywordPages: this.keywordPages,
    };
  }
}
