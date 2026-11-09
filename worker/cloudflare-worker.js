/* ======================================================================
 * Web Crawler - Cloudflare Worker
 *
 *   GET  /?url=https://site/pagina   proxy CORS (a app usa-o para ler as lojas)
 *   POST /deal                       "e bom negocio?" (IA com pesquisa web)
 *   GET  /state  POST /sync          estado dos alertas / sincronizar seguidos e pesquisas
 *   POST /run                        verificar agora (o Cron faz o mesmo de hora a hora)
 *   GET  /push/key  POST /push/subscribe  POST /push/test   notificacoes push
 *
 * Configuracao (ver worker/README.md):
 *   - Segredo AI_API_KEY (gsk_... Groq, xai-... xAI, sk-ant-... Anthropic)  -> /deal
 *   - KV namespace ligado com o nome CRAWLER_KV                            -> alertas e limites
 *   - Cron Trigger "0 * * * *"                                             -> verificacao automatica
 *   - Segredo APP_TOKEN (opcional, recomendado): so aceita pedidos com ?token=... ou X-App-Token
 *
 * Este ficheiro e gerado por tools/build_worker.py (nao editar a mao).
 * ASCII only.
 * ==================================================================== */


/* =========================================================
   Extracao de produtos SEM DOM (so texto/regex).
   Usado na app (atualizar precos dos seguidos) e no Worker da Cloudflare
   (verificacoes automaticas), onde nao existe DOMParser.
   ASCII only: este ficheiro e copiado para o Worker.
   ========================================================= */

const LiteX = (() => {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', euro: 'EUR' };
  function decode(s) {
    return String(s || '')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
  }
  const stripTags = (h) => decode(String(h || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

  function parsePrice(raw) {
    if (raw == null) return null;
    if (typeof raw === 'number') return isFinite(raw) && raw > 0 ? Math.round(raw * 100) / 100 : null;
    // formato frances "279\u20ac98" (simbolo do euro no lugar da virgula)
    const fr = String(raw).match(/^\s*(\d{1,3}(?:[ .\u00a0\u202f]\d{3})*|\d+)\s?\u20ac(\d{2})(?!\d)/);
    if (fr) raw = fr[1].replace(/[ .\u00a0\u202f]/g, '') + '.' + fr[2];
    let s = String(raw).replace(/[^\d.,]/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
    if (lastDot > -1 && lastComma > -1) {
      const dec = lastDot > lastComma ? '.' : ',';
      s = s.split(dec === '.' ? ',' : '.').join('').replace(dec, '.');
    } else if (lastComma > -1) {
      const decimals = s.length - lastComma - 1;
      s = decimals === 3 && s.indexOf(',') === lastComma ? s.replace(',', '') : s.replace(/,/g, (m, i) => (i === lastComma ? '.' : ''));
    } else if (lastDot > -1) {
      const decimals = s.length - lastDot - 1;
      if (decimals === 3 && s.length > 4) s = s.replace(/\./g, '');
      else s = s.replace(/\.(?=.*\.)/g, '');
    }
    const n = parseFloat(s);
    return isFinite(n) && n > 0 && n < 1e7 ? Math.round(n * 100) / 100 : null;
  }

  const PRICE_RE = /(\d{1,3}(?:[ .\u00a0\u202f]\d{3})*\u20ac\d{2}(?!\d))|(?:\u20ac|EUR|R\$|\u00a3|\$)\s?(\d{1,3}(?:[ .\u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)|(\d{1,3}(?:[ .\u00a0\u202f]\d{3})*(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?)\s?(?:\u20ac|EUR|R\$|\u00a3|\$)/g;

  function pricesIn(text) {
    const out = [];
    PRICE_RE.lastIndex = 0;
    let m;
    while ((m = PRICE_RE.exec(text))) {
      const v = parsePrice(m[1] || m[2] || m[3]);
      if (v != null) out.push(v);
    }
    return out;
  }

  function detectAvailability(text) {
    const t = String(text || '');
    if (/OutOfStock|SoldOut|Discontinued|esgotad|indispon[i\u00ed]vel|sem stock|fora de stock|out of stock|sold out|rupture|[e\u00e9]puis[e\u00e9]|agotad|ausverkauft/i.test(t)) return 'out';
    if (/PreOrder|BackOrder|brevemente|pr[e\u00e9]-?reserva|por encomenda|sob encomenda|pre-?order|pr[e\u00e9]commande/i.test(t)) return 'preorder';
    if (/InStock|LimitedAvailability|em stock|dispon[i\u00ed]vel|in stock|en stock|[u\u00fa]ltimos artigos/i.test(t)) return 'in';
    return null;
  }

  function absUrl(href, base) {
    try { return new URL(decode(href), base).href.split('#')[0]; } catch { return ''; }
  }

  function makeItem(raw, base) {
    const price = parsePrice(raw.price);
    let oldPrice = parsePrice(raw.oldPrice);
    if (oldPrice != null && price != null && oldPrice <= price) oldPrice = null;
    let discount = raw.discount != null ? Math.abs(parseFloat(String(raw.discount).replace(',', '.'))) : null;
    if ((discount == null || !isFinite(discount)) && price != null && oldPrice != null) discount = Math.round(((oldPrice - price) / oldPrice) * 100);
    if (!isFinite(discount)) discount = null;
    return {
      name: stripTags(raw.name || '').slice(0, 300),
      brand: stripTags(typeof raw.brand === 'object' ? raw.brand?.name : raw.brand || ''),
      price, oldPrice, discount,
      currency: raw.currency || 'EUR',
      url: raw.url ? absUrl(raw.url, base) : base,
      image: raw.image ? absUrl(typeof raw.image === 'object' ? raw.image.url || '' : raw.image, base) : '',
      availability: raw.availability || null,
      ean: String(raw.ean || '').replace(/\D/g, ''),
      mpn: String(raw.mpn || ''),
      sku: String(raw.sku || ''),
    };
  }

  /* ---------- JSON-LD ---------- */

  function jsonLdBlocks(html) {
    const out = [];
    const re = /<script[^>]+type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
      try { out.push(JSON.parse(m[1].trim())); } catch {}
    }
    return out;
  }

  function productsFromJsonLd(html, base) {
    const out = [];
    const visit = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) return node.forEach(visit);
      const type = [].concat(node['@type'] || []).join(' ');
      if (/Product/i.test(type)) {
        const offers = [].concat(node.offers || []);
        const offer = offers[0] || {};
        const inner = [].concat(offer.offers || [])[0] || offer;
        const spec = [].concat(inner.priceSpecification || []);
        const listPrice = spec.find((s) => /ListPrice|Strikethrough/i.test(s.priceType || ''))?.price;
        out.push(makeItem({
          name: node.name, brand: node.brand,
          price: inner.price ?? inner.lowPrice ?? offer.lowPrice,
          oldPrice: listPrice ?? inner.highPrice,
          currency: inner.priceCurrency,
          url: node.url || offer.url,
          image: [].concat(node.image || [])[0],
          availability: detectAvailability(inner.availability || offer.availability || ''),
          ean: node.gtin13 || node.gtin || node.gtin12 || node.gtin14 || node.gtin8 || '',
          mpn: node.mpn, sku: node.sku,
        }, base));
      }
      if (node['@graph']) visit(node['@graph']);
      if (node.itemListElement) visit([].concat(node.itemListElement).map((e) => e.item || e));
    };
    jsonLdBlocks(html).forEach(visit);
    return out;
  }

  /* ---------- pagina de produto ---------- */

  function attr(html, re) {
    const m = html.match(re);
    return m ? decode(m[1]) : null;
  }

  function productFromHtml(html, url) {
    const ld = productsFromJsonLd(html, url);
    const main = ld.find((p) => p.price != null) || ld[0];
    const meta = (prop) =>
      attr(html, new RegExp(`<meta[^>]+(?:property|name|itemprop)\\s*=\\s*["']${prop}["'][^>]*content\\s*=\\s*["']([^"']*)["']`, 'i')) ||
      attr(html, new RegExp(`<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]*(?:property|name|itemprop)\\s*=\\s*["']${prop}["']`, 'i'));
    const itempropPrice = attr(html, /itemprop\s*=\s*["']price["'][^>]*content\s*=\s*["']([^"']+)["']/i) ||
      attr(html, /content\s*=\s*["']([\d.,]+)["'][^>]*itemprop\s*=\s*["']price["']/i);
    const salesPrice = attr(html, /class\s*=\s*["'][^"']*\bsales\b[^"']*["'][\s\S]{0,200}?content\s*=\s*["']([\d.,]+)["']/i);
    // microdata: paginas com varios produtos (relacionados, vistos recentemente) -> escolher o bloco
    // cujo nome coincide com o titulo da pagina
    const micro = !main?.price ? mainMicrodata(html, url, meta('og:title') || stripTags(attr(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || '')) : null;
    if (micro && micro.price != null) {
      return { ...micro, url, image: micro.image || (meta('og:image') ? absUrl(meta('og:image'), url) : ''),
        availability: micro.availability || detectAvailability(meta('product:availability') || '') };
    }
    const price = main?.price ?? parsePrice(meta('product:price:amount') || meta('og:price:amount') || itempropPrice || salesPrice);
    const name = main?.name || meta('og:title') || stripTags(attr(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i) || '') || stripTags(attr(html, /<title[^>]*>([\s\S]*?)<\/title>/i) || '');
    let availability = main?.availability || detectAvailability(meta('product:availability') || meta('og:availability') || attr(html, /itemprop\s*=\s*["']availability["'][^>]*(?:href|content)\s*=\s*["']([^"']+)["']/i) || '');
    if (!availability) {
      const zone = stripTags((html.match(/<(?:div|span|p)[^>]*class\s*=\s*["'][^"']*(?:stock|availability|disponib)[^"']*["'][^>]*>[\s\S]{0,300}/i) || [''])[0]);
      availability = detectAvailability(zone);
    }
    return {
      ...(main || makeItem({}, url)),
      name: name || main?.name || '',
      price: price ?? null,
      image: main?.image || (meta('og:image') ? absUrl(meta('og:image'), url) : ''),
      url,
      availability,
    };
  }

  const norm = (t) => decode(String(t || '')).toLowerCase().replace(/\s*[|\u2013\u2014-]\s.*$/, '').replace(/\s+/g, ' ').trim();

  /** bloco microdata (itemprop="name") do produto principal; null se nao houver um que coincida com o titulo */
  function mainMicrodata(html, url, title) {
    const want = norm(title);
    if (!want || want.length < 4) return null;
    const re = /itemprop\s*=\s*["']name["'][^>]*content\s*=\s*["']([^"']+)["']/gi;
    let m;
    while ((m = re.exec(html))) {
      const got = norm(m[1]);
      if (!got || (got !== want && !want.startsWith(got) && !got.startsWith(want))) continue;
      // segmento: deste nome ate ao proximo produto microdata (ou 20000 caracteres)
      const nextProd = html.slice(m.index + 1, m.index + 20000).search(/itemtype\s*=\s*["'][^"']*schema\.org\/Product["']/i);
      const seg = html.slice(m.index, nextProd > 0 ? m.index + 1 + nextProd : m.index + 20000);
      const priceAttr = attr(seg, /itemprop\s*=\s*["']price["'][^>]*content\s*=\s*["']([^"']+)["']/i);
      if (!priceAttr) continue;
      const it = tileFromSegment(seg, url);
      if (!it) continue;
      it.name = decode(m[1]).trim();
      it.price = parsePrice(priceAttr);
      if (it.oldPrice != null && it.oldPrice <= it.price) it.oldPrice = null;
      // bloco so com metadados (sem preco antigo): procurar o preco riscado junto do preco visivel igual
      if (it.oldPrice == null && it.price != null) {
        const esc = priceAttr.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const vis = new RegExp(`itemprop\\s*=\\s*["']price["'][^>]*content\\s*=\\s*["']${esc}["']`, 'gi');
        let v;
        while ((v = vis.exec(html)) && it.oldPrice == null) {
          const w0 = Math.max(0, v.index - 1500), win = html.slice(w0, v.index + 400);
          const near = struckRanges(win).filter(([, e]) => e <= v.index - w0 + 400);
          const sp = pricesIn(stripTags(near.map(([a, b]) => win.slice(a, b)).join(' ').replace(/(\d)((?:\s*<\/?(?:span|sup|sub|small|b|strong|em|i)\b[^>]*>\s*)+)([.,]\d{2})(?!\d)/gi, '$1$3$2'))).filter((x) => x > it.price && x < it.price * 5);
          if (sp.length) it.oldPrice = Math.max(...sp);
        }
      }
      it.ean = it.ean || attr(seg, /itemprop\s*=\s*["']gtin13["'][^>]*content\s*=\s*["']([^"']+)["']/i) || '';
      it.sku = it.sku || attr(seg, /itemprop\s*=\s*["']sku["'][^>]*content\s*=\s*["']([^"']+)["']/i) || '';
      if (it.oldPrice && it.price && it.discount == null) it.discount = Math.round((1 - it.price / it.oldPrice) * 100);
      return it;
    }
    return null;
  }

  /* ---------- sitemaps ---------- */

  /** le um sitemap XML: { sitemaps: [url], urls: [{ loc, title }] } (titulo vem de image:title, se houver) */
  function parseSitemap(xml) {
    const text = String(xml || '');
    const sitemaps = [], urls = [];
    const cdata = (v) => decode(String(v || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')).trim();
    for (const m of text.matchAll(/<sitemap\b[^>]*>([\s\S]*?)<\/sitemap>/gi)) {
      const loc = cdata(attr(m[1], /<loc>([\s\S]*?)<\/loc>/i));
      if (loc) sitemaps.push(loc);
    }
    for (const m of text.matchAll(/<url\b[^>]*>([\s\S]*?)<\/url>/gi)) {
      const loc = cdata(attr(m[1], /<loc>([\s\S]*?)<\/loc>/i));
      if (!loc) continue;
      urls.push({ loc, title: cdata(attr(m[1], /<image:title>([\s\S]*?)<\/image:title>/i) || '') });
    }
    return { sitemaps, urls };
  }

  /** ordena sitemaps: os de produtos primeiro; paginas, categorias, blog e imagens no fim */
  function rankSitemaps(list) {
    const score = (u0) => { const u = String(u0).split('/').pop().replace(/sitemaps?/gi, ''); return /prod|item|artic|catalog/i.test(u) ? 0 : /pagin|page|categor|blog|news|post|image|video|marca|brand|store|loja/i.test(u) ? 2 : 1; };
    return [...list].sort((a, b) => score(a) - score(b));
  }

  /** linhas "Sitemap:" de um robots.txt */
  function robotsSitemaps(txt) {
    return [...String(txt || '').matchAll(/^\s*sitemap\s*:\s*(\S+)/gim)].map((m) => m[1]);
  }

  /* ---------- listas de produtos (HTML) ---------- */

  /** indice onde termina o elemento que abre em `start` (conta a profundidade da mesma tag) */
  function elementEnd(html, start, tag, cap = 40000) {
    const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
    re.lastIndex = start;
    let depth = 0, m;
    while ((m = re.exec(html))) {
      if (m.index - start > cap) break;
      if (m[0][1] === '/') { if (--depth === 0) return m.index + m[0].length; }
      else if (!/\/>$/.test(m[0])) depth++;
    }
    return Math.min(html.length, start + cap);
  }

  /** zonas [inicio, fim] de elementos riscados (preco antigo) */
  function struckRanges(seg) {
    const out = [];
    const re = /<(s|del|strike)\b[^>]*>|<(\w+)\b[^>]*class\s*=\s*["'][^"']*(?:(?<!no-)strike|old-price|price-old|list-price|regular-price|price-regular|was-price|price-before|crossed)[^"']*["'][^>]*>/gi;
    let m;
    while ((m = re.exec(seg))) {
      const tag = (m[1] || m[2]).toLowerCase();
      out.push([m.index, elementEnd(seg, m.index, tag, 3000)]);
    }
    return out;
  }

  function tileFromSegment(seg, base) {
    // "79<sup>,99</sup>" / "\u20ac109</span><sup>,99</sup>" -> "79,99" / "\u20ac109,99"
    seg = seg.replace(/(\d)((?:\s*<\/?(?:span|sup|sub|small|b|strong|em|i)\b[^>]*>\s*)+)([.,]\d{2})(?!\d)/gi, '$1$3$2');
    // preco: atributos content= perto de "price/sales/value"; os que estao em zonas riscadas sao o preco antigo
    const struck = struckRanges(seg);
    const inStruck = (i) => struck.some(([s, e]) => i >= s && i < e);
    let price = null, oldPrice = null;
    const contentRe = /content\s*=\s*["'](\d+(?:[.,]\d{1,2})?)["']/gi;
    let m;
    while ((m = contentRe.exec(seg))) {
      const before = seg.slice(Math.max(0, m.index - 260), m.index);
      if (!/price|sales|value|amount/i.test(before)) continue;
      const v = parsePrice(m[1]);
      if (v == null) continue;
      if (inStruck(m.index)) { if (oldPrice == null) oldPrice = v; } else if (price == null) price = v;
    }
    if (price != null && oldPrice == null && struck.length) {
      const sp = pricesIn(stripTags(struck.map(([s0, e0]) => seg.slice(s0, e0)).join(' '))).filter((v) => v > price);
      if (sp.length) oldPrice = Math.max(...sp);
    }
    const text = stripTags(seg);
    if (price == null) {
      const struckPrices = pricesIn(stripTags(struck.map(([s, e]) => seg.slice(s, e)).join(' ')));
      const all = [...new Set(pricesIn(text))];
      const rest = all.filter((p) => !struckPrices.includes(p));
      price = rest.length ? Math.min(...rest) : all.length ? Math.min(...all) : null;
      if (struckPrices.length && struckPrices[0] > (price ?? 0)) oldPrice = struckPrices[0];
      else if (all.length > 1) { const big = all.filter((p) => p > price); if (big.length) oldPrice = Math.max(...big); }
    }
    // link e nome
    const links = [...seg.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .filter((a) => !/^(javascript|mailto|tel):/i.test(a[1]));
    const named = links.find((a) => /class\s*=\s*["'][^"']*(?:name|title|link)/i.test(a[0]) && stripTags(a[2]).length > 3) ||
      links.find((a) => stripTags(a[2]).length > 8);
    const heading = stripTags(attr(seg, /<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i) || '');
    const img = seg.match(/<img\b[^>]*>/i)?.[0] || '';
    const placeholder = (u) => !u || /^data:|1x1|blank|placeholder|spacer|pixel\.(gif|png)|loader\.gif/i.test(u);
    const imgCands = [
      attr(seg, /itemprop\s*=\s*["']image["'][^>]*content\s*=\s*["']([^"']+)["']/i),
      attr(img, /data-src\s*=\s*["']([^"']+)["']/i),
      attr(img, /\ssrc\s*=\s*["']([^"']+)["']/i),
      attr(img, /background-image\s*:\s*url\(\s*['"]?([^'")]+)/i),
    ];
    const imgSrc = imgCands.find((u) => !placeholder(u)) || '';
    const microName = attr(seg, /itemprop\s*=\s*["']name["'][^>]*content\s*=\s*["']([^"']{4,})["']/i);
    const name = microName || (named && stripTags(named[2])) || heading || attr(img, /alt\s*=\s*["']([^"']+)["']/i) || '';
    const discount = (text.match(/-\s?(\d{1,2})\s?%/) || [])[1];
    return makeItem({
      name, price, oldPrice, discount,
      url: (named || links[0] || [])[1] || '',
      image: imgSrc,
      availability: detectAvailability(attr(seg, /itemprop\s*=\s*["']availability["'][^>]*(?:href|content)\s*=\s*["']([^"']+)["']/i) || text),
    }, base);
  }

  function listingFromHtml(html, base) {
    const ld = productsFromJsonLd(html, base).filter((p) => p.price != null);
    if (ld.length >= 2) return ld;
    const body = html.replace(/<script[\s\S]*?<\/script>/gi, (s) => ' '.repeat(s.length));  // preserva posicoes
    const re = /<(div|li|article)\b[^>]*\bclass\s*=\s*["']([^"']*\b(?:product|tile|item|card|miniature)[^"']*)["'][^>]*>/gi;
    const groups = new Map();
    let m;
    while ((m = re.exec(body))) {
      const cls = m[2].trim().replace(/\s+/g, ' ');
      // agrupa pela classe completa e pela primeira classe ("product-grid-module ECI" e "product-grid-module" sao o mesmo cartao)
      for (const key of new Set([cls, 'first:' + m[1].toLowerCase() + ':' + cls.split(' ')[0]])) {
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(m.index);
      }
    }
    let best = null;
    for (const [cls, pos] of groups) {
      if (pos.length < 2 || pos.length > 400) continue;
      const lens = pos.slice(1).map((p, i) => p - pos[i]);
      const avg = lens.reduce((a, b) => a + b, 0) / lens.length;
      if (avg > 20000 || avg < 80) continue;
      const tag = (body.slice(pos[0], pos[0] + 12).match(/^<(\w+)/) || [, 'div'])[1];
      const segs = pos.map((p, i) => body.slice(p, Math.min(elementEnd(body, p, tag), i < pos.length - 1 ? Math.max(pos[i + 1], p + 1) : Infinity)));
      const tiles = segs.map((s) => tileFromSegment(s, base)).filter((t) => t.price != null && t.name && t.url);
      // conta produtos distintos (um bloco interno, ex. "Entrega em 2 dias", repete o mesmo link em todos os cartoes)
      const distinct = new Set(tiles.map((t) => t.url)).size;
      const score = distinct - (distinct ? 0 : 1000);
      // empate: o elemento de fora (cartao completo) costuma ter nome, link e imagem certos
      if (!best || score > best.score || (score === best.score && avg > best.avg)) best = { cls, tiles, score, avg };
    }
    const tiles = best?.tiles || [];
    const seen = new Set();
    return tiles.filter((t) => (seen.has(t.url + t.name) ? false : seen.add(t.url + t.name)));
  }

  /* ---------- PrestaShop (JSON) e Lidl (API) ---------- */

  function isPrestaShopJson(text) {
    return /^\s*\{/.test(text || '') && /"rendered_products"|"rendered_products_top"/.test((text || '').slice(0, 5000));
  }

  function prestaShopItems(json, base) {
    return (json.products || []).map((p) => {
      const cover = p.cover || p.default_image || {};
      const pct = String(p.discount_percentage_absolute || p.discount_percentage || '').replace(/[^\d.,]/g, '');
      return makeItem({
        name: p.name, brand: p.manufacturer_name || '',
        price: p.price_amount ?? p.price,
        oldPrice: p.has_discount ? p.regular_price_amount ?? p.regular_price : null,
        discount: p.has_discount && pct && /percent/i.test(p.discount_type || 'percentage') ? pct : null,
        url: p.url || p.link,
        image: cover.bySize?.home_default?.url || cover.medium?.url || cover.large?.url || '',
        ean: p.ean13 || '', sku: p.reference || '',
        availability: p.availability === 'unavailable' ? 'out' : p.availability ? 'in' : null,
      }, base);
    });
  }

  const LIDL_LOCALES = {
    fr: 'fr_FR', pt: 'pt_PT', es: 'es_ES', de: 'de_DE', it: 'it_IT', nl: 'nl_NL', be: 'nl_BE', pl: 'pl_PL',
    'co.uk': 'en_GB', ie: 'en_IE', at: 'de_AT', ch: 'de_CH', cz: 'cs_CZ', sk: 'sk_SK', hu: 'hu_HU', ro: 'ro_RO',
    bg: 'bg_BG', hr: 'hr_HR', si: 'sl_SI', dk: 'da_DK', se: 'sv_SE', fi: 'fi_FI', lt: 'lt_LT', lv: 'lv_LV',
    ee: 'et_EE', gr: 'el_GR', cy: 'el_CY', mt: 'en_MT', rs: 'sr_RS',
  };

  function lidlApiUrl(pageUrl, offset, size) {
    let u;
    try { u = new URL(pageUrl); } catch { return null; }
    const m = u.hostname.match(/(?:^|\.)lidl\.([a-z.]+)$/);
    if (!m || !/^\/q\/(query|search)/.test(u.pathname)) return null;
    const locale = LIDL_LOCALES[m[1]] || 'en_GB';
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

  function lidlItems(json, base) {
    return (json.items || []).map((it) => {
      const d = it.gridbox?.data || {};
      const pr = d.price || {};
      return makeItem({
        name: d.fullTitle || it.gridbox?.title || d.title,
        brand: d.brand?.name || '',
        price: pr.price, oldPrice: pr.oldPrice, discount: pr.discount?.percentageDiscount,
        url: d.canonicalUrl || it.url, image: d.image,
      }, base);
    });
  }

  /* ---------- identidade do produto (igual em todas as lojas) ---------- */

  const BRANDS = ['aoc', 'philips', 'lg', 'samsung', 'acer', 'asus', 'lenovo', 'hp', 'dell', 'msi', 'gigabyte', 'benq', 'xiaomi', 'huawei',
    'garmin', 'sony', 'bosch', 'siemens', 'beko', 'teka', 'balay', 'aeg', 'whirlpool', 'indesit', 'candy', 'hisense', 'tcl', 'panasonic',
    'sharp', 'apple', 'logitech', 'razer', 'corsair', 'kingston', 'crucial', 'wd', 'western digital', 'seagate', 'sandisk', 'noctua', 'arctic',
    'cooler master', 'nzxt', 'be quiet', 'thermaltake', 'intel', 'amd', 'zotac', 'sapphire', 'powercolor', 'asrock', 'tp-link', 'netgear',
    'epson', 'canon', 'brother', 'jbl', 'bose', 'sennheiser', 'marshall', 'dyson', 'rowenta', 'krups', 'delonghi', 'braun',
    'tefal', 'moulinex', 'smeg', 'electrolux', 'haier', 'gorenje', 'miele', 'cecotec', 'roborock', 'ecovacs', 'irobot', 'dreame', 'makita',
    'dewalt', 'einhell', 'stanley', 'hyperx', 'steelseries', 'gamemax', 'mars gaming', 'nox', 'tempest', 'deepcool', 'lian li', 'fractal',
    'patriot', 'g.skill', 'adata', 'lexar', 'pny', 'evga', 'nintendo', 'microsoft', 'oppo', 'realme', 'motorola', 'nokia', 'honor', 'oneplus',
    'karcher', 'hoover', 'russell hobbs', 'princess', 'orbegozo', 'taurus', 'ufesa', 'fujitsu', 'daikin', 'mitsubishi', 'toshiba',
    'meross', 'reolink', 'ezviz', 'tapo', 'anker', 'ugreen', 'belkin', 'trust', 'genesis', 'krom', 'ozone', 'thrustmaster', 'playmobil'];
  const UNIT = /^\d+(?:[.,]\d+)?(?:gb|tb|mb|hz|khz|mhz|ghz|gbps|mbps|fps|w|kw|mah|wh|mm|cm|m|ms|k|p|l|kg|g|v|a|in|pol|rpm|dpi|nits?|bit|mp|x)$/i;
  const NOT_MODEL = /^(?:ddr|lpddr|usb|hdmi|pcie|wifi|wi-fi|rtx|gtx|rx|gen|ps|ip|bt|cat|ax|ac|qi|m\.2|nvme|sata|fhd|uhd|qhd|wqhd|hdr|oled|ips|va|led|lcd)\d/i;

  function brandOf(it) {
    const b = String(it.brand || '').toLowerCase().trim();
    if (b) return b.replace(/[^a-z0-9]+/g, '');
    const name = ' ' + String(it.name || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9.'+\s-]/g, ' ') + ' ';
    const hit = BRANDS.find((x) => name.includes(' ' + x + ' '));
    return hit ? hit.replace(/[^a-z0-9]+/g, '') : '';
  }

  /** codigo de modelo no nome: letras + algarismos ("27B36X", "27E2N1500L/00", "KB242YP0BI", "L24-4C") */
  function modelCode(name) {
    let best = '';
    for (let tok of String(name || '').toUpperCase().split(/[\s,;()|]+/)) {
      tok = tok.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/g, '');
      if (tok.includes('/')) { const first = tok.split('/')[0]; if (first.length >= 5) tok = first; }
      if (!/^[A-Z0-9][A-Z0-9.-]{3,19}$/.test(tok)) continue;
      const digits = (tok.match(/\d/g) || []).length, letters = (tok.match(/[A-Z]/g) || []).length;
      if (digits < 2 || letters < 1 || UNIT.test(tok) || NOT_MODEL.test(tok)) continue;
      const clean = tok.replace(/[.-]/g, '');
      if (clean.length < 4) continue;
      if (clean.length > best.length) best = clean;
    }
    return best;
  }

  /** identidade do produto independente da loja (para comparar lojas) */
  function productIdentity(it) {
    if (!it) return null;
    const ean = String(it.ean || '').replace(/\D/g, '');
    if ([8, 12, 13, 14].includes(ean.length)) return 'ean:' + ean.replace(/^0+(?=\d{12,})/, '');
    const text = `${it.brand || ''} ${it.name || ''}`;
    if (/\blego\b/i.test(text)) {
      const m = text.match(/\((\d{4,6})\)/) || text.match(/\b(\d{5})\b/) || text.match(/(?:ref\.?|set|n\.?\u00ba?)\s*(\d{4,6})\b/i);
      if (m) return 'lego:' + m[1];
    }
    // loja oficial LEGO: o numero do set esta no fim do endereco (/product/megatron-robot-vehicle-40924)
    const u = String(it.url || '');
    if (/(^|\.)lego\.com\//i.test(u.replace(/^https?:\/\//, '')) || /\blego\b/i.test(text)) {
      const m = u.match(/-(\d{4,6})(?:[/?#]|$)/);
      if (m) return 'lego:' + m[1];
    }
    const mpn = String(it.mpn || '').trim();
    if (mpn.length >= 4 && it.brand) return `mpn:${it.brand.toLowerCase()}:${mpn.toLowerCase()}`;
    // marca conhecida + codigo de modelo no nome: "MONITOR LED AOC 27B36X" = "Monitor AOC 27B36X 27'' FHD"
    const brand = brandOf(it), code = modelCode(it.name);
    if (brand && code) return `model:${brand}:${code.toLowerCase()}`;
    return null;
  }

  /* ---------- filtros (iguais aos da app) ---------- */

  /** padrao de uma palavra-chave: singular e plural contam ("monitores" encontra "monitor" e vice-versa) */
  function keywordSource(kw) {
    const escW = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const word = (w) => {
      if (!/^[\p{L}]{3,}$/u.test(w)) return escW(w);
      const low = w.toLowerCase();
      const stem = /[^aeiou]es$/.test(low) && w.length > 4 ? w.slice(0, -2) : /s$/.test(low) && w.length > 3 ? w.slice(0, -1) : w;
      return `${escW(stem)}(?:es|s)?`;
    };
    return String(kw).trim().split(/\s+/).map(word).join('[\\s\\-_]+');
  }

  function keywordRegexes(keywords, { wholeWord = true, caseSensitive = false } = {}) {
    return (keywords || []).map((k) => String(k).trim()).filter(Boolean).map((kw) => {
      let src = keywordSource(kw);
      if (wholeWord) src = `(?<![\\p{L}\\p{N}])${src}(?![\\p{L}\\p{N}])`;
      return { kw, re: new RegExp(src, 'u' + (caseSensitive ? '' : 'i')) };
    });
  }

  function matchesFilters(it, f = {}) {
    if (f.minPrice != null && (it.price == null || it.price < f.minPrice)) return false;
    if (f.maxPrice != null && (it.price == null || it.price > f.maxPrice)) return false;
    if (f.minDiscount != null && (it.discount == null || it.discount < f.minDiscount)) return false;
    const res = keywordRegexes(f.keywords, f);
    if (res.length) {
      let slug = '';
      try { slug = decodeURIComponent(new URL(it.url).pathname).replace(/[-_/]+/g, ' '); } catch {}
      const hay = `${it.brand} ${it.name} ${slug}`;
      if (!res.some(({ re }) => re.test(hay))) return false;
    }
    return true;
  }

  /* ---------- robots.txt e chave do produto (partilhados com o Worker) ---------- */

  /** regras Allow/Disallow do grupo "User-agent: *" */
  function parseRobots(txt) {
    const rules = [];
    let applies = false, lastWasAgent = false;
    for (let line of String(txt || '').split(/\r?\n/)) {
      line = line.replace(/#.*/, '').trim();
      if (!line) continue;
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim().toLowerCase();
      const val = line.slice(i + 1).trim();
      if (key === 'user-agent') { if (!lastWasAgent) applies = false; if (val === '*') applies = true; lastWasAgent = true; continue; }
      lastWasAgent = false;
      if (applies && (key === 'allow' || key === 'disallow') && val) rules.push({ allow: key === 'allow', path: val });
    }
    return rules;
  }

  /** a regra mais longa que coincide ganha; * = qualquer coisa, $ no fim = fim do endereco */
  function robotsAllows(url, rules) {
    const u = new URL(url);
    const path = u.pathname + u.search;
    let best = null;
    for (const r of rules || []) {
      const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
      if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
    }
    return !best || best.allow;
  }

  const TRACKING = /^(utm_|srsltid|gclid|gbraid|wbraid|fbclid|msclkid|mc_|_ga|ref$|sc_|cmp)/i;

  /** chave estavel de um produto numa loja: host + caminho (+ query sem parametros de seguimento) */
  function itemKey(url) {
    try {
      const u = new URL(url);
      [...u.searchParams.keys()].forEach((k) => TRACKING.test(k) && u.searchParams.delete(k));
      u.searchParams.sort();
      const q = u.searchParams.toString();
      return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '')).toLowerCase();
    } catch { return String(url || '').toLowerCase(); }
  }

  return {
    decode, stripTags, parsePrice, pricesIn, detectAvailability,
    jsonLdBlocks, productsFromJsonLd, productFromHtml, listingFromHtml,
    mainMicrodata, parseSitemap, rankSitemaps, robotsSitemaps,
    isPrestaShopJson, prestaShopItems, lidlApiUrl, lidlItems,
    keywordRegexes, keywordSource, matchesFilters,
    productIdentity, modelCode, brandOf,
    parseRobots, robotsAllows, itemKey,
  };
})();

// So a tua app pode usar o Worker (evita que outros gastem a tua quota).
const ALLOWED_ORIGINS = [
  'https://sense01.github.io',
  'http://localhost:8000',
  'http://localhost:8765',
];

// identificacao do remetente das notificacoes push (exigido pelos servicos de push)
const PUSH_SUBJECT = 'https://sense01.github.io';
const APP_URL = 'https://sense01.github.io/';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  // igual a um browser a abrir uma pagina (pedir JSON faz algumas lojas, ex. PrestaShop, responder em JSON)
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-PT,pt;q=0.9,fr-FR;q=0.8,fr;q=0.7,en;q=0.6',
};

const MODELS = {
  // Groq: tenta pela ordem; o primeiro a que a conta tiver acesso e usado
  groq: ['openai/gpt-oss-120b', 'groq/compound', 'openai/gpt-oss-20b', 'groq/compound-mini'],
  xai: 'grok-4.7',
  anthropic: 'claude-haiku-5-5',
};
const DEAL_MAX_SEARCHES = 3;
const DEAL_CACHE_SECONDS = 12 * 3600;
const DEAL_DAILY_LIMIT = 60;          // avaliacoes por dia (protege a quota da API)

const MONITOR = {
  maxFetches: 38,                     // plano gratis: 50 sub-pedidos por execucao (fica margem para push)
  maxWatch: 25,
  maxSitesPerSearch: 3,
  seenPerSearch: 600,
  alertsKept: 100,
  historyPoints: 90,
  histItems: 1500,                    // historico de todos os produtos das pesquisas (para comparar e detetar promocoes falsas)
  histPoints: 30,
  robotsTtlMs: 24 * 3600e3,
};

const enc = new TextEncoder();
const EURO = '\u20ac';
const fmt = (v) => (v == null ? '-' : `${Number(v).toFixed(2).replace('.', ',')} ${EURO}`);

/* ======================================================================
 * Entrada
 * ==================================================================== */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const originOk = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);
    const allowed = originOk || !origin;
    const cors = {
      'Access-Control-Allow-Origin': allowed && origin ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Expose-Headers': 'X-Final-Url',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowed) return new Response('Origem nao autorizada', { status: 403, headers: cors });

    const reqUrl = new URL(request.url);
    // segredo opcional APP_TOKEN: a Origin pode ser falsificada por scripts, o token nao
    if (env.APP_TOKEN && (request.headers.get('X-App-Token') || reqUrl.searchParams.get('token')) !== env.APP_TOKEN) {
      return new Response('Falta o token da app', { status: 401, headers: cors });
    }
    const path = reqUrl.pathname.replace(/\/+$/, '') || '/';
    const api = {
      '/deal': () => handleDeal(request, env, ctx, cors),
      '/state': () => handleState(env, cors),
      '/sync': () => handleSync(request, env, cors),
      '/history': () => handleHistory(request, env, cors),
      '/run': () => handleRun(request, env, cors),
      '/push/key': () => handlePushKey(env, cors),
      '/push/subscribe': () => handleSubscribe(request, env, cors),
      '/push/test': () => handlePushTest(env, cors),
    }[path];
    if (api) {
      // as rotas da API so respondem a tua app (pedidos sem Origin sao recusados)
      if (ALLOWED_ORIGINS.length && !originOk) return json({ error: 'Origem nao autorizada' }, 403, cors);
      try { return await api(); } catch (e) { return json({ error: e.message || String(e), setup: e.setup, retryAfter: e.retryAfter }, e.status || 500, cors); }
    }
    if (request.method !== 'GET') return new Response('So GET', { status: 405, headers: cors });
    return proxy(request, cors);
  },

  // Cron Trigger (ex.: "0 * * * *"): verificacao automatica
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env, { reason: 'cron' }).catch((e) => console.log('monitor:', e.message)));
  },
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

class HttpError extends Error {
  constructor(message, status = 400, setup) { super(message); this.status = status; this.setup = setup; }
}

/* ======================================================================
 * Proxy CORS
 * ==================================================================== */

async function proxy(request, cors) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response('Use ?url=https://...', { status: 400, headers: cors });
  }
  try {
    const res = await fetch(target, { headers: BROWSER_HEADERS, redirect: 'follow', cf: { cacheTtl: 120 } });
    const headers = new Headers(res.headers);
    for (const h of ['content-security-policy', 'set-cookie', 'x-frame-options', 'content-encoding', 'content-length']) headers.delete(h);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    headers.set('X-Final-Url', res.url);
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return new Response(`Erro ao contactar o site: ${e.message}`, { status: 502, headers: cors });
  }
}

/* ======================================================================
 * KV (estado dos alertas)
 * ==================================================================== */

const KV_SETUP = 'No Worker: Settings -> Bindings -> Add -> KV namespace. Cria um namespace (ex.: crawler) e liga-o com o nome CRAWLER_KV. Depois faz Deploy.';

function kv(env) {
  if (!env.CRAWLER_KV) throw new HttpError('Falta ligar o armazenamento KV ao Worker (CRAWLER_KV)', 500, KV_SETUP);
  return env.CRAWLER_KV;
}
async function kvGet(env, key, fallback) {
  const v = await kv(env).get(key, 'json');
  return v ?? fallback;
}
const kvPut = (env, key, value, opts) => kv(env).put(key, JSON.stringify(value), opts);

const emptyState = () => ({ watch: [], searches: [], prices: {}, seen: {}, baselined: {}, robots: {}, alerts: [], lastRun: null, cron: false, histCount: 0, alertMinBelow: 0 });

async function loadState(env) {
  return { ...emptyState(), ...(await kvGet(env, 'state', {})) };
}

// o historico fica numa chave propria: e grande e so o Cron e /history precisam dele
async function loadHist(env, st) {
  return (await kvGet(env, 'hist', null)) || st.hist || {};   // st.hist: estado antigo (antes da chave propria)
}

async function saveState(env, st, hist) {
  const { hist: _old, ...rest } = st;
  if (hist) { rest.histCount = Object.keys(hist).length; await kvPut(env, 'hist', hist); }
  await kvPut(env, 'state', rest);
}

async function publicState(env, st) {
  st ||= await loadState(env);
  const subs = await kvGet(env, 'subs', []);
  return {
    watch: st.watch.map((w) => ({ key: w.key, name: w.name, target: w.target, last: st.prices[w.key] || null })),
    searches: st.searches.map((s) => ({ id: s.id, name: s.name, tracked: Object.keys(st.seen[s.id] || {}).length })),
    histItems: st.histCount || Object.keys(st.hist || {}).length, alertMinBelow: st.alertMinBelow || 0,
    alerts: st.alerts.slice(0, 40),
    lastRun: st.lastRun, lastSummary: st.lastSummary || null, cron: !!st.cron,
    subscriptions: subs.length,
  };
}

async function handleState(env, cors) {
  return json(await publicState(env), 200, cors);
}

function sanitizeLists(body) {
  const watch = (Array.isArray(body.watch) ? body.watch : []).slice(0, 200)
    .filter((w) => w && /^https?:\/\//.test(w.url || ''))
    .map((w) => ({
      key: String(w.key || w.url).slice(0, 400), url: String(w.url).slice(0, 1000), name: String(w.name || '').slice(0, 200),
      image: String(w.image || '').slice(0, 1000), store: String(w.store || '').slice(0, 100),
      target: w.target == null || w.target === '' ? null : Number(w.target), price: w.price == null ? null : Number(w.price),
    }));
  const searches = (Array.isArray(body.searches) ? body.searches : []).slice(0, 30)
    .filter((s) => s && s.id && s.config)
    .map((s) => ({ id: String(s.id).slice(0, 40), name: String(s.name || '').slice(0, 100), config: s.config }));
  return { watch, searches };
}

/** historico de precos que o Worker juntou (a app junta-o ao seu) */
async function handleHistory(request, env, cors) {
  const st = await loadState(env);
  const since = new URL(request.url).searchParams.get('since') || '';
  const out = {};
  for (const [k, e] of Object.entries(await loadHist(env, st))) {
    const pts = since ? e.h.filter((x) => x[0] >= since) : e.h;
    if (pts.length) out[k] = { ...e, h: pts };
  }
  return json({ items: out, count: Object.keys(out).length, lastRun: st.lastRun }, 200, cors);
}

/** junta um preco ao historico (um ponto por dia) */
function histAdd(st, it) {
  const k = itemKey(it.url);
  const e = (st.hist[k] ||= { n: it.name, u: it.url, s: hostOf(it.url), id: LiteX.productIdentity(it), h: [] });
  e.n = it.name || e.n;
  e.id = LiteX.productIdentity(it) || e.id;
  e.h = e.h.filter((x) => x[0] !== today());
  e.h.push([today(), it.price]);
  if (e.h.length > MONITOR.histPoints) e.h = e.h.slice(-MONITOR.histPoints);
  e.t = Date.now();
}

function histPrune(st) {
  const keys = Object.keys(st.hist);
  if (keys.length <= MONITOR.histItems) return;
  keys.sort((a, b) => (st.hist[a].t || 0) - (st.hist[b].t || 0)).slice(0, keys.length - MONITOR.histItems).forEach((k) => delete st.hist[k]);
}

/** referencia para "abaixo da media": outras lojas com o mesmo produto, senao o historico deste produto, senao o preco antigo */
function referenceFor(st, it) {
  const id = LiteX.productIdentity(it), host = hostOf(it.url);
  if (id) {
    const others = Object.values(st.hist).filter((e) => e.id === id && e.s !== host && e.h.length).map((e) => e.h[e.h.length - 1][1]);
    if (others.length) return { ref: others.reduce((a, b) => a + b, 0) / others.length, label: `media de ${others.length} loja${others.length > 1 ? 's' : ''}` };
  }
  const own = st.hist[itemKey(it.url)];
  const past = own ? own.h.filter((x) => x[0] !== today()).map((x) => x[1]) : [];
  if (past.length >= 2) return { ref: past.reduce((a, b) => a + b, 0) / past.length, label: `media do historico (${past.length} dias)` };
  if (it.oldPrice > it.price) return { ref: it.oldPrice, label: 'preco antigo anunciado' };
  return null;
}

function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } }

async function handleSync(request, env, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const body = await request.json().catch(() => ({}));
  const st = await loadState(env);
  const { watch, searches } = sanitizeLists(body);
  st.watch = watch;
  st.searches = searches;
  if (body.alertMinBelow != null) st.alertMinBelow = Math.max(0, Math.min(90, Number(body.alertMinBelow) || 0));
  dropRemoved(st);
  // o preco que a app viu serve de ponto de partida
  for (const w of watch) if (!st.prices[w.key] && w.price != null) st.prices[w.key] = { p: w.price, t: Date.now(), av: null, hist: [[today(), w.price]] };
  await saveState(env, st);
  return json(await publicState(env, st), 200, cors);
}

/** limpa estado de pesquisas/produtos que ja nao estao nas listas */
function dropRemoved(st) {
  const ids = new Set(st.searches.map((s) => s.id));
  for (const id of Object.keys(st.seen)) if (!ids.has(id)) { delete st.seen[id]; delete st.baselined[id]; }
  const keys = new Set(st.watch.map((w) => w.key));
  for (const k of Object.keys(st.prices)) if (!keys.has(k)) delete st.prices[k];
}

async function handleRun(request, env, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const body = await request.json().catch(() => ({}));
  if (body.watch || body.searches) {
    // sincroniza primeiro (garante que verifica a lista mais recente)
    await handleSync(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }), env, cors);
  }
  const res = await runMonitor(env, { reason: 'manual' });
  return json({ summary: res.summary, alerts: res.alerts, state: await publicState(env, res.state) }, 200, cors);
}

/* ======================================================================
 * Verificacao (Cron e "Verificar agora")
 * ==================================================================== */

const today = () => new Date().toISOString().slice(0, 10);

const itemKey = (url) => LiteX.itemKey(url);

function blockedPage(r) {
  if (!r) return true;
  if (r.status === 401 || r.status === 403 || r.status === 203 || r.status === 429) return true;
  return /Robot Check|validateCaptcha|cf-chl-|challenge-platform|Just a moment\.\.\.|px-captcha|_Incapsula_Resource|captcha-delivery|verify you are human/i.test((r.text || '').slice(0, 20000));
}

/** contexto de uma execucao: orcamento de pedidos, robots.txt em cache */
function makeCtx(st) {
  return {
    budget: MONITOR.maxFetches,
    errors: [],
    async get(url, { json: wantJson = false } = {}) {
      if (this.budget <= 0) return null;
      const ok = await this.allowed(url);
      if (ok == null) return null;                     // sem orcamento para ler o robots.txt: nao le a pagina
      if (!ok) { this.errors.push(`robots.txt nao permite ${url}`); return null; }
      this.budget--;
      try {
        const res = await fetch(url, { headers: wantJson ? { ...BROWSER_HEADERS, Accept: 'application/json' } : BROWSER_HEADERS, redirect: 'follow' });
        return { status: res.status, ok: res.ok, text: await res.text(), type: res.headers.get('content-type') || '' };
      } catch (e) {
        this.errors.push(`${url}: ${e.message}`);
        return null;
      }
    },
    async allowed(url) {
      const origin = new URL(url).origin;
      const c = st.robots[origin];
      if (c && Date.now() - c.t < MONITOR.robotsTtlMs) return LiteX.robotsAllows(url, c.rules);
      if (this.budget <= 1) return null;
      this.budget--;
      let rules = [];
      try {
        const r = await fetch(origin + '/robots.txt', { headers: BROWSER_HEADERS });
        const t = r.ok ? await r.text() : '';
        if (!/<html/i.test(t.slice(0, 500))) rules = LiteX.parseRobots(t);
      } catch {}
      st.robots[origin] = { t: Date.now(), rules };
      return LiteX.robotsAllows(url, rules);
    },
  };
}

async function listProducts(siteUrl, c) {
  const lidl = LiteX.lidlApiUrl(siteUrl, 0, 100);
  if (lidl) {
    const r = await c.get(lidl, { json: true });
    if (!r || !r.ok) return [];
    try { return LiteX.lidlItems(JSON.parse(r.text), siteUrl); } catch { return []; }
  }
  const r = await c.get(siteUrl);
  if (!r || !r.ok || blockedPage(r)) return [];
  if (LiteX.isPrestaShopJson(r.text)) {
    try { return LiteX.prestaShopItems(JSON.parse(r.text), siteUrl); } catch { return []; }
  }
  return LiteX.listingFromHtml(r.text, siteUrl);
}

function filtersOf(config) {
  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  return {
    keywords: String(config.keywords || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
    minPrice: num(config.minPrice), maxPrice: num(config.maxPrice), minDiscount: num(config.minDiscount),
    wholeWord: config.wholeWord !== false, caseSensitive: !!config.caseSensitive,
  };
}

async function runMonitor(env, { reason = 'cron' } = {}) {
  const st = await loadState(env);
  st.hist = await loadHist(env, st);
  const c = makeCtx(st);
  const alerts = [];
  const now = Date.now();
  if (reason === 'cron') st.cron = true;

  // 1) produtos seguidos: preco, preco-alvo, regresso ao stock
  let checked = 0;
  for (const w of st.watch.slice(0, MONITOR.maxWatch)) {
    if (c.budget <= 0) break;
    const r = await c.get(w.url);
    if (!r || !r.ok || blockedPage(r)) continue;
    const p = LiteX.productFromHtml(r.text, w.url);
    if (p.price == null) continue;
    checked++;
    const prev = st.prices[w.key];
    const name = w.name || p.name;
    if (prev && p.price < prev.p - 0.004) {
      alerts.push({ kind: 'drop', title: `\u2193 ${name}`, body: `${fmt(prev.p)} \u2192 ${fmt(p.price)} em ${w.store}`, url: w.url, key: w.key });
    }
    if (w.target != null && p.price <= w.target && !(prev && prev.p <= w.target)) {
      alerts.push({ kind: 'target', title: `\ud83c\udfaf ${name}`, body: `Chegou a ${fmt(p.price)} (o teu alvo era ${fmt(w.target)}) em ${w.store}`, url: w.url, key: w.key });
    }
    if (prev && prev.av === 'out' && p.availability === 'in') {
      alerts.push({ kind: 'stock', title: `\ud83d\udce6 De volta ao stock`, body: `${name} - ${fmt(p.price)} em ${w.store}`, url: w.url, key: w.key });
    }
    const hist = (prev?.hist || []).filter((h) => h[0] !== today());
    hist.push([today(), p.price]);
    st.prices[w.key] = { p: p.price, t: now, av: p.availability || null, hist: hist.slice(-MONITOR.historyPoints) };
    histAdd(st, { ...p, name: name, url: w.url });
  }

  // 2) pesquisas com alertas: produtos novos e descidas de preco (+ historico de todos os produtos)
  let searched = 0;
  const runs = [];
  for (const s of st.searches) {
    if (c.budget <= 0) break;
    const sites = String(s.config.sites || '').split(/[\n\s,]+/).map((x) => x.trim()).filter(Boolean)
      .map((x) => (/^https?:\/\//i.test(x) ? x : 'https://' + x)).slice(0, MONITOR.maxSitesPerSearch);
    const f = filtersOf(s.config);
    const found = [];
    for (const site of sites) found.push(...(await listProducts(site, c)));
    if (!found.length) continue;
    searched++;
    const matched = found.filter((it) => it.price != null && it.name && LiteX.matchesFilters(it, f));
    for (const it of matched) histAdd(st, it);           // primeiro o historico: as referencias usam todas as lojas
    runs.push({ s, matched });
  }
  histPrune(st);
  const minBelow = Number(st.alertMinBelow) || 0;
  for (const { s, matched } of runs) {
    const seen = (st.seen[s.id] ||= {});
    const first = !st.baselined[s.id];
    for (const it of matched) {
      const k = itemKey(it.url) + '|' + it.name.slice(0, 60).toLowerCase();
      const prev = seen[k];
      const isNew = prev == null && !first;
      const isDrop = prev != null && it.price < prev - 0.004;
      seen[k] = it.price;
      if (!isNew && !isDrop) continue;
      // so avisar quando esta X% abaixo da media (se o utilizador pediu)
      let note = '';
      if (minBelow > 0) {
        const r = referenceFor(st, it);
        if (!r) continue;
        const pct = Math.round((1 - it.price / r.ref) * 100);
        if (pct < minBelow) continue;
        note = ` \u00b7 ${pct}% abaixo da ${r.label}`;
      }
      if (isNew) alerts.push({ kind: 'new', title: `\ud83c\udd95 ${s.name}`, body: `${it.name} - ${fmt(it.price)}${it.discount ? ` (-${it.discount}%)` : ''}${note}`, url: it.url });
      else alerts.push({ kind: 'drop', title: `\u2193 ${it.name}`, body: `${fmt(prev)} \u2192 ${fmt(it.price)} (${s.name})${note}`, url: it.url });
    }
    const keys = Object.keys(seen);
    if (keys.length > MONITOR.seenPerSearch) keys.slice(0, keys.length - MONITOR.seenPerSearch).forEach((k) => delete seen[k]);
    st.baselined[s.id] = true;
  }

  // 3) guardar e notificar
  const stamped = alerts.map((a) => ({ ...a, t: now }));
  st.alerts = [...stamped, ...st.alerts].slice(0, MONITOR.alertsKept);
  st.lastRun = now;
  const summary = `${checked}/${st.watch.length} produto(s) verificados, ${searched}/${st.searches.length} pesquisa(s), ${alerts.length} alerta(s)` +
    (c.errors.length ? `, ${c.errors.length} aviso(s)` : '');
  st.lastSummary = summary;
  // a verificacao demora: se a app sincronizou entretanto, as listas novas ganham
  const fresh = await loadState(env);
  st.watch = fresh.watch; st.searches = fresh.searches; st.alertMinBelow = fresh.alertMinBelow;
  for (const w of st.watch) if (!st.prices[w.key] && fresh.prices[w.key]) st.prices[w.key] = fresh.prices[w.key];
  dropRemoved(st);
  const hist = st.hist;
  await saveState(env, st, hist);
  st.hist = hist;

  if (alerts.length) {
    const messages = alerts.length <= 3
      ? alerts.map((a) => ({ title: a.title, body: a.body, url: a.url, tag: a.key || a.url }))
      : [{ title: `${alerts.length} alertas de precos`, body: alerts.slice(0, 4).map((a) => a.title.replace(/^\S+\s/, '')).join(' \u00b7 '), url: APP_URL, tag: 'resumo' }];
    await pushAll(env, messages);
  }
  return { summary, alerts: stamped, state: st };
}

/* ======================================================================
 * Notificacoes push (Web Push: VAPID + aes128gcm, so com WebCrypto)
 * ==================================================================== */

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function getVapid(env) {
  let v = await kvGet(env, 'vapid', null);
  if (v) return v;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  v = {
    publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await kvPut(env, 'vapid', v);
  return v;
}

async function vapidAuth(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** RFC 8291: encripta a mensagem para a subscricao (aes128gcm) */
async function encryptPayload(sub, plaintext) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));   // 0x02 = ultimo registo
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));
  const rs = new Uint8Array([0, 0, 16, 0]);                             // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(sub, message, vapid) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: await vapidAuth(sub.endpoint, vapid),
    },
    body,
  });
  return res.status;
}

async function pushAll(env, messages) {
  const subs = await kvGet(env, 'subs', []);
  if (!subs.length) return 0;
  const vapid = await getVapid(env);
  let sent = 0;
  const dead = new Set();
  for (const sub of subs) {
    for (const m of messages) {
      try {
        const status = await sendPush(sub, m, vapid);
        if (status === 404 || status === 410) { dead.add(sub.endpoint); break; }
        if (status < 300) sent++;
      } catch (e) { console.log('push:', e.message); }
    }
  }
  if (dead.size) await kvPut(env, 'subs', subs.filter((s) => !dead.has(s.endpoint)));
  return sent;
}

async function handlePushKey(env, cors) {
  const v = await getVapid(env);
  return json({ publicKey: v.publicKey }, 200, cors);
}

async function handleSubscribe(request, env, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const body = await request.json().catch(() => ({}));
  const s = body.subscription;
  if (!s || !/^https:\/\//.test(s.endpoint || '') || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError('Subscricao invalida');
  const subs = (await kvGet(env, 'subs', [])).filter((x) => x.endpoint !== s.endpoint);
  subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: String(body.device || '').slice(0, 120), at: Date.now() });
  await kvPut(env, 'subs', subs.slice(-10));
  return json(await publicState(env), 200, cors);
}

async function handlePushTest(env, cors) {
  const sent = await pushAll(env, [{ title: '\ud83d\udd77\ufe0f Web Crawler', body: 'As notificacoes estao a funcionar!', url: APP_URL, tag: 'teste' }]);
  return json({ sent }, 200, cors);
}

/* ======================================================================
 * "E bom negocio?" (IA com pesquisa web)
 * ==================================================================== */

function pickProvider(env) {
  const named = [env.AI_API_KEY, env.GROQ_API_KEY, env.XAI_API_KEY, env.ANTHROPIC_API_KEY];
  const all = Object.values(env || {}).filter((v) => typeof v === 'string');
  for (const raw of [...named, ...all]) {
    if (!raw) continue;
    const k = String(raw).trim().replace(/^["']|["']$/g, '');
    if (k.startsWith('gsk_')) return { name: 'groq', key: k };
    if (k.startsWith('xai-')) return { name: 'xai', key: k };
    if (k.startsWith('sk-ant-')) return { name: 'anthropic', key: k };
  }
  return null;
}

async function handleDeal(request, env, ctx, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const provider = pickProvider(env);
  if (!provider) {
    const names = Object.keys(env || {}).filter((k) => typeof env[k] === 'string');
    throw new HttpError('Nao encontrei nenhuma chave (gsk_..., xai-... ou sk-ant-...) no Worker. ' +
      (names.length ? `Variaveis que o Worker ve: ${names.join(', ')}.` : 'O Worker nao ve nenhuma variavel/segredo.') +
      ' Confirma em Settings -> Variables and Secrets e faz Deploy.', 500);
  }
  const item = await request.json().catch(() => null);
  if (!item) throw new HttpError('JSON invalido');
  const name = String(item.name || '').slice(0, 200).trim();
  const price = Number(item.price);
  if (!name || !isFinite(price)) throw new HttpError('Faltam name/price');
  const currency = String(item.currency || 'EUR').slice(0, 5);
  const store = String(item.store || '').slice(0, 80);
  const country = /^[A-Z]{2}$/.test(item.country || '') ? item.country : 'PT';

  const cacheKey = new Request('https://deal-cache.local/' + encodeURIComponent(`${name}|${price}|${country}`.toLowerCase()));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, cors);

  // limite diario (so conta pedidos que vao mesmo a API)
  const dayKey = `deals:${today()}`;
  let used = 0;
  if (env.CRAWLER_KV) {
    used = Number(await env.CRAWLER_KV.get(dayKey)) || 0;
    if (used >= DEAL_DAILY_LIMIT) {
      throw new HttpError(`Limite diario de ${DEAL_DAILY_LIMIT} avaliacoes atingido. Volta amanha (ou aumenta DEAL_DAILY_LIMIT no Worker).`, 429);
    }
  }

  const h = item.history && typeof item.history === 'object' ? item.history : null;
  const others = Array.isArray(item.otherStores) ? item.otherStores.slice(0, 3) : [];
  const prompt =
    `Product: "${name}"\n` +
    `Price found: ${price} ${currency}` + (item.oldPrice ? ` (store says previous price ${item.oldPrice} ${currency})` : '') +
    (store ? `\nStore: ${store}` : '') +
    (item.ean ? `\nEAN: ${String(item.ean).replace(/\D/g, '')}` : '') +
    (h && h.points > 1 ? `\nOur own price tracking at this store since ${h.since}: min ${h.min}, max ${h.max} (${h.points} observations).` : '') +
    (others.length ? `\nWe also saw it at: ${others.map((o) => `${o.store} ${o.price} (${o.date})`).join('; ')}.` : '') +
    `\nBuyer country: ${country}\n\n` +
    'Search the web to judge whether this is a good deal. Find: the typical current price in other ' +
    'shops in this country/EU, the lowest current price you can find, and the official launch/retail ' +
    'price (RRP) if it exists (e.g. for LEGO sets use the set number). Prefer price comparison sites ' +
    'and official stores. When done searching, write your final answer as plain text (do NOT call any ' +
    'tool named json or any other tool for the answer) containing ONLY one JSON object:\n' +
    '{"verdict":"bom"|"razoavel"|"caro"|"incerto","score":0-100,"typicalPrice":number|null,' +
    '"lowestPrice":number|null,"rrp":number|null,"currency":"EUR","summary":"1-2 short sentences in ' +
    'European Portuguese explaining the verdict with the numbers","sources":[{"title":"...","url":"..."}]}\n' +
    'score: 100 = exceptional deal, 50 = normal price, 0 = clearly overpriced. Use "incerto" if you ' +
    'could not find reliable comparable prices or you are not sure it is the same product.';

  let out;
  try {
    out = await askProvider(provider, prompt, country);
  } catch (e) {
    const err = new HttpError(`${provider.name}: ${e.message}`, e.retryAfter ? 429 : 502);
    if (e.retryAfter) err.retryAfter = Math.min(120, Math.ceil(e.retryAfter));
    throw err;
  }
  const text = out.text || '';
  let result = extractVerdict(text) || { verdict: 'incerto', score: null, summary: cleanText(text).slice(-400) };
  if (result.summary) result.summary = cleanText(String(result.summary));
  if (!Array.isArray(result.sources) || !result.sources.length) result.sources = (out.sources || []).slice(0, 4);
  result.sources = result.sources.filter((x) => /^https?:\/\//i.test(x?.url || '')).slice(0, 5);
  result.checkedAt = new Date().toISOString();
  result.searches = out.searches ?? null;
  result.provider = provider.name + (out.model ? ` (${out.model})` : '');

  if (env.CRAWLER_KV) ctx.waitUntil(env.CRAWLER_KV.put(dayKey, String(used + 1), { expirationTtl: 2 * 86400 }));
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${DEAL_CACHE_SECONDS}` },
  })));
  return json(result, 200, cors);
}

async function askProvider(p, prompt, country) {
  if (p.name === 'groq') return askGroq(p.key, prompt);
  if (p.name === 'xai') return askXai(p.key, prompt);
  return askAnthropic(p.key, prompt, country);
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

function collectSources(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || out.length > 20) return out;
  if (Array.isArray(node)) { node.forEach((n) => collectSources(n, out, seen)); return out; }
  if (typeof node.url === 'string' && /^https?:/.test(node.url) && !seen.has(node.url)) {
    seen.add(node.url);
    out.push({ title: node.title || node.url, url: node.url });
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectSources(v, out, seen);
  return out;
}

async function askGroq(key, prompt) {
  let lastErr, rateErr;
  for (const model of MODELS.groq) {
    const compound = model.startsWith('groq/');
    // os modelos gpt-oss as vezes "inventam" uma ferramenta (ex. 'json') e a Groq rejeita o pedido:
    // repete o mesmo modelo ate 2 vezes e depois passa ao seguinte
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = { model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: 2500 };
      if (!compound) {
        body.tools = [{ type: 'browser_search' }];
        // na repeticao, deixa o modelo escolher: menos tentativas de chamar ferramentas inexistentes
        body.tool_choice = attempt === 0 ? 'required' : 'auto';
        body.reasoning_effort = 'low';
      }
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.error?.message || `HTTP ${res.status}`;
        lastErr = new Error(`${model}: ${msg}`);
        if (res.status === 404 || /does not exist|access|not found|decommission|not supported/i.test(msg)) break;
        const toolGlitch = data?.error?.code === 'tool_use_failed' || /tool call validation|failed to call a function|not in request\.tools|tool_use_failed/i.test(msg);
        if (toolGlitch && attempt < 2) continue;
        if (res.status === 429 || /rate limit|tokens per minute|requests per minute/i.test(msg)) {
          // limite por minuto do plano gratuito: guarda a mensagem (diz quanto esperar) e tenta outro modelo
          rateErr = rateErr || new Error(`Limite de pedidos da Groq por minuto: ${msg}`);
          rateErr.retryAfter = +(res.headers.get('retry-after') || (msg.match(/try again in ([\d.]+)s/i) || [])[1] || 20);
          break;
        }
        if (toolGlitch || res.status >= 500) break;   // tenta o modelo seguinte
        throw lastErr;
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      const tools = msg.executed_tools || [];
      const text = msg.content || '';
      const urls = [...new Set((text.match(/https?:\/\/[^\s)\]"'<>]+/g) || []))].map((u) => ({ title: u, url: u }));
      return { text, sources: [...collectSources(tools), ...urls].slice(0, 6), searches: tools.length || null, model };
    }
  }
  throw rateErr || lastErr || new Error('Nenhum modelo Groq disponivel');
}

async function askXai(key, prompt) {
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODELS.xai, input: prompt, tools: [{ type: 'web_search' }], max_turns: DEAL_MAX_SEARCHES + 1 }),
  });
  const data = await readJson(res);
  let text = data.output_text || '';
  if (!text) for (const item of data.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) text += c.text;
  const searches = (data.output || []).filter((i) => /search/i.test(i.type || '')).length || null;
  return { text, sources: collectSources(data.output || data.citations || []).slice(0, 6), searches };
}

async function askAnthropic(key, prompt, country) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELS.anthropic, max_tokens: 1200, messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEAL_MAX_SEARCHES, user_location: { type: 'approximate', country } }],
    }),
  });
  const data = await readJson(res);
  const blocks = data.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const sources = collectSources(blocks.filter((b) => b.type === 'web_search_tool_result')).slice(0, 6);
  return { text, sources, searches: data.usage?.server_tool_use?.web_search_requests ?? null };
}

// remove marcas de citacao (parenteses especiais U+3010/U+3011) e espacos a mais
function cleanText(s) {
  return s.replace(/\u3010[^\u3011]*\u3011/g, '').replace(/\s+/g, ' ').trim();
}

// encontra o ULTIMO objeto JSON com "verdict" (chavetas equilibradas) e faz parse
function extractVerdict(text) {
  if (!text) return null;
  const idxs = [];
  let i = -1;
  while ((i = text.indexOf('"verdict"', i + 1)) !== -1) idxs.push(i);
  for (const at of idxs.reverse()) {
    let start = text.lastIndexOf('{', at);
    while (start !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { const o = JSON.parse(cleanText(text.slice(start, j + 1))); if (o && o.verdict) return o; } catch {}
          break;
        }
      }
      start = text.lastIndexOf('{', start - 1);
      if (start !== -1 && at - start > 4000) break;
    }
  }
  return null;
}
