export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const SKIP = /\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|mp3|css|js|xml|json)(\?|$)/i;
export const JUNK = /\/(cart|panier|basket|checkout|login|connexion|signin|signup|register|account|compte|mon-compte|logout|privacy|confidentialite|cookies?|legal|mentions-legales|terms|cgv|cgu|contact|newsletter|unsubscribe|wishlist|favoris)(\/|\?|$|-)/i;

// minúsculas e sem acentos, mantendo o comprimento (os índices continuam alinhados com o texto original)
export const norm = (s) => s.split('').map((c) => c.normalize('NFD').toLowerCase().charAt(0)).join('');

export function cleanUrl(href) {
  const u = new URL(href);
  u.hash = '';
  for (const k of [...u.searchParams.keys()]) if (/^(utm_|fbclid|gclid|mc_|ref$)/i.test(k)) u.searchParams.delete(k);
  return u.href;
}

// "Parkside, estágio, -usado" -> termos a incluir e a excluir
export function parseTerms(list) {
  const include = [], exclude = [], seen = new Set();
  for (const raw of list) {
    let t = String(raw).trim();
    const neg = t.length > 1 && t.startsWith('-');
    if (neg) t = t.slice(1).trim();
    const n = norm(t);
    if (!/[\p{L}\p{N}]/u.test(n) || seen.has((neg ? '-' : '') + n)) continue;
    seen.add((neg ? '-' : '') + n);
    (neg ? exclude : include).push({ label: t, n });
  }
  return { include, exclude };
}

// Relevância de um link: palavras-chave no texto/URL, paginação, e preferência por URLs mais curtas
export function urlScore(href, text, include) {
  let dec = href;
  try { dec = decodeURIComponent(href); } catch {}
  const t = norm(`${text} ${dec}`);
  let s = 0;
  for (const k of include) if (t.includes(k.n)) s += 10;
  if (/[?&](page|p)=\d+|\/page\/\d+/i.test(href)) s += 3;
  return s - Math.min(new URL(href).pathname.split('/').length, 10) * 0.1;
}
