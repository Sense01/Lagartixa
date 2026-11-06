// Análise da página dentro do browser: conta ocorrências visíveis, extrai excertos e (opcionalmente) destaca a amarelo
export function analyzePage(page, { include, exclude, highlight }) {
  return page.evaluate(({ include, exclude, highlight }) => {
    const norm = (s) => s.split('').map((c) => c.normalize('NFD').toLowerCase().charAt(0)).join('');
    const counts = {}, snippets = [], ranges = [];
    include.forEach((t) => { counts[t.label] = 0; });
    let excluded = false;
    const empty = { counts, snippets, excluded, headings: '', title: document.title };
    if (!document.body) return empty;
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const p = n.parentElement, raw = n.nodeValue;
      if (!p || raw.length < 2 || ['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE'].includes(p.tagName)) continue;
      const t = norm(raw);
      let vis;
      const visible = () => (vis ??= p.checkVisibility ? p.checkVisibility({ checkVisibilityCSS: true }) : true);
      for (const e of exclude) if (t.includes(e.n) && visible()) excluded = true;
      for (const term of include) {
        let i = t.indexOf(term.n);
        while (i !== -1) {
          if (visible()) {
            counts[term.label]++;
            if (highlight) { const r = new Range(); r.setStart(n, i); r.setEnd(n, i + term.n.length); ranges.push(r); }
            if (snippets.length < 8)
              snippets.push({ keyword: term.label, hit: raw.slice(i, i + term.n.length),
                snippet: raw.slice(Math.max(0, i - 70), i + term.n.length + 70).replace(/\s+/g, ' ').trim() });
          }
          i = t.indexOf(term.n, i + term.n.length);
        }
      }
    }
    if (highlight && ranges.length && window.CSS?.highlights) {
      const st = document.createElement('style');
      st.textContent = '::highlight(hit){background:#ffeb3b;color:#000}';
      document.head.appendChild(st);
      CSS.highlights.set('hit', new Highlight(...ranges));
      ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' });
    }
    const headings = [...document.querySelectorAll('h1,h2,h3')].map((h) => h.innerText).join(' | ').slice(0, 1000);
    return { counts, snippets, excluded, headings, title: document.title };
  }, { include, exclude, highlight });
}

// Metadados e dados estruturados (JSON-LD: produtos, preços, ofertas de emprego...)
export function pageMeta(page) {
  return page.evaluate(() => {
    const m = (s) => document.querySelector(s)?.getAttribute('content') || '';
    const canonical = document.querySelector('link[rel="canonical"]')?.href || '';
    const items = [];
    const walk = (o) => {
      if (!o || typeof o !== 'object') return;
      if (Array.isArray(o)) return o.forEach(walk);
      items.push(o); walk(o['@graph']);
    };
    document.querySelectorAll('script[type="application/ld+json"]').forEach((s) => { try { walk(JSON.parse(s.textContent)); } catch {} });
    const types = ['Product', 'JobPosting', 'Event'];
    const data = items.filter((o) => [].concat(o['@type'] || []).some((t) => types.includes(t))).slice(0, 3).map((o) => {
      const off = [].concat(o.offers || [])[0] || {};
      return {
        type: [].concat(o['@type'])[0], name: o.name || o.title, price: off.price ?? off.lowPrice, currency: off.priceCurrency,
        brand: o.brand?.name || (typeof o.brand === 'string' ? o.brand : undefined), company: o.hiringOrganization?.name,
        location: [].concat(o.jobLocation || [])[0]?.address?.addressLocality, date: o.datePosted || o.startDate,
      };
    });
    return { description: (m('meta[property="og:description"]') || m('meta[name="description"]')).slice(0, 300), canonical, data };
  });
}
