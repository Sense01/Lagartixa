// Testes do Worker (Node 18+):  node tests/worker.test.mjs
// Carrega worker/cloudflare-worker.js com fetch/KV/cache simulados.
import fs from 'fs';
import { webcrypto as wc } from 'crypto';
import path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const subtle = wc.subtle;
let passed = 0, failed = 0;
function ok(cond, name, extra = '') {
  if (cond) { passed++; console.log('  ✓', name); }
  else { failed++; console.log('  ✗', name, extra); }
}

/* ---------- ambiente simulado ---------- */
const routes = [];          // [{ match: fn(url, opts), reply: fn(url, opts) }]
const calls = [];
globalThis.fetch = async (url, opts = {}) => {
  url = String(url);
  calls.push({ url, opts });
  for (const r of routes) if (r.match(url, opts)) return r.reply(url, opts);
  return new Response('not found', { status: 404 });
};
globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };

function makeKV(init = {}) {
  const m = new Map(Object.entries(init).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  return {
    m,
    async get(k, type) { const v = m.get(k); if (v == null) return null; return type === 'json' ? JSON.parse(v) : v; },
    async put(k, v) { m.set(k, v); },
  };
}

let src = fs.readFileSync(path.join(ROOT, 'worker/cloudflare-worker.js'), 'utf8').replace('export default', 'globalThis.W =');
src += '\nglobalThis.__T = { encryptPayload, vapidAuth, runMonitor, getVapid, LiteX, extractVerdict };';
(0, eval)(src);
const { encryptPayload, vapidAuth, runMonitor, LiteX } = globalThis.__T;

const ORIGIN = 'https://sense01.github.io';
const waitCtx = { waitUntil: (p) => p };
const req = (p, { method = 'GET', body, origin = ORIGIN } = {}) =>
  new Request('https://w.dev' + p, { method, headers: origin ? { Origin: origin, 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });

/* ---------- utilitários de push (lado do "telemóvel") ---------- */
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(s, 'base64url'));
async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}
const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };
const te = new TextEncoder();

async function makeDevice() {
  const pair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
  const auth = wc.getRandomValues(new Uint8Array(16));
  return { pair, pub, auth, sub: { endpoint: 'https://push.example/abc123', keys: { p256dh: b64u(pub), auth: b64u(auth) } } };
}

// RFC 8291 - desencriptar como o browser faria
async function decryptPush(dev, body) {
  body = new Uint8Array(body);
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const asPub = body.slice(21, 21 + idlen);
  const cipher = body.slice(21 + idlen);
  const asKey = await subtle.importKey('raw', asPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: asKey }, dev.pair.privateKey, 256));
  const prkKey = await hmac(dev.auth, shared);
  const ikm = await hmac(prkKey, cat(te.encode('WebPush: info\0'), dev.pub, asPub, new Uint8Array([1])));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(te.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(te.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, cipher));
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (plain[end] !== 2) throw new Error('padding invalido');
  return JSON.parse(new TextDecoder().decode(plain.slice(0, end)));
}

/* ======================================================================== */
console.log('\nPush (RFC 8291 + VAPID)');
{
  const dev = await makeDevice();
  const body = await encryptPayload(dev.sub, JSON.stringify({ title: 'Teste ↓', body: 'olá' }));
  const msg = await decryptPush(dev, body);
  ok(msg.title === 'Teste ↓' && msg.body === 'olá', 'mensagem encriptada e desencriptada corretamente');

  const kvs = makeKV();
  const env = { CRAWLER_KV: kvs };
  const r = await W.fetch(req('/push/key'), env, waitCtx);
  const { publicKey } = await r.json();
  ok(unb64u(publicKey).length === 65, 'chave VAPID publica gerada (65 bytes) e guardada no KV');
  const vapid = JSON.parse(kvs.m.get('vapid'));
  const auth = await vapidAuth(dev.sub.endpoint, vapid);
  const [, jwt, k] = auth.match(/^vapid t=([^,]+), k=(.+)$/);
  const [h, c, s] = jwt.split('.');
  const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
  const pubKey = await subtle.importKey('raw', unb64u(k), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const valid = await subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pubKey, unb64u(s), te.encode(`${h}.${c}`));
  ok(valid, 'assinatura VAPID (ES256) valida');
  ok(claims.aud === 'https://push.example' && claims.exp > Date.now() / 1000, 'claims VAPID (aud/exp) corretos');
}

/* ======================================================================== */
console.log('\nRotas e seguranca');
{
  const r1 = await W.fetch(req('/state', { origin: '' }), { CRAWLER_KV: makeKV() }, waitCtx);
  ok(r1.status === 403, '/state sem Origin e recusado');
  const r2 = await W.fetch(req('/state', { origin: 'https://evil.example' }), { CRAWLER_KV: makeKV() }, waitCtx);
  ok(r2.status === 403, '/state de outra origem e recusado');
  const r3 = await W.fetch(req('/state'), {}, waitCtx);
  const j3 = await r3.json();
  ok(r3.status === 500 && /CRAWLER_KV/.test(j3.error) && /Bindings/.test(j3.setup), 'sem KV: erro claro com instrucoes');
  const r4 = await W.fetch(req('/state'), { CRAWLER_KV: makeKV() }, waitCtx);
  ok(r4.status === 200, '/state com KV responde 200');
}

/* ======================================================================== */
console.log('\nAvaliacao de negocio');
{
  routes.length = 0;
  let sentPrompt = '';
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    sentPrompt = JSON.parse(o.body).messages[0].content;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'excertos {"x":1}\n{"verdict":"bom","score":80,"typicalPrice":12.49,"lowestPrice":8.91,"rrp":14.99,"summary":"Bom preço 【1†L2】.","sources":[]}' } }] }));
  } });
  const kvs = makeKV();
  const env = { CRAWLER_KV: kvs, QUALQUER_NOME: 'gsk_test' };
  const body = { name: 'LEGO Rosas 40460', price: 8.91, history: { min: 9.5, max: 12, points: 4, since: '2026-10-01' }, otherStores: [{ store: 'fnac.pt', price: 11.99, date: '2026-11-08' }] };
  const r = await W.fetch(req('/deal', { method: 'POST', body }), env, waitCtx);
  const j = await r.json();
  ok(r.status === 200 && j.verdict === 'bom' && j.score === 80, 'veredicto extraido da resposta da IA');
  ok(!/【/.test(j.summary), 'marcas de citacao removidas do resumo');
  ok(/Our own price tracking/.test(sentPrompt) && /fnac\.pt 11\.99/.test(sentPrompt), 'historico proprio e outras lojas enviados no pedido');
  ok(kvs.m.get(`deals:${new Date().toISOString().slice(0, 10)}`) === '1', 'contador diario incrementado');
  // a Groq rejeita o pedido quando o modelo tenta chamar uma ferramenta inexistente ('json'): repetir
  let groqCalls = 0, choices = [];
  routes.length = 0;
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    groqCalls++; choices.push(JSON.parse(o.body).tool_choice);
    if (groqCalls === 1) return new Response(JSON.stringify({ error: { message: "tool call validation failed: attempted to call tool 'json' which was not in request.tools", code: 'tool_use_failed' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"razoavel","score":55,"summary":"Preco normal.","sources":[]}' } }] }));
  } });
  const rg = await W.fetch(req('/deal', { method: 'POST', body: { ...body, name: 'Snapmaker U1', price: 699 } }), env, waitCtx);
  const jg = await rg.json();
  ok(rg.status === 200 && jg.verdict === 'razoavel' && groqCalls === 2 && choices[1] === 'auto', "erro 'tool json' da Groq: repete e responde", JSON.stringify({ s: rg.status, groqCalls, choices }));
  groqCalls = 0;
  routes.length = 0;
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    groqCalls++;
    const m = JSON.parse(o.body).model;
    if (m === 'openai/gpt-oss-120b') return new Response(JSON.stringify({ error: { message: "tool call validation failed: attempted to call tool 'json'", code: 'tool_use_failed' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"bom","score":70,"summary":"Ok.","sources":[]}' } }] }));
  } });
  const rh = await W.fetch(req('/deal', { method: 'POST', body: { ...body, name: 'Snapmaker U1 B', price: 698 } }), env, waitCtx);
  const jh = await rh.json();
  ok(rh.status === 200 && jh.verdict === 'bom' && groqCalls === 4, 'se o erro persistir, passa ao modelo seguinte', JSON.stringify({ s: rh.status, groqCalls, e: jh.error }));
  // limite por minuto da Groq: o Worker devolve 429 com o tempo de espera (e nao a mensagem do ultimo modelo)
  routes.length = 0;
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    const m = JSON.parse(o.body).model;
    if (m === 'groq/compound-mini') return new Response(JSON.stringify({ error: { message: 'The model `groq/compound-mini` does not exist or you do not have access to it.' } }), { status: 404 });
    return new Response(JSON.stringify({ error: { message: 'Rate limit reached for model openai/gpt-oss-120b on tokens per minute (TPM). Please try again in 14.2s.' } }), { status: 429 });
  } });
  const rr = await W.fetch(req('/deal', { method: 'POST', body: { ...body, name: 'Produto limite', price: 5 } }), env, waitCtx);
  const jr = await rr.json();
  ok(rr.status === 429 && jr.retryAfter === 15 && /Limite de pedidos/.test(jr.error), 'limite por minuto: 429 com "espera 15 s" (nao o erro do ultimo modelo)', JSON.stringify({ s: rr.status, jr }));
  kvs.m.set(`deals:${new Date().toISOString().slice(0, 10)}`, '60');
  const r2 = await W.fetch(req('/deal', { method: 'POST', body: { ...body, price: 9.99 } }), env, waitCtx);
  ok(r2.status === 429 && /Limite diario/.test((await r2.json()).error), 'limite diario devolve 429 com mensagem clara');
}

/* ======================================================================== */
console.log('\nVerificacao automatica (Cron)');
{
  const dev = await makeDevice();
  const pushes = [];
  let productPrice = '24.90', listing = 1;
  const tile = (id, name, price, old) => `<div class="product" data-pid="${id}"><div class="product-tile"><a href="/p/${id}.html"><img src="/i/${id}.jpg" alt="${name}"></a><div class="pdp-link"><a class="link" href="/p/${id}.html">${name}</a></div><div class="price">${old ? `<span class="strike-through"><span class="value" content="${old}">${old} €</span></span>` : ''}<span class="sales"><span class="value" content="${price}">${price} €</span></span></div></div></div>`;
  routes.length = 0;
  routes.push({ match: (u) => u.endsWith('/robots.txt'), reply: () => new Response('User-agent: *\nDisallow: /privado\n') });
  routes.push({ match: (u) => u.includes('/p/seguido'), reply: () => new Response(`<html><head><script type="application/ld+json">{"@type":"Product","name":"Ventoinha Noctua","offers":{"price":"${productPrice}","availability":"https://schema.org/InStock"}}</script></head></html>`) });
  routes.push({ match: (u) => u.includes('/componentes/ventoinhas'), reply: () => new Response(`<div class="grid">${tile('A', 'Ventoinha Arctic P12', '5.90', '9.90')}${tile('B', 'Pasta termica', '3.00')}${listing > 1 ? tile('C', 'Ventoinha Lian Li Novidade', '19.90') : ''}</div>`) });
  routes.push({ match: (u) => u.includes('/privado'), reply: () => new Response('nao devia ser pedido') });
  routes.push({ match: (u) => u.startsWith('https://push.example'), reply: (u, o) => { pushes.push(o); return new Response('', { status: 201 }); } });

  const kvs = makeKV({ subs: [dev.sub] });
  const env = { CRAWLER_KV: kvs };
  const sync = await W.fetch(req('/sync', { method: 'POST', body: {
    watch: [{ key: 'loja.pt/p/seguido', url: 'https://loja.pt/p/seguido', name: 'Ventoinha Noctua', store: 'loja.pt', price: 29.9, target: 25 }],
    searches: [
      { id: 's1', name: 'Ventoinhas', config: { sites: 'https://loja.pt/componentes/ventoinhas', keywords: 'Ventoinha', maxPrice: '30' } },
      { id: 's2', name: 'Privado', config: { sites: 'https://loja.pt/privado/lista', keywords: '' } },
    ],
  } }), env, waitCtx);
  ok(sync.status === 200, '/sync guarda seguidos e pesquisas');

  const run1 = await runMonitor(env, { reason: 'cron' });
  const kinds1 = run1.alerts.map((a) => a.kind).sort().join(',');
  ok(kinds1 === 'drop,target', 'descida + preco-alvo detetados no produto seguido', kinds1);
  ok(!calls.some((c) => c.url.includes('/privado/lista')), 'robots.txt respeitado (pagina proibida nao foi pedida)');
  ok(pushes.length === 2, '2 notificacoes push enviadas', `(${pushes.length})`);
  const msg = await decryptPush(dev, pushes[0].body);
  ok(/Ventoinha Noctua/.test(msg.title) && /24,90/.test(msg.body), 'conteudo da notificacao correto e legivel no aparelho', JSON.stringify(msg));
  ok(pushes[0].headers['Content-Encoding'] === 'aes128gcm' && /^vapid t=/.test(pushes[0].headers.Authorization), 'cabecalhos Web Push corretos');
  ok(run1.state.cron === true && run1.state.lastRun, 'estado do cron guardado');

  pushes.length = 0;
  listing = 2; productPrice = '24.90';
  const run2 = await runMonitor(env, { reason: 'cron' });
  const kinds2 = run2.alerts.map((a) => a.kind).join(',');
  ok(kinds2 === 'new' && /Lian Li/.test(run2.alerts[0].body), 'produto novo na pesquisa gera alerta (e sem repetir a descida)', kinds2);
  ok(!run2.alerts.some((a) => /Pasta/.test(a.body)), 'filtro de palavras-chave aplicado (pasta termica ignorada)');

  // aparelho que deixou de existir e removido
  routes.unshift({ match: (u) => u.startsWith('https://push.example'), reply: () => new Response('', { status: 410 }) });
  productPrice = '19.90';
  await runMonitor(env, { reason: 'cron' });
  ok(JSON.parse(kvs.m.get('subs')).length === 0, 'subscricao expirada (410) removida');
}

/* ======================================================================== */
console.log('\nHistorico de todas as pesquisas e alertas abaixo da media');
{
  const dev = await makeDevice();
  const pushes = [];
  const tile = (id, name, price, old) => `<div class="product"><div class="product-tile"><a href="/p/${id}.html"><img src="/i/${id}.jpg" alt="${name}"></a><div class="pdp-link"><a class="link" href="/p/${id}.html">${name}</a></div><div class="price">${old ? `<span class="strike-through"><span class="value" content="${old}">${old} €</span></span>` : ''}<span class="sales"><span class="value" content="${price}">${price} €</span></span></div></div></div>`;
  let lojaA = [tile('m1', 'Monitor AOC 27B36X', '120.00'), tile('m0', 'Monitor Philips 27E2N1500L', '130.00')];
  let lojaB = [tile('x1', 'MONITOR LED AOC 27B36X', '119.00'), tile('x2', 'MONITOR LED PHILIPS 27E2N1500L/00', '128.00')];
  routes.length = 0;
  routes.push({ match: (u) => u.endsWith('/robots.txt'), reply: () => new Response('User-agent: *\nAllow: /\n') });
  routes.push({ match: (u) => u.startsWith('https://loja-a.pt/monitores'), reply: () => new Response(`<div class="grid">${lojaA.join('')}</div>`) });
  routes.push({ match: (u) => u.startsWith('https://loja-b.pt/monitores'), reply: () => new Response(`<div class="grid">${lojaB.join('')}</div>`) });
  routes.push({ match: (u) => u.startsWith('https://push.example'), reply: (u, o) => { pushes.push(o); return new Response('', { status: 201 }); } });
  const kvs = makeKV({ subs: [dev.sub] });
  const env = { CRAWLER_KV: kvs };
  await W.fetch(req('/sync', { method: 'POST', body: { watch: [], alertMinBelow: 15, searches: [
    { id: 'a', name: 'Monitores A', config: { sites: 'https://loja-a.pt/monitores', keywords: 'monitor' } },
    { id: 'b', name: 'Monitores B', config: { sites: 'https://loja-b.pt/monitores', keywords: 'monitor' } },
  ] } }), env, waitCtx);
  await runMonitor(env, { reason: 'cron' });          // primeira vez: so regista
  let st = JSON.parse(kvs.m.get('state'));
  const ids = Object.values(st.hist).map((e) => e.id);
  ok(Object.keys(st.hist).length === 4 && ids.filter((x) => x === 'model:aoc:27b36x').length === 2 && ids.filter((x) => x === 'model:philips:27e2n1500l').length === 2, 'historico guardado para todos os produtos das pesquisas (com o modelo reconhecido nas 2 lojas)', JSON.stringify(ids));
  // novo produto barato na loja A (o mesmo modelo noutra loja custa 119) e outro sem referencia
  lojaA = [tile('m1', 'Monitor AOC 27B36X', '120.00'), tile('m0', 'Monitor Philips 27E2N1500L', '130.00'), tile('m2', 'Monitor AOC 27B36X Recondicionado', '79.00'), tile('m3', 'Monitor Generico XPTO', '50.00')];
  const run = await runMonitor(env, { reason: 'cron' });
  const bodies = run.alerts.map((a) => a.body);
  ok(run.alerts.length === 1 && /34% abaixo da media de 1 loja/.test(bodies[0]), 'alerta so para o que esta >= 15% abaixo da media (o sem referencia nao avisa)', JSON.stringify(bodies));
  const h = await W.fetch(req('/history'), env, waitCtx);
  const hj = await h.json();
  ok(h.status === 200 && hj.count === 6 && Object.values(hj.items).every((e) => e.h.length >= 1), '/history devolve o historico para a app', hj.count);
  ok((await W.fetch(req('/history', { origin: 'https://outro.site' }), env, waitCtx)).status === 403, '/history so responde a tua app');
}

/* ======================================================================== */
console.log('\nExtrator leve (partilhado com a app)');
{
  const html = `<ul class="products"><li class="product-miniature"><a href="/p/1.html"><img src="/a.jpg"></a><h3 class="product-title"><a href="/p/1.html">LEGO Rosas (40460)</a></h3><span class="regular-price">14,99 €</span><span class="price">8,91 €</span><span>Esgotado</span></li><li class="product-miniature"><a href="/p/2.html"><img src="/b.jpg"></a><h3 class="product-title"><a href="/p/2.html">LEGO Orquidea (10343)</a></h3><span class="price">19,50 €</span></li></ul>`;
  const items = LiteX.listingFromHtml(html, 'https://loja.pt/lego');
  ok(items.length === 2 && items[0].price === 8.91 && items[0].oldPrice === 14.99 && items[0].availability === 'out', 'lista simples: preco, preco antigo e stock', JSON.stringify(items[0]));
  ok(LiteX.matchesFilters(items[1], { keywords: ['orquidea'], maxPrice: 20 }) && !LiteX.matchesFilters(items[1], { maxPrice: 15 }), 'filtros de preco e palavras-chave');
}

console.log(`\n${passed} passaram, ${failed} falharam\n`);
process.exit(failed ? 1 : 0);
