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
    return new Response(JSON.stringify({ choices: [{ message: { content: 'excertos {"x":1}\n{"verdict":"bom","score":80,"prices":[{"store":"Fnac","price":12.49,"url":"https://www.fnac.pt/lego-rosas"},{"store":"Worten","price":11.99,"url":"https://www.worten.pt/p/rosas"}],"typicalPrice":12.49,"rrp":14.99,"rrpUrl":"https://www.lego.com/pt-pt/product/40460","summary":"Bom preço 【1†L2】."}' } }] }));
  } });
  routes.push({ match: (u) => u.endsWith('/robots.txt'), reply: () => new Response('User-agent: *\nAllow: /\n') });
  routes.push({ match: (u) => u.includes('worten.pt/p/rosas'), reply: () => new Response('<h1>LEGO Rosas</h1><span class="price">11,99 €</span>') });
  const kvs = makeKV();
  const env = { CRAWLER_KV: kvs, QUALQUER_NOME: 'gsk_test' };
  const body = { name: 'LEGO Rosas 40460', price: 8.91, history: { min: 9.5, max: 12, points: 4, since: '2026-10-01' }, otherStores: [{ store: 'fnac.pt', price: 11.99, date: '2026-11-08' }] };
  const r = await W.fetch(req('/deal', { method: 'POST', body }), env, waitCtx);
  const j = await r.json();
  ok(r.status === 200 && j.verdict === 'bom' && j.score === 80, 'veredicto extraido da resposta da IA');
  ok(!/【/.test(j.summary), 'marcas de citacao removidas do resumo');
  ok(j.lowestPrice === 11.99 && j.lowestPriceUrl === 'https://www.worten.pt/p/rosas' && j.lowestPriceStore === 'Worten', 'preco mais baixo vem sempre com o link da pagina', JSON.stringify(j));
  ok(j.lowestVerified === true, 'o Worker abriu o link e confirmou o preco na pagina');
  ok(j.prices.length === 2 && j.prices.every((o) => o.price > 0 && /^https:/.test(o.url)) && j.rrp === 14.99 && /lego\.com/.test(j.rrpUrl), 'cada preco citado tem o seu link (ofertas e PVP)');
  ok(/exact URL/.test(sentPrompt) && /"prices":\[\{"store"/.test(sentPrompt), 'o pedido a IA exige o par preco + link');
  ok(/Our own price tracking/.test(sentPrompt) && /fnac\.pt 11\.99/.test(sentPrompt), 'historico proprio e outras lojas enviados no pedido');
  ok(kvs.m.get(`deals:${new Date().toISOString().slice(0, 10)}`) === '1', 'contador diario incrementado');
  // a Groq rejeita o pedido quando o modelo tenta chamar uma ferramenta inexistente ('json'): repetir
  let groqCalls = 0, choices = [];
  const shop = { match: (u) => u.startsWith('https://loja.pt/'), reply: () => new Response('<html>loja</html>') };
  routes.length = 0;
  routes.push(shop);
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    groqCalls++; choices.push(JSON.parse(o.body).tool_choice);
    if (groqCalls === 1) return new Response(JSON.stringify({ error: { message: "tool call validation failed: attempted to call tool 'json' which was not in request.tools", code: 'tool_use_failed' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"razoavel","score":55,"prices":[{"store":"Loja","price":705,"url":"https://loja.pt/u1"}],"summary":"Preco normal."}' } }] }));
  } });
  const rg = await W.fetch(req('/deal', { method: 'POST', body: { ...body, name: 'Snapmaker U1', price: 699 } }), env, waitCtx);
  const jg = await rg.json();
  ok(rg.status === 200 && jg.verdict === 'razoavel' && groqCalls === 2 && choices[1] === 'auto', "erro 'tool json' da Groq: repete e responde", JSON.stringify({ s: rg.status, groqCalls, choices }));
  groqCalls = 0;
  routes.length = 0;
  routes.push(shop);
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    groqCalls++;
    const m = JSON.parse(o.body).model;
    if (m === 'openai/gpt-oss-120b') return new Response(JSON.stringify({ error: { message: "tool call validation failed: attempted to call tool 'json'", code: 'tool_use_failed' } }), { status: 400 });
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"bom","score":70,"prices":[{"store":"Loja","price":750,"url":"https://loja.pt/u1"}],"summary":"Ok."}' } }] }));
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
console.log('\nTraducao das palavras-chave');
{
  routes.length = 0;
  let asked = 0, sent = null;
  routes.push({ match: (u) => u.includes('groq.com'), reply: (u, o) => {
    asked++; sent = JSON.parse(o.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'Aqui esta:\n{"dobradiça":{"pt":["dobradiça"],"fr":["charnière"],"es":["bisagra"],"de":["Scharnier","<b>x"]},"lego":{"pt":"lego","fr":["lego"],"es":["lego"],"de":["lego"]}}' } }] }));
  } });
  const kvs = makeKV();
  const env = { CRAWLER_KV: kvs, AI_API_KEY: 'gsk_x' };
  const r = await W.fetch(req('/translate', { method: 'POST', body: { terms: ['dobradiça', 'lego', 'dobradiça'] } }), env, waitCtx);
  const j = await r.json();
  ok(r.status === 200 && j.translations['dobradiça'].fr[0] === 'charnière' && j.translations['dobradiça'].de[0] === 'Scharnier', '/translate devolve o termo nas 4 linguas', JSON.stringify(j));
  ok(!JSON.stringify(j).includes('<') && j.translations.lego.pt[0] === 'lego', 'resposta da IA limpa (sem HTML; texto solto vira lista)');
  ok(asked === 1 && !sent.tools && sent.model === 'openai/gpt-oss-20b' && /"dobradi/.test(sent.messages[0].content), 'um so pedido, sem pesquisa web, no modelo pequeno');
  ok(kvs.m.get(`tr:${new Date().toISOString().slice(0, 10)}`) === '1', 'contador diario de traducoes');
  ok((await W.fetch(req('/translate', { method: 'POST', body: { terms: [] } }), env, waitCtx)).status === 400, 'sem termos: 400');
  ok((await W.fetch(req('/translate', { method: 'POST', body: { terms: ['x'] }, origin: 'https://outro.site' }), env, waitCtx)).status === 403, '/translate so responde a tua app');
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
  let st = { hist: JSON.parse(kvs.m.get('hist')) };
  ok(!('hist' in JSON.parse(kvs.m.get('state'))) && JSON.parse(kvs.m.get('state')).histCount === 4, 'historico numa chave propria (o estado fica leve)');
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

/* ======================================================================== */
console.log('\nAuditoria: corrida com a sincronizacao, robots, token, fontes');
{
  // a app sincroniza enquanto o Cron esta a ler as lojas: as listas novas nao se perdem
  routes.length = 0;
  let env;
  routes.push({ match: (u) => u.endsWith('/robots.txt'), reply: () => new Response('User-agent: *\nAllow: /\n') });
  routes.push({ match: (u) => u.includes('loja-c.pt/lista'), reply: async () => {
    await W.fetch(req('/sync', { method: 'POST', body: { watch: [], searches: [
      { id: 'c', name: 'Lista C', config: { sites: 'https://loja-c.pt/lista', keywords: '' } },
      { id: 'nova', name: 'Nova', config: { sites: 'https://loja-c.pt/outra', keywords: '' } },
    ] } }), env, waitCtx);
    return new Response('<div></div>');
  } });
  env = { CRAWLER_KV: makeKV({ state: { searches: [{ id: 'c', name: 'Lista C', config: { sites: 'https://loja-c.pt/lista', keywords: '' } }] } }) };
  await runMonitor(env, { reason: 'cron' });
  const st = JSON.parse(env.CRAWLER_KV.m.get('state'));
  ok(st.searches.map((s) => s.id).join(',') === 'c,nova', 'pesquisa ativada durante a verificacao nao e apagada pelo Cron', st.searches.map((s) => s.id));

  // estado antigo com o historico dentro: passa para a chave propria
  env = { CRAWLER_KV: makeKV({ state: { hist: { 'x.pt/p': { n: 'X', u: 'https://x.pt/p', s: 'x.pt', h: [['2026-01-01', 5]] } } } }) };
  const hres = await (await W.fetch(req('/history'), env, waitCtx)).json();
  ok(hres.count === 1, '/history le o historico antigo (antes da migracao)');
  await runMonitor(env, { reason: 'cron' });
  ok(JSON.parse(env.CRAWLER_KV.m.get('hist'))['x.pt/p'] && !JSON.parse(env.CRAWLER_KV.m.get('state')).hist, 'historico antigo migrado para a chave propria');

  // sem orcamento para ler o robots.txt: a pagina nao e lida
  routes.length = 0;
  routes.push({ match: () => true, reply: () => new Response('User-agent: *\nAllow: /\n') });
  const sites = Array.from({ length: 40 }, (_, i) => `https://site${i}.pt/lista`);
  // o robots.txt do primeiro site ja esta em cache: o orcamento chega a 1 numa loja nova
  env = { CRAWLER_KV: makeKV({ state: { robots: { 'https://site0.pt': { t: Date.now(), rules: [] } }, searches: sites.map((u, i) => ({ id: 's' + i, name: 'S' + i, config: { sites: u, keywords: '' } })) } }) };
  calls.length = 0;
  await runMonitor(env, { reason: 'cron' });
  const pages = calls.filter((c) => !c.url.endsWith('/robots.txt')).map((c) => new URL(c.url).origin);
  const robots = new Set(calls.filter((c) => c.url.endsWith('/robots.txt')).map((c) => new URL(c.url).origin));
  ok(pages.length > 0 && pages.every((o) => o === 'https://site0.pt' || robots.has(o)), 'nenhuma pagina lida sem ler antes o robots.txt da loja', pages.filter((o) => o !== 'https://site0.pt' && !robots.has(o)));

  // APP_TOKEN
  env = { CRAWLER_KV: makeKV(), APP_TOKEN: 'segredo123' };
  ok((await W.fetch(req('/state'), env, waitCtx)).status === 401, 'com APP_TOKEN: pedido sem token recusado (mesmo com a Origin certa)');
  ok((await W.fetch(req('/?url=https://loja.pt/'), env, waitCtx)).status === 401, 'com APP_TOKEN: proxy sem token recusado');
  const withHeader = new Request('https://w.dev/state', { headers: { Origin: ORIGIN, 'X-App-Token': 'segredo123' } });
  ok((await W.fetch(withHeader, env, waitCtx)).status === 200, 'com APP_TOKEN: cabecalho X-App-Token aceite');
  routes.length = 0;
  routes.push({ match: (u) => u.startsWith('https://loja.pt/'), reply: () => new Response('ok') });
  ok((await W.fetch(req('/?url=' + encodeURIComponent('https://loja.pt/') + '&token=segredo123'), env, waitCtx)).status === 200, 'com APP_TOKEN: proxy com &token= funciona');
  const pre = await W.fetch(req('/state', { method: 'OPTIONS' }), env, waitCtx);
  ok(/X-App-Token/.test(pre.headers.get('Access-Control-Allow-Headers')), 'CORS permite o cabecalho X-App-Token');

  // fontes da IA: so http(s)
  routes.length = 0;
  routes.push({ match: (u) => u.includes('groq.com'), reply: () => new Response(JSON.stringify({ choices: [{ message: { content: '{"verdict":"bom","score":80,"summary":"ok","prices":[{"store":"mau","price":3,"url":"javascript:alert(1)"},{"store":"bom","price":12,"url":"https://kuantokusta.pt/x"}]}' } }] })) });
  routes.push({ match: (u) => u.includes('kuantokusta.pt'), reply: () => new Response('ok') });
  env = { CRAWLER_KV: makeKV(), AI_API_KEY: 'gsk_x' };
  const d = await (await W.fetch(req('/deal', { method: 'POST', body: { name: 'Produto fontes', price: 10 } }), env, waitCtx)).json();
  ok(d.sources.length === 1 && d.sources[0].url.startsWith('https://') && d.lowestPrice === 12, 'links javascript: removidos (e o preco que traziam tambem)', d.sources);

  // o caso do cabo: a IA diz "mais baixo 1,98 EUR" sem link -> esse preco nao passa
  const groq = (content, tools) => ({ match: (u) => u.includes('groq.com'), reply: () => new Response(JSON.stringify({ choices: [{ message: { content, executed_tools: tools } }] })) });
  const deal = async (name) => (await W.fetch(req('/deal', { method: 'POST', body: { name, price: 5.9, oldPrice: 13.9, store: 'globaldata.pt' } }), env, waitCtx)).json();
  routes.length = 0;
  routes.push(groq('{"verdict":"bom","score":80,"typicalPrice":7.5,"lowestPrice":1.98,"prices":[{"store":"PTec","price":7.49,"url":"https://ptec.pt/cabo"},{"store":"Coolmatica","price":7.9,"url":"https://coolmatica.pt/cabo"},{"store":"Sem link","price":1.98}],"summary":"O preço de 5,90 € está abaixo do típico (~7,5 €) e acima do mínimo encontrado (1,98 €)."}'));
  routes.push({ match: (u) => /ptec\.pt|coolmatica\.pt/.test(u), reply: (u) => new Response(u.endsWith('robots.txt') ? '' : '<b>7,49 €</b>') });
  const c1 = await deal('Cabo Lightning Nanocable 1M');
  ok(c1.lowestPrice === 7.49 && c1.lowestPriceUrl === 'https://ptec.pt/cabo' && c1.prices.length === 2, 'preco mais baixo sem link e descartado (fica o mais baixo COM link)', JSON.stringify(c1.prices));
  ok(!/1,98/.test(c1.summary) && /7,49/.test(c1.summary), 'resumo que cita um preco sem link e reescrito', c1.summary);

  // dominio que nao apareceu na pesquisa = link inventado
  routes.length = 0;
  routes.push(groq('{"verdict":"bom","score":80,"prices":[{"store":"Inventada","price":1.98,"url":"https://loja-inventada.pt/cabo"},{"store":"PTec","price":7.49,"url":"https://www.ptec.pt/cabo"}],"summary":"Bom."}',
    [{ type: 'search', output: 'resultados: https://ptec.pt/cabo-lightning PTec 7,49 EUR; https://cooptec.pt/x' }]));
  routes.push({ match: (u) => /ptec\.pt|inventada/.test(u), reply: () => new Response('nada') });
  const c2 = await deal('Cabo Lightning B');
  ok(c2.prices.length === 1 && c2.lowestPrice === 7.49 && c2.lowestVerified === false, 'link de um dominio que nao veio da pesquisa e descartado; sem confirmacao fica "por confirmar"', JSON.stringify(c2.prices));

  // link morto (404) sai; sem nenhum preco com link -> "incerto"
  routes.length = 0;
  routes.push(groq('{"verdict":"bom","score":90,"prices":[{"store":"Morta","price":2,"url":"https://morta.pt/x"},{"store":"Viva","price":6,"url":"https://viva.pt/x"}],"summary":"Bom."}'));
  routes.push({ match: (u) => u.includes('viva.pt'), reply: () => new Response('6,00 €') });
  const c3 = await deal('Cabo Lightning C');
  ok(c3.lowestPrice === 6 && c3.lowestPriceStore === 'Viva' && c3.lowestVerified === true, 'link que da 404 e descartado e passa ao seguinte', JSON.stringify(c3.prices));
  routes.length = 0;
  routes.push(groq('{"verdict":"bom","score":90,"typicalPrice":7.5,"lowestPrice":1.98,"rrp":9.99,"summary":"Bom negocio, minimo 1,98 €."}'));
  const c4 = await deal('Cabo Lightning D');
  ok(c4.verdict === 'incerto' && c4.lowestPrice === null && c4.typicalPrice === null && c4.rrp === null && !/1,98/.test(c4.summary), 'sem precos com link: nenhum preco e mostrado e o veredicto e "incerto"', JSON.stringify(c4));
}

console.log(`\n${passed} passaram, ${failed} falharam\n`);
process.exit(failed ? 1 : 0);
