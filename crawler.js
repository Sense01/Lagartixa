import { chromium } from 'playwright';
import robotsParser from 'robots-parser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = /\.(pdf|jpe?g|png|gif|svg|zip|mp4|mp3|css|js)(\?|$)/i;

async function ensureCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__cursor')) return;
    const c = document.createElement('div');
    c.id = '__cursor';
    c.style.cssText =
      'position:fixed;z-index:2147483647;width:22px;height:22px;border-radius:50%;' +
      'background:rgba(255,60,60,.85);border:2px solid #fff;pointer-events:none;' +
      'transition:all .6s ease;left:60px;top:60px;box-shadow:0 0 14px red';
    document.body.appendChild(c);
  });
}

async function moveCursor(page, x, y) {
  await page.evaluate(([x, y]) => {
    const c = document.getElementById('__cursor');
    if (c) { c.style.left = x + 'px'; c.style.top = y + 'px'; }
  }, [x, y]);
  await sleep(700);
}

// Procura as palavras-chave na página e destaca-as a amarelo
async function scan(page, keywords) {
  return page.evaluate((kws) => {
    const out = [], ranges = [];
    const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = w.nextNode())) {
      const tag = n.parentElement?.tagName;
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(tag)) continue;
      const t = n.nodeValue.toLowerCase();
      for (const k of kws) {
        const kl = k.toLowerCase();
        let i = t.indexOf(kl);
        while (i !== -1) {
          const r = new Range();
          r.setStart(n, i); r.setEnd(n, i + kl.length);
          ranges.push(r);
          if (out.length < 30)
            out.push({ keyword: k, snippet: n.nodeValue.slice(Math.max(0, i - 60), i + kl.length + 60).trim() });
          i = t.indexOf(kl, i + kl.length);
        }
      }
    }
    if (ranges.length && window.CSS?.highlights) {
      const st = document.createElement('style');
      st.textContent = '::highlight(hit){background:#ffeb3b;color:#000}';
      document.head.appendChild(st);
      CSS.highlights.set('hit', new Highlight(...ranges));
      ranges[0].startContainer.parentElement?.scrollIntoView({ block: 'center' });
    }
    return out;
  }, keywords);
}

async function scrollDown(page) {
  for (let i = 0; i < 5; i++) {
    const atEnd = await page.evaluate(() => {
      window.scrollBy({ top: 350, behavior: 'smooth' });
      return window.innerHeight + window.scrollY >= document.body.scrollHeight - 5;
    });
    await moveCursor(page, 200 + Math.random() * 600, 150 + Math.random() * 400);
    if (atEnd) break;
  }
}

export async function crawl({ keywords, sites, maxPages = 10, delay = 1000 }, emit, signal) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 } });
  const results = [];
  let visited = 0;

  // Envia capturas de ecrã continuamente -> é isto que cria a "animação" na UI
  const frames = setInterval(async () => {
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 55 });
      emit({ type: 'frame', data: buf.toString('base64') });
    } catch {}
  }, 250);

  try {
    for (const site of sites) {
      if (signal.aborted) break;
      const origin = new URL(site).origin;
      let robots = null;
      try {
        const txt = await (await fetch(origin + '/robots.txt')).text();
        robots = robotsParser(origin + '/robots.txt', txt);
      } catch {}

      const queue = [site], seen = new Set();
      let count = 0;
      emit({ type: 'status', message: `A começar em ${site}` });

      while (queue.length && count < maxPages && !signal.aborted) {
        const url = queue.shift();
        if (seen.has(url)) continue;
        seen.add(url);
        if (robots && robots.isAllowed(url, 'WebCrawlerApp') === false) continue;

        try {
          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        } catch {
          emit({ type: 'status', message: `Falhou: ${url}` });
          continue;
        }
        count++; visited++;
        emit({ type: 'visit', url, title: await page.title(), visited });

        await ensureCursor(page);
        const matches = await scan(page, keywords);
        if (matches.length) {
          const hit = { url, title: await page.title(), matches };
          results.push(hit);
          emit({ type: 'hit', ...hit });
        }
        await scrollDown(page);

        const links = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
        for (const l of links) {
          try {
            const u = new URL(l);
            u.hash = '';
            if (u.origin === origin && /^https?:/.test(u.protocol) && !SKIP.test(u.href) && !seen.has(u.href))
              queue.push(u.href);
          } catch {}
        }

        // Move o cursor até ao próximo link antes de navegar
        const next = queue[0];
        if (next) {
          const pos = await page.evaluate((href) => {
            const a = [...document.querySelectorAll('a[href]')].find((a) => a.href.split('#')[0] === href);
            if (!a) return null;
            a.scrollIntoView({ block: 'center' });
            const r = a.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }, next);
          if (pos) await moveCursor(page, pos.x, pos.y);
        }
        await sleep(delay);
      }
    }
  } finally {
    clearInterval(frames);
    await browser.close();
  }
  return { results, visited, stopped: signal.aborted };
}
