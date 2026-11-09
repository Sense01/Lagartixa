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

if (typeof module !== 'undefined') module.exports = LiteX;
