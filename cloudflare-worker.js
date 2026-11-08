/**
 * Proxy CORS próprio para o Web Crawler — Cloudflare Workers (plano grátis: 100 000 pedidos/dia).
 *
 * Uso: https://<nome>.<conta>.workers.dev/?url=https://site.com/pagina
 * Na app: "O meu proxy" →  https://<nome>.<conta>.workers.dev/?url={url}
 */

// Só a tua app pode usar o proxy (evita que outros gastem a tua quota).
// Troca pelo endereço do teu GitHub Pages. Deixa a lista vazia para permitir qualquer origem.
const ALLOWED_ORIGINS = [
  'https://SEU-UTILIZADOR.github.io',
  'http://localhost:8000',
];

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'fr-FR,fr;q=0.9,pt-PT;q=0.8,pt;q=0.7,en;q=0.6',
};

export default {
  async fetch(request) {
    const origin = request.headers.get('Origin') || '';
    const allowed = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin) || !origin;
    const cors = {
      'Access-Control-Allow-Origin': allowed && origin ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'X-Final-Url',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowed) return new Response('Origem não autorizada', { status: 403, headers: cors });
    if (request.method !== 'GET') return new Response('Só GET', { status: 405, headers: cors });

    const target = new URL(request.url).searchParams.get('url');
    if (!target || !/^https?:\/\//i.test(target)) {
      return new Response('Use ?url=https://…', { status: 400, headers: cors });
    }

    try {
      const res = await fetch(target, {
        headers: BROWSER_HEADERS,
        redirect: 'follow',
        cf: { cacheTtl: 120, cacheEverything: false },
      });
      const headers = new Headers(res.headers);
      for (const h of ['content-security-policy', 'set-cookie', 'x-frame-options', 'content-encoding', 'content-length']) {
        headers.delete(h);
      }
      Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
      headers.set('X-Final-Url', res.url);
      return new Response(res.body, { status: res.status, headers });
    } catch (e) {
      return new Response(`Erro ao contactar o site: ${e.message}`, { status: 502, headers: cors });
    }
  },
};
