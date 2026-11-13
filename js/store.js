/* =========================================================
   Dados guardados no aparelho (localStorage)
   - histórico de preços por produto
   - lista de produtos seguidos
   - pesquisas guardadas
   - cache das avaliações de negócio
   ========================================================= */

const Store = (() => {
  // prefixo opcional (a página de testes usa outro, para não mexer nos teus dados)
  const P = (typeof window !== 'undefined' && window.STORE_PREFIX) || '';
  const K = {
    history: P + 'crawler-history',
    watch: P + 'crawler-watch',
    searches: P + 'crawler-searches',
  };
  const MAX_POINTS = 90;       // pontos de histórico por produto
  const MAX_PRODUCTS = 3000;   // produtos no histórico (os mais antigos saem)
  const listeners = {};

  function read(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  }
  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      // armazenamento cheio: corta o histórico e tenta outra vez
      if (key !== K.history) { pruneHistory(Math.floor(MAX_PRODUCTS / 2)); try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch {} }
      console.warn('Armazenamento cheio:', e);
      return false;
    }
  }
  function emit(ev) { (listeners[ev] || []).forEach((fn) => fn()); }
  function on(ev, fn) { (listeners[ev] ||= []).push(fn); }

  /* ---------- identidade do produto ---------- */

  /** chave estável de um produto numa loja: host + caminho (+ query relevante) — partilhada com o Worker */
  const keyCache = new WeakMap();   // por objeto: a análise pede a chave muitas vezes
  function itemKey(urlOrItem) {
    if (typeof urlOrItem === 'string' || !urlOrItem) return LiteX.itemKey(urlOrItem);
    const c = keyCache.get(urlOrItem);
    if (c && c.u === urlOrItem.url) return c.k;
    const k = LiteX.itemKey(urlOrItem.url);
    keyCache.set(urlOrItem, { u: urlOrItem.url, k });
    return k;
  }

  /** identidade do produto independente da loja (para comparar lojas) — partilhada com o Worker (js/extract-lite.js) */
  // em cache por objeto: a análise pede-a muitas vezes para os mesmos produtos
  const idCache = new WeakMap();
  function productIdentity(it) {
    if (!it || typeof it !== 'object') return LiteX.productIdentity(it);
    const c = idCache.get(it);
    const sig = `${it.ean}|${it.brand}|${it.name}|${it.url}|${it.mpn}`;
    if (c && c.sig === sig) return c.id;
    const id = LiteX.productIdentity(it);
    idCache.set(it, { sig, id });
    return id;
  }

  /* ---------- histórico de preços ---------- */

  let historyCache = null;
  const history = () => (historyCache ||= read(K.history, {}));

  // índice identidade -> chaves do histórico (evita percorrer o histórico inteiro por cada produto)
  let idIndex = null;
  function byId() {
    if (!idIndex) {
      idIndex = new Map();
      for (const [k, e] of Object.entries(history())) if (e.id) indexAdd(k, e.id);
    }
    return idIndex;
  }
  function indexAdd(key, id) {
    const a = idIndex.get(id);
    if (!a) idIndex.set(id, [key]); else if (!a.includes(key)) a.push(key);
  }
  const saveHistory = debounce(() => write(K.history, history()), 300);

  function pruneHistory(keep = MAX_PRODUCTS) {
    const h = history();
    const keys = Object.keys(h);
    if (keys.length <= keep) return;
    keys.sort((a, b) => (h[b].seen || 0) - (h[a].seen || 0)).slice(keep).forEach((k) => delete h[k]);
    idIndex = null;
    write(K.history, h);
  }

  /**
   * Regista o preço visto agora. Devolve a análise em relação ao histórico ANTERIOR:
   * { prev, prevDate, change, changePct, min, max, points, isLowest }
   */
  function recordPrice(it) {
    if (!it?.url || it.price == null) return null;
    const key = itemKey(it);
    const h = history();
    const e = h[key] || { pts: [] };
    const oldId = e.id;
    const day = today();
    const before = e.pts.filter((p) => p[0] !== day);   // pontos de dias anteriores
    const last = e.pts[e.pts.length - 1];
    if (last && last[0] === day) last[1] = it.price; else e.pts.push([day, it.price]);
    if (e.pts.length > MAX_POINTS) e.pts.splice(0, e.pts.length - MAX_POINTS);
    Object.assign(e, {
      n: it.name, u: it.url, i: it.image || e.i || '', s: hostOf(it.url),
      id: productIdentity(it) || e.id || null, av: it.availability || null, seen: Date.now(),
    });
    h[key] = e;
    if (idIndex) { if (oldId && oldId !== e.id) idIndex = null; else if (e.id) indexAdd(key, e.id); }
    saveHistory();
    if (Object.keys(h).length > MAX_PRODUCTS * 1.1) pruneHistory();
    return analyse(before, it.price);
  }

  function analyse(before, price) {
    if (!before.length) return { points: 1, isNew: true };
    const prevPt = before[before.length - 1];
    const all = [...before.map((p) => p[1]), price];
    const min = Math.min(...all), max = Math.max(...all);
    const change = Math.round((price - prevPt[1]) * 100) / 100;
    return {
      prev: prevPt[1], prevDate: prevPt[0], change,
      changePct: prevPt[1] ? Math.round((change / prevPt[1]) * 100) : 0,
      min, max, points: before.length + 1,
      isLowest: before.length >= 2 && price <= Math.min(...before.map((p) => p[1])),
    };
  }

  /** junta pontos vindos do Worker: { chave: { n, u, s, id, o, h: [[dia, preço], …] } }; devolve quantos pontos novos */
  function importHistory(map) {
    const h = history();
    let added = 0;
    for (const [rawKey, x] of Object.entries(map || {})) {
      if (!x || !Array.isArray(x.h) || !x.u) continue;
      const key = itemKey(x.u) || rawKey;
      const e = h[key] || { pts: [], n: x.n, u: x.u, s: x.s || hostOf(x.u), id: x.id || null };
      const byDay = new Map(e.pts.map((p) => [p[0], p[1]]));
      for (const [d, p] of x.h) if (!byDay.has(d) && p > 0) { byDay.set(d, p); added++; }
      e.pts = [...byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).slice(-MAX_POINTS);
      e.id = e.id || x.id || null;
      e.seen = Math.max(e.seen || 0, Date.now() - 1);
      h[key] = e;
    }
    if (added) { idIndex = null; write(K.history, h); }
    return added;
  }

  function getHistory(urlOrItem) { return history()[itemKey(urlOrItem)] || null; }

  /** o mesmo produto visto noutras lojas (pela identidade) */
  function otherStores(it) {
    const id = productIdentity(it);
    if (!id) return [];
    const myHost = hostOf(it.url);
    const out = [];
    const h = history();
    for (const key of byId().get(id) || []) {
      const e = h[key];
      if (!e || e.id !== id || e.s === myHost || !e.pts.length) continue;
      const lastPt = e.pts[e.pts.length - 1];
      out.push({ key, store: e.s, url: e.u, name: e.n, price: lastPt[1], date: lastPt[0], av: e.av });
    }
    return out.sort((a, b) => a.price - b.price);
  }

  function historyStats(urlOrItem) {
    const e = getHistory(urlOrItem);
    if (!e || !e.pts.length) return null;
    const ps = e.pts.map((p) => p[1]);
    return { min: Math.min(...ps), max: Math.max(...ps), points: ps.length, since: e.pts[0][0] };
  }

  /* ---------- produtos seguidos ---------- */

  const watchList = () => read(K.watch, []);
  const isWatched = (it) => watchList().some((w) => w.key === itemKey(it));

  function toggleWatch(it) {
    const list = watchList();
    const key = itemKey(it);
    const i = list.findIndex((w) => w.key === key);
    if (i >= 0) list.splice(i, 1);
    else list.unshift({
      key, url: it.url, name: it.name, brand: it.brand || '', image: it.image || '', store: hostOf(it.url),
      price: it.price, target: null, id: productIdentity(it), addedAt: Date.now(),
    });
    write(K.watch, list);
    emit('watch');
    return i < 0;
  }

  function updateWatch(key, patch) {
    const list = watchList();
    const w = list.find((x) => x.key === key);
    if (!w) return;
    Object.assign(w, patch);
    write(K.watch, list);
    emit('watch');
  }

  function removeWatch(key) {
    write(K.watch, watchList().filter((w) => w.key !== key));
    emit('watch');
  }

  /* ---------- pesquisas guardadas ---------- */

  const searches = () => read(K.searches, []);

  function saveSearch(name, config) {
    const list = searches();
    const existing = list.find((s) => s.name.toLowerCase() === name.toLowerCase());
    if (existing) Object.assign(existing, { config, updatedAt: Date.now() });
    else list.unshift({ id: 's' + Date.now().toString(36), name, config, monitor: false, createdAt: Date.now() });
    write(K.searches, list);
    emit('searches');
  }

  function updateSearch(id, patch) {
    const list = searches();
    const s = list.find((x) => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    write(K.searches, list);
    emit('searches');
  }

  function removeSearch(id) {
    write(K.searches, searches().filter((s) => s.id !== id));
    emit('searches');
  }

  /* ---------- cache de avaliações ---------- */

  const dealKey = (it) => `${P}deal:${itemKey(it)}|${it.price}`;
  function getDeal(it, maxAgeMs = 24 * 3600e3) {
    const d = read(dealKey(it), null);
    // avaliações do Worker antigo (sem a lista de preços com link) não contam: são pedidas de novo
    return d && Array.isArray(d.prices) && Date.now() - Date.parse(d.checkedAt) < maxAgeMs ? d : null;
  }
  const setDeal = (it, d) => { write(dealKey(it), d); emit('deal'); };

  /** apaga avaliações com mais de 24 h (senão enchem o armazenamento e o histórico é cortado para dar espaço) */
  function pruneDeals(maxAgeMs = 24 * 3600e3) {
    try {
      const old = [];
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k.startsWith(P + 'deal:')) continue;
        const d = read(k, null);
        if (!d || !(Date.now() - Date.parse(d.checkedAt) < maxAgeMs)) old.push(k);
      }
      old.forEach((k) => localStorage.removeItem(k));
      return old.length;
    } catch { return 0; }
  }
  if (typeof localStorage !== 'undefined') pruneDeals();

  /** só para testes: esquece a cache em memória */
  function _reset() { historyCache = null; idIndex = null; }

  return {
    on, itemKey, productIdentity, _reset,
    recordPrice, getHistory, historyStats, otherStores, history, importHistory,
    watchList, isWatched, toggleWatch, updateWatch, removeWatch,
    searches, saveSearch, updateSearch, removeSearch,
    getDeal, setDeal, pruneDeals,
  };
})();
