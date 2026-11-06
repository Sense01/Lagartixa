import { chromium } from 'playwright';
import robotsParser from 'robots-parser';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SKIP = /\.(pdf|jpe?g|png|gif|svg|zip|mp4|mp3|css|js)(\?|$)/i;

// Aranha animada (com fio de seda preso ao topo da página) no lugar do cursor
async function ensureCursor(page) {
  await page.evaluate(() => {
    if (document.getElementById('__spider')) return;
    const T = 'left .6s ease, top .6s ease, height .6s ease';
    const thread = document.createElement('div');
    thread.id = '__thread';
    thread.style.cssText =
      'position:fixed;z-index:2147483646;width:2px;left:80px;top:0;height:80px;' +
      'background:#777;box-shadow:0 0 2px #fff;pointer-events:none;transition:' + T;
    const sp = document.createElement('div');
    sp.id = '__spider';
    sp.style.cssText =
      'position:fixed;z-index:2147483647;left:80px;top:80px;width:56px;height:56px;' +
      'margin:-28px 0 0 -28px;pointer-events:none;transition:' + T;
    const leg = (d) => `<path d="${d}"/>`;
    const L = [
      'M-6 -6 Q-18 -22 -26 -20', 'M-7 -2 Q-22 -10 -28 -4',
      'M-7 3 Q-22 8 -28 14', 'M-6 7 Q-16 22 -24 26',
    ];
    const R = L.map((d) => d.replace(/-?\d+(\.\d+)?/g, (n, i, s) => n).replace(/(-?\d+) (-?\d+)/g, (m, a, b) => (-a) + ' ' + b));
    sp.innerHTML =
      '<svg viewBox="-30 -30 60 60" width="56" height="56" style="transition:transform .3s ease">' +
      '<g stroke="#111" stroke-width="2.6" fill="none" stroke-linecap="round">' +
      '<g>' + L.map(leg).join('') +
      '<animateTransform attributeName="transform" type="rotate" values="-5 0 0;5 0 0;-5 0 0" dur=".45s" repeatCount="indefinite"/></g>' +
      '<g>' + R.map(leg).join('') +
      '<animateTransform attributeName="transform" type="rotate" values="5 0 0;-5 0 0;5 0 0" dur=".45s" repeatCount="indefinite"/></g>' +
      '</g>' +
      '<ellipse cx="0" cy="5" rx="9" ry="12" fill="#1c1c1c"/>' +
      '<circle cx="0" cy="-9" r="6" fill="#2b2b2b"/>' +
      '<circle cx="-2.5" cy="-11" r="1.4" fill="#ff3b3b"/><circle cx="2.5" cy="-11" r="1.4" fill="#ff3b3b"/>' +
      '</svg>';
    document.body.append(thread, sp);
  });
}

async function moveCursor(page, x, y) {
  await page.evaluate(([x, y]) => {
    const s = document.getElementById('__spider'), t = document.getElementById('__thread');
    if (!s || !t) return;
    const px = parseFloat(s.dataset.x ?? s.style.left), py = parseFloat(s.dataset.y ?? s.style.top);
    if (Math.hypot(x - px, y - py) > 4)
      s.firstElementChild.style.transform = 'rotate(' + (Math.atan2(y - py, x - px) * 180 / Math.PI + 90) + 'deg)';
    s.style.left = x + 'px'; s.style.top = y + 'px';
    t.style.left = x + 'px'; t.style.height = y + 'px';
    s.dataset.x = x; s.dataset.y = y;
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
  const browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage({ viewport: { width: 1100, height: 700 }, bypassCSP: true });
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
