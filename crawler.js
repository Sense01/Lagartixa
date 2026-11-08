/**
 * Crawler BFS que corre no browser.
 * Como o GitHub Pages é estático, os pedidos a outros domínios passam
 * por um proxy CORS (template com o marcador {url}).
 */
class Crawler {
  constructor(opts) {
    this.opts = {
      startUrls: [],          // um ou mais sites
      keywords: [],           // palavras/expressões a procurar
      caseSensitive: false,
      wholeWord: true,
      snippetsPerKeyword: 3,
      maxPages: 50,
      maxDepth: 2,
      concurrency: 3,
      delay: 300,
      proxy: '{url}',
      sameDomain: true,
      respectRobots: true,
      stripQuery: false,
      timeout: 15000,
      ...opts,
    };
    this.queue = [];          // { url, depth, from }
    this.seen = new Set();    // URLs já enfileirados/visitados
    this.results = [];
    this.errors = 0;
    this.running = false;
    this.active = 0;
    this.robotsRules = new Map(); // origin -> [{allow, path}]
    this.controllers = new Set();
    this.keywordTotals = {};      // palavra -> nº total de ocorrências
    this.keywordPages = {};       // palavra -> nº de páginas onde aparece
    this.pagesWithMatches = 0;
    this.matchers = this.buildMatchers();

    // callbacks
    this.onResult = () => {};
    this.onLog = () => {};
    this.onProgress = () => {};
    this.onDone = () => {};
  }

  /* ---------- utilitários ---------- */

  normalize(raw, base) {
    try {
      const u = new URL(raw, base);
      if (!/^https?:$/.test(u.protocol)) return null;
      u.hash = '';
      if (this.opts.stripQuery) u.search = '';
      // remove barra final excepto na raiz
      if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
        u.pathname = u.pathname.slice(0, -1);
      }
      return u.href;
    } catch {
      return null;
    }
  }

  hostKey(url) {
    return new URL(url).hostname.replace(/^www\./, '');
  }

  proxied(url) {
    const tpl = this.opts.proxy || '{url}';
    if (tpl === '{url}') return url;
    return tpl.replace('{url}', encodeURIComponent(url));
  }

  sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  async fetchText(url) {
    const ctrl = new AbortController();
    this.controllers.add(ctrl);
    const timer = setTimeout(() => ctrl.abort(), this.opts.timeout);
    const t0 = performance.now();
    try {
      const res = await fetch(this.proxied(url), { signal: ctrl.signal, redirect: 'follow' });
      const type = res.headers.get('content-type') || '';
      const text = await res.text();
      return { status: res.status, ok: res.ok, type, text, ms: Math.round(performance.now() - t0) };
    } finally {
      clearTimeout(timer);
      this.controllers.delete(ctrl);
    }
  }

  /* ---------- palavras-chave ---------- */

  buildMatchers() {
    const flags = 'gu' + (this.opts.caseSensitive ? '' : 'i');
    const kws = [...new Set(this.opts.keywords.map((k) => k.trim()).filter(Boolean))];
    return kws.map((kw) => {
      // espaços na expressão aceitam qualquer espaço em branco
      let src = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
      if (this.opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
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

  /* ---------- robots.txt ---------- */

  async loadRobots(origin) {
    if (this.robotsRules.has(origin)) return this.robotsRules.get(origin);
    let rules = [];
    try {
      const r = await this.fetchText(origin + '/robots.txt');
      if (r.ok) rules = this.parseRobots(r.text);
      this.onLog(`robots.txt de ${origin}: ${rules.length} regras`);
    } catch {
      this.onLog(`robots.txt de ${origin} indisponível — a continuar sem regras`);
    }
    this.robotsRules.set(origin, rules);
    return rules;
  }

  parseRobots(txt) {
    // Usa só os grupos "User-agent: *"
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
      if ((key === 'allow' || key === 'disallow') && val) {
        rules.push({ allow: key === 'allow', path: val });
      }
    }
    return rules;
  }

  robotsAllows(url, rules) {
    const u = new URL(url);
    const path = u.pathname + u.search;
    let best = null;
    for (const r of rules) {
      const re = new RegExp(
        '^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$')
      );
      if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
    }
    return !best || best.allow;
  }

  /* ---------- parsing ---------- */

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

    const meta = (name) =>
      doc.querySelector(`meta[name="${name}"]`)?.getAttribute('content')?.trim() || '';

    const title = doc.querySelector('title')?.textContent.trim() || '';
    const description = meta('description');

    // texto visível: sem scripts, estilos, etc.
    doc.querySelectorAll('script, style, noscript, template, svg, iframe').forEach((n) => n.remove());
    const bodyText = (doc.body?.textContent || '').replace(/\s+/g, ' ').trim();
    const searchable = [title, description, bodyText].filter(Boolean).join(' · ');
    const kw = this.findKeywords(searchable);

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

    // example.com e www.example.com contam como o mesmo site
    this.startHosts = new Set(starts.map((u) => this.hostKey(u)));
    this.running = true;
    this.onLog(`A iniciar em: ${starts.join(', ')}`);
    if (this.matchers.length) {
      this.onLog(`Palavras-chave: ${this.matchers.map((m) => m.kw).join(', ')}`);
    }
    // os sites iniciais contam sempre, mesmo que excedam maxPages
    for (const s of starts) {
      if (!this.seen.has(s)) {
        this.seen.add(s);
        this.queue.push({ url: s, depth: 0, from: null });
      }
    }

    const workers = Array.from({ length: this.opts.concurrency }, () => this.worker());
    await Promise.all(workers);

    this.running = false;
    this.onLog(`Terminado: ${this.results.length} páginas, ${this.errors} erros`);
    this.onDone(this.results);
  }

  async worker() {
    while (this.running) {
      const job = this.queue.shift();
      if (!job) {
        // fila vazia: termina se ninguém estiver a trabalhar
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
        const origin = new URL(url).origin;
        const rules = await this.loadRobots(origin);
        if (!this.robotsAllows(url, rules)) {
          row.status = 'robots';
          row.error = 'Bloqueado por robots.txt';
          this.push(row);
          return;
        }
      }

      const r = await this.fetchText(url);
      row.status = r.status;
      row.ms = r.ms;
      row.contentType = r.type;

      if (!r.ok) {
        row.error = `HTTP ${r.status}`;
        this.errors++;
      } else if (!r.type || r.type.includes('html')) {
        Object.assign(row, this.parse(r.text, url));
        if (!/nofollow/i.test(row.robotsMeta || '')) {
          for (const link of row.links) this.enqueue(link, depth + 1, url);
        }
      }
    } catch (e) {
      row.status = 'erro';
      row.error = e.name === 'AbortError' ? (this.running ? 'Timeout' : 'Cancelado') : e.message;
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
      keywordTotals: this.keywordTotals,
      keywordPages: this.keywordPages,
    };
  }
}
