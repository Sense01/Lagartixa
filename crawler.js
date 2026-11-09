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
      respectRobots: true,
      stripQuery: false,
      timeout: 20000,
      maxApiProducts: 1000,
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
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.slice(0, -1);
      return u.href;
    } catch {
      return null;
    }
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
      let src = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s\\-_]+');
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

  static parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) ? raw : null;
    let s = String(raw).replace(/[^\d.,]/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.');
    const lastComma = s.lastIndexOf(',');
    if (lastDot > -1 && lastComma > -1) {
      // o separador que aparece por último é o decimal
      const dec = lastDot > lastComma ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (lastComma > -1) {
      const decimals = s.length - lastComma - 1;
      s = decimals === 3 && s.indexOf(',') === lastComma ? s.replace(',', '') : s.replace(/,/g, (m, i) => (i === lastComma ? '.' : ''));
    } else if (lastDot > -1) {
      const decimals = s.length - lastDot - 1;
      if (decimals === 3 && (s.match(/\./g) || []).length >= 1 && s.length > 4) s = s.replace(/\./g, '');
      else s = s.replace(/\.(?=.*\.)/g, '');
    }
    const n = parseFloat(s);
    return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
  }

  static PRICE_RE = /(?:€|EUR|R\$|£|\$)\s?(\d{1,3}(?:[ .  ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[ .  ]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(?:€|EUR|R\$|£|\$)/g;
  static DISCOUNT_RE = /-\s?(\d{1,2})\s?%|(\d{1,2})\s?%\s?(?:off|de\s+(?:r[ée]duction|desconto|descuento)|remise|desconto|rabatt|sconto)/i;

  static pricesIn(text) {
    const out = [];
    Crawler.PRICE_RE.lastIndex = 0;
    let m;
    while ((m = Crawler.PRICE_RE.exec(text))) {
      const v = Crawler.parsePrice(m[1] || m[2]);
      if (v != null) out.push(v);
    }
    return out;
  }

  makeItem(raw, source, pageUrl) {
    const price = Crawler.parsePrice(raw.price);
    let oldPrice = Crawler.parsePrice(raw.oldPrice);
    if (oldPrice != null && price != null && oldPrice <= price) oldPrice = null;
    let discount = raw.discount != null ? Math.abs(parseFloat(raw.discount)) : null;
    if ((discount == null || !isFinite(discount)) && price != null && oldPrice != null) {
      discount = Math.round(((oldPrice - price) / oldPrice) * 100);
    }
    if (!isFinite(discount)) discount = null;
    const url = raw.url ? this.normalize(raw.url, pageUrl) || pageUrl : pageUrl;
    return {
      name: (raw.name || '').replace(/\s+/g, ' ').trim(),
      brand: (raw.brand || '').trim(),
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
    const sel = 'article, li, [itemtype*="Product"], [class*="product" i], [class*="tile" i], [class*="card" i], [class*="item" i]';
    let cands = [...doc.querySelectorAll(sel)].filter((el) => {
      const t = el.textContent;
      return t.length < 800 && el.querySelector('a[href]') && Crawler.pricesIn(t).length;
    });
    // fica com os contentores mais interiores
    cands = cands.filter((el) => !cands.some((o) => o !== el && el.contains(o)));
    return cands.slice(0, 300).map((el) => {
      const text = el.textContent.replace(/\s+/g, ' ');
      const prices = [...new Set(Crawler.pricesIn(text))];
      const ip = el.querySelector('[itemprop="price"]');
      const price = ip ? ip.getAttribute('content') || ip.textContent : prices.length ? Math.min(...prices) : null;
      const priceN = Crawler.parsePrice(price);
      const bigger = prices.filter((p) => priceN != null && p > priceN);
      const dm = text.match(Crawler.DISCOUNT_RE);
      const nameEl = el.querySelector('[itemprop="name"], h2, h3, h4, [class*="title" i], [class*="name" i]');
      const img = el.querySelector('img');
      const a = el.querySelector('a[href]');
      return this.makeItem(
        {
          name: nameEl?.textContent || img?.alt || a?.getAttribute('title') || a?.textContent || '',
          price: priceN,
          oldPrice: bigger.length ? Math.max(...bigger) : null,
          discount: dm ? dm[1] || dm[2] : null,
          url: a?.getAttribute('href'),
          image: img?.getAttribute('data-src') || img?.getAttribute('src') || '',
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
      },
      'prestashop',
      pageUrl
    );
  }

  /* ---------- robots.txt ---------- */

  async loadRobots(origin) {
    if (this.robotsRules.has(origin)) return this.robotsRules.get(origin);
    let rules = [];
    this.robotsRules.set(origin, rules);
    try {
      const r = await this.fetchText(origin + '/robots.txt', { timeout: 10000, maxTries: 1 });
      if (r.ok && !/<html/i.test(r.text.slice(0, 500))) rules = this.parseRobots(r.text);
      this.onLog(`robots.txt de ${origin}: ${rules.length} regras`);
    } catch {
      this.onLog(`robots.txt de ${origin} indisponível — a continuar sem regras`);
    }
    this.robotsRules.set(origin, rules);
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

  enqueue(url, depth, from) {
    if (this.seen.has(url)) return;
    if (this.seen.size >= this.opts.maxPages) return;
    if (depth > this.opts.maxDepth) return;
    if (this.opts.sameDomain && !this.startHosts.has(this.hostKey(url))) return;
    this.seen.add(url);
    this.queue.push({ url, depth, from });
  }

  async start() {
    const starts = this.opts.startUrls
      .map((u) => u.trim())
      .filter(Boolean)
      .map((u) => this.normalize(/^https?:\/\//i.test(u) ? u : 'https://' + u))
      .filter(Boolean);
    if (!starts.length) throw new Error('Indique pelo menos um site válido');

    this.startHosts = new Set(starts.map((u) => this.hostKey(u)));
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
        this.queue.push({ url: s, depth: 0, from: null });
      }
    }

    await Promise.all(Array.from({ length: this.opts.concurrency }, () => this.worker()));

    const stopped = !this.running;
    this.running = false;
    this.onLog(`Terminado: ${this.results.length} páginas, ${this.items.length} produtos encontrados, ${this.errors} erros`);
    return { stopped };
  }

  async worker() {
    while (this.running) {
      const job = this.queue.shift();
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

  async visit({ url, depth, from }) {
    const row = { url, depth, from, status: null, title: '', links: [], ms: 0, error: '' };

    try {
      if (this.opts.respectRobots) {
        const rules = await this.loadRobots(new URL(url).origin);
        if (!this.robotsAllows(url, rules)) {
          row.status = 'robots';
          row.error = 'Bloqueado por robots.txt';
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
