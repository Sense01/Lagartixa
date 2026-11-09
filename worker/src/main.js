/* ======================================================================
 * Web Crawler - Cloudflare Worker
 *
 *   GET  /?url=https://site/pagina   proxy CORS (a app usa-o para ler as lojas)
 *   POST /deal                       "e bom negocio?" (IA com pesquisa web)
 *   GET  /state  POST /sync          estado dos alertas / sincronizar seguidos e pesquisas
 *   POST /run                        verificar agora (o Cron faz o mesmo de hora a hora)
 *   GET  /push/key  POST /push/subscribe  POST /push/test   notificacoes push
 *
 * Configuracao (ver worker/README.md):
 *   - Segredo AI_API_KEY (gsk_... Groq, xai-... xAI, sk-ant-... Anthropic)  -> /deal
 *   - KV namespace ligado com o nome CRAWLER_KV                            -> alertas e limites
 *   - Cron Trigger "0 * * * *"                                             -> verificacao automatica
 *
 * Este ficheiro e gerado por tools/build_worker.py (nao editar a mao).
 * ASCII only.
 * ==================================================================== */

// So a tua app pode usar o Worker (evita que outros gastem a tua quota).
const ALLOWED_ORIGINS = [
  'https://sense01.github.io',
  'http://localhost:8000',
  'http://localhost:8765',
];

// identificacao do remetente das notificacoes push (exigido pelos servicos de push)
const PUSH_SUBJECT = 'https://sense01.github.io';
const APP_URL = 'https://sense01.github.io/';

const BROWSER_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  // igual a um browser a abrir uma pagina (pedir JSON faz algumas lojas, ex. PrestaShop, responder em JSON)
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pt-PT,pt;q=0.9,fr-FR;q=0.8,fr;q=0.7,en;q=0.6',
};

const MODELS = {
  // Groq: tenta pela ordem; o primeiro a que a conta tiver acesso e usado
  groq: ['openai/gpt-oss-120b', 'groq/compound', 'openai/gpt-oss-20b', 'groq/compound-mini'],
  xai: 'grok-4.7',
  anthropic: 'claude-haiku-5-5',
};
const DEAL_MAX_SEARCHES = 3;
const DEAL_CACHE_SECONDS = 12 * 3600;
const DEAL_DAILY_LIMIT = 60;          // avaliacoes por dia (protege a quota da API)

const MONITOR = {
  maxFetches: 38,                     // plano gratis: 50 sub-pedidos por execucao (fica margem para push)
  maxWatch: 25,
  maxSitesPerSearch: 3,
  seenPerSearch: 600,
  alertsKept: 100,
  historyPoints: 90,
  robotsTtlMs: 24 * 3600e3,
};

const enc = new TextEncoder();
const EURO = '€';
const fmt = (v) => (v == null ? '-' : `${Number(v).toFixed(2).replace('.', ',')} ${EURO}`);

/* ======================================================================
 * Entrada
 * ==================================================================== */

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin') || '';
    const originOk = !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);
    const allowed = originOk || !origin;
    const cors = {
      'Access-Control-Allow-Origin': allowed && origin ? origin : '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'X-Final-Url',
      Vary: 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!allowed) return new Response('Origem nao autorizada', { status: 403, headers: cors });

    const path = new URL(request.url).pathname.replace(/\/+$/, '') || '/';
    const api = {
      '/deal': () => handleDeal(request, env, ctx, cors),
      '/state': () => handleState(env, cors),
      '/sync': () => handleSync(request, env, cors),
      '/run': () => handleRun(request, env, cors),
      '/push/key': () => handlePushKey(env, cors),
      '/push/subscribe': () => handleSubscribe(request, env, cors),
      '/push/test': () => handlePushTest(env, cors),
    }[path];
    if (api) {
      // as rotas da API so respondem a tua app (pedidos sem Origin sao recusados)
      if (ALLOWED_ORIGINS.length && !originOk) return json({ error: 'Origem nao autorizada' }, 403, cors);
      try { return await api(); } catch (e) { return json({ error: e.message || String(e), setup: e.setup }, e.status || 500, cors); }
    }
    if (request.method !== 'GET') return new Response('So GET', { status: 405, headers: cors });
    return proxy(request, cors);
  },

  // Cron Trigger (ex.: "0 * * * *"): verificacao automatica
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMonitor(env, { reason: 'cron' }).catch((e) => console.log('monitor:', e.message)));
  },
};

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

class HttpError extends Error {
  constructor(message, status = 400, setup) { super(message); this.status = status; this.setup = setup; }
}

/* ======================================================================
 * Proxy CORS
 * ==================================================================== */

async function proxy(request, cors) {
  const target = new URL(request.url).searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) {
    return new Response('Use ?url=https://...', { status: 400, headers: cors });
  }
  try {
    const res = await fetch(target, { headers: BROWSER_HEADERS, redirect: 'follow', cf: { cacheTtl: 120 } });
    const headers = new Headers(res.headers);
    for (const h of ['content-security-policy', 'set-cookie', 'x-frame-options', 'content-encoding', 'content-length']) headers.delete(h);
    Object.entries(cors).forEach(([k, v]) => headers.set(k, v));
    headers.set('X-Final-Url', res.url);
    return new Response(res.body, { status: res.status, headers });
  } catch (e) {
    return new Response(`Erro ao contactar o site: ${e.message}`, { status: 502, headers: cors });
  }
}

/* ======================================================================
 * KV (estado dos alertas)
 * ==================================================================== */

const KV_SETUP = 'No Worker: Settings -> Bindings -> Add -> KV namespace. Cria um namespace (ex.: crawler) e liga-o com o nome CRAWLER_KV. Depois faz Deploy.';

function kv(env) {
  if (!env.CRAWLER_KV) throw new HttpError('Falta ligar o armazenamento KV ao Worker (CRAWLER_KV)', 500, KV_SETUP);
  return env.CRAWLER_KV;
}
async function kvGet(env, key, fallback) {
  const v = await kv(env).get(key, 'json');
  return v ?? fallback;
}
const kvPut = (env, key, value, opts) => kv(env).put(key, JSON.stringify(value), opts);

const emptyState = () => ({ watch: [], searches: [], prices: {}, seen: {}, baselined: {}, robots: {}, alerts: [], lastRun: null, cron: false });

async function loadState(env) {
  return { ...emptyState(), ...(await kvGet(env, 'state', {})) };
}

async function publicState(env, st) {
  st ||= await loadState(env);
  const subs = await kvGet(env, 'subs', []);
  return {
    watch: st.watch.map((w) => ({ key: w.key, name: w.name, target: w.target, last: st.prices[w.key] || null })),
    searches: st.searches.map((s) => ({ id: s.id, name: s.name, tracked: Object.keys(st.seen[s.id] || {}).length })),
    alerts: st.alerts.slice(0, 40),
    lastRun: st.lastRun, lastSummary: st.lastSummary || null, cron: !!st.cron,
    subscriptions: subs.length,
  };
}

async function handleState(env, cors) {
  return json(await publicState(env), 200, cors);
}

function sanitizeLists(body) {
  const watch = (Array.isArray(body.watch) ? body.watch : []).slice(0, 200)
    .filter((w) => w && /^https?:\/\//.test(w.url || ''))
    .map((w) => ({
      key: String(w.key || w.url).slice(0, 400), url: String(w.url).slice(0, 1000), name: String(w.name || '').slice(0, 200),
      image: String(w.image || '').slice(0, 1000), store: String(w.store || '').slice(0, 100),
      target: w.target == null || w.target === '' ? null : Number(w.target), price: w.price == null ? null : Number(w.price),
    }));
  const searches = (Array.isArray(body.searches) ? body.searches : []).slice(0, 30)
    .filter((s) => s && s.id && s.config)
    .map((s) => ({ id: String(s.id).slice(0, 40), name: String(s.name || '').slice(0, 100), config: s.config }));
  return { watch, searches };
}

async function handleSync(request, env, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const body = await request.json().catch(() => ({}));
  const st = await loadState(env);
  const { watch, searches } = sanitizeLists(body);
  st.watch = watch;
  st.searches = searches;
  // limpa estado de pesquisas/produtos que ja nao existem
  const ids = new Set(searches.map((s) => s.id));
  for (const id of Object.keys(st.seen)) if (!ids.has(id)) { delete st.seen[id]; delete st.baselined[id]; }
  const keys = new Set(watch.map((w) => w.key));
  for (const k of Object.keys(st.prices)) if (!keys.has(k)) delete st.prices[k];
  // o preco que a app viu serve de ponto de partida
  for (const w of watch) if (!st.prices[w.key] && w.price != null) st.prices[w.key] = { p: w.price, t: Date.now(), av: null, hist: [[today(), w.price]] };
  await kvPut(env, 'state', st);
  return json(await publicState(env, st), 200, cors);
}

async function handleRun(request, env, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const body = await request.json().catch(() => ({}));
  if (body.watch || body.searches) {
    // sincroniza primeiro (garante que verifica a lista mais recente)
    await handleSync(new Request(request.url, { method: 'POST', body: JSON.stringify(body) }), env, cors);
  }
  const res = await runMonitor(env, { reason: 'manual' });
  return json({ summary: res.summary, alerts: res.alerts, state: await publicState(env, res.state) }, 200, cors);
}

/* ======================================================================
 * Verificacao (Cron e "Verificar agora")
 * ==================================================================== */

const today = () => new Date().toISOString().slice(0, 10);

function itemKey(url) {
  try {
    const u = new URL(url);
    [...u.searchParams.keys()].forEach((k) => /^(utm_|srsltid|gclid|fbclid|mc_|_ga|ref$|sc_|cmp)/i.test(k) && u.searchParams.delete(k));
    u.searchParams.sort();
    const q = u.searchParams.toString();
    return (u.hostname.replace(/^www\./, '') + u.pathname.replace(/\/+$/, '') + (q ? '?' + q : '')).toLowerCase();
  } catch { return String(url).toLowerCase(); }
}

function blockedPage(r) {
  if (!r) return true;
  if (r.status === 401 || r.status === 403 || r.status === 203 || r.status === 429) return true;
  return /Robot Check|validateCaptcha|cf-chl-|challenge-platform|Just a moment\.\.\.|px-captcha|_Incapsula_Resource|captcha-delivery|verify you are human/i.test((r.text || '').slice(0, 20000));
}

function parseRobots(txt) {
  const rules = [];
  let applies = false, lastWasAgent = false;
  for (let line of String(txt).split(/\r?\n/)) {
    line = line.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const key = line.slice(0, i).trim().toLowerCase();
    const val = line.slice(i + 1).trim();
    if (key === 'user-agent') { if (!lastWasAgent) applies = false; if (val === '*') applies = true; lastWasAgent = true; continue; }
    lastWasAgent = false;
    if (applies && (key === 'allow' || key === 'disallow') && val) rules.push({ allow: key === 'allow', path: val });
  }
  return rules;
}

function robotsAllows(url, rules) {
  const u = new URL(url);
  const path = u.pathname + u.search;
  let best = null;
  for (const r of rules) {
    const re = new RegExp('^' + r.path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r.path.length > best.path.length)) best = r;
  }
  return !best || best.allow;
}

/** contexto de uma execucao: orcamento de pedidos, robots.txt em cache */
function makeCtx(st) {
  return {
    budget: MONITOR.maxFetches,
    errors: [],
    async get(url, { json: wantJson = false } = {}) {
      if (this.budget <= 0) return null;
      if (!(await this.allowed(url))) { this.errors.push(`robots.txt nao permite ${url}`); return null; }
      this.budget--;
      try {
        const res = await fetch(url, { headers: wantJson ? { ...BROWSER_HEADERS, Accept: 'application/json' } : BROWSER_HEADERS, redirect: 'follow' });
        return { status: res.status, ok: res.ok, text: await res.text(), type: res.headers.get('content-type') || '' };
      } catch (e) {
        this.errors.push(`${url}: ${e.message}`);
        return null;
      }
    },
    async allowed(url) {
      const origin = new URL(url).origin;
      const c = st.robots[origin];
      if (c && Date.now() - c.t < MONITOR.robotsTtlMs) return robotsAllows(url, c.rules);
      if (this.budget <= 1) return true;
      this.budget--;
      let rules = [];
      try {
        const r = await fetch(origin + '/robots.txt', { headers: BROWSER_HEADERS });
        const t = r.ok ? await r.text() : '';
        if (!/<html/i.test(t.slice(0, 500))) rules = parseRobots(t);
      } catch {}
      st.robots[origin] = { t: Date.now(), rules };
      return robotsAllows(url, rules);
    },
  };
}

async function listProducts(siteUrl, c) {
  const lidl = LiteX.lidlApiUrl(siteUrl, 0, 100);
  if (lidl) {
    const r = await c.get(lidl, { json: true });
    if (!r || !r.ok) return [];
    try { return LiteX.lidlItems(JSON.parse(r.text), siteUrl); } catch { return []; }
  }
  const r = await c.get(siteUrl);
  if (!r || !r.ok || blockedPage(r)) return [];
  if (LiteX.isPrestaShopJson(r.text)) {
    try { return LiteX.prestaShopItems(JSON.parse(r.text), siteUrl); } catch { return []; }
  }
  return LiteX.listingFromHtml(r.text, siteUrl);
}

function filtersOf(config) {
  const num = (v) => (v === '' || v == null || isNaN(+v) ? null : +v);
  return {
    keywords: String(config.keywords || '').split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean),
    minPrice: num(config.minPrice), maxPrice: num(config.maxPrice), minDiscount: num(config.minDiscount),
    wholeWord: config.wholeWord !== false, caseSensitive: !!config.caseSensitive,
  };
}

async function runMonitor(env, { reason = 'cron' } = {}) {
  const st = await loadState(env);
  const c = makeCtx(st);
  const alerts = [];
  const now = Date.now();
  if (reason === 'cron') st.cron = true;

  // 1) produtos seguidos: preco, preco-alvo, regresso ao stock
  let checked = 0;
  for (const w of st.watch.slice(0, MONITOR.maxWatch)) {
    if (c.budget <= 0) break;
    const r = await c.get(w.url);
    if (!r || !r.ok || blockedPage(r)) continue;
    const p = LiteX.productFromHtml(r.text, w.url);
    if (p.price == null) continue;
    checked++;
    const prev = st.prices[w.key];
    const name = w.name || p.name;
    if (prev && p.price < prev.p - 0.004) {
      alerts.push({ kind: 'drop', title: `↓ ${name}`, body: `${fmt(prev.p)} → ${fmt(p.price)} em ${w.store}`, url: w.url, key: w.key });
    }
    if (w.target != null && p.price <= w.target && !(prev && prev.p <= w.target)) {
      alerts.push({ kind: 'target', title: `🎯 ${name}`, body: `Chegou a ${fmt(p.price)} (o teu alvo era ${fmt(w.target)}) em ${w.store}`, url: w.url, key: w.key });
    }
    if (prev && prev.av === 'out' && p.availability === 'in') {
      alerts.push({ kind: 'stock', title: `📦 De volta ao stock`, body: `${name} - ${fmt(p.price)} em ${w.store}`, url: w.url, key: w.key });
    }
    const hist = (prev?.hist || []).filter((h) => h[0] !== today());
    hist.push([today(), p.price]);
    st.prices[w.key] = { p: p.price, t: now, av: p.availability || null, hist: hist.slice(-MONITOR.historyPoints) };
  }

  // 2) pesquisas com alertas: produtos novos e descidas de preco
  let searched = 0;
  for (const s of st.searches) {
    if (c.budget <= 0) break;
    const sites = String(s.config.sites || '').split(/[\n\s,]+/).map((x) => x.trim()).filter(Boolean)
      .map((x) => (/^https?:\/\//i.test(x) ? x : 'https://' + x)).slice(0, MONITOR.maxSitesPerSearch);
    const f = filtersOf(s.config);
    const found = [];
    for (const site of sites) found.push(...(await listProducts(site, c)));
    const matched = found.filter((it) => it.price != null && it.name && LiteX.matchesFilters(it, f));
    if (!found.length) continue;
    searched++;
    const seen = (st.seen[s.id] ||= {});
    const first = !st.baselined[s.id];
    for (const it of matched) {
      const k = itemKey(it.url) + '|' + it.name.slice(0, 60).toLowerCase();
      const prev = seen[k];
      if (prev == null && !first) {
        alerts.push({ kind: 'new', title: `🆕 ${s.name}`, body: `${it.name} - ${fmt(it.price)}${it.discount ? ` (-${it.discount}%)` : ''}`, url: it.url });
      } else if (prev != null && it.price < prev - 0.004) {
        alerts.push({ kind: 'drop', title: `↓ ${it.name}`, body: `${fmt(prev)} → ${fmt(it.price)} (${s.name})`, url: it.url });
      }
      seen[k] = it.price;
    }
    const keys = Object.keys(seen);
    if (keys.length > MONITOR.seenPerSearch) keys.slice(0, keys.length - MONITOR.seenPerSearch).forEach((k) => delete seen[k]);
    st.baselined[s.id] = true;
  }

  // 3) guardar e notificar
  const stamped = alerts.map((a) => ({ ...a, t: now }));
  st.alerts = [...stamped, ...st.alerts].slice(0, MONITOR.alertsKept);
  st.lastRun = now;
  const summary = `${checked}/${st.watch.length} produto(s) verificados, ${searched}/${st.searches.length} pesquisa(s), ${alerts.length} alerta(s)` +
    (c.errors.length ? `, ${c.errors.length} aviso(s)` : '');
  st.lastSummary = summary;
  await kvPut(env, 'state', st);

  if (alerts.length) {
    const messages = alerts.length <= 3
      ? alerts.map((a) => ({ title: a.title, body: a.body, url: a.url, tag: a.key || a.url }))
      : [{ title: `${alerts.length} alertas de precos`, body: alerts.slice(0, 4).map((a) => a.title.replace(/^\S+\s/, '')).join(' · '), url: APP_URL, tag: 'resumo' }];
    await pushAll(env, messages);
  }
  return { summary, alerts: stamped, state: st };
}

/* ======================================================================
 * Notificacoes push (Web Push: VAPID + aes128gcm, so com WebCrypto)
 * ==================================================================== */

const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
function unb64u(s) {
  const bin = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hmac(key, data) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}

async function getVapid(env) {
  let v = await kvGet(env, 'vapid', null);
  if (v) return v;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  v = {
    publicKey: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
  };
  await kvPut(env, 'vapid', v);
  return v;
}

async function vapidAuth(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const header = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: PUSH_SUBJECT })));
  const key = await crypto.subtle.importKey('jwk', vapid.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u(sig)}, k=${vapid.publicKey}`;
}

/** RFC 8291: encripta a mensagem para a subscricao (aes128gcm) */
async function encryptPayload(sub, plaintext) {
  const uaPublic = unb64u(sub.keys.p256dh);
  const authSecret = unb64u(sub.keys.auth);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));

  const prkKey = await hmac(authSecret, shared);
  const ikm = await hmac(prkKey, concat(enc.encode('WebPush: info\0'), uaPublic, asPublic, new Uint8Array([1])));
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const padded = concat(enc.encode(plaintext), new Uint8Array([2]));   // 0x02 = ultimo registo
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, padded));
  const rs = new Uint8Array([0, 0, 16, 0]);                             // record size 4096
  return concat(salt, rs, new Uint8Array([asPublic.length]), asPublic, cipher);
}

async function sendPush(sub, message, vapid) {
  const body = await encryptPayload(sub, JSON.stringify(message));
  const res = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      TTL: '86400',
      Urgency: 'high',
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      Authorization: await vapidAuth(sub.endpoint, vapid),
    },
    body,
  });
  return res.status;
}

async function pushAll(env, messages) {
  const subs = await kvGet(env, 'subs', []);
  if (!subs.length) return 0;
  const vapid = await getVapid(env);
  let sent = 0;
  const dead = new Set();
  for (const sub of subs) {
    for (const m of messages) {
      try {
        const status = await sendPush(sub, m, vapid);
        if (status === 404 || status === 410) { dead.add(sub.endpoint); break; }
        if (status < 300) sent++;
      } catch (e) { console.log('push:', e.message); }
    }
  }
  if (dead.size) await kvPut(env, 'subs', subs.filter((s) => !dead.has(s.endpoint)));
  return sent;
}

async function handlePushKey(env, cors) {
  const v = await getVapid(env);
  return json({ publicKey: v.publicKey }, 200, cors);
}

async function handleSubscribe(request, env, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const body = await request.json().catch(() => ({}));
  const s = body.subscription;
  if (!s || !/^https:\/\//.test(s.endpoint || '') || !s.keys?.p256dh || !s.keys?.auth) throw new HttpError('Subscricao invalida');
  const subs = (await kvGet(env, 'subs', [])).filter((x) => x.endpoint !== s.endpoint);
  subs.push({ endpoint: s.endpoint, keys: { p256dh: s.keys.p256dh, auth: s.keys.auth }, device: String(body.device || '').slice(0, 120), at: Date.now() });
  await kvPut(env, 'subs', subs.slice(-10));
  return json(await publicState(env), 200, cors);
}

async function handlePushTest(env, cors) {
  const sent = await pushAll(env, [{ title: '🕷️ Web Crawler', body: 'As notificacoes estao a funcionar!', url: APP_URL, tag: 'teste' }]);
  return json({ sent }, 200, cors);
}

/* ======================================================================
 * "E bom negocio?" (IA com pesquisa web)
 * ==================================================================== */

function pickProvider(env) {
  const named = [env.AI_API_KEY, env.GROQ_API_KEY, env.XAI_API_KEY, env.ANTHROPIC_API_KEY];
  const all = Object.values(env || {}).filter((v) => typeof v === 'string');
  for (const raw of [...named, ...all]) {
    if (!raw) continue;
    const k = String(raw).trim().replace(/^["']|["']$/g, '');
    if (k.startsWith('gsk_')) return { name: 'groq', key: k };
    if (k.startsWith('xai-')) return { name: 'xai', key: k };
    if (k.startsWith('sk-ant-')) return { name: 'anthropic', key: k };
  }
  return null;
}

async function handleDeal(request, env, ctx, cors) {
  if (request.method !== 'POST') throw new HttpError('Use POST', 405);
  const provider = pickProvider(env);
  if (!provider) {
    const names = Object.keys(env || {}).filter((k) => typeof env[k] === 'string');
    throw new HttpError('Nao encontrei nenhuma chave (gsk_..., xai-... ou sk-ant-...) no Worker. ' +
      (names.length ? `Variaveis que o Worker ve: ${names.join(', ')}.` : 'O Worker nao ve nenhuma variavel/segredo.') +
      ' Confirma em Settings -> Variables and Secrets e faz Deploy.', 500);
  }
  const item = await request.json().catch(() => null);
  if (!item) throw new HttpError('JSON invalido');
  const name = String(item.name || '').slice(0, 200).trim();
  const price = Number(item.price);
  if (!name || !isFinite(price)) throw new HttpError('Faltam name/price');
  const currency = String(item.currency || 'EUR').slice(0, 5);
  const store = String(item.store || '').slice(0, 80);
  const country = /^[A-Z]{2}$/.test(item.country || '') ? item.country : 'PT';

  const cacheKey = new Request('https://deal-cache.local/' + encodeURIComponent(`${name}|${price}|${country}`.toLowerCase()));
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return json({ ...(await hit.json()), cached: true }, 200, cors);

  // limite diario (so conta pedidos que vao mesmo a API)
  const dayKey = `deals:${today()}`;
  let used = 0;
  if (env.CRAWLER_KV) {
    used = Number(await env.CRAWLER_KV.get(dayKey)) || 0;
    if (used >= DEAL_DAILY_LIMIT) {
      throw new HttpError(`Limite diario de ${DEAL_DAILY_LIMIT} avaliacoes atingido. Volta amanha (ou aumenta DEAL_DAILY_LIMIT no Worker).`, 429);
    }
  }

  const h = item.history && typeof item.history === 'object' ? item.history : null;
  const others = Array.isArray(item.otherStores) ? item.otherStores.slice(0, 3) : [];
  const prompt =
    `Product: "${name}"\n` +
    `Price found: ${price} ${currency}` + (item.oldPrice ? ` (store says previous price ${item.oldPrice} ${currency})` : '') +
    (store ? `\nStore: ${store}` : '') +
    (item.ean ? `\nEAN: ${String(item.ean).replace(/\D/g, '')}` : '') +
    (h && h.points > 1 ? `\nOur own price tracking at this store since ${h.since}: min ${h.min}, max ${h.max} (${h.points} observations).` : '') +
    (others.length ? `\nWe also saw it at: ${others.map((o) => `${o.store} ${o.price} (${o.date})`).join('; ')}.` : '') +
    `\nBuyer country: ${country}\n\n` +
    'Search the web to judge whether this is a good deal. Find: the typical current price in other ' +
    'shops in this country/EU, the lowest current price you can find, and the official launch/retail ' +
    'price (RRP) if it exists (e.g. for LEGO sets use the set number). Prefer price comparison sites ' +
    'and official stores. When done searching, write your final answer as plain text (do NOT call any ' +
    'tool named json or any other tool for the answer) containing ONLY one JSON object:\n' +
    '{"verdict":"bom"|"razoavel"|"caro"|"incerto","score":0-100,"typicalPrice":number|null,' +
    '"lowestPrice":number|null,"rrp":number|null,"currency":"EUR","summary":"1-2 short sentences in ' +
    'European Portuguese explaining the verdict with the numbers","sources":[{"title":"...","url":"..."}]}\n' +
    'score: 100 = exceptional deal, 50 = normal price, 0 = clearly overpriced. Use "incerto" if you ' +
    'could not find reliable comparable prices or you are not sure it is the same product.';

  let out;
  try {
    out = await askProvider(provider, prompt, country);
  } catch (e) {
    throw new HttpError(`${provider.name}: ${e.message}`, 502);
  }
  const text = out.text || '';
  let result = extractVerdict(text) || { verdict: 'incerto', score: null, summary: cleanText(text).slice(-400) };
  if (result.summary) result.summary = cleanText(String(result.summary));
  if (!Array.isArray(result.sources) || !result.sources.length) result.sources = (out.sources || []).slice(0, 4);
  result.sources = result.sources.slice(0, 5);
  result.checkedAt = new Date().toISOString();
  result.searches = out.searches ?? null;
  result.provider = provider.name + (out.model ? ` (${out.model})` : '');

  if (env.CRAWLER_KV) ctx.waitUntil(env.CRAWLER_KV.put(dayKey, String(used + 1), { expirationTtl: 2 * 86400 }));
  ctx.waitUntil(cache.put(cacheKey, new Response(JSON.stringify(result), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': `max-age=${DEAL_CACHE_SECONDS}` },
  })));
  return json(result, 200, cors);
}

async function askProvider(p, prompt, country) {
  if (p.name === 'groq') return askGroq(p.key, prompt);
  if (p.name === 'xai') return askXai(p.key, prompt);
  return askAnthropic(p.key, prompt, country);
}

async function readJson(res) {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message || data?.error || `HTTP ${res.status}`);
  return data;
}

function collectSources(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object' || out.length > 20) return out;
  if (Array.isArray(node)) { node.forEach((n) => collectSources(n, out, seen)); return out; }
  if (typeof node.url === 'string' && /^https?:/.test(node.url) && !seen.has(node.url)) {
    seen.add(node.url);
    out.push({ title: node.title || node.url, url: node.url });
  }
  for (const v of Object.values(node)) if (v && typeof v === 'object') collectSources(v, out, seen);
  return out;
}

async function askGroq(key, prompt) {
  let lastErr;
  for (const model of MODELS.groq) {
    const compound = model.startsWith('groq/');
    // os modelos gpt-oss as vezes "inventam" uma ferramenta (ex. 'json') e a Groq rejeita o pedido:
    // repete o mesmo modelo ate 2 vezes e depois passa ao seguinte
    for (let attempt = 0; attempt < 3; attempt++) {
      const body = { model, messages: [{ role: 'user', content: prompt }], max_completion_tokens: 2500 };
      if (!compound) {
        body.tools = [{ type: 'browser_search' }];
        // na repeticao, deixa o modelo escolher: menos tentativas de chamar ferramentas inexistentes
        body.tool_choice = attempt === 0 ? 'required' : 'auto';
        body.reasoning_effort = 'low';
      }
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.error?.message || `HTTP ${res.status}`;
        lastErr = new Error(`${model}: ${msg}`);
        if (res.status === 404 || /does not exist|access|not found|decommission|not supported/i.test(msg)) break;
        const toolGlitch = data?.error?.code === 'tool_use_failed' || /tool call validation|failed to call a function|not in request\.tools|tool_use_failed/i.test(msg);
        if (toolGlitch && attempt < 2) continue;
        if (toolGlitch || res.status === 429 || res.status >= 500) break;   // tenta o modelo seguinte
        throw lastErr;
      }
      const data = await res.json();
      const msg = data.choices?.[0]?.message || {};
      const tools = msg.executed_tools || [];
      const text = msg.content || '';
      const urls = [...new Set((text.match(/https?:\/\/[^\s)\]"'<>]+/g) || []))].map((u) => ({ title: u, url: u }));
      return { text, sources: [...collectSources(tools), ...urls].slice(0, 6), searches: tools.length || null, model };
    }
  }
  throw lastErr || new Error('Nenhum modelo Groq disponivel');
}

async function askXai(key, prompt) {
  const res = await fetch('https://api.x.ai/v1/responses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: MODELS.xai, input: prompt, tools: [{ type: 'web_search' }], max_turns: DEAL_MAX_SEARCHES + 1 }),
  });
  const data = await readJson(res);
  let text = data.output_text || '';
  if (!text) for (const item of data.output || []) for (const c of item.content || []) if (c.type === 'output_text' && c.text) text += c.text;
  const searches = (data.output || []).filter((i) => /search/i.test(i.type || '')).length || null;
  return { text, sources: collectSources(data.output || data.citations || []).slice(0, 6), searches };
}

async function askAnthropic(key, prompt, country) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODELS.anthropic, max_tokens: 1200, messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: DEAL_MAX_SEARCHES, user_location: { type: 'approximate', country } }],
    }),
  });
  const data = await readJson(res);
  const blocks = data.content || [];
  const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  const sources = collectSources(blocks.filter((b) => b.type === 'web_search_tool_result')).slice(0, 6);
  return { text, sources, searches: data.usage?.server_tool_use?.web_search_requests ?? null };
}

// remove marcas de citacao (parenteses especiais U+3010/U+3011) e espacos a mais
function cleanText(s) {
  return s.replace(/【[^】]*】/g, '').replace(/\s+/g, ' ').trim();
}

// encontra o ULTIMO objeto JSON com "verdict" (chavetas equilibradas) e faz parse
function extractVerdict(text) {
  if (!text) return null;
  const idxs = [];
  let i = -1;
  while ((i = text.indexOf('"verdict"', i + 1)) !== -1) idxs.push(i);
  for (const at of idxs.reverse()) {
    let start = text.lastIndexOf('{', at);
    while (start !== -1) {
      let depth = 0, inStr = false, esc = false;
      for (let j = start; j < text.length; j++) {
        const ch = text[j];
        if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === '{') depth++;
        else if (ch === '}' && --depth === 0) {
          try { const o = JSON.parse(cleanText(text.slice(start, j + 1))); if (o && o.verdict) return o; } catch {}
          break;
        }
      }
      start = text.lastIndexOf('{', start - 1);
      if (start !== -1 && at - start > 4000) break;
    }
  }
  return null;
}
