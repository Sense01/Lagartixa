// Lê sitemaps (robots.txt + /sitemap.xml, incluindo índices) para encontrar páginas relevantes sem ter de as "descobrir" por links
export async function sitemapUrls(origin, robots, limit = 5000) {
  const queue = [...(robots?.getSitemaps?.() || []), origin + '/sitemap.xml'];
  const done = new Set(), urls = [];
  let fetched = 0;
  while (queue.length && fetched < 8 && urls.length < limit) {
    const sm = queue.shift();
    if (done.has(sm) || /\.gz(\?|$)/i.test(sm)) continue;
    done.add(sm); fetched++;
    try {
      const r = await fetch(sm, { signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'WebCrawlerApp' } });
      if (!r.ok) continue;
      const xml = await r.text();
      for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
        const u = m[1].replace(/&amp;/g, '&');
        (/\.xml(\?|$)/i.test(u) ? queue : urls).push(u);
      }
    } catch {}
  }
  return urls.slice(0, limit);
}
