import { chromium } from 'playwright';
import robotsParser from 'robots-parser';
import { sleep, norm, SKIP, JUNK, cleanUrl, urlScore } from './util.js';
import { ensureCursor, moveCursor, setFast } from './spider.js';
import { dismissConsent } from './consent.js';
import { analyzePage, pageMeta } from './scan.js';
import { sitemapUrls } from './sitemap.js';

const UA = 'WebCrawlerApp';

async function scrollDown(page, steps) { // com a aranha
  for (let i = 0; i < steps; i++) {
    const end = await page.evaluate(() => {
      window.scrollBy({ top: 450, behavior: 'smooth' });
      return innerHeight + scrollY >= document.body.scrollHeight - 5;
    });
    await moveCursor(page, 200 + Math.random() * 600, 150 + Math.random() * 400);
    if (end) break;
  }
}

async function autoScroll(page, steps) { // sem animação, só para carregar conteúdo "lazy"
  for (let i = 0; i < steps; i++) {
    const end = await page.evaluate(() => { window.scrollBy(0, innerHeight); return innerHeight + scrollY >= document.body.scrollHeight - 5; });
    await sleep(250);
    if (end) break;
  }
}

/**
 * Motor de pesquisa: N separadores em paralelo, fila global "best-first" com limite de ritmo por site,
 * sitemaps, deduplicação por URL canónico, pontuação de relevância e dados estruturados.
 */
export async function crawl(cfg, emit, signal) {
  const { include, exclude, match, sites, maxPages, maxHits, maxDepth, delay, concurrency, consent, fast, useSitemap, timeLimit } = cfg;
  setFast(fast);
  const t0 = Date.now(), deadline = t0 + timeLimit * 1000;

  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1100, height: 700 }, bypassCSP: true });
  if (fast) await context.route('**/*', (r) => (['image', 'media', 'font'].includes(r.request().resourceType()) ? r.abort() : r.continue()));
  const pages = await Promise.all(Array.from({ length: concurrency }, () => context.newPage()));

  const origins = new Map(), results = [];
  let visited = 0, inflight = 0;
  const queued = () => [...origins.values()].reduce((a, o) => a + o.queue.length, 0);
  const stats = () => ({ visited, queued: queued(), hits: results.length, elapsed: Math.round((Date.now() - t0) / 1000) });
  const stopped = () => signal.aborted || Date.now() > deadline || results.length >= maxHits;
  const pending = () => [...origins.values()].some((o) => o.queue.length && o.taken < maxPages);
  const enqueue = (st, url, score, depth, raw = url) => {
    if (st.known.has(url)) return;
    st.known.add(url);
    st.queue.push({ url, raw, score, depth });
  };

  // Só a 1.ª página (a "animada") é transmitida ao vivo
  const timer = setInterval(async () => {
    try { emit({ type: 'frame', data: (await pages[0].screenshot({ type: 'jpeg', quality: 55 })).toString('base64') }); } catch {}
  }, 250);

  async function initOrigin(origin, siteList) {
    const st = { origin, queue: [], known: new Set(), visited: new Set(), taken: 0, next: 0, robots: null, consentChecks: 0 };
    origins.set(origin, st);
    try {
      const r = await fetch(origin + '/robots.txt', { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': UA } });
      if (r.ok) st.robots = robotsParser(origin + '/robots.txt', await r.text());
    } catch {}
    for (const s of siteList) enqueue(st, cleanUrl(s), 100, 0);
    if (useSitemap) {
      emit({ type: 'status', message: `A ler sitemap de ${origin}…` });
      const seeds = [];
      for (const u of await sitemapUrls(origin, st.robots)) {
        try {
          const href = cleanUrl(u), p = new URL(href);
          if (p.origin !== origin || SKIP.test(href) || JUNK.test(p.pathname)) continue;
          const s = urlScore(href, '', include);
          if (s > 5) seeds.push([href, s]);
        } catch {}
      }
      seeds.sort((a, b) => b[1] - a[1]).slice(0, 300).forEach(([h, s]) => enqueue(st, h, s + 5, 1));
      if (seeds.length) emit({ type: 'status', message: `${Math.min(seeds.length, 300)} páginas relevantes encontradas no sitemap de ${origin}` });
    }
  }

  function take() {
    const now = Date.now();
    let best = null;
    for (const st of origins.values()) {
      if (!st.queue.length || st.taken >= maxPages || now < st.next) continue;
      st.queue.sort((a, b) => b.score - a.score);
      if (!best || st.queue[0].score > best.queue[0].score) best = st;
    }
    if (!best) return null;
    best.taken++; best.next = now + delay; // limite de ritmo por site
    return { st: best, ...best.queue.shift() };
  }

  async function visit({ st, url, depth }, page, animate) {
    if (st.robots && st.robots.isAllowed(url, UA) === false) { st.taken--; return; }
    let resp;
    for (let attempt = 0; attempt < 2 && !resp; attempt++) {
      try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 }); } catch { await sleep(800); }
    }
    if (!resp || resp.status() >= 400 || !/html/i.test(resp.headers()['content-type'] || '')) {
      emit({ type: 'status', message: `Ignorada (${resp ? resp.status() : 'sem resposta'}): ${url}` });
      return;
    }
    await page.waitForLoadState('networkidle', { timeout: 4000 }).catch(() => {});
    const meta = await pageMeta(page);
    const key = meta.canonical ? cleanUrl(meta.canonical) : url;
    if (st.visited.has(key)) return; // mesmo conteúdo com outro URL
    st.visited.add(key); st.visited.add(url);
    visited++;
    emit({ type: 'visit', url, title: await page.title(), ...stats() });

    if (st.consentChecks < 3) { st.consentChecks++; await dismissConsent(page, consent); }
    if (animate) { await ensureCursor(page); await scrollDown(page, fast ? 2 : 5); } else await autoScroll(page, fast ? 2 : 4);

    const a = await analyzePage(page, { include, exclude, highlight: animate });
    const found = include.filter((t) => a.counts[t.label] > 0).length;
    const ok = !a.excluded && found > 0 && (match === 'all' ? found === include.length : true);
    if (ok) {
      const title = norm(a.title), heads = norm(a.headings), u = norm(decodeURI(url));
      let score = 0;
      for (const t of include) {
        const c = a.counts[t.label];
        if (c) score += Math.min(c, 10) + 1 + (title.includes(t.n) ? 15 : 0) + (heads.includes(t.n) ? 8 : 0) + (u.includes(t.n) ? 5 : 0);
      }
      const hit = { url, title: a.title, score, counts: a.counts, matches: a.snippets, description: meta.description, data: meta.data };
      results.push(hit);
      emit({ type: 'hit', ...hit });
    }

    if (depth < maxDepth) {
      const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((x) => ({
        href: x.href, text: (x.innerText || x.getAttribute('aria-label') || '').trim().slice(0, 120) })));
      for (const l of links) {
        try {
          if (!/^https?:/.test(l.href)) continue;
          const href = cleanUrl(l.href), p = new URL(href);
          if (p.origin !== st.origin || SKIP.test(href) || JUNK.test(p.pathname) || st.known.has(href)) continue;
          enqueue(st, href, urlScore(href, l.text, include) + (ok ? 2 : 0), depth + 1, l.href);
        } catch {}
      }
    }

    if (animate) { // a aranha caminha até ao próximo link
      st.queue.sort((x, y) => y.score - x.score);
      const next = st.queue[0]?.raw;
      const pos = next && await page.evaluate((href) => {
        const el = [...document.querySelectorAll('a[href]')].find((x) => x.href === href);
        if (!el) return null;
        el.scrollIntoView({ block: 'center' });
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      }, next);
      if (pos) await moveCursor(page, pos.x, pos.y);
    }
  }

  async function worker(i) {
    while (!stopped()) {
      const job = take();
      if (!job) { if (!inflight && !pending()) break; await sleep(150); continue; }
      inflight++;
      try { await visit(job, pages[i], i === 0); }
      catch (e) { emit({ type: 'status', message: `Erro em ${job.url}: ${e.message.split('\n')[0]}` }); }
      finally { inflight--; }
    }
  }

  try {
    const byOrigin = new Map();
    for (const s of sites) byOrigin.set(new URL(s).origin, [...(byOrigin.get(new URL(s).origin) || []), s]);
    await Promise.all([...byOrigin].map(([o, list]) => initOrigin(o, list)));
    emit({ type: 'status', message: 'A pesquisar…' });
    await Promise.all(pages.map((_, i) => worker(i)));
  } finally {
    clearInterval(timer);
    await browser.close();
  }
  results.sort((a, b) => b.score - a.score);
  const reason = signal.aborted ? 'parado' : results.length >= maxHits ? 'limite de resultados' : Date.now() > deadline ? 'tempo limite' : 'concluído';
  return { results, ...stats(), reason };
}
